#!/usr/bin/python3
"""Run Partitura's hash-pinned macOS host installer from a staged directory."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile

# Updated with install-host.sh; both files are pinned by the source commit.
INSTALL_HOST_SHA256 = "65f93ca9b8fc59f0659ad568195e5519aac38969ca15d2bd4631bf1b2448ba0a"
HASH = re.compile(r"[a-f0-9]{64}\Z")
STAGED_FILES = {
    '/Library/Partitura/NativeBuild/broker.py': 'broker.py',
    '/Library/Partitura/NativeBuild/config.json': 'config.json',
    '/Library/Partitura/NativeBuild/authorized_keys': 'authorized_keys',
    '/private/etc/ssh/sshd_config.d/90-partitura-native-build.conf': 'sshd_config',
}
TART_TARGET = '/Library/Partitura/NativeBuild/tart.app/Contents/MacOS/tart'


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
    return payloads


def fail(message: str) -> int:
    print(f"partitura native host: {message}", file=sys.stderr)
    return 1


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
    while current != root_home:
        metadata = current.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise OSError(f"unsafe root scratch directory: {current}")
        current = current.parent
    return scratch


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", type=Path, required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--tart-sha256", required=True)
    parser.add_argument("--manifest-sha256", required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,30}", args.account):
        return fail("invalid configured host account")
    if not HASH.fullmatch(args.tart_sha256) or not HASH.fullmatch(args.manifest_sha256) or not HASH.fullmatch(INSTALL_HOST_SHA256):
        return fail("installer pins are incomplete")
    if os.uname().sysname != "Darwin":
        return fail("host installation requires macOS")
    stage = args.stage
    try:
        info = stage.lstat()
        if not stage.is_absolute() or stage.resolve() != stage:
            return fail("stage path must be absolute and contain no symlink")
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700:
            return fail("stage directory must be mode 0700")
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
        result = subprocess.run(
            ["/bin/bash", str(root_script), str(root_stage), args.tart_sha256, args.account],
            check=False,
        )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
