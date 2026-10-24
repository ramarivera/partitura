#!/usr/bin/env python3
"""Install hash-pinned Firecracker assets without package or firewall changes.

The operator supplies reviewed guest artifact SHA-256 pins. This installer owns
only firecracker-managed-files.json; the broker/Sysbox manifest stays separate.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import urllib.request

VERSION = "1.17.0"
RELEASE_URL = f"https://github.com/firecracker-microvm/firecracker/releases/download/v{VERSION}/firecracker-v{VERSION}-x86_64.tgz"
RELEASE_SHA256 = "06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558"
BINARY_HASHES = {
    "firecracker": "99ad0f5cd0514a88aad0e9ae8cfdb3cc3b4ab9d190e1194602406c786b5de7a5",
    "jailer": "65ef226e96f0ceda55ba643f445801ef2cc0ea667ef67cad8ac4f406c9c8434f",
}
MANIFEST = Path("/usr/lib/partitura-sandbox/firecracker-managed-files.json")
SFTP_ROOT = Path("/opt/partitura-sandbox/sftp-root")
STATE_DIRS = (Path("/var/lib/partitura-sandbox"), Path("/var/lib/partitura-vms"))
HASH = re.compile(r"[a-f0-9]{64}\Z")


class InstallError(ValueError):
    pass


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verified(path: Path, pin: str) -> Path:
    if not HASH.fullmatch(pin):
        raise InstallError("artifact SHA-256 must be 64 lowercase hex characters")
    if not stat.S_ISREG(path.lstat().st_mode) or digest(path) != pin:
        raise InstallError(f"artifact is unsafe or differs from its SHA-256 pin: {path}")
    return path


def release_binaries(archive: Path) -> dict[str, bytes]:
    verified(archive, RELEASE_SHA256)
    result = {}
    with tarfile.open(archive, "r:gz") as release:
        for name in ("firecracker", "jailer"):
            expected = f"release-v{VERSION}-x86_64/{name}-v{VERSION}-x86_64"
            members = [entry for entry in release.getmembers() if entry.name == expected]
            if len(members) != 1 or not members[0].isfile() or members[0].size > 64 * 1024 * 1024:
                raise InstallError(f"release has no unique regular executable: {expected}")
            result[name] = release.extractfile(members[0]).read()
            if hashlib.sha256(result[name]).hexdigest() != BINARY_HASHES[name]:
                raise InstallError(f"release executable differs from its SHA-256 pin: {name}")
    return result


def safe_directory(path: Path, *, uid: int, create: bool = False, mode: int = 0o755) -> None:
    """Reject links and writable parents, including parents outside a test root."""
    if path.parent != path:
        safe_directory(path.parent, uid=uid, create=False)
    if create and not path.exists():
        path.mkdir(mode=mode)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, uid} or info.st_mode & 0o022:
        raise InstallError(f"directory must be owned by uid {uid} and not writable by others: {path}")


def sftp_files(binary: Path, *, uid: int = 0, run=subprocess.run) -> dict[Path, Path]:
    if not binary.is_absolute():
        raise InstallError("SFTP executable path must be absolute")
    safe_directory(binary.parent, uid=uid)
    info = binary.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
        raise InstallError("SFTP server must be a trusted regular system executable")
    result = {SFTP_ROOT / str(binary).lstrip("/"): binary}
    output = run(["/usr/bin/ldd", str(binary)], check=True, capture_output=True, text=True).stdout
    if "not found" in output:
        raise InstallError("SFTP server has an unresolved shared library")
    for name in re.findall(r"(?:^|\s)(/[^\s()]+)", output):
        requested = Path(name)
        # System loaders/libraries may be symlinks. Copy their verified resolved
        # regular bytes to the exact runtime path inside the symlink-free jail.
        source = requested.resolve(strict=True)
        safe_directory(source.parent, uid=uid)
        info = source.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
            raise InstallError(f"untrusted SFTP dependency: {source}")
        result[SFTP_ROOT / str(requested).lstrip("/")] = source
    return result


def load_manifest(root: Path, *, uid: int) -> dict:
    path = root / MANIFEST.relative_to("/")
    if not path.exists() and not path.is_symlink():
        return {}
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o444:
        raise InstallError("unsafe Firecracker installation manifest")
    contents = json.loads(path.read_bytes())
    if not isinstance(contents, dict):
        raise InstallError("invalid Firecracker installation manifest")
    for name, record in contents.items():
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or str(relative) != name:
            raise InstallError("unsafe Firecracker manifest path")
        target = root / name
        safe_directory(target.parent, uid=uid)
        info = target.lstat()
        if not isinstance(record, dict) or set(record) != {"sha256", "mode"}:
            raise InstallError("invalid Firecracker manifest entry")
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != uid
            or stat.S_IMODE(info.st_mode) != record["mode"]
            or info.st_mode & 0o022 or digest(target) != record["sha256"]):
            raise InstallError(f"installed Firecracker file differs from manifest: {target}")
    return contents


def check_sftp_tree(root: Path, names, *, uid: int) -> None:
    jail = root / SFTP_ROOT.relative_to("/")
    if not jail.exists() and not jail.is_symlink():
        return
    allowed = {root / name for name in names if (root / name).is_relative_to(jail)}
    allowed.add(jail / "workspace")
    for path in tuple(allowed):
        allowed.update(parent for parent in path.parents if parent.is_relative_to(jail))
    safe_directory(jail, uid=uid)
    for path in jail.rglob("*"):
        info = path.lstat()
        if (path not in allowed or stat.S_ISLNK(info.st_mode) or info.st_uid != uid
                or info.st_mode & 0o022):
            raise InstallError(f"unmanaged or unsafe file in minimal SFTP jail: {path}")


def check_host(kernel_hash: str, rootfs_hash: str, sftp: Path, *, root: Path = Path("/"),
               uid: int = 0, run=subprocess.run) -> bool:
    """Read-only comparison, so repeated managed applies need no elevation."""
    for pin in (kernel_hash, rootfs_hash):
        if not HASH.fullmatch(pin):
            raise InstallError("artifact SHA-256 must be 64 lowercase hex characters")
    manifest = load_manifest(root, uid=uid)
    if not manifest:
        return False
    expected = {
        str((Path("/usr/local/bin") / name).relative_to("/")): {"sha256": pin, "mode": 0o555}
        for name, pin in BINARY_HASHES.items()
    }
    expected["opt/partitura-sandbox/vmlinux"] = {"sha256": kernel_hash, "mode": 0o444}
    expected["opt/partitura-sandbox/rootfs.ext4"] = {"sha256": rootfs_hash, "mode": 0o444}
    expected.update({str(target.relative_to("/")): {"sha256": digest(source), "mode": 0o555}
                     for target, source in sftp_files(sftp, uid=uid, run=run).items()})
    check_sftp_tree(root, set(manifest) | set(expected), uid=uid)
    if manifest != expected:
        return False
    for absolute in (*STATE_DIRS, SFTP_ROOT / "workspace"):
        target = root / absolute.relative_to("/")
        if not target.exists():
            return False
        safe_directory(target, uid=uid)
        if absolute in STATE_DIRS and stat.S_IMODE(target.stat().st_mode) != 0o700:
            raise InstallError(f"state directory must have mode 0700: {target}")
    return True


def install(archive: Path, kernel: Path, kernel_hash: str, rootfs: Path,
            rootfs_hash: str, sftp: Path, *, root: Path = Path("/"), uid: int = 0,
            run=subprocess.run) -> bool:
    """Return True only when bytes or state directories changed."""
    if os.geteuid() != uid:
        raise InstallError("host installation must run as the target files' owner")
    payloads: dict[Path, tuple[bytes | Path, int]] = {
        Path("/usr/local/bin") / name: (blob, 0o555)
        for name, blob in release_binaries(archive).items()
    }
    payloads[Path("/opt/partitura-sandbox/vmlinux")] = (verified(kernel, kernel_hash), 0o444)
    payloads[Path("/opt/partitura-sandbox/rootfs.ext4")] = (verified(rootfs, rootfs_hash), 0o444)
    payloads.update({target: (source, 0o555) for target, source in sftp_files(sftp, uid=uid, run=run).items()})
    lock_parent = root / "run"
    safe_directory(lock_parent, uid=uid)
    descriptor = os.open(lock_parent / "partitura-firecracker-install.lock", os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o600:
            raise InstallError("unsafe Firecracker installer lock")
        fcntl.flock(lock, fcntl.LOCK_EX)
        old = load_manifest(root, uid=uid)
        desired = {}
        changes = []
        for absolute, (source, mode) in payloads.items():
            relative = str(absolute.relative_to("/"))
            record = {"sha256": hashlib.sha256(source).hexdigest() if isinstance(source, bytes) else digest(source), "mode": mode}
            if absolute == Path("/opt/partitura-sandbox/vmlinux"):
                record["sha256"] = kernel_hash
            elif absolute == Path("/opt/partitura-sandbox/rootfs.ext4"):
                record["sha256"] = rootfs_hash
            desired[relative] = record
            target = root / relative
            if target.exists() or target.is_symlink():
                if relative not in old:
                    raise InstallError(f"refusing to replace unmanaged file: {target}")
                if old[relative] == record:
                    continue
            changes.append((target, source, mode))
        check_sftp_tree(root, set(old) | set(desired), uid=uid)
        # Do not delete obsolete files automatically. This catches dependency
        # changes which need an explicit operator migration of the minimal jail.
        if set(old) - set(desired):
            raise InstallError("obsolete managed files require an explicit reviewed migration")
        directories = {SFTP_ROOT / "workspace": 0o755, **{path: 0o700 for path in STATE_DIRS}}
        directories.update({absolute.parent: 0o755 for absolute in [*payloads, MANIFEST]})
        changed = bool(changes)
        for absolute, mode in sorted(directories.items(), key=lambda item: len(item[0].parts)):
            target = root / absolute.relative_to("/")
            missing = []
            parent = target
            while not parent.exists() and not parent.is_symlink():
                missing.append(parent)
                parent = parent.parent
            safe_directory(parent, uid=uid)
            for parent in reversed(missing):
                parent.mkdir(mode=mode if parent == target else 0o755)
                changed = True
            safe_directory(target, uid=uid)
            if absolute in STATE_DIRS and stat.S_IMODE(target.stat().st_mode) != mode:
                raise InstallError(f"state directory must have mode 0700: {target}")
        if not changed:
            return False
        manifest = (json.dumps(desired, indent=2, sort_keys=True) + "\n").encode()
        changes.append((root / MANIFEST.relative_to("/"), manifest, 0o444))
        staged = []
        backups = []
        try:
            for target, source, mode in changes:
                fd, temporary = tempfile.mkstemp(prefix=".partitura-install-", dir=target.parent)
                staged.append((target, Path(temporary)))
                with os.fdopen(fd, "wb") as output:
                    if isinstance(source, bytes):
                        output.write(source)
                    else:
                        with source.open("rb") as input_stream:
                            shutil.copyfileobj(input_stream, output, 1024 * 1024)
                    output.flush()
                    os.fchmod(output.fileno(), mode)
                    os.fsync(output.fileno())
                relative = str(target.relative_to(root))
                expected = desired.get(relative)
                if expected is not None and digest(Path(temporary)) != expected["sha256"]:
                    raise InstallError(f"artifact changed while staging: {source}")
            for target, temporary in staged:
                backup = None
                if target.exists():
                    fd, backup_name = tempfile.mkstemp(prefix=".partitura-previous-", dir=target.parent)
                    os.close(fd)
                    backup = Path(backup_name)
                    os.replace(target, backup)
                backups.append((target, backup))
                os.replace(temporary, target)
        except BaseException:
            for target, backup in reversed(backups):
                target.unlink(missing_ok=True)
                if backup is not None:
                    os.replace(backup, target)
            raise
        finally:
            for _, temporary in staged:
                temporary.unlink(missing_ok=True)
            for _, backup in backups:
                if backup is not None:
                    backup.unlink(missing_ok=True)
        load_manifest(root, uid=uid)
        return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", type=Path, help="Download the pinned Firecracker archive to this new file, then exit")
    parser.add_argument("--check", action="store_true", help="Read-only verification; exit 2 if installation or update is needed")
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--kernel", type=Path)
    parser.add_argument("--kernel-sha256")
    parser.add_argument("--rootfs", type=Path)
    parser.add_argument("--rootfs-sha256")
    parser.add_argument("--sftp-server", type=Path, default=Path("/usr/lib/ssh/sftp-server"))
    arguments = parser.parse_args()
    if arguments.download:
        try:
            with urllib.request.urlopen(RELEASE_URL, timeout=120) as response:
                payload = response.read(128 * 1024 * 1024 + 1)
            if len(payload) > 128 * 1024 * 1024 or hashlib.sha256(payload).hexdigest() != RELEASE_SHA256:
                raise InstallError("Firecracker download differs from the reviewed release SHA-256")
            with arguments.download.open("xb") as output:
                output.write(payload)
            return 0
        except (OSError, InstallError) as error:
            parser.exit(1, f"{error}\n")
    if arguments.check:
        if not arguments.kernel_sha256 or not arguments.rootfs_sha256:
            parser.error("--check requires --kernel-sha256 and --rootfs-sha256")
        try:
            return 0 if check_host(arguments.kernel_sha256, arguments.rootfs_sha256, arguments.sftp_server) else 2
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            parser.exit(1, f"{error}\n")
    if not all((arguments.archive, arguments.kernel, arguments.kernel_sha256, arguments.rootfs, arguments.rootfs_sha256)):
        parser.error("installation requires --archive, --kernel, --kernel-sha256, --rootfs, --rootfs-sha256")
    try:
        changed = install(arguments.archive, arguments.kernel, arguments.kernel_sha256,
                          arguments.rootfs, arguments.rootfs_sha256, arguments.sftp_server)
        print("Firecracker host assets installed and verified" if changed else "Firecracker host assets already match the reviewed pins")
    except (OSError, ValueError, subprocess.SubprocessError, tarfile.TarError) as error:
        parser.exit(1, f"{error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
