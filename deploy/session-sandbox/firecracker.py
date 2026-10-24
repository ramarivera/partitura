"""Broker-owned Firecracker lifecycle. No guest NIC or host filesystem mounts.

Only root-owned metadata selects a runtime. VMMs run in separate systemd units
with session UIDs, private networking, bounded resources and access to KVM only.
"""
from __future__ import annotations

import asyncio
import ctypes
import errno
import fcntl
import hashlib
import json
import os
import pwd
import stat
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import time
from typing import Any

STATE_ROOT = Path(os.environ.get("PARTITURA_SANDBOX_STATE_ROOT", "/var/lib/partitura-sandbox"))
VM_ROOT = Path(os.environ.get("PARTITURA_FIRECRACKER_VM_ROOT", "/var/lib/partitura-vms"))
BINARY = os.environ.get("PARTITURA_FIRECRACKER_BINARY", "/usr/local/bin/firecracker")
KERNEL = os.environ.get("PARTITURA_FIRECRACKER_KERNEL", "/opt/partitura-sandbox/vmlinux")
ROOTFS = os.environ.get("PARTITURA_FIRECRACKER_ROOTFS", "/opt/partitura-sandbox/rootfs.ext4")
MEMORY_MIB = int(os.environ.get("PARTITURA_FIRECRACKER_MEMORY_MIB", "4096"))
VCPUS = int(os.environ.get("PARTITURA_FIRECRACKER_VCPUS", "2"))
MAX_DISK_BYTES = int(os.environ.get("PARTITURA_FIRECRACKER_MAX_DISK_BYTES", str(32 * 1024**3)))
GUEST_PORT = 52


def key(session: str) -> str:
    return hashlib.sha256(session.encode()).hexdigest()[:24]


def state_path(session: str) -> Path:
    return STATE_ROOT / (key(session) + ".json")


def load(session: str) -> dict[str, Any] | None:
    path = state_path(session)
    try:
        record = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    if record.get("sessionId") != session or record.get("runtime") not in ("firecracker", "sysbox"):
        raise ValueError("sandbox lifecycle record is invalid")
    return record


def save(session: str, record: dict[str, Any]) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = state_path(session)
    temporary = path.with_suffix(".new")
    with open(temporary, "w", opener=lambda p, f: os.open(p, f | os.O_NOFOLLOW, 0o600)) as output:
        json.dump(record, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


class SessionLock:
    """Cross-request serialization across socket-activated broker instances."""
    def __init__(self, session: str):
        STATE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.file = (STATE_ROOT / (key(session) + ".lock")).open("a")

    def __enter__(self):
        fcntl.flock(self.file, fcntl.LOCK_EX)
        return self

    def __exit__(self, *_):
        self.file.close()


def run(args: list[str], timeout: int = 60) -> str:
    result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout)
    return result.stdout.strip()


def unit(session: str) -> str:
    return "partitura-vm-" + key(session) + ".service"


def running(session: str) -> bool:
    result = subprocess.run(["/usr/bin/systemctl", "is-active", "--quiet", unit(session)], capture_output=True, timeout=10)
    return result.returncode == 0


def copy_rootfs(destination: Path) -> None:
    run(["/usr/bin/cp", "--reflink=auto", "--sparse=always", ROOTFS, str(destination)], timeout=180)
    # Installed base images are immutable. cp preserves their readonly mode;
    # the private writable copy must allow its VMM uid to open it read/write.
    os.chmod(destination, 0o600)


