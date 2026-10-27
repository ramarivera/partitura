"""Streaming execution, relay, and request dispatch for the sandbox broker."""
from __future__ import annotations

import asyncio
import errno
import ipaddress
import json
import os
import re
import secrets
import socket
from pathlib import Path
from typing import Any

from . import core
from .core import vm

# The image owns this interpreter and its stdlib. Framing preserves the
# distinction between closing child stdin and relinquishing process ownership.
SYSBOX_EXEC_WRAPPER = r"""
import os, signal, subprocess, sys, threading
process = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, start_new_session=True)
lock = threading.Lock()
def stop():
    with lock:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
def exact(length):
    data = bytearray()
    while len(data) < length:
        part = sys.stdin.buffer.read(length - len(data))
        if not part:
            raise EOFError()
        data.extend(part)
    return bytes(data)
def input_loop():
    try:
        while True:
            header = exact(5)
            kind, length = header[:1], int.from_bytes(header[1:], "big")
            if kind == b"C" and length == 0:
                process.stdin.close()
            elif kind == b"I" and length <= 4 * 1024 * 1024:
                data = exact(length)
                if not process.stdin.closed:
                    try:
                        process.stdin.write(data)
                        process.stdin.flush()
                    except BrokenPipeError:
                        process.stdin.close()
            else:
                raise ValueError("invalid input frame")
    except (EOFError, OSError, ValueError):
        stop()
threading.Thread(target=input_loop, daemon=True).start()
try:
    code = process.wait()
finally:
    stop()
os._exit(code if 0 <= code <= 255 else 1)
"""


