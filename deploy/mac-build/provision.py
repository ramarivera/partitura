#!/usr/bin/env python3
"""Helpers for provision-host.sh, the one-shot native build host provisioner.

Subcommands (each runs with the identity provision-host.sh gives it):
  settings  operator: render pinned host settings and the desired manifest
  sshd      root: admit the build account to an existing sshd allowlist
  password  root: set the build account password from its saved credential
  keychain  build account: create its login keychain once
"""
import argparse
import uuid
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
BOOTSTRAP_BINDING = Path('/Library/Partitura/NativeBuild/credential-bootstrap.json')


def bootstrap_binding(account):
    if os.geteuid() != 0 or not ACCOUNT.fullmatch(account) or account == 'root':
        raise ValueError('bootstrap binding requires root and the dedicated account')
    identity = pwd.getpwnam(account)
    if identity.pw_uid == 0 or identity.pw_dir != '/Users/' + account:
        raise ValueError('invalid dedicated account identity')
    missing = []
    current = BOOTSTRAP_BINDING.parent
    while not os.path.lexists(current):
        missing.append(current)
        current = current.parent
    for path in (current, *current.parents):
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unsafe bootstrap binding ancestor')
    for path in reversed(missing):
        path.mkdir(mode=0o755)
        path.chmod(0o755)
    config_path = BOOTSTRAP_BINDING.with_name('config.json')
    if os.path.lexists(config_path):
        descriptor = os.open(config_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > 65536:
                raise ValueError('unsafe installed credential binding')
            config = json.load(source)
        if config['keychainPath'] != identity.pw_dir + '/Library/Keychains/login.keychain-db' or config['keychainCredentialPath'] != identity.pw_dir + '/' + CREDENTIAL:
            raise ValueError('installed config binds a different dedicated account')
    value = dict(schema=1, account=account, uid=identity.pw_uid, home=identity.pw_dir)
    if os.path.lexists(BOOTSTRAP_BINDING):
        info = BOOTSTRAP_BINDING.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o444 or json.loads(BOOTSTRAP_BINDING.read_bytes()) != value:
            raise ValueError('bootstrap binding differs')
        return 0
    descriptor = os.open(BOOTSTRAP_BINDING, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
    with os.fdopen(descriptor, 'w') as stream:
        os.fchmod(stream.fileno(), 0o444)
        stream.write(json.dumps(value) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(BOOTSTRAP_BINDING.parent, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return 0

INSTALL_GUARD_SCRIPT = r'''
import fcntl
import json
import os
from pathlib import Path
import stat
import sys
import uuid
import re
import base64
import io
import importlib.abc
import importlib.util
import zipfile

root = Path(sys.argv[1])
if not root.is_absolute() or root.resolve() != root:
    raise SystemExit('unsafe runtime root')
info = root.lstat()
if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit('unsafe runtime root')
descriptor = os.open(root / 'runner.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
info = os.fstat(descriptor)
if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077:
    raise SystemExit('unsafe runner lock')
fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
fences = ('active-vm', 'cleanup-required', 'unlock-attempt', 'keychain-relock-pending', 'runner.json', 'recovery.json', 'maintenance-blocked', 'inventory-required')
def marker(name):
    fd = os.open(root / name, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'r') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 128:
            raise SystemExit('unsafe installation marker')
        return stream.read(129)
existing = {name for name in fences if os.path.lexists(root / name)}
blocked = marker('maintenance-blocked') if 'maintenance-blocked' in existing else ''
match = re.fullmatch('installation-incomplete ([a-f0-9]{32})\n', blocked)
token = match[1] if match else uuid.uuid4().hex
resume = bool(match) and existing <= {'cleanup-required', 'maintenance-blocked', 'inventory-required'} and not os.path.lexists(root / token)
if resume and 'cleanup-required' in existing:
    resume = marker('cleanup-required') == token + '\n'
if resume and 'inventory-required' in existing:
    resume = marker('inventory-required') == 'installation\n'
if existing and not resume:
    raise SystemExit('drain and reconcile existing native jobs before installation')
tart = Path(sys.argv[2])
if tart.resolve() != tart or (tart / 'vms').is_symlink() or any(item.name.startswith('partitura-job-') for item in (tart / 'vms').iterdir()):
    raise SystemExit('drain owned clones before installation')
# Execute only the root wrapper's hash-verified broker bytes, never code from a
# job tree. Classification does no keychain IO and cannot start a native build.
archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(sys.argv[3], validate=True)))
class BrokerLoader(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        if fullname != 'partitura_broker' and not fullname.startswith('partitura_broker.'):
            return None
        name = fullname.replace('.', '/')
        package = fullname == 'partitura_broker'
        member = name + ('/__init__.py' if package else '.py')
        if member not in archive.namelist():
            raise ImportError('missing sealed broker module')
        return importlib.util.spec_from_loader(fullname, self, is_package=package)
    def exec_module(self, module):
        member = module.__name__.replace('.', '/') + ('/__init__.py' if module.__name__ == 'partitura_broker' else '.py')
        module.__file__ = '/dev/null'
        exec(compile(archive.read(member), '<sealed broker inventory>', 'exec'), module.__dict__)
sys.meta_path.insert(0, BrokerLoader())
import partitura_broker as broker
config = json.loads(sys.argv[4])
jobs = broker.inventory_obligations(config)
for job in jobs:
    broker.inspect_job_directory(root / job)
if jobs:
    print('legacy job receipts require broker SSH recovery: ' + ','.join(sorted(jobs)), file=sys.stderr)
def sync():
    fd = os.open(root, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
def write(name, value):
    path = root / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    sync()
# Classification never mutates admission. A timed-out wrapper closes stdin
# without authorizing fences, even if inventory finishes much later.
print('classified', flush=True)
if sys.stdin.readline() != 'fence\n':
    raise SystemExit('installation not authorized; admission unchanged')
started = False
try:
    if not resume:
        write('maintenance-blocked', 'installation-incomplete ' + token + '\n')
    if 'cleanup-required' not in existing:
        write('cleanup-required', token + '\n')
    print('ready', flush=True)
    if sys.stdin.readline() != 'start\n':
        raise SystemExit('installation not started; prior admission restored')
    started = True
finally:
    # Includes a late BrokenPipeError after the root wrapper has timed out and
    # closed stdout. No transaction was started, so only our new fences may go.
    if not started and not resume:
        owned = {'maintenance-blocked': 'installation-incomplete ' + token + '\n', 'cleanup-required': token + '\n'}
        present = {name for name in owned if os.path.lexists(root / name)}
        if all(marker(name) == owned[name] for name in present):
            for name in ('cleanup-required', 'maintenance-blocked'):
                if name in present:
                    (root / name).unlink()
                    sync()
command = sys.stdin.readline()
if command not in ('commit\n', 'abort-restored\n'):
    raise SystemExit('installation incomplete; admission remains fenced')
if command == 'abort-restored\n' and resume:
    raise SystemExit('prior incomplete installation still requires successful readback')
if marker('maintenance-blocked') != 'installation-incomplete ' + token + '\n' or marker('cleanup-required') != token + '\n':
    raise SystemExit('installation fence ownership changed')
# Every policy/profile change invalidates commands queued before installation.
if command == 'commit\n':
    epoch = root / 'admission-epoch'
    pending = root / ('.installation-epoch-' + uuid.uuid4().hex)
    write(pending.name, uuid.uuid4().hex + '\n')
    pending.replace(epoch)
    sync()
# A new host or upgraded broker must complete its bounded boot inventory.
if command == 'commit\n' and not os.path.lexists(root / 'inventory-required'):
    write('inventory-required', 'installation\n')
for name in ('cleanup-required', 'maintenance-blocked'):
    (root / name).unlink()
    sync()
'''


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
    out = Path(args.out)
    installed = hs.read_root_json(hs.ROOT_CONFIG) or {}
    identity = hs.read_root_json(hs.ROOT_IDENTITY) or {}
    cached = {}
    if not installed.get('hostId') and not identity.get('hostId') and (out / 'settings.json').exists():
        cached = json.loads((out / 'settings.json').read_text()).get('broker', {})
    host_id = args.host_id or identity.get('hostId') or installed.get('hostId') or cached.get('host_id') or str(uuid.uuid4())
    old = dict(host_id=host_id, protocol=2, profile=installed.get('profile', 'legacy'), minimum_free_bytes=installed.get('minimumFreeBytes', hs.MINIMUM_FREE_BYTES), daemon_relock_qualified=installed.get('daemonRelockQualified', False), daemon_relock_macos_build=installed.get('daemonRelockMacOSBuild', ''), keychain_policy=installed.get('keychainPolicy'))
    if args.keychain_policy is not None:
        old['keychain_policy'] = None if args.keychain_policy == 'preserve' else json.loads(args.keychain_policy)
    policy = dict(old, **{key: value for key, value in dict(profile=args.profile, minimum_free_bytes=args.minimum_free_bytes, daemon_relock_qualified=args.daemon_relock_qualified, daemon_relock_macos_build=args.daemon_relock_macos_build).items() if value is not None})
    names = ('broker.py', 'guest-run.sh', 'qualify-base.sh', 'native_host.py', 'install-host.sh', 'credential-writer.py', 'maintenance_ssh.py', 'remote_login.py')
    blobs = {name: show(name) for name in names if name != 'broker.py'}
    blobs['broker.py'] = hs.broker_from_commit(clone, commit, hs.git_environment())
    digest = {name: hashlib.sha256(blob).hexdigest() for name, blob in blobs.items()}
    settings = {
        'account': args.account,
        'authorized_keys': args.authorized_key,
        'broker': policy,
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
        'predecessor_manifest_sha256': args.predecessor_manifest_sha256,
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
    config = hs.resolve_broker_policy(hs.validate_settings(settings))
    manifest = hs.expected_managed_manifest(
        hs.expected_host_files(config, tuple(blobs[name] for name in names)), config)
    settings['tart'] = dict(settings['tart'], source_app=str(root / 'tart.app'))
    hs.validate_settings(settings)
    data = json.dumps(settings, sort_keys=True, indent=2).encode() + b'\n'
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
    groups = run(['/usr/bin/id', '-Gn', account], capture_output=True, text=True, check=True, timeout=15).stdout.split()
    if {'admin', 'wheel'} & set(groups):
        raise ValueError('build account must be unprivileged')

    def effective():
        out = run(['/usr/sbin/sshd', '-T', '-C', f'user={account},host=localhost,addr=127.0.0.1'],
                  capture_output=True, text=True, check=True, timeout=15).stdout
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
        run(['/usr/sbin/sshd', '-t'], capture_output=True, text=True, check=True, timeout=15)
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
                 'host', 'account', 'guest-user', 'runtime-root', 'tart-home', 'out'):
        render.add_argument(f'--{name}', required=True)
    render.add_argument('--authorized-key', action='append', required=True)
    render.add_argument('--host-id')
    render.add_argument('--profile', choices=('legacy', 'registry-only'))
    render.add_argument('--minimum-free-bytes', type=int)
    render.add_argument('--keychain-policy', help='preserve, or explicit JSON lockOnSleep/lockInterval settings')
    qualification = render.add_mutually_exclusive_group()
    qualification.add_argument('--daemon-relock-qualified', action='store_true', default=None)
    qualification.add_argument('--daemon-relock-unqualified', action='store_false', dest='daemon_relock_qualified')
    render.add_argument('--daemon-relock-macos-build')
    render.add_argument('--predecessor-manifest-sha256', default='')
    commands.add_parser('validate-keys').add_argument('keys', nargs='+')
    commands.add_parser('bootstrap-binding').add_argument('--account', required=True)
    for name in ('sshd', 'password'):
        sub = commands.add_parser(name)
        sub.add_argument('--account', required=True)
        if name == 'sshd':
            sub.add_argument('--apply', action='store_true')
    commands.add_parser('keychain')
    args = parser.parse_args(argv)
    try:
        if args.command == 'validate-keys':
            spec = importlib.util.spec_from_file_location('public_keys', Path(__file__).with_name('host_setup.py'))
            helper = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(helper)
            helper.validate_authorized_keys(args.keys, True)
            return 0
        if args.command == 'bootstrap-binding':
            return bootstrap_binding(args.account)
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