def provision(session: str, worker_uid: str, workspace: Path) -> dict[str, Any]:
    if not 128 <= MEMORY_MIB <= 32768 or not 1 <= VCPUS <= 16:
        raise ValueError("Firecracker memory or CPU bounds are invalid")
    for path in (Path(BINARY), Path(KERNEL), Path(ROOTFS)):
        if not path.is_file() or path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022:
            raise ValueError("Firecracker binary, kernel and rootfs must be installed regular files")
    if not Path("/dev/kvm").exists():
        raise ValueError("Firecracker requires /dev/kvm")
    if not 1 <= Path(ROOTFS).stat().st_size <= MAX_DISK_BYTES:
        raise ValueError("Firecracker rootfs exceeds the configured disk limit")
    if any(character in str(workspace) for character in " \t\r\n:\\"):
        raise ValueError("workspace path cannot contain systemd mount delimiters")
    directory = VM_ROOT / key(session)
    if directory.exists():
        raise ValueError("Firecracker state already exists; recover or destroy it first")
    directory.mkdir(parents=True, mode=0o700)
    record = {"sessionId": session, "runtime": "firecracker", "workerUid": worker_uid,
              "workspaceHost": str(workspace), "token": secrets.token_hex(32)}
    # Publish ownership before allocating resources, so failed starts are removable.
    save(session, record)
    copy_rootfs(directory / "rootfs.ext4")
    config_directory = directory / "config-seed"
    config_directory.mkdir(mode=0o700)
    (config_directory / "config.json").write_text(json.dumps({"token": record["token"], "workerUid": worker_uid}))
    os.chmod(config_directory / "config.json", 0o400)
    with (directory / "config.ext4").open("wb") as disk:
        disk.truncate(4 * 1024 * 1024)
    run(["/usr/bin/mkfs.ext4", "-q", "-F", "-d", str(config_directory), str(directory / "config.ext4")])
    shutil.rmtree(config_directory)
    os.chmod(directory / "rootfs.ext4", 0o600)
    os.chmod(directory / "config.ext4", 0o400)
    for artifact in directory.iterdir():
        os.chown(artifact, int(worker_uid), int(worker_uid))
    os.chown(directory, int(worker_uid), int(worker_uid))
    start(session)
    return record


def write_machine(session: str) -> None:
    machine = {"boot-source": {"kernel_image_path": KERNEL,
                              "boot_args": "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/sbin/partitura-init"},
               "drives": [{"drive_id": "rootfs", "path_on_host": "/run/partitura-vm/rootfs.ext4", "is_root_device": True, "is_read_only": False},
                          {"drive_id": "config", "path_on_host": "/run/partitura-vm/config.ext4", "is_root_device": False, "is_read_only": True}],
               "machine-config": {"vcpu_count": VCPUS, "mem_size_mib": MEMORY_MIB},
               "vsock": {"guest_cid": 3, "uds_path": "/run/partitura-vm/v.sock"}}
    config_path = STATE_ROOT / (key(session) + ".machine.json")
    with open(config_path, "w", opener=lambda p, f: os.open(p, f | os.O_NOFOLLOW, 0o600)) as output:
        json.dump(machine, output)
    os.chmod(config_path, 0o644)  # No secrets; readable only through the private readonly bind.