async def _stream_exec(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, request: dict[str, Any]) -> None:
    session = core._session(request.get("sessionId"))
    worker_uid = request.get("workerUid")
    argv = request.get("argv")
    cwd = request.get("cwd")
    env = request.get("env", {})
    if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) for arg in argv):
        raise ValueError("argv must be a non-empty string array")
    if not isinstance(cwd, str) or not cwd.startswith("/workspace"):
        raise ValueError("cwd must be inside /workspace")
    if not isinstance(worker_uid, str) or not re.fullmatch(r"[1-9][0-9]{0,4}", worker_uid):
        raise ValueError("worker uid must be a non-root numeric uid")
    if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in env.items()):
        raise ValueError("env must contain string values")
    allowed_env = {
        "PATH", "HOME", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TERM",
        "COLORTERM", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
        "BUN_INSTALL_CACHE_DIR", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "PI_CODING_AGENT_DIR",
        "PI_PACKAGE_DIR", "OMP_SKIP_UPDATE_CHECK", "NO_COLOR", "FNOX_AGE_KEY_FILE",
        "MISE_DATA_DIR", "MISE_CACHE_DIR", "MISE_CONFIG_DIR", "MISE_TRUSTED_CONFIG_PATHS",
        "NIX_SSL_CERT_FILE", "T3CODE_HOME", "T3CODE_NO_BROWSER",
        "T3CODE_TELEMETRY_ENABLED", "DISABLE_AUTOUPDATER",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY", "CLIPROXYAPI_BASE_URL", "CLIPROXYAPI_API_KEY",
        "PI_CLAUDE_DRIVER", "PI_CLAUDE_AUTH", "PI_CLAUDE_EXECUTABLE",
    }
    if set(env) - allowed_env:
        raise ValueError("environment contains unsupported variables")
    container_record = await core._docker_api_json(
        "GET", f"/containers/{core._container(session)}/json"
    )
    container_config = container_record.get("Config")
    labels = container_config.get("Labels") if isinstance(container_config, dict) else None
    if not isinstance(labels, dict) or labels.get("partitura.session") != session:
        raise ValueError("sandbox container session label does not match")
    if labels.get("partitura.worker_uid") != worker_uid:
        raise ValueError("sandbox container worker uid does not match")
    exec_record = await core._docker_api_json(
        "POST",
        f"/containers/{core._container(session)}/exec",
        {
            "AttachStdin": True,
            "AttachStdout": True,
            "AttachStderr": True,
            "Tty": False,
            "Cmd": ["/opt/partitura/bin/python3", "-I", "-S", "-c", SYSBOX_EXEC_WRAPPER, *argv],
            "Env": [f"{key}={value}" for key, value in env.items()],
            "WorkingDir": cwd,
            "User": f"{worker_uid}:{worker_uid}",
        },
    )
    exec_id = exec_record.get("Id")
    if not isinstance(exec_id, str) or not re.fullmatch(r"[a-f0-9]{12,64}", exec_id):
        raise ValueError("Docker API returned an invalid exec id")
    docker_reader, docker_writer = await asyncio.open_unix_connection(core.DOCKER_SOCKET)
    start_body = b'{"Detach":false,"Tty":false}'
    docker_writer.write(
        f"POST /v1.41/exec/{exec_id}/start HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: {len(start_body)}\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n".encode()
        + start_body
    )
    await docker_writer.drain()
    status = await docker_reader.readline()
    while line := await docker_reader.readline():
        if line == b"\r\n":
            break
    if b" 101 " not in status and b" 200 " not in status:
        docker_writer.close()
        await docker_writer.wait_closed()
        raise RuntimeError("Docker exec stream could not start")

    async def input_loop() -> None:
        try:
            while True:
                header = await reader.readexactly(5)
                kind, length = header[:1], int.from_bytes(header[1:], "big")
                if kind == b"C" and length == 0:
                    docker_writer.write(header)
                    await docker_writer.drain()
                    continue
                if kind != b"I" or length > 4 * 1024 * 1024:
                    raise ValueError("invalid input frame")
                docker_writer.write(header + await reader.readexactly(length))
                await docker_writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            # EOF belongs to the supervisor, which terminates only its child
            # process group. C frames only close the child's input stream.
            raw_socket = docker_writer.transport.get_extra_info("socket")
            if raw_socket is not None:
                try:
                    raw_socket.shutdown(socket.SHUT_WR)
                except OSError:
                    pass

    async def output_loop() -> None:
        while True:
            try:
                header = await docker_reader.readexactly(8)
            except asyncio.IncompleteReadError as error:
                if not error.partial:
                    return
                raise ValueError("Docker returned a truncated exec frame") from error
            kind = header[:1]
            length = int.from_bytes(header[4:], "big")
            if kind not in (b"\x01", b"\x02") or length > 4 * 1024 * 1024:
                raise ValueError("Docker returned an invalid exec frame")
            try:
                data = await docker_reader.readexactly(length)
            except asyncio.IncompleteReadError as error:
                raise ValueError("Docker returned a truncated exec payload") from error
            writer.write((b"O" if kind == b"\x01" else b"E") + len(data).to_bytes(4, "big") + data)
            await writer.drain()

    inputs = asyncio.create_task(input_loop())
    outputs = asyncio.create_task(output_loop())
    try:
        done, _ = await asyncio.wait(
            {inputs, outputs}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in done:
            task.result()
        if inputs in done:
            await outputs
    finally:
        for task in (inputs, outputs):
            if not task.done():
                task.cancel()
        await asyncio.gather(inputs, outputs, return_exceptions=True)
        docker_writer.close()
        await docker_writer.wait_closed()
    exit_info = await core._docker_api_json("GET", f"/exec/{exec_id}/json")
    code = exit_info.get("ExitCode", 1)
    if not isinstance(code, int) or code < 0 or code > 255:
        code = 1
    writer.write(b"X" + code.to_bytes(4, "big"))


async def _stream_relay(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, request: dict[str, Any]
) -> None:
    session = core._session(request.get("sessionId"))
    target = request.get("target")
    port = request.get("targetPort")
    if target not in ("gateway", "worker"):
        raise ValueError("relay target must be gateway or worker")
    if not isinstance(port, int) or isinstance(port, bool) or port < 1 or port > 65535:
        raise ValueError("relay target port is invalid")
    network = core._network(session)
    container = core._container(session)
    worker_ip = core._run(
        ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}', container]
    )
    gateway_ip = core._run(
        ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{core.GATEWAY_NETWORK}").IPAddress}}}}', core.GATEWAY_NETWORK_CONTAINER]
    )
    relay_ip = core._run(
        ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network]
    )
    target_ip = gateway_ip if target == "gateway" else worker_ip
    expected_peer = worker_ip if target == "gateway" else gateway_ip
    if not all(ipaddress.ip_address(value).version == 4 for value in (worker_ip, gateway_ip, relay_ip)):
        raise ValueError("relay requires IPv4 Docker addresses")
    active_writers: set[asyncio.StreamWriter] = set()
    active_tasks: set[asyncio.Task[Any]] = set()

    async def pipe(source: asyncio.StreamReader, destination: asyncio.StreamWriter) -> None:
        try:
            while chunk := await source.read(65_536):
                destination.write(chunk)
                await destination.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            try:
                destination.write_eof()
            except (AttributeError, ConnectionError, OSError):
                destination.close()

    async def relay_client(
        client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter
    ) -> None:
        task = asyncio.current_task()
        if task is not None:
            active_tasks.add(task)
        active_writers.add(client_writer)
        target_writer: asyncio.StreamWriter | None = None
        peer = client_writer.get_extra_info("peername")
        try:
            if not isinstance(peer, tuple) or peer[0] != expected_peer:
                return
            target_reader, target_writer = await asyncio.open_connection(target_ip, port)
            active_writers.add(target_writer)
            await asyncio.gather(
                pipe(client_reader, target_writer),
                pipe(target_reader, client_writer),
            )
        except OSError:
            pass
        finally:
            active_writers.discard(client_writer)
            client_writer.close()
            if target_writer is not None:
                active_writers.discard(target_writer)
                target_writer.close()
                await target_writer.wait_closed()
            await client_writer.wait_closed()
            if task is not None:
                active_tasks.discard(task)

    server = await asyncio.start_server(relay_client, relay_ip, 0)
    relay_port = server.sockets[0].getsockname()[1]
    try:
        core._allow_listener(expected_peer, relay_ip, relay_port, network if target == "gateway" else core.GATEWAY_NETWORK)
        writer.write((json.dumps({"ok": True, "result": {"address": relay_ip, "port": relay_port}}) + "\n").encode())
        await writer.drain()
        # The control socket owns this relay's lifetime. Closing it stops all
        # listeners and active streams before the systemd instance exits.
        await reader.read()
    finally:
        server.close()
        for active_writer in active_writers:
            active_writer.close()
        for task in active_tasks:
            task.cancel()
        if active_tasks:
            await asyncio.gather(*active_tasks, return_exceptions=True)
        await server.wait_closed()
        core._cleanup_firewall()


