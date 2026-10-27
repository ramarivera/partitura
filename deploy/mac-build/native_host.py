#!/usr/bin/python3
"""Run Partitura's hash-pinned macOS host installer from a staged directory."""
from __future__ import annotations

import argparse
import ast
import contextlib
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import select
import subprocess
import sys
import tempfile

# Updated with install-host.sh; both files are pinned by the source commit.
INSTALL_HOST_SHA256 = "b8863ad7ae1f203b8889dcd198536683e599206cd59ad4275fe0930fa41d1009"
PROVISION_SHA256 = "1298d586e8b4a9a802107ba2f438ee88e952795699a52f013863727875b3068f"
HASH = re.compile(r"[a-f0-9]{64}\Z")
STAGED_FILES = {
    '/Library/Partitura/NativeBuild/credential-writer.py': 'credential-writer.py',
    '/Library/Partitura/NativeBuild/broker.py': 'broker.py',
    '/Library/Partitura/NativeBuild/config.json': 'config.json',
    '/Library/Partitura/NativeBuild/authorized_keys': 'authorized_keys',
    '/private/etc/ssh/sshd_config.d/90-partitura-native-build.conf': 'sshd_config',
    '/Library/LaunchDaemons/net.partitura.native-build-maintenance.plist': 'maintenance.plist',
}
TART_TARGET = '/Library/Partitura/NativeBuild/tart.app/Contents/MacOS/tart'
MANIFEST_PATH = Path('/Library/Partitura/NativeBuild/managed-files.json')
CONFIG_PATH = Path('/Library/Partitura/NativeBuild/config.json')
IDENTITY_PATH = Path('/Library/Partitura/NativeBuild/installation.json')
PLIST_TARGET = '/Library/LaunchDaemons/net.partitura.native-build-maintenance.plist'
WRITER_TARGET = '/Library/Partitura/NativeBuild/credential-writer.py'