def start(session: str) -> None:
    directory = VM_ROOT / key(session)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("Firecracker state directory must be a real directory")
    for name in ("rootfs.ext4", "config.ext4"):
        path = directory / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 1 <= info.st_size <= MAX_DISK_BYTES:
            raise ValueError("Firecracker disks must be bounded regular files without hardlinks")
    try:
        pwd.getpwuid(int(load(session)["workerUid"]))
    except KeyError:
        pass
    else:
        raise ValueError("Firecracker worker uid must not match a host account")
    write_machine(session)
    for path in directory.glob("v.sock*"):
        path.unlink()
    # Transient service survives its individual socket request, but has a
    # single stable owner for stop/recovery. No network device is configured.
    subprocess.run(["/usr/bin/systemctl", "reset-failed", unit(session)], capture_output=True, timeout=10)
    run(["/usr/bin/systemd-run", "--quiet", "--collect", "--service-type=exec", "--unit", unit(session),
         "--property=BindPaths=" + str(directory) + ":/run/partitura-vm",
         "--property=ReadWritePaths=/run/partitura-vm",
         "--property=BindReadOnlyPaths=" + str(STATE_ROOT / (key(session) + ".machine.json")) + ":/run/partitura-vm-machine.json", "--property=UMask=0077", "--property=PrivateNetwork=yes",
         "--property=PrivateTmp=yes", "--property=ProtectSystem=strict", "--property=ProtectHome=yes",
         "--property=NoNewPrivileges=yes", "--property=CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETPCAP", "--property=DevicePolicy=closed",
         "--property=DeviceAllow=/dev/kvm rw", "--property=RestrictAddressFamilies=AF_UNIX",
         "--property=ProtectProc=invisible", "--property=ProcSubset=pid",
         "--property=InaccessiblePaths=/root /home",
         "--property=ProtectKernelTunables=yes", "--property=ProtectKernelModules=yes", "--property=ProtectControlGroups=yes",
         "--property=TasksMax=128", "--property=MemoryMax=" + str(MEMORY_MIB + 256) + "M",
         "--property=CPUQuota=" + str(VCPUS * 100) + "%", "--property=TimeoutStopSec=15s",
         "--setenv=PARTITURA_SANDBOX_STATE_ROOT=" + str(STATE_ROOT),
         "--setenv=PARTITURA_FIRECRACKER_BINARY=" + BINARY,
         "/usr/bin/python3", "-I", "-S", str(Path(__file__).resolve()), "--vmm-exec", session])


def destroy(session: str) -> None:
    workspace_unit = "partitura-workspace-" + key(session) + ".service"
    stopped = subprocess.run(["/usr/bin/systemctl", "stop", workspace_unit], capture_output=True, text=True, timeout=30)
    if stopped.returncode != 0 and "not loaded" not in stopped.stderr:
        raise RuntimeError("workspace server stop failed; retry teardown")
    result = subprocess.run(["/usr/bin/systemctl", "stop", unit(session)], capture_output=True, text=True, timeout=30)
    if result.returncode != 0 and "not loaded" not in result.stderr:
        raise RuntimeError("Firecracker stop failed; retry teardown")
    if running(session):
        raise RuntimeError("Firecracker is still running; retry teardown")
    directory = VM_ROOT / key(session)
    # VMM-owned files are untrusted. shutil.rmtree is descriptor-based on Linux.
    if directory.is_symlink():
        raise ValueError("Firecracker state directory must not be a symlink")
    if directory.exists():
        shutil.rmtree(directory)
    jail = sftp_jail(session)
    if jail.exists():
        shutil.rmtree(jail)
    (STATE_ROOT / (key(session) + ".machine.json")).unlink(missing_ok=True)
    state_path(session).unlink(missing_ok=True)


async def connect(record: dict[str, Any], request: dict[str, Any]):
    path = str(VM_ROOT / key(record["sessionId"]) / "v.sock")
    reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(path), 5)
    try:
        writer.write(f"CONNECT {GUEST_PORT}\n".encode())
        await writer.drain()
        if not (await asyncio.wait_for(reader.readline(), 5)).startswith(b"OK "):
            raise RuntimeError("Firecracker vsock connection refused")
        writer.write((json.dumps({**request, "token": record["token"]}) + "\n").encode())
        await writer.drain()
        return reader, writer
    except BaseException:
        writer.close()
        await writer.wait_closed()
        raise


async def command(record: dict[str, Any], request: dict[str, Any]) -> dict[str, Any]:
    reader, writer = await connect(record, request)
    try:
        response = json.loads(await asyncio.wait_for(reader.readline(), 10))
        if not isinstance(response, dict) or response.get("ok") is not True:
            raise RuntimeError("Firecracker guest command failed")
        return response
    finally:
        writer.close()
        await writer.wait_closed()


def stop_for_recovery(record: dict[str, Any]) -> None:
    session = record["sessionId"]
    if not running(session):
        return
    asyncio.run(command(record, {"operation": "shutdown"}))
    deadline = time.monotonic() + 45
    while running(session):
        if time.monotonic() >= deadline:
            raise RuntimeError("Firecracker graceful shutdown timed out; ownership retained")
        time.sleep(0.1)


