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
REMOTE_LOGIN_SHA256 = '773ff222088045c21600da6ce8aa21654fc1a951f9e440509946fd57afe8faf8'


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


def prepare(account, backup, run=subprocess.run):
    uid = pwd.getpwnam(account).pw_uid
    protected_parents(SSH_ROOT)
    protected(backup, mode=0o700, directory=True)
    admission = remote_login()
    prior = admission.admit(account, run=run)
    added = 'needs explicit Remote Login membership approval' in prior
    (backup / 'membership.json').write_text(json.dumps({'added': added, 'account': account}))
    if os.path.lexists(SSH_ROOT):
        protected(SSH_ROOT, mode=0o755, directory=True)
        if {path.name for path in SSH_ROOT.iterdir()} != {'id_ed25519', 'id_ed25519.pub', 'authorized_keys', 'known_hosts'}:
            raise ValueError('incomplete loopback SSH installation; refusing key rotation')
        protected(KEY, uid, 0o400)
        for path in (PUBLIC, AUTHORIZED, KNOWN_HOSTS):
            protected(path, 0, 0o444)
        shutil.copytree(SSH_ROOT, backup / 'previous', copy_function=shutil.copy2)
        key = public_key(run(['/usr/bin/ssh-keygen', '-y', '-f', str(KEY)], capture_output=True, text=True, check=True, timeout=15).stdout)
        if PUBLIC.read_text() != key + '\n' or AUTHORIZED.read_text() != authorized_key(key):
            raise ValueError('loopback SSH identity binding differs')
    else:
        # Root-private scratch holds the key until publication; it is never
        # staged in an operator-readable directory or put in a command/env.
        (backup / 'new').mkdir(mode=0o700)
        key_path = backup / 'new/id_ed25519'
        run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', '', '-f', str(key_path)], check=True, capture_output=True, timeout=15)
        key = public_key(key_path.with_suffix('.pub').read_text())
        SSH_ROOT.mkdir(mode=0o755)
        os.chmod(SSH_ROOT, 0o755)
        write_if_changed(KEY, key_path.read_bytes(), uid, 0o400)
        write_if_changed(PUBLIC, (key + '\n').encode(), 0, 0o444)
        write_if_changed(AUTHORIZED, authorized_key(key).encode(), 0, 0o444)
    # Pin the host's own root-owned public key; never ssh-keyscan or TOFU.
    host = HOST_PUBLIC.resolve(strict=True)
    protected_parents(host)
    protected(host)
    host_key = public_key(host.read_text())
    write_if_changed(KNOWN_HOSTS, ('127.0.0.1,::1 ' + host_key + '\n').encode(), 0, 0o444)
    gateway = (ROOT / 'authorized_keys').read_text()
    if key.split()[1] in gateway:
        raise ValueError('maintenance key cannot also be a gateway key')
    admission.admit(account, apply=True, run=run)
    (backup / 'prepared').touch()


def rollback(account, backup, run=subprocess.run):
    membership = backup / 'membership.json'
    if not membership.exists():
        return
    state = json.loads(membership.read_text())
    if state['account'] != account:
        raise ValueError('loopback rollback account differs')
    # The installer holds the host gate. Restore the private key owner as well
    # as its bytes; copy2 alone doesn't preserve ownership when run as root.
    previous = backup / 'previous'
    if previous.exists():
        protected(SSH_ROOT, mode=0o755, directory=True)
        for path in previous.iterdir():
            owner = pwd.getpwnam(account).pw_uid if path.name == 'id_ed25519' else 0
            write_if_changed(SSH_ROOT / path.name, path.read_bytes(), owner, 0o400 if path.name == 'id_ed25519' else 0o444)
    elif not (backup / 'new').exists():
        return  # Validation failed before we owned any mutation.
    elif os.path.lexists(SSH_ROOT):
        protected(SSH_ROOT, mode=0o755, directory=True)
        for path in SSH_ROOT.iterdir():
            if path.name not in {'id_ed25519', 'id_ed25519.pub', 'authorized_keys', 'known_hosts'} or path.is_symlink():
                raise ValueError('unsafe loopback rollback entry')
            path.unlink()
        SSH_ROOT.rmdir()
    if state['added']:
        # Prepare can fail before admission, or after dseditgroup added the
        # account but before its verification completed. Restore either case.
        member = run(['/usr/sbin/dseditgroup', '-o', 'checkmember', '-m', account, 'com.apple.access_ssh'], capture_output=True, text=True, timeout=15)
        if member.returncode == 0:
            run(['/usr/sbin/dseditgroup', '-o', 'edit', '-d', account, '-t', 'user', 'com.apple.access_ssh'], check=True, capture_output=True, timeout=15)
        elif f'no {account} is NOT a member of com.apple.access_ssh' not in member.stdout:
            raise ValueError('could not verify Remote Login rollback membership')


def self_test(account, check=False, run=subprocess.run):
    command = ['/usr/bin/sudo', '--non-interactive', '-H', '-u', account, '/usr/bin/env', '-i',
               'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'HOME=/Users/' + account,
               'DEVELOPER_DIR=/Library/Developer/CommandLineTools', *ssh_command(account, check)]
    result = run(command, check=False, capture_output=True, text=True, timeout=150, cwd='/')
    marker = 'PARTITURA_MAINTENANCE_STORAGE_OK'
    if marker not in result.stdout.splitlines():
        raise ValueError('loopback maintenance storage check failed; verify Remote Login > Allow full disk access for remote users, the Remote Login account ACL, and the pinned host key. No TCC.db read is used.')
    if result.returncode:
        raise ValueError('loopback maintenance returned failure; inspect maintenance health/reason and the private stderr log')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'rollback', 'check', 'test'))
    parser.add_argument('--account', required=True)
    parser.add_argument('--backup', type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0 or not re.fullmatch(r'[a-z][a-z0-9_-]{0,30}', args.account) or args.account == 'root':
        parser.error('requires root and an unprivileged build account')
    try:
        if args.action in ('prepare', 'rollback'):
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
