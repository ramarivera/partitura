#!/usr/bin/python3
"""Pinned loopback SSH installation and pre/post-activation checks. No secrets on stdout."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile

ROOT = Path('/Library/Partitura/NativeBuild')
SSH_ROOT = ROOT / 'maintenance-ssh'
KEY = SSH_ROOT / 'id_ed25519'
PUBLIC = SSH_ROOT / 'id_ed25519.pub'
AUTHORIZED = SSH_ROOT / 'authorized_keys'
KNOWN_HOSTS = SSH_ROOT / 'known_hosts'
HOST_PUBLIC = Path('/etc/ssh/ssh_host_ed25519_key.pub')
VERB = 'partitura-local-maintenance'
CHECK_VERB = 'partitura-maintenance-check'
PROVISION_SHA256 = 'd137301fcdff6865a8c92134ad0aaa908a8f13e1adecc6af9adb663dfc9b434b'
REMOTE_LOGIN_SHA256 = '2453a1364f7ddf0f8a6e3ccdf62f629fe531ca99ff2ee815ced1dca4aad51669'


def ssh_command(account, check=False):
    return ['/usr/bin/ssh', '-F', '/dev/null', '-n', '-T', '-p', '22', '-l', account,
            '-i', str(KEY), '-oBatchMode=yes', '-oIdentitiesOnly=yes', '-oIdentityAgent=none',
            '-oStrictHostKeyChecking=yes', '-oUserKnownHostsFile=' + str(KNOWN_HOSTS),
            '-oGlobalKnownHostsFile=/dev/null', '-oHostKeyAlgorithms=ssh-ed25519',
            '-oUpdateHostKeys=no', '-oClearAllForwardings=yes', '-oControlMaster=no', '-oControlPath=none',
            '-oConnectTimeout=10', '-oConnectionAttempts=1', '-oServerAliveInterval=15',
            '-oServerAliveCountMax=3', '-oLogLevel=ERROR', '127.0.0.1', CHECK_VERB if check else VERB]


def maintenance_plist(account):
    return plistlib.dumps({
        'Label': 'net.partitura.native-build-maintenance', 'UserName': account, 'GroupName': 'staff',
        'ProgramArguments': ssh_command(account),
        'EnvironmentVariables': {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': '/Users/' + account,
                                 'DEVELOPER_DIR': '/Library/Developer/CommandLineTools'},
        'RunAtLoad': True, 'StartInterval': 60, 'ProcessType': 'Background', 'WorkingDirectory': '/',
        'Umask': 0o077, 'ExitTimeOut': 150, 'ThrottleInterval': 60,
        'StandardErrorPath': str(ROOT / 'maintenance.stderr.log'),
        'HardResourceLimits': {'Core': 0, 'FileSize': 1048576},
        'SoftResourceLimits': {'Core': 0, 'FileSize': 1048576},
    }, sort_keys=True)


def protected(path, owner=0, mode=None, directory=False):
    info = path.lstat()
    valid = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    if not valid or info.st_uid != owner or info.st_mode & 0o022 or (mode is not None and stat.S_IMODE(info.st_mode) != mode):
        raise ValueError('unsafe loopback SSH installation')
    return info


def protected_parents(path):
    for parent in path.parents:
        protected(parent, directory=True)


def public_key(value):
    words = value.split()
    if len(words) < 2 or words[0] != 'ssh-ed25519':
        raise ValueError('expected an ed25519 SSH public key')
    blob = base64.b64decode(words[1], validate=True)
    if len(blob) != 51 or blob[:19] != b'\0\0\0\x0bssh-ed25519\0\0\0\x20':
        raise ValueError('invalid ed25519 SSH public key')
    return ' '.join(words[:2])


def authorized_key(key):
    return 'restrict,from="127.0.0.1,::1",command="/usr/bin/python3 /Library/Partitura/NativeBuild/broker.py" ' + public_key(key) + '\n'


def remote_login():
    path = Path(__file__).with_name('remote_login.py')
    source = path.read_bytes()
    if hashlib.sha256(source).hexdigest() != REMOTE_LOGIN_SHA256:
        raise ValueError('Remote Login helper differs from pin')
    spec = importlib.util.spec_from_file_location('maintenance_remote_login', path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def write_if_changed(path, data, owner, mode):
    if path.exists():
        protected(path, owner, mode)
        if path.read_bytes() == data:
            return
    descriptor, name = tempfile.mkstemp(prefix='.ssh-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchown(stream.fileno(), owner, -1)
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.lexists(name):
            os.unlink(name)


def snapshot_admission(account, backup, run):
    helper = load_provision()
    prior = helper.admit_sshd(account, run=run)
    if 'needs ' in prior:
        path, _ = helper.first_allowlist()
        protected_parents(path)
        info = protected(path)
        shutil.copy2(path, backup / 'sshd-original')
        (backup / 'sshd.json').write_text(json.dumps(dict(path=str(path), mode=stat.S_IMODE(info.st_mode), gid=info.st_gid)))
    helper.admit_sshd(account, apply=True, run=run, backups=backup / 'allowusers-backups')


def load_provision():
    path = Path(__file__).with_name('provision.py')
    if hashlib.sha256(path.read_bytes()).hexdigest() != PROVISION_SHA256:
        raise ValueError('SSH admission helper differs from pin')
    spec = importlib.util.spec_from_file_location('maintenance_provision', path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    return helper


def existing_key(account, uid, run):
    try:
        protected(KEY, uid, 0o400)
        key = public_key(run(['/usr/bin/sudo', '--non-interactive', '-H', '-u', account, '/usr/bin/ssh-keygen', '-y', '-f', str(KEY)], capture_output=True, text=True, check=True, timeout=15).stdout)
        return key if PUBLIC.read_text() == key + '\n' and AUTHORIZED.read_text() == authorized_key(key) else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None  # Explicit root reinstall repairs account-controlled damage.


def prepare(account, backup, run=subprocess.run):
    uid = pwd.getpwnam(account).pw_uid
    protected_parents(SSH_ROOT)
    protected(backup, mode=0o700, directory=True)
    admission = remote_login()
    prior = admission.admit(account, run=run)
    added = 'needs explicit Remote Login membership approval' in prior
    (backup / 'membership.json').write_text(json.dumps({'added': added, 'account': account}))
    existed = os.path.lexists(SSH_ROOT)
    (backup / 'identity.json').write_text(json.dumps(dict(existed=existed)))
    if existed:
        protected(SSH_ROOT, mode=0o755, directory=True)
        if {path.name for path in SSH_ROOT.iterdir()} - {'id_ed25519', 'id_ed25519.pub', 'authorized_keys', 'known_hosts'}:
            raise ValueError('unexpected loopback SSH installation entries')
        (backup / 'previous').mkdir(mode=0o700)
        for path in (PUBLIC, AUTHORIZED, KNOWN_HOSTS):
            if os.path.lexists(path):
                protected(path, 0, 0o444)
                shutil.copy2(path, backup / 'previous' / path.name)
        key = existing_key(account, uid, run)
    else:
        SSH_ROOT.mkdir(mode=0o755)
        os.chmod(SSH_ROOT, 0o755)
        key = None
    if key is None:
        # Rename the old inode in its sealed directory, never copy private bytes
        # into rollback scratch. Root never parses the account-controlled key.
        if os.path.lexists(KEY):
            os.replace(KEY, KEY.with_name('id_ed25519.previous'))
        (backup / 'replaced').touch()
        with tempfile.TemporaryDirectory(prefix='.keygen-', dir=SSH_ROOT) as generated:
            key_path = Path(generated) / 'key'
            run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', str(key_path)], check=True, capture_output=True, timeout=15)
            key = public_key(key_path.with_suffix('.pub').read_text())
            os.chown(key_path, uid, -1)
            key_path.chmod(0o400)
            os.replace(key_path, KEY)
        write_if_changed(PUBLIC, (key + '\n').encode(), 0, 0o444)
        write_if_changed(AUTHORIZED, authorized_key(key).encode(), 0, 0o444)
    host = HOST_PUBLIC.resolve(strict=True)
    protected_parents(host)
    protected(host)
    host_key = public_key(host.read_text())
    write_if_changed(KNOWN_HOSTS, ('127.0.0.1,::1 ' + host_key + '\n').encode(), 0, 0o444)
    if key.split()[1] in (ROOT / 'authorized_keys').read_text():
        raise ValueError('maintenance key cannot also be a gateway key')
    admission.admit(account, apply=True, run=run)
    snapshot_admission(account, backup, run)
    (backup / 'prepared').touch()


def finish(backup):
    # Called only after the transaction commits. It removes the revoked inode.
    if (backup / 'replaced').exists():
        KEY.with_name('id_ed25519.previous').unlink(missing_ok=True)


def rollback(account, backup, run=subprocess.run):
    membership = backup / 'membership.json'
    if not membership.exists():
        return
    state = json.loads(membership.read_text())
    if state['account'] != account:
        raise ValueError('loopback rollback account differs')
    identity = backup / 'identity.json'
    if identity.exists():
        existed = json.loads(identity.read_text())['existed']
        previous = backup / 'previous'
        if previous.exists() or not existed:
            protected(SSH_ROOT, mode=0o755, directory=True)
            if (backup / 'replaced').exists():
                KEY.unlink(missing_ok=True)
                old = KEY.with_name('id_ed25519.previous')
                if os.path.lexists(old):
                    os.replace(old, KEY)
            for path in (PUBLIC, AUTHORIZED, KNOWN_HOSTS):
                original = previous / path.name
                if original.exists():
                    write_if_changed(path, original.read_bytes(), 0, 0o444)
                else:
                    path.unlink(missing_ok=True)
            if not existed:
                SSH_ROOT.rmdir()
    if (backup / 'sshd.json').exists():
        saved = json.loads((backup / 'sshd.json').read_text())
        path = Path(saved['path'])
        write_if_changed(path, (backup / 'sshd-original').read_bytes(), 0, saved['mode'])
        os.chown(path, 0, saved['gid'])
        run(['/usr/sbin/sshd', '-t'], check=True, capture_output=True, timeout=15)
    if state['added']:
        member = run(['/usr/sbin/dseditgroup', '-o', 'checkmember', '-m', account, 'com.apple.access_ssh'], capture_output=True, text=True, timeout=15)
        if member.returncode == 0:
            run(['/usr/sbin/dseditgroup', '-o', 'edit', '-d', account, '-t', 'user', 'com.apple.access_ssh'], check=True, capture_output=True, timeout=15)
        elif f'no {account} is NOT a member of com.apple.access_ssh' not in member.stdout:
            raise ValueError('could not verify Remote Login rollback membership')


def run_test(command, timeout=150):
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True, cwd='/')
    try:
        stdout, stderr = child.communicate(timeout=timeout)
    except BaseException:
        # Kill sudo AND its ssh child. The detached sshd-side pass remains
        # protected by its own deadline and crash fences, not this process group.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.communicate()
        raise
    return subprocess.CompletedProcess(command, child.returncode, stdout, stderr)


def self_test(account, check=False, run=None):
    command = ['/usr/bin/sudo', '--non-interactive', '-H', '-u', account, '/usr/bin/env', '-i',
               'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'HOME=/Users/' + account,
               'DEVELOPER_DIR=/Library/Developer/CommandLineTools', *ssh_command(account, check)]
    result = run_test(command) if run is None or run is subprocess.run else run(command, check=False, capture_output=True, text=True, timeout=150, cwd='/')
    if result.returncode == 255:
        raise ValueError('loopback SSH transport, authentication or pinned host-key check failed')
    if 'PARTITURA_MAINTENANCE_STORAGE_ERROR=storage-access-denied' in result.stdout.splitlines():
        raise ValueError('Enable Remote Login > Allow full disk access for remote users. This macOS setting cannot be set by a script.')
    if 'PARTITURA_MAINTENANCE_STORAGE_OK' not in result.stdout.splitlines():
        raise ValueError('loopback maintenance refused by sudo or broker, or storage permissions/IO failed; inspect the private maintenance log')
    if result.returncode:
        raise ValueError('loopback maintenance returned failure; inspect maintenance health/reason and the private stderr log')


def accepts_ssh_environment(pattern):
    # OpenSSH AcceptEnv uses * and ?. Check whether any suffix of SSH_ could
    # satisfy the pattern, rather than checking only SSH_USER_AUTH.
    pending, seen = [(0, 0)], set()
    while pending:
        i, j = pending.pop()
        if (i, j) in seen:
            continue
        seen.add((i, j))
        if j == 4:
            return True
        if i == len(pattern):
            continue
        token = pattern[i]
        if token == '*':
            pending.extend(((i + 1, j), (i, j + 1)))
        elif token == '?' or token == 'SSH_'[j]:
            pending.append((i + 1, j + 1))
    return False


def verify_environment(policy):
    values = [value for line in policy.splitlines() if len(parts := line.split(None, 1)) == 2 for key, value in [parts] if key.lower() == 'acceptenv']
    if any(accepts_ssh_environment(pattern) for value in values for pattern in value.split()):
        raise ValueError('effective sshd AcceptEnv must not accept SSH_*')


def verify_effective_sshd(account, effective):
    expected = dict(authorizedkeysfile=str(ROOT / 'authorized_keys') + ' ' + str(AUTHORIZED), exposeauthinfo='yes', passwordauthentication='no', kbdinteractiveauthentication='no', authenticationmethods='publickey', forcecommand='/usr/bin/python3 /Library/Partitura/NativeBuild/broker.py', allowtcpforwarding='no', allowagentforwarding='no', x11forwarding='no', permittty='no', permituserenvironment='no', clientaliveinterval='15', clientalivecountmax='3')
    mismatch = [key for key, value in expected.items() if effective.get(key) != value]
    if mismatch:
        raise ValueError('effective sshd policy differs: ' + ', '.join(mismatch))
    verify_environment('acceptenv ' + effective.get('acceptenv', ''))


def preflight_storage(tart_home, source_path=None):
    # A fresh host has neither the build identity nor its maintenance key. Use
    # the incoming Remote Login session (same sshd FDA grant), without creating
    # an account/key/ACL just to test. Installed-key checks still run on loopback.
    if len(os.environ.get('SSH_CONNECTION', '').split()) != 4:
        raise ValueError('Run the read-only preflight over Remote Login SSH; no local Terminal FDA result is accepted')
    for candidate in (tart_home, source_path):
        if not candidate:
            continue
        path = Path(candidate)
        if not path.is_absolute() or path.parts[:2] != ('/', 'Volumes') or len(path.parts) < 3:
            continue
        volume = Path(*path.parts[:3])
        try:
            with os.scandir(volume) as entries:
                next(entries, None)
            return
        except FileNotFoundError:
            continue  # A new target volume can use the existing external source.
        except OSError as error:
            if error.errno == 1:
                raise ValueError('Enable Remote Login > Allow full disk access for remote users. This macOS setting cannot be set by a script.') from None
            raise ValueError('Remote Login storage preflight failed: external volume permissions or IO; not an FDA diagnosis') from None
    raise ValueError('Remote Login storage preflight needs an existing external target or source volume')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'rollback', 'finish', 'check', 'test', 'policy', 'preflight'))
    parser.add_argument('--account')
    parser.add_argument('--tart-home')
    parser.add_argument('--source-path')
    parser.add_argument('--backup', type=Path)
    args = parser.parse_args()
    try:
        if args.action == 'preflight':
            preflight_storage(args.tart_home, args.source_path)
            return 0
        if os.geteuid() != 0 or not args.account or not re.fullmatch(r'[a-z][a-z0-9_-]{0,30}', args.account) or args.account == 'root':
            parser.error('requires root and an unprivileged build account')
        if args.action == 'policy':
            verify_environment(sys.stdin.read(1048576))
        elif args.action == 'finish':
            if args.backup is None:
                parser.error('--backup is required')
            finish(args.backup)
        elif args.action in ('prepare', 'rollback'):
            if args.backup is None:
                parser.error('--backup is required')
            (prepare if args.action == 'prepare' else rollback)(args.account, args.backup)
        else:
            self_test(args.account, check=args.action == 'check')
        return 0
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        # Never include helper stdout/stderr, key bytes or foreign exception text.
        print('maintenance SSH setup failed: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