async def ready(record: dict[str, Any]) -> None:
    for _ in range(120):
        if not await asyncio.to_thread(running, record["sessionId"]):
            raise RuntimeError("Firecracker VM exited during startup")
        try:
            await command(record, {"operation": "ping"})
            return
        except (OSError, ValueError, RuntimeError, TimeoutError):
            await asyncio.sleep(0.5)
    raise RuntimeError("Firecracker guest did not become ready")

SFTP_ROOT = os.environ.get("PARTITURA_FIRECRACKER_SFTP_ROOT", "/opt/partitura-sandbox/sftp-root")
SFTP_BINARY = os.environ.get("PARTITURA_FIRECRACKER_SFTP_BINARY", "/usr/lib/ssh/sftp-server")
WORKSPACE_PORT = 1080


def sftp_jail(session: str) -> Path:
    return STATE_ROOT / (key(session) + ".sftp-root")


def share_sftp_file(source: str, destination: str) -> str:
    try:
        os.link(source, destination)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        shutil.copy2(source, destination)
    return destination


def prepare_sftp_jail(session: str) -> None:
    record = load(session)
    if record is None or record["runtime"] != "firecracker":
        raise ValueError("workspace session is not owned")
    uid = int(record["workerUid"])
    jail = sftp_jail(session)
    if jail.is_symlink():
        raise ValueError("SFTP session jail must not be a symlink")
    if jail.exists():
        shutil.rmtree(jail)
    # The immutable binary/library files can be shared by hardlink. Namespace
    # mounts expose this root read-only and only /workspace is writable.
    if (Path(SFTP_ROOT) / "etc").exists():
        raise ValueError("SFTP base jail must not contain account configuration")
    shutil.copytree(SFTP_ROOT, jail, copy_function=share_sftp_file)
    etc = jail / "etc"
    etc.mkdir(mode=0o755, exist_ok=True)
    os.chmod(etc, 0o755)  # Broker UMask=0077 must not block the session uid.
    # OpenSSH requires getpwuid even for a keyless, stdio-only SFTP server.
    # This private NSS record never changes host accounts or SSH settings.
    (etc / "passwd").write_text(f"partitura:x:{uid}:{uid}:Partitura session:/workspace:/sbin/nologin\n")
    (etc / "group").write_text(f"partitura:x:{uid}:\n")
    os.chmod(etc / "passwd", 0o644)
    os.chmod(etc / "group", 0o644)
    # OpenSSH opens /dev/null before serving even in stdio mode. systemd binds
    # its private null device here; no host device tree enters the jail.
    (jail / "dev").mkdir(mode=0o755)
    os.chmod(jail / "dev", 0o755)
    (jail / "dev/null").touch(mode=0o600)


def start_workspace(session: str) -> None:
    root = Path(SFTP_ROOT)
    if not root.is_dir() or root.is_symlink() or root.stat().st_uid != 0 or root.stat().st_mode & 0o022:
        raise ValueError("SFTP root must be a root-owned non-writable directory")
    for path in root.rglob("*"):
        if path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022:
            raise ValueError("SFTP root contains unsafe files")
    if not (root / SFTP_BINARY.lstrip("/")).is_file() or not (root / "workspace").is_dir():
        raise ValueError("SFTP root requires its server binary and workspace mountpoint")
    prepare_sftp_jail(session)
    run(["/usr/bin/systemd-run", "--quiet", "--collect", "--service-type=exec",
         "--unit", "partitura-workspace-" + key(session) + ".service",
         "--property=BindsTo=" + unit(session), "--property=After=" + unit(session),
         "--setenv=PARTITURA_SANDBOX_STATE_ROOT=" + str(STATE_ROOT),
         "--setenv=PARTITURA_FIRECRACKER_VM_ROOT=" + str(VM_ROOT),
         "--setenv=PARTITURA_FIRECRACKER_SFTP_ROOT=" + SFTP_ROOT,
         "--setenv=PARTITURA_FIRECRACKER_SFTP_BINARY=" + SFTP_BINARY,
         "--property=PrivateNetwork=yes", "--property=NoNewPrivileges=yes",
         "--property=ProtectSystem=strict", "--property=ProtectHome=yes",
         "--property=ReadWritePaths=" + str(VM_ROOT / key(session)),
         "--property=RestrictAddressFamilies=AF_UNIX", "--property=MemoryMax=128M", "--property=TasksMax=128",
         "/usr/bin/python3", str(Path(__file__).resolve()), "--workspace-server", session])