async def _stream_egress(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, request: dict[str, Any], record: dict[str, Any] | None = None
) -> None:
    if core.EGRESS_MODE == "allowlist" and not core.EGRESS_HOSTS:
        raise ValueError("PARTITURA_SANDBOX_EGRESS_HOSTS must not be empty")
    session = core._session(request.get("sessionId"))
    network = core._network(session)
    container = core._container(session)
    if record is None:
        worker_ip = core._run(
            ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}', container]
        )
        relay_ip = core._run(
            ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network]
        )
        if not all(ipaddress.ip_address(value).version == 4 for value in (worker_ip, relay_ip)):
            raise ValueError("egress proxy requires IPv4 Docker addresses")
    else:
        worker_ip, relay_ip = None, "127.0.0.1"
    active_writers: set[asyncio.StreamWriter] = set()
    active_tasks: set[asyncio.Task[Any]] = set()

    async def pipe(source: asyncio.StreamReader, destination: asyncio.StreamWriter) -> None:
        try:
            while chunk := await source.read(65_536):
                destination.write(chunk)
                await destination.drain()
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            try:
                destination.write_eof()
            except (AttributeError, ConnectionError, OSError):
                destination.close()

    async def proxy_client(
        client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter
    ) -> None:
        task = asyncio.current_task()
        if task is not None:
            active_tasks.add(task)
        active_writers.add(client_writer)
        remote_writer: asyncio.StreamWriter | None = None
        peer = client_writer.get_extra_info("peername")
        try:
            if record is None and (not isinstance(peer, tuple) or peer[0] != worker_ip):
                return
            try:
                header = await asyncio.wait_for(client_reader.readuntil(b"\r\n\r\n"), timeout=5)
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
                return
            if len(header) > 8192:
                client_writer.write(b"HTTP/1.1 413 Request Too Large\r\nConnection: close\r\n\r\n")
                await client_writer.drain()
                return
            try:
                host, port, forwarded = core.proxy_target(header)
            except (ValueError, UnicodeError):
                client_writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
                await client_writer.drain()
                return
            try:
                answers = await asyncio.get_running_loop().getaddrinfo(
                    host, port, type=socket.SOCK_STREAM
                )
                addresses = core.egress_addresses(host, {answer[4][0] for answer in answers}, port)
                for address in addresses:
                    try:
                        remote_reader, remote_writer = await asyncio.wait_for(asyncio.open_connection(address, port), 15)
                        break
                    except (OSError, TimeoutError):
                        if address == addresses[-1]:
                            raise
                active_writers.add(remote_writer)
            except (OSError, ValueError):
                client_writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
                await client_writer.drain()
                return
            if forwarded is None:
                client_writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await client_writer.drain()
            else:
                remote_writer.write(forwarded)
                await remote_writer.drain()
            await asyncio.gather(
                pipe(client_reader, remote_writer),
                pipe(remote_reader, client_writer),
            )
        finally:
            active_writers.discard(client_writer)
            client_writer.close()
            if remote_writer is not None:
                active_writers.discard(remote_writer)
                remote_writer.close()
                await remote_writer.wait_closed()
            await client_writer.wait_closed()
            if task is not None:
                active_tasks.discard(task)

    guest_writer = None
    unix_path = None
    if record is None:
        server = await asyncio.start_server(proxy_client, relay_ip, core.EGRESS_PROXY_PORT, limit=8192)
        proxy_port = server.sockets[0].getsockname()[1]
    else:
        unix_path = vm.VM_ROOT / vm.key(session) / "v.sock_1081"
        unix_path.unlink(missing_ok=True)
        server = await asyncio.start_unix_server(proxy_client, path=str(unix_path), limit=8192)
        os.chmod(unix_path, 0o666)
        proxy_port = core.EGRESS_PROXY_PORT
    try:
        if record is None:
            core._allow_listener(worker_ip, relay_ip, proxy_port, network)
        else:
            guest_reader, guest_writer = await vm.connect(record, {"operation": "listen", "port": proxy_port, "targetPort": 1081})
            response = json.loads(await asyncio.wait_for(guest_reader.readline(), 10))
            if response.get("ok") is not True:
                raise RuntimeError("guest egress listener failed")
        writer.write((json.dumps({"ok": True, "result": {"address": relay_ip, "port": proxy_port}}) + "\n").encode())
        await writer.drain()
        await reader.read()
    finally:
        server.close()
        for active_writer in active_writers:
            active_writer.close()
        for task in active_tasks:
            task.cancel()
        if active_tasks:
            await asyncio.gather(*active_tasks, return_exceptions=True)
        await server.wait_closed()
        if guest_writer is not None:
            guest_writer.close()
            await guest_writer.wait_closed()
        if unix_path is not None:
            unix_path.unlink(missing_ok=True)
        else:
            core._cleanup_firewall()