def verified_payloads(stage: Path, manifest_sha256: str, tart_sha256: str) -> dict[str, bytes]:
    def read(name):
        descriptor = os.open(stage / name, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 2 * 1024 * 1024:
                raise ValueError('unsafe staged payload')
            return stream.read(2 * 1024 * 1024 + 1)
    manifest = read('managed-files.json')
    if hashlib.sha256(manifest).hexdigest() != manifest_sha256:
        raise ValueError('staged manifest differs from the approved pin')
    decoded = json.loads(manifest)
    if set(decoded) != {'schema', 'files'} or decoded['schema'] != 1 or set(decoded['files']) != set(STAGED_FILES) | {TART_TARGET}:
        raise ValueError('staged manifest has an unexpected file set')
    if decoded['files'][TART_TARGET]['sha256'] != tart_sha256:
        raise ValueError('staged manifest differs from the Tart pin')
    payloads = {'managed-files.json': manifest}
    for target, name in STAGED_FILES.items():
        payload = read(name)
        if hashlib.sha256(payload).hexdigest() != decoded['files'][target]['sha256']:
            raise ValueError('staged payload differs from the approved manifest: ' + name)
        payloads[name] = payload
    helper = read('provision.py')
    if hashlib.sha256(helper).hexdigest() != PROVISION_SHA256:
        raise ValueError('staged provision helper differs from the Partitura pin')
    payloads['provision.py'] = helper
    return payloads


def read_installed(path: Path) -> bytes | None:
    if not os.path.lexists(path):
        return None
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unsafe installed state')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 2 * 1024 * 1024:
            raise ValueError('unsafe installed payload')
        return stream.read()


def verify_predecessor(payloads: dict, predecessor: str) -> None:
    manifest_path = MANIFEST_PATH
    manifest = read_installed(manifest_path)
    targets = set(STAGED_FILES) | {TART_TARGET}
    previous = {}
    if manifest is not None:
        decoded = json.loads(manifest)
        previous = decoded['files']
        if set(decoded) != {'schema', 'files'} or decoded['schema'] != 1:
            raise ValueError('invalid installed manifest')
        allowed = (targets, targets - {PLIST_TARGET}, targets - {PLIST_TARGET, WRITER_TARGET})
        if set(previous) not in allowed or (set(previous) != targets and not predecessor) or set(previous) != targets and hashlib.sha256(manifest).hexdigest() != predecessor:
            raise ValueError('installed manifest differs from the approved exact predecessor')
        for target, entry in previous.items():
            path = Path(target)
            for item in (path, *path.parents):
                info = item.lstat()
                if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                    raise ValueError('unsafe installed predecessor')
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            digest = hashlib.sha256()
            with os.fdopen(descriptor, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError('unsafe installed predecessor')
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            if set(entry) != {'sha256', 'mode'} or digest.hexdigest() != entry['sha256'] or stat.S_IMODE(info.st_mode) != entry['mode']:
                raise ValueError('installed predecessor payload differs')
    for target in targets - set(previous):
        if os.path.lexists(target):
            raise ValueError('unexpected unmanaged installation target')


def ensure_identity(config: dict, account: str) -> None:
    path = IDENTITY_PATH
    value = dict(schema=1, account=account, hostId=config['hostId'])
    installed = read_installed(CONFIG_PATH)
    if installed is not None:
        old = json.loads(installed)
        if old.get('hostId', config['hostId']) != config['hostId'] or old['keychainPath'] != f'/Users/{account}/Library/Keychains/login.keychain-db' or any(old[key] != config[key] for key in ('root', 'tartHome')):
            raise ValueError('installed identity/account/runtime roots differ')
    prior = read_installed(path)
    if prior is not None:
        if json.loads(prior) != value:
            raise ValueError('installation identity journal differs')
        return
    missing = []
    current = path.parent
    while not os.path.lexists(current):
        missing.append(current)
        current = current.parent
    for item in (current, *current.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unsafe installation identity ancestor')
    for item in reversed(missing):
        item.mkdir(mode=0o755)
        item.chmod(0o755)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
    with os.fdopen(descriptor, 'w') as stream:
        os.fchmod(stream.fileno(), 0o444)
        stream.write(json.dumps(value, sort_keys=True) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def helper_constant(blob: bytes, name: str) -> str:
    for node in ast.parse(blob).body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError('fixed provision helper unavailable')


@contextlib.contextmanager
def installation_guard(config: dict, account: str, helper: bytes, broker: bytes):
    script = helper_constant(helper, 'INSTALL_GUARD_SCRIPT')
    command = ['/usr/bin/sudo', '--non-interactive', '-H', '-u', account, '/usr/bin/env', '-i', f'HOME=/Users/{account}', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'DEVELOPER_DIR=/Library/Developer/CommandLineTools', '/usr/bin/python3', '-I', '-c', script, config['root'], config['tartHome'], broker.decode(), json.dumps(config)]
    guard = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True, close_fds=True)
    try:
        if not select.select([guard.stdout], [], [], 15)[0] or guard.stdout.readline(64) != b'ready\n':
            raise ValueError('native jobs are busy, fenced or unsafe; drain/reconcile before installation')
        # The installer inherits this write end too. If this root wrapper dies,
        # EOF cannot release the run lock while its transaction is still alive.
        rolled_back = False
        try:
            yield guard.stdin.fileno()
        except InstallationRestored:
            rolled_back = True
        guard.stdin.write(b'abort-restored\n' if rolled_back else b'commit\n')
        guard.stdin.flush()
        guard.stdin.close()
        if guard.wait(timeout=15) != 0:
            raise ValueError('installation readback complete but admission fence remains')
        if rolled_back:
            raise InstallationRestored('installation failed; verified predecessor restored and installer fences removed')
    finally:
        if guard.stdin and not guard.stdin.closed:
            guard.stdin.close()
        try:
            guard.wait(timeout=15)
        except subprocess.TimeoutExpired:
            # A surviving transaction or stalled IO must retain the lock/fence.
            # Never kill its lock owner to make installation look complete.
            print('native host installation guard still owns admission; host inspection required', file=sys.stderr)
        guard.stdout.close()


class InstallationRestored(ValueError):
    pass


def fail(message: str) -> int:
    print(f"partitura native host: {message}", file=sys.stderr)
    return 1


def untrusted_root_interpreter() -> str | None:
    """Name the first interpreter path component root must not execute from."""
    if os.geteuid() != 0:
        return None
    for location in (sys.executable, sys.prefix):
        real = Path(os.path.realpath(location))
        for item in (real, *real.parents):
            metadata = item.lstat()
            if metadata.st_uid != 0 or metadata.st_mode & 0o022:
                return str(item)
    return None


def root_scratch_directory() -> Path:
    # sudo may preserve the administrator's HOME. Root staging must use the
    # root account's own directory, never an environment-selected home.
    root_home = Path(pwd.getpwuid(0).pw_dir).resolve(strict=True)
    scratch = root_home / "dev/agentic-scratchpads/partitura/native-host/root-installer"
    missing: list[Path] = []
    current = scratch
    while not current.exists():
        missing.append(current)
        current = current.parent
    metadata = current.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
        raise OSError(f"unsafe root scratch ancestor: {current}")
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
    current = scratch
    while True:
        metadata = current.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise OSError(f"unsafe root scratch directory: {current}")
        if current == current.parent:
            break
        current = current.parent
    return scratch


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--tart-sha256", required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--predecessor-manifest-sha256", default='')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,30}", args.account):
        return fail("invalid configured host account")
    if not HASH.fullmatch(args.tart_sha256) or not HASH.fullmatch(args.manifest_sha256) or not HASH.fullmatch(INSTALL_HOST_SHA256):
        return fail("installer pins are incomplete")
    if args.predecessor_manifest_sha256 and not HASH.fullmatch(args.predecessor_manifest_sha256):
        return fail('invalid predecessor manifest pin')
    if os.uname().sysname != "Darwin":
        return fail("host installation requires macOS")
    unsafe = untrusted_root_interpreter()
    if unsafe is not None:
        return fail(f"root Python interpreter is not root-owned and protected: {unsafe}")
    stage = args.stage
    try:
        info = stage.lstat()
        if not stage.is_absolute() or stage.resolve() != stage:
            return fail("stage path must be absolute and contain no symlink")
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700:
            return fail("stage directory must be mode 0700")
        if os.geteuid() == 0:
            for ancestor in (stage, *stage.parents):
                metadata = ancestor.lstat()
                if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
                    return fail("root stage requires protected root-owned ancestors")
        if os.geteuid() != 0 and info.st_uid != os.getuid():
            return fail("stage directory must belong to the caller")
        installer = stage / "install-host.sh"
        source = installer.lstat()
        if not stat.S_ISREG(source.st_mode) or source.st_uid != info.st_uid or source.st_mode & 0o022:
            return fail("staged installer has unsafe ownership or mode")
        descriptor = os.open(installer, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino, opened.st_uid) != (source.st_dev, source.st_ino, source.st_uid):
                return fail("staged installer changed while being opened")
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                payload = stream.read()
        finally:
            os.close(descriptor)
        if hashlib.sha256(payload).hexdigest() != INSTALL_HOST_SHA256:
            return fail("staged host installer differs from the Partitura pin")
        payloads = verified_payloads(stage, args.manifest_sha256, args.tart_sha256)
    except (OSError, ValueError, KeyError, TypeError) as error:
        return fail(f"cannot read staged installer: {error}")
    if args.check:
        print("partitura native host: pinned installer verified; apply not requested")
        return 0
    if os.geteuid() != 0:
        return fail("--apply requires root privileges")
    try:
        original_manifest = read_installed(MANIFEST_PATH)
        verify_predecessor(payloads, args.predecessor_manifest_sha256)
        config = json.loads(payloads['config.json'])
        if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', config['hostId']) or config['profile'] not in ('legacy', 'registry-only'):
            raise ValueError('invalid sealed broker identity/profile')
        ensure_identity(config, args.account)
    except (OSError, ValueError, KeyError, TypeError) as error:
        return fail(f'cannot validate installed predecessor: {error}')
    try:
        scratch = root_scratch_directory()
    except OSError as error:
        return fail(f"cannot prepare private root scratch directory: {error}")
    with tempfile.TemporaryDirectory(prefix="partitura-native-host-", dir=scratch) as temporary:
        root_script = Path(temporary) / "install-host.sh"
        root_script.write_bytes(payload)
        os.chmod(root_script, 0o500)
        root_stage = Path(temporary) / 'payload'
        root_stage.mkdir(mode=0o700)
        for name, contents in payloads.items():
            target = root_stage / name
            target.write_bytes(contents)
            target.chmod(0o600)
        subprocess.run(['/usr/bin/ditto', '--rsrc', str(stage / 'tart.app'), str(root_stage / 'tart.app')], check=True)
        try:
            with installation_guard(config, args.account, payloads['provision.py'], payloads['broker.py']) as guard_fd:
                result = subprocess.run(["/bin/bash", str(root_script), str(root_stage), args.tart_sha256, args.account], pass_fds=(guard_fd,), check=False)
                if result.returncode == 75:
                    if read_installed(MANIFEST_PATH) != original_manifest:
                        raise ValueError('rollback changed the predecessor manifest; admission remains fenced')
                    verify_predecessor(payloads, args.predecessor_manifest_sha256)
                    raise InstallationRestored()
                result.check_returncode()
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            return fail(f'host installation did not complete: {error}')
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