async def pipe(reader, writer) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        try:
            writer.write_eof()
        except (AttributeError, OSError, RuntimeError):
            pass


def sftp_command(record: dict[str, Any], service: str) -> list[str]:
    session = record["sessionId"]
    jail = str(sftp_jail(session))
    return [
        "/usr/bin/systemd-run", "--quiet", "--pipe", "--wait", "--collect",
        "--service-type=exec", "--unit", service,
        "--property=BindsTo=" + "partitura-workspace-" + key(session) + ".service",
        "--property=After=" + "partitura-workspace-" + key(session) + ".service",
        "--property=BindPaths=" + record["workspaceHost"] + ":" + jail + "/workspace",
        "--property=BindReadOnlyPaths=/dev/null:" + jail + "/dev/null",
        "--property=PrivateNetwork=yes", "--property=PrivateDevices=yes",
        "--property=NoNewPrivileges=yes", "--property=CapabilityBoundingSet=CAP_SYS_CHROOT CAP_SETUID CAP_SETGID CAP_SETPCAP",
        "--property=ProtectSystem=strict", "--property=ProtectHome=yes",
        "--property=ReadWritePaths=" + jail + "/workspace",
        "--property=RestrictAddressFamilies=AF_UNIX", "--property=TasksMax=64",
        "--property=MemoryMax=128M",
        "--setenv=PARTITURA_SANDBOX_STATE_ROOT=" + str(STATE_ROOT),
        "--setenv=PARTITURA_FIRECRACKER_SFTP_ROOT=" + SFTP_ROOT,
        "--setenv=PARTITURA_FIRECRACKER_SFTP_BINARY=" + SFTP_BINARY,
        "/usr/bin/python3", "-I", "-S", str(Path(__file__).resolve()), "--sftp-exec", session,
    ]


async def workspace_server(session: str) -> None:
    record = load(session)
    if record is None or record["runtime"] != "firecracker":
        raise ValueError("workspace session is not owned")
    path = VM_ROOT / key(session) / ("v.sock_" + str(WORKSPACE_PORT))
    path.unlink(missing_ok=True)
    clients = asyncio.Semaphore(16)

    async def serve(reader, writer):
        process = None
        service = "partitura-sftp-" + key(session) + "-" + secrets.token_hex(4) + ".service"
        try:
            async with clients:
                # systemd creates and tears down the mount namespace. The worker
                # sees only a minimal immutable SFTP installation and its exact
                # workspace. No account, SSH daemon, keys or host /proc exists.
                process = await asyncio.create_subprocess_exec(
                    *sftp_command(record, service),
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL)
                upstream = asyncio.create_task(pipe(reader, process.stdin))
                downstream = asyncio.create_task(pipe(process.stdout, writer))
                try:
                    await asyncio.wait({upstream, downstream}, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    upstream.cancel()
                    downstream.cancel()
                    await asyncio.gather(upstream, downstream, return_exceptions=True)
        finally:
            if process is not None:
                stopper = await asyncio.create_subprocess_exec("/usr/bin/systemctl", "stop", service,
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await stopper.wait()
                await process.wait()
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_unix_server(serve, path=str(path))
    os.chmod(path, 0o666)  # Parent directory permits only this session's VMM UID.
    async with server:
        await server.serve_forever()


class CapHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class CapData(ctypes.Structure):
    _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32),
                ("inheritable", ctypes.c_uint32)]