async def _vm_relay(reader, writer, request, record):
    target, port = request.get("target"), request.get("targetPort")
    if target not in ("gateway", "worker") or not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError("relay target or port is invalid")
    gateway_ip, bridge_ip = core._gateway_routing()
    active: set[asyncio.Task[Any]] = set()
    guest_writer = None
    unix_path = None

    async def client(client_reader, client_writer):
        task = asyncio.current_task()
        active.add(task)
        upstream_writer = None
        try:
            if target == "worker":
                peer = client_writer.get_extra_info("peername")
                if not isinstance(peer, tuple) or peer[0] != gateway_ip:
                    return
                upstream_reader, upstream_writer = await vm.connect(record, {"operation": "tunnel", "targetPort": port})
                reply = json.loads(await asyncio.wait_for(upstream_reader.readline(), 10))
                if reply.get("ok") is not True:
                    raise RuntimeError("guest tunnel failed")
            else:
                upstream_reader, upstream_writer = await asyncio.wait_for(asyncio.open_connection(gateway_ip, port), 10)
            outgoing = asyncio.create_task(vm.pipe(client_reader, upstream_writer))
            incoming = asyncio.create_task(vm.pipe(upstream_reader, client_writer))
            try:
                await asyncio.wait({outgoing, incoming}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                outgoing.cancel()
                incoming.cancel()
                await asyncio.gather(outgoing, incoming, return_exceptions=True)
        except (OSError, ValueError, RuntimeError, TimeoutError):
            pass
        finally:
            client_writer.close()
            if upstream_writer is not None:
                upstream_writer.close()
                await upstream_writer.wait_closed()
            await client_writer.wait_closed()
            active.discard(task)

    if target == "worker":
        server = await asyncio.start_server(client, bridge_ip, 0)
        relay_port = server.sockets[0].getsockname()[1]
        relay_ip = bridge_ip
    else:
        # The guest accepts this destination as a bounded service port. Bind
        # explicitly so a random collision never unlinks another live listener.
        for attempt in range(8):
            host_port = 2000 + secrets.randbelow(65536 - 2000)
            unix_path = vm.VM_ROOT / vm.key(record["sessionId"]) / ("v.sock_" + str(host_port))
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                listener.bind(str(unix_path))
                listener.listen(socket.SOMAXCONN)
                listener.setblocking(False)
                server = await asyncio.start_unix_server(client, sock=listener)
                break
            except OSError as error:
                listener.close()
                if error.errno != errno.EADDRINUSE:
                    raise
        else:
            raise RuntimeError("no guest relay service port is available")
        os.chmod(unix_path, 0o666)
        relay_ip, relay_port = "127.0.0.1", 0
    try:
        if target == "worker":
            if core.GATEWAY_INTERFACE:
                core._allow_interface_listener(gateway_ip, relay_ip, relay_port, core.GATEWAY_INTERFACE)
            else:
                core._allow_listener(gateway_ip, relay_ip, relay_port, core.GATEWAY_NETWORK)
        else:
            guest_reader, guest_writer = await vm.connect(record, {"operation": "listen", "port": 0, "targetPort": host_port})
            response = json.loads(await asyncio.wait_for(guest_reader.readline(), 10))
            relay_port = response.get("port")
            if response.get("ok") is not True or not isinstance(relay_port, int) or not 1 <= relay_port <= 65535:
                raise RuntimeError("guest relay listener failed")
        writer.write((json.dumps({"ok": True, "result": {"address": relay_ip, "port": relay_port}}) + "\n").encode())
        await writer.drain()
        await reader.read()
    finally:
        server.close()
        await server.wait_closed()
        for task in list(active):
            task.cancel()
        await asyncio.gather(*active, return_exceptions=True)
        if guest_writer is not None:
            guest_writer.close()
            await guest_writer.wait_closed()
        if unix_path is not None:
            unix_path.unlink(missing_ok=True)
        else:
            core._cleanup_firewall()

async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        raw = await reader.readline()
        if len(raw) > 16_384:
            raise ValueError("request too large")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        operation = request.get("operation")
        if operation == "exec":
            record = core._owned_runtime(request)
            if record["runtime"] == "firecracker":
                await core._vm_exec(reader, writer, request, record)
            else:
                await _stream_exec(reader, writer, request)
            return
        if operation == "relay":
            record = core._owned_runtime(request)
            if record["runtime"] == "firecracker":
                await _vm_relay(reader, writer, request, record)
            else:
                await _stream_relay(reader, writer, request)
            return
        if operation == "egress":
            record = core._owned_runtime(request)
            await _stream_egress(reader, writer, request, record if record["runtime"] == "firecracker" else None)
            return
        if operation == "provision":
            result = await asyncio.to_thread(core.provision, request)
        elif operation == "destroy":
            result = await asyncio.to_thread(core.destroy, request)
        elif operation == "recover":
            result = await asyncio.to_thread(core.recover, request)
        else:
            raise ValueError("unsupported operation")
        if operation in ("provision", "recover") and result.get("runtime") == "firecracker" and result.get("exists", True):
            record = core._owned_runtime(request)
            await vm.ready(record)
            await vm.command(record, {"operation": "mount-workspace", "targetPort": vm.WORKSPACE_PORT})
        writer.write((json.dumps({"ok": True, "result": result}) + "\n").encode())
    except Exception as error:
        # Never relay process stdout/stderr: Docker diagnostics can contain paths.
        writer.write((json.dumps({"ok": False, "error": str(error)[:240]}) + "\n").encode())
    finally:
        await writer.drain()
        writer.close()
        await writer.wait_closed()


async def main() -> None:
    # With the Accept=yes systemd socket unit, fd 0 is one accepted connection.
    sock = socket.socket(fileno=os.dup(0))
    sock.setblocking(False)
    reader, writer = await asyncio.open_connection(sock=sock)
    await handle(reader, writer)
