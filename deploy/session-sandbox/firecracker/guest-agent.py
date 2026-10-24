#!/opt/partitura/bin/python3
"""Authenticated, per-VM control channel. Never expose this on a TCP socket."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
from pathlib import Path
import re
import signal
import socket

PORT = 52
MAX_REQUEST = 1024 * 1024
MAX_FRAME = 4 * 1024 * 1024
WORKSPACE = Path("/workspace")
ENV_KEYS = frozenset("""PATH HOME LANG LANGUAGE LC_ALL LC_CTYPE TERM COLORTERM TMPDIR
XDG_CACHE_HOME XDG_CONFIG_HOME XDG_DATA_HOME BUN_INSTALL_CACHE_DIR
BUN_RUNTIME_TRANSPILER_CACHE_PATH PI_CODING_AGENT_DIR PI_PACKAGE_DIR
OMP_SKIP_UPDATE_CHECK NO_COLOR FNOX_AGE_KEY_FILE MISE_DATA_DIR MISE_CACHE_DIR
MISE_CONFIG_DIR MISE_TRUSTED_CONFIG_PATHS NIX_SSL_CERT_FILE T3CODE_HOME
T3CODE_NO_BROWSER T3CODE_TELEMETRY_ENABLED DISABLE_AUTOUPDATER
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC HTTP_PROXY HTTPS_PROXY NO_PROXY
CLIPROXYAPI_BASE_URL CLIPROXYAPI_API_KEY PI_CLAUDE_DRIVER PI_CLAUDE_AUTH
PI_CLAUDE_EXECUTABLE DOCKER_HOST""".split())
BASE_ENV = {
    "PATH": "/mise/shims:/mise/bin:/opt/partitura/bin:/opt/t3:/opt/codex/bin:/opt/claude/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "HOME": "/workspace/.omp-home", "LANG": "C.UTF-8",
    "MISE_DATA_DIR": "/mise", "MISE_CACHE_DIR": "/mise/cache",
    "MISE_CONFIG_DIR": "/workspace/.omp-home/mise/config",
    "MISE_TRUSTED_CONFIG_PATHS": "/workspace", "DOCKER_HOST": "unix:///run/docker.sock",
}


def validate_exec(request: dict, uid: int) -> tuple[list[str], str, dict[str, str]]:
    if request.get("workerUid") != str(uid):
        raise ValueError("worker identity mismatch")
    argv, cwd, env = request.get("argv"), request.get("cwd"), request.get("env", {})
    if not isinstance(argv, list) or not argv or len(argv) > 4096 or any(
        not isinstance(arg, str) or "\0" in arg for arg in argv
    ):
        raise ValueError("invalid argv")
    if not isinstance(cwd, str) or "\0" in cwd:
        raise ValueError("invalid cwd")
    resolved = Path(cwd).resolve(strict=True)
    if not resolved.is_relative_to(WORKSPACE) or not resolved.is_dir():
        raise ValueError("cwd must resolve inside /workspace")
    if not isinstance(env, dict) or set(env) - ENV_KEYS or any(
        not isinstance(value, str) or "\0" in value for value in env.values()
    ):
        raise ValueError("unsupported environment")
    return argv, str(resolved), BASE_ENV | env


def drop_privileges(uid: int) -> None:
    os.setgroups([])
    os.setgid(uid)
    os.setuid(uid)
    # exec children can't regain guest-root via setuid programs.
    import ctypes
    if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:
        raise OSError("PR_SET_NO_NEW_PRIVS failed")


async def send_json(writer, value: dict) -> None:
    writer.write(json.dumps(value, separators=(",", ":")).encode() + b"\n")
    await writer.drain()


async def stream_exec(reader, writer, request: dict, uid: int) -> None:
    argv, cwd, env = validate_exec(request, uid)
    process = await asyncio.create_subprocess_exec(
        *argv, cwd=cwd, env=env, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        start_new_session=True, preexec_fn=lambda: drop_privileges(uid),
    )

    async def input_loop():
        while True:
            header = await reader.readexactly(5)
            kind, length = header[:1], int.from_bytes(header[1:], "big")
            if kind == b"C" and length == 0:
                process.stdin.close()
                # Keep ownership of the process after stdin closes. A lost
                # broker connection still terminates an otherwise idle worker.
                await reader.read(1)
                raise ConnectionError("exec owner disconnected")
            if kind != b"I" or length > MAX_FRAME:
                raise ValueError("invalid input frame")
            process.stdin.write(await reader.readexactly(length))
            await process.stdin.drain()

    async def output_loop(stream, kind):
        while chunk := await stream.read(65536):
            writer.write(kind + len(chunk).to_bytes(4, "big") + chunk)
            await writer.drain()

    inputs = asyncio.create_task(input_loop())
    outputs = asyncio.gather(output_loop(process.stdout, b"O"), output_loop(process.stderr, b"E"))
    try:
        done, _ = await asyncio.wait({inputs, outputs}, return_when=asyncio.FIRST_COMPLETED)
        if inputs in done:
            # A close-input frame permits the process to continue. A disconnected
            # broker or malformed frame kills the entire process group below.
            inputs.result()
        await outputs
        code = await process.wait()
        writer.write(b"X" + (code if 0 <= code <= 255 else 1).to_bytes(4, "big"))
        await writer.drain()
    finally:
        inputs.cancel()
        outputs.cancel()
        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        await process.wait()
        await asyncio.gather(inputs, outputs, return_exceptions=True)



def port(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1024 <= value <= 65535:
        raise ValueError("port must be unprivileged")
    return value


async def bridge(reader, writer, peer_reader, peer_writer):
    async def pump(source, target):
        while chunk := await source.read(65536):
            target.write(chunk)
            await target.drain()
    tasks = [asyncio.create_task(pump(reader, peer_writer)), asyncio.create_task(pump(peer_reader, writer))]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        peer_writer.close()
        await peer_writer.wait_closed()


class Agent:
    def __init__(self, token: str, uid: int):
        if not re.fullmatch(r"[a-f0-9]{64}", token) or not 1 <= uid <= 65535:
            raise ValueError("invalid guest configuration")
        self.token, self.uid = token, uid
        self.listeners = {}
        self.workspace_process = None
        self.workspace_host_port = None
        self.mount_lock = asyncio.Lock()

    async def handle(self, reader, writer):
        try:
            line = await asyncio.wait_for(reader.readline(), 15)
            if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
                raise ValueError("invalid request")
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(request.get("token"), str) or not re.fullmatch(r"[a-f0-9]{64}", request["token"]) or not hmac.compare_digest(request["token"], self.token):
                raise ValueError("unauthorized")
            operation = request.get("operation")
            if operation == "ping":
                await send_json(writer, {"ok": True})
            elif operation == "shutdown":
                await send_json(writer, {"ok": True})
                # PID 1 stops Docker and syncs the private disk before reboot.
                os.kill(1, signal.SIGTERM)
            elif operation == "exec":
                await stream_exec(reader, writer, request, self.uid)
            elif operation == "mount-workspace":
                async with self.mount_lock:
                    target_port = port(request.get("targetPort"))
                    if self.workspace_process is not None:
                        if self.workspace_process.returncode is None and os.path.ismount(WORKSPACE) and target_port == self.workspace_host_port:
                            await send_json(writer, {"ok": True})
                            return
                        raise ValueError("workspace mount unavailable")
                    channel = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
                    channel.setblocking(False)
                    try:
                        await asyncio.get_running_loop().sock_connect(channel, (2, target_port))
                        channel.setblocking(True)
                        self.workspace_process = await asyncio.create_subprocess_exec(
                            "sshfs", "-f", "-o", f"slave,allow_other,default_permissions,uid={self.uid},gid={self.uid},nodev,nosuid,dir_cache=no,attr_timeout=0,entry_timeout=0,negative_timeout=0",
                            "ignored:/workspace", str(WORKSPACE),
                            stdin=channel, stdout=channel, stderr=asyncio.subprocess.DEVNULL,
                            env=BASE_ENV,
                        )
                        self.workspace_host_port = target_port
                    finally:
                        channel.close()
                    for _ in range(200):
                        if self.workspace_process.returncode is not None:
                            raise ValueError("workspace mount failed")
                        if os.path.ismount(WORKSPACE):
                            break
                        await asyncio.sleep(0.05)
                    else:
                        self.workspace_process.kill()
                        await self.workspace_process.wait()
                        raise ValueError("workspace mount timed out")
                    await send_json(writer, {"ok": True})
            elif operation == "tunnel":
                peer_reader, peer_writer = await asyncio.open_connection("127.0.0.1", port(request.get("targetPort")))
                await send_json(writer, {"ok": True})
                await bridge(reader, writer, peer_reader, peer_writer)
            elif operation == "listen":
                listen_port = request.get("port")
                if listen_port != 0 or isinstance(listen_port, bool):
                    listen_port = port(listen_port)
                target = port(request.get("targetPort"))
                if listen_port in self.listeners:
                    raise ValueError("listener already exists")
                active = set()
                async def forward(client_reader, client_writer):
                    task = asyncio.current_task()
                    active.add(task)
                    try:
                        channel = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
                        channel.setblocking(False)
                        await asyncio.get_running_loop().sock_connect(channel, (2, target))
                        peer_reader, peer_writer = await asyncio.open_connection(sock=channel)
                        await bridge(client_reader, client_writer, peer_reader, peer_writer)
                    finally:
                        active.discard(task)
                        client_writer.close()
                        await client_writer.wait_closed()
                self.listeners[listen_port] = await asyncio.start_server(forward, "127.0.0.1", listen_port)
                server = self.listeners.pop(listen_port)
                allocated = server.sockets[0].getsockname()[1]
                self.listeners[allocated] = server
                try:
                    await send_json(writer, {"ok": True, "port": allocated})
                    await reader.read(1)
                finally:
                    self.listeners.pop(allocated, None)
                    server.close()
                    await server.wait_closed()
                    for task in active:
                        task.cancel()
                    await asyncio.gather(*active, return_exceptions=True)
            else:
                raise ValueError("unsupported operation")
        except (ValueError, OSError, asyncio.IncompleteReadError, asyncio.TimeoutError):
            # No command output, environment, credentials or filesystem paths.
            try:
                await send_json(writer, {"ok": False, "error": "guest operation failed"})
            except (ConnectionError, OSError):
                pass
        finally:
            writer.close()
            await writer.wait_closed()


async def main():
    config = json.loads(Path("/run/partitura-config/config.json").read_text())
    agent = Agent(config["token"], int(config["workerUid"]))
    listener = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    listener.bind((socket.VMADDR_CID_ANY, PORT))
    listener.listen(128)
    listener.setblocking(False)
    server = await asyncio.start_server(agent.handle, sock=listener, limit=MAX_REQUEST + 1)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
