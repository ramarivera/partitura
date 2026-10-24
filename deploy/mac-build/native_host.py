#!/usr/bin/python3
"""Run Partitura's hash-pinned macOS host installer from a staged directory."""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

# Updated with install-host.sh; both files are pinned by the source commit.
INSTALL_HOST_SHA256 = "e615fe959a2cb49f571b3b94939a4d612e0d03e9de3e7fd946b36f563f6bf71e"
HASH = re.compile(r"[a-f0-9]{64}\Z")


def fail(message: str) -> int:
    print(f"partitura native host: {message}", file=sys.stderr)
    return 1


def root_scratch_directory() -> Path:
    root_home = Path.home().resolve(strict=True)
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
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,30}", args.account):
        return fail("invalid configured host account")
    if not HASH.fullmatch(args.tart_sha256) or not HASH.fullmatch(INSTALL_HOST_SHA256):
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
    except OSError as error:
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
        result = subprocess.run(
            ["/bin/bash", str(root_script), str(stage), args.tart_sha256, args.account],
            check=False,
        )
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
