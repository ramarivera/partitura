#!/usr/bin/env python3
"""Helpers for provision-host.sh, the one-shot native build host provisioner.

Subcommands (each runs with the identity provision-host.sh gives it):
  settings  operator: render pinned host settings and the desired manifest
  sshd      root: admit the build account to an existing sshd allowlist
  password  root: set the build account password from its saved credential
  keychain  build account: create its login keychain once
"""
import argparse
import errno
import fnmatch
import glob
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import termios
import time

ACCOUNT = re.compile(r'[a-z][a-z0-9_-]{0,30}\Z')
SSHD_CONFIG = Path('/private/etc/ssh/sshd_config')
# Backups live outside sshd_config.d: its `Include sshd_config.d/*` would load them.
SSHD_BACKUPS = Path('/Library/Partitura/NativeBuild/sshd-backup')
CREDENTIAL = '.partitura-native-login.password'
KEYCHAIN = 'Library/Keychains/login.keychain-db'


def render_settings(args):
    """Write settings.json and managed-files.json for a fresh host install."""
    clone = Path(args.clone)
    spec = importlib.util.spec_from_file_location('host_setup', clone / 'deploy/mac-build/host_setup.py')
    hs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hs)

    def show(name):
        return subprocess.run(['/usr/bin/git', '-C', str(clone), 'show', f'HEAD:deploy/mac-build/{name}'],
                              check=True, capture_output=True, env=hs.git_environment()).stdout

    commit = subprocess.run(['/usr/bin/git', '-C', str(clone), 'rev-parse', 'HEAD'], check=True,
                            capture_output=True, text=True, env=hs.git_environment()).stdout.strip()
    receipt = json.loads(Path(args.receipt).read_text())
    root = Path(args.root_dir)
    names = ('broker.py', 'guest-run.sh', 'qualify-base.sh', 'native_host.py', 'install-host.sh', 'credential-writer.py')
    blobs = {name: show(name) for name in names}
    digest = {name: hashlib.sha256(blob).hexdigest() for name, blob in blobs.items()}
    settings = {
        'account': args.account,
        'authorized_key': args.authorized_key,
        'base': {
            'dedicated_path': receipt['basePath'],
            'mise_binary': args.mise_binary,
            'mise_sha256': receipt['miseSha256'],
            'mise_version': receipt['miseVersion'],
            'name': receipt['base'],
            'node_version': receipt['nodeVersion'],
            'python_version': receipt['pythonVersion'],
            'qualification_receipt': args.receipt,
            'sha256': receipt['baseSha256'],
            'source_name': receipt['sourceName'],
            'source_path': args.source_path,
            'source_sha256': receipt['sourceSha256'],
        },
        'enabled': True,
        'guest_user': args.guest_user,
        'host': args.host,
        'predecessor_manifest_sha256': '',
        'runtime': {'root': args.runtime_root, 'tart_home': args.tart_home},
        'source': {
            'partitura_repository': str(root / 'checkout'),
            'broker_commit': commit,
            'broker_sha256': digest['broker.py'],
            'guest_runner_sha256': digest['guest-run.sh'],
            'native_host_sha256': digest['native_host.py'],
            'install_host_sha256': digest['install-host.sh'],
            'qualifier_source': str(root / 'checkout/deploy/mac-build/qualify-base.sh'),
            'qualifier_sha256': digest['qualify-base.sh'],
            'credential_writer_sha256': digest['credential-writer.py'],
        },
        'tart': {
            'executable_relative_path': 'Contents/MacOS/tart',
            'installed_app': str(hs.ROOT_TART_APP),
            'sha256': args.tart_sha256,
            # The operator copy supplies the executable mode; root installs from its own copy.
            'source_app': args.tart_app,
        },
    }
    config = hs.validate_settings(settings)
    manifest = hs.expected_managed_manifest(
        hs.expected_host_files(config, tuple(blobs[name] for name in names)), config)
    settings['tart'] = dict(settings['tart'], source_app=str(root / 'tart.app'))
    hs.validate_settings(settings)
    data = json.dumps(settings, sort_keys=True, indent=2).encode() + b'\n'
    out = Path(args.out)
    out.mkdir(mode=0o700, parents=True, exist_ok=True)
    (out / 'settings.json').write_bytes(data)
    (out / 'managed-files.json').write_bytes(manifest)
    print(f'settings_sha256={hashlib.sha256(data).hexdigest()}')
    print(f'manifest_sha256={hashlib.sha256(manifest).hexdigest()}')


def sshd_values(output):
    """Collect the access-list keywords from `sshd -T` output."""
    values = {key: [] for key in ('allowusers', 'denyusers', 'allowgroups', 'denygroups')}
    for line in output.splitlines():
        key, _, rest = line.partition(' ')
        if key.lower() in values:
            values[key.lower()].extend(rest.split())
    return values