LIBC = ctypes.CDLL(None, use_errno=True)


def _prctl(option: int, arg: int = 0, arg2: int = 0) -> int:
    result = LIBC.prctl(option, arg, arg2, 0, 0)
    if result == -1:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result


def drop_privileges(uid: int, groups: list[int]) -> None:
    """Irreversibly remove helper privileges before entering any untrusted code."""
    if uid <= 0 or uid > 99999 or uid in (65534, 65535):
        raise ValueError("sandbox uid must be non-root and fit the reserved range")
    _prctl(38, 1)  # PR_SET_NO_NEW_PRIVS
    _prctl(8, 0)  # PR_SET_KEEPCAPS
    _prctl(47, 4)  # PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL
    # Bounding drops do not alter current SETUID/SETGID capabilities, so all
    # capability bits can be removed before the permanent credential transition.
    for capability in range(64):
        try:
            _prctl(24, capability)  # PR_CAPBSET_DROP
        except OSError as error:
            if error.errno == errno.EINVAL:
                break
            raise
    os.setgroups(groups)
    os.setresgid(uid, uid, uid)
    os.setresuid(uid, uid, uid)
    header = CapHeader(0x20080522, 0)  # _LINUX_CAPABILITY_VERSION_3
    data = (CapData * 2)()
    if LIBC.capset(ctypes.byref(header), data) != 0:
        error = ctypes.get_errno()
        raise OSError(error, "cannot clear sandbox capability sets")
    if LIBC.capget(ctypes.byref(header), data) != 0:
        raise RuntimeError("cannot verify sandbox capability sets")
    if any(word.effective or word.permitted or word.inheritable for word in data):
        raise RuntimeError("sandbox retained capabilities")
    for capability in range(64):
        try:
            if _prctl(23, capability) != 0:  # PR_CAPBSET_READ
                raise RuntimeError("sandbox retained a bounding capability")
            if _prctl(47, 1, capability) != 0:  # PR_CAP_AMBIENT_IS_SET
                raise RuntimeError("sandbox retained an ambient capability")
        except OSError as error:
            if error.errno == errno.EINVAL:
                break
            raise
    if os.getresuid() != (uid, uid, uid) or os.getresgid() != (uid, uid, uid):
        raise RuntimeError("sandbox retained privileged credentials")
    if sorted(os.getgroups()) != sorted(groups) or _prctl(39) != 1:
        raise RuntimeError("sandbox credential restrictions did not hold")


def exec_owned(session: str, kind: str) -> None:
    record = load(session)
    if record is None or record["runtime"] != "firecracker":
        raise ValueError("sandbox session is not owned")
    uid = int(record["workerUid"])
    if kind == "vmm":
        kvm = os.stat("/dev/kvm")
        if not stat.S_ISCHR(kvm.st_mode):
            raise ValueError("KVM must be a character device")
        groups = [kvm.st_gid]
        command = [BINARY, "--no-api", "--config-file", "/run/partitura-vm-machine.json"]
    elif kind == "sftp":
        os.chroot(sftp_jail(session))
        os.chdir("/")
        groups = []
        command = [SFTP_BINARY, "-e", "-d", "/workspace", "-u", "0077"]
    else:
        raise ValueError("unsupported sandbox helper")
    drop_privileges(uid, groups)
    # A fixed clean environment also excludes inherited loader/interpreter hooks.
    os.execve(command[0], command, {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--workspace-server":
        # Session identifiers are never used as filesystem components or argv
        # options; lookup uses a digest and verifies the record's exact identity.
        asyncio.run(workspace_server(sys.argv[2]))
    elif len(sys.argv) == 3 and sys.argv[1] in ("--vmm-exec", "--sftp-exec"):
        exec_owned(sys.argv[2], sys.argv[1][2:-5])
    else:
        raise SystemExit("unsupported Firecracker helper arguments")