def access_plan(account, groups, values):
    """Return 'allowed' or 'append', or raise when only a human should decide.

    sshd lists hold glob patterns, optionally host-qualified as user@host.
    Denials are matched by their user part alone, so a host-limited denial
    still stops the run rather than being guessed about.
    """
    patterns = [pattern for entries in values.values() for pattern in entries]
    if any(pattern.startswith('!') for pattern in patterns):
        raise ValueError('negated sshd access patterns need manual review')
    if any(fnmatch.fnmatchcase(account, pattern.split('@', 1)[0]) for pattern in values['denyusers']) \
            or any(fnmatch.fnmatchcase(group, pattern) for group in groups for pattern in values['denygroups']):
        raise ValueError(f'sshd DenyUsers/DenyGroups matches {account}; refusing to override')
    if values['allowgroups'] and not any(fnmatch.fnmatchcase(group, pattern)
                                         for group in groups for pattern in values['allowgroups']):
        raise ValueError(f'sshd AllowGroups excludes {account}; add it by hand')
    if not values['allowusers'] or account in values['allowusers']:
        return 'allowed'
    # A plain entry is unconditional, unlike a pattern that may be host-limited.
    return 'append'


def global_directives(path, base=None, depth=0):
    """Yield (path, line index, keyword) for global directives in sshd parse order.

    Include expands in place, as sshd reads it. A Match line ends global scope
    for the rest of its file.
    """
    if depth > 8:
        raise ValueError('sshd Include nesting is too deep')
    base = base or path.parent
    for index, line in enumerate(path.read_text().splitlines()):
        words = line.split()
        if not words or words[0].startswith('#'):
            continue
        keyword = words[0].lower()
        if keyword == 'match':
            return
        if keyword == 'include':
            for pattern in words[1:]:
                if pattern.startswith('#'):
                    break
                if not pattern.startswith('/'):
                    pattern = str(base / pattern)
                for included in sorted(glob.glob(pattern)):
                    yield from global_directives(Path(included), base, depth + 1)
            continue
        yield path, index, keyword


def first_allowlist(main=SSHD_CONFIG):
    """The file and line of the AllowUsers directive sshd applies, if any."""
    for path, index, keyword in global_directives(main):
        if keyword == 'allowusers':
            return path, index
    return None


def append_allowed_user(line, account):
    """Add the account to an AllowUsers line, ahead of any inline comment."""
    body = line.rstrip('\r\n')
    ending = line[len(body):]
    comment = re.search(r'\s+#', body)
    code, rest = (body[:comment.start()], body[comment.start():]) if comment else (body, '')
    return f'{code.rstrip()} {account}{rest}{ending}'


def admit_sshd(account, apply=False, run=subprocess.run, main=SSHD_CONFIG, backups=SSHD_BACKUPS, owner=0):
    groups = run(['/usr/bin/id', '-Gn', account], capture_output=True, text=True, check=True).stdout.split()
    if {'admin', 'wheel'} & set(groups):
        raise ValueError('build account must be unprivileged')

    def effective():
        out = run(['/usr/sbin/sshd', '-T', '-C', f'user={account},host=localhost,addr=127.0.0.1'],
                  capture_output=True, text=True, check=True).stdout
        return access_plan(account, groups, sshd_values(out))

    if effective() == 'allowed':
        return f'sshd already admits {account}'
    found = first_allowlist(main)
    if found is None:
        raise ValueError('sshd AllowUsers is set but no global AllowUsers line was found to extend')
    path, index = found
    lines = path.read_text().splitlines(keepends=True)
    lines[index] = append_allowed_user(lines[index], account)
    edited = ''.join(lines)
    if not apply:
        return f'sshd allowlist in {path} needs {account} appended'
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or info.st_uid != owner or info.st_mode & 0o022:
        raise ValueError(f'refusing to edit unsafe sshd file {path}')
    backups.mkdir(mode=0o700, parents=True, exist_ok=True)
    backup = backups / f'{path.name}.{time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())}'
    shutil.copy2(path, backup)
    descriptor, name = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            handle.write(edited)
        os.chown(name, info.st_uid, info.st_gid)
        os.chmod(name, stat.S_IMODE(info.st_mode))
        os.replace(name, path)
    finally:
        if os.path.lexists(name):
            os.unlink(name)
    try:
        run(['/usr/sbin/sshd', '-t'], capture_output=True, text=True, check=True)
        if effective() != 'allowed':
            raise ValueError('edited sshd allowlist still does not admit the account')
    except (subprocess.CalledProcessError, ValueError):
        shutil.copy2(backup, path)
        raise ValueError(f'sshd rejected the allowlist edit; restored {path}') from None
    return f'sshd admits {account}; previous {path.name} kept at {backup}'


def read_credential(home):
    """Read the build credential with the same checks the broker applies."""
    descriptor = os.open(home / CREDENTIAL, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as handle:
        info = os.fstat(handle.fileno())
        owner = home.lstat().st_uid
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('credential metadata unexpected')
        secret = bytearray(handle.read(1025))
    if not 1 <= len(secret) <= 1024 or any(b in secret for b in b'\0\n\r'):
        secret[:] = b'\0' * len(secret)
        raise ValueError('credential content unexpected')
    return secret


def drive_passwd(argv, secret, prompts=2, timeout=30):
    """Answer `passwd`'s two hidden prompts on a private pseudo-terminal.

    The secret never reaches argv, the environment or a log. Echo is off before
    the child starts, so the secret is not echoed back even if the child is slow
    to disable it. Output is drained to EOF because macOS blocks a session
    leader's exit until its tty drains.
    """
    pid, master = os.forkpty()
    if pid == 0:
        try:
            attributes = termios.tcgetattr(0)
            attributes[3] &= ~(termios.ECHO | termios.ECHONL)
            termios.tcsetattr(0, termios.TCSANOW, attributes)
            os.execv(argv[0], argv)
        finally:
            os._exit(127)
    seen, answered, deadline = bytearray(), 0, time.monotonic() + timeout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                raise ValueError('passwd did not finish in time')
            if not select.select([master], [], [], remaining)[0]:
                continue
            try:
                chunk = os.read(master, 1024)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            seen.extend(chunk)
            if answered < prompts and bytes(seen).rstrip().endswith(b':'):
                os.write(master, bytes(secret) + b'\n')
                answered += 1
                seen.clear()
    finally:
        seen.clear()
        os.close(master)
    _, status = os.waitpid(pid, 0)
    if answered != prompts or os.waitstatus_to_exitcode(status) != 0:
        raise ValueError('passwd did not accept the saved credential')


def set_password(account):
    if os.geteuid() != 0:
        raise ValueError('run as root')
    home = Path(pwd.getpwnam(account).pw_dir)
    secret = read_credential(home)
    try:
        drive_passwd(['/usr/bin/passwd', account], secret)
    finally:
        secret[:] = b'\0' * len(secret)
    return f'{account} password set from its saved credential'


def keychain():
    """Create the build account's login keychain from its saved credential.

    There is no unlock check: on macOS 27 an unlock run through sudo -u from the
    operator's session fails even for a correct keychain. The broker's first job
    unlocks it in the build account's own SSH session.
    """
    import ctypes as C
    home = Path(os.path.expanduser('~'))
    if os.getuid() == 0 or home != Path('/Users') / pwd.getpwuid(os.getuid()).pw_name:
        raise ValueError('run as the build account with sudo -H')
    path = home / KEYCHAIN
    if os.path.lexists(path):
        raise ValueError('keychain path still exists')
    secret = read_credential(home)
    S = C.CDLL('/System/Library/Frameworks/Security.framework/Security')
    ref = C.c_void_p
    S.SecKeychainCreate.argtypes = [C.c_char_p, C.c_uint32, C.c_void_p, C.c_ubyte, C.c_void_p, C.POINTER(ref)]
    S.SecKeychainCreate.restype = C.c_int32
    S.SecKeychainLock.argtypes = [ref]
    S.SecKeychainLock.restype = C.c_int32
    buffer = C.create_string_buffer(bytes(secret))
    secret[:] = b'\0' * len(secret)
    handle = ref()
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        code = S.SecKeychainCreate(os.fsencode(path), len(buffer) - 1, buffer, 0, None, C.byref(handle))
        if code:
            raise ValueError(f'keychain create failed: {code}')
        S.SecKeychainLock(handle)
    finally:
        C.memset(buffer, 0, len(buffer))
    print('build keychain created and locked')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    render = commands.add_parser('settings')
    for name in ('clone', 'receipt', 'root-dir', 'tart-app', 'tart-sha256', 'mise-binary', 'source-path',
                 'host', 'account', 'guest-user', 'authorized-key', 'runtime-root', 'tart-home', 'out'):
        render.add_argument(f'--{name}', required=True)
    for name in ('sshd', 'password'):
        sub = commands.add_parser(name)
        sub.add_argument('--account', required=True)
        if name == 'sshd':
            sub.add_argument('--apply', action='store_true')
    commands.add_parser('keychain')
    args = parser.parse_args(argv)
    try:
        if args.command == 'settings':
            render_settings(args)
            return 0
        if args.command == 'keychain':
            return keychain()
        if not ACCOUNT.fullmatch(args.account) or args.account == 'root':
            raise ValueError('invalid build account')
        if args.command == 'sshd':
            if os.geteuid() != 0:
                raise ValueError('run as root')
            print(admit_sshd(args.account, args.apply))
        else:
            print(set_password(args.account))
        return 0
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f'provision {args.command}: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
