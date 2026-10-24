#!/usr/bin/env python3
"""Narrow Docker broker for Partitura's per-session Sysbox sandboxes.

The broker accepts one JSON request per Unix socket connection. It deliberately
does not implement the Docker Engine API. Docker's socket stays on the host.
"""

from __future__ import annotations

import asyncio
import json
import ipaddress
import os
import re
import socket
import subprocess
from pathlib import Path
from typing import Any

SESSION_RE = re.compile(r"^[a-zA-Z0-9_-]{1,96}$")
CONTAINER_PREFIX = "partitura-session-"
NETWORK_PREFIX = "partitura-network-"
SANDBOX_IMAGE = os.environ.get("PARTITURA_SANDBOX_IMAGE", "")
GATEWAY_CONTAINER = os.environ.get("PARTITURA_GATEWAY_CONTAINER", "")
GATEWAY_NETWORK = os.environ.get("PARTITURA_GATEWAY_NETWORK", "")
GATEWAY_NETWORK_CONTAINER = os.environ.get(
    "PARTITURA_GATEWAY_NETWORK_CONTAINER", GATEWAY_CONTAINER
)
WORKSPACE_ROOT = Path(os.environ.get("PARTITURA_WORKSPACE_ROOT", "/app/workspaces"))
WORKSPACE_HOST_ROOT = os.environ.get("PARTITURA_WORKSPACE_HOST_ROOT", "")
DOCKER = os.environ.get("PARTITURA_DOCKER", "/usr/bin/docker")
DOCKER_SOCKET = os.environ.get("PARTITURA_DOCKER_SOCKET", "/var/run/docker.sock")
MEMORY_LIMIT = os.environ.get("PARTITURA_SANDBOX_MEMORY", "8g")
CPU_LIMIT = os.environ.get("PARTITURA_SANDBOX_CPUS", "4")
PIDS_LIMIT = int(os.environ.get("PARTITURA_SANDBOX_PIDS", "2048"))
EGRESS_PROXY_PORT = 3128
EGRESS_HOSTS = frozenset(
    host.strip().lower()
    for host in os.environ.get("PARTITURA_SANDBOX_EGRESS_HOSTS", "").split(",")
    if host.strip()
)


def _session(value: Any) -> str:
    if not isinstance(value, str) or not SESSION_RE.fullmatch(value):
        raise ValueError("invalid session id")
    return value


def _worker_uid(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,4}", value):
        raise ValueError("worker uid must be a non-root numeric uid")
    return value


def _workspace(value: Any) -> Path:
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError("workspace path must be absolute")
    candidate = Path(value)
    logical_root = WORKSPACE_ROOT
    if (
        str(candidate) != value
        or not logical_root.is_absolute()
        or str(logical_root) != os.path.normpath(str(logical_root))
    ):
        raise ValueError("workspace path and logical root must be canonical")
    try:
        relative = candidate.relative_to(logical_root)
    except ValueError as error:
        raise ValueError("workspace must be inside the configured logical root") from error
    if relative == Path(".") or any(part in ("", ".", "..") for part in relative.parts):
        raise ValueError("workspace must be a strict child of the logical root")
    if not WORKSPACE_HOST_ROOT:
        raise ValueError("PARTITURA_WORKSPACE_HOST_ROOT must map the gateway workspace volume")
    host_root = Path(WORKSPACE_HOST_ROOT)
    if not host_root.is_absolute():
        raise ValueError("PARTITURA_WORKSPACE_HOST_ROOT must be absolute")
    resolved_root = host_root.resolve(strict=True)
    if resolved_root != host_root or not resolved_root.is_dir():
        raise ValueError("host workspace root must be a canonical directory")
    mapped = resolved_root.joinpath(*relative.parts)
    current = resolved_root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("workspace path cannot contain symlinks")
    resolved = mapped.resolve(strict=True)
    if resolved != mapped or not resolved.is_relative_to(resolved_root) or not mapped.is_dir():
        raise ValueError("mapped workspace must be a real directory under host root")
    return resolved


def _run(args: list[str], *, timeout: int = 60) -> str:
    completed = subprocess.run(
        [DOCKER, *args], check=True, capture_output=True, text=True, timeout=timeout
    )
    return completed.stdout.strip()


def _container(session: str) -> str:
    return CONTAINER_PREFIX + session


def _network(session: str) -> str:
    return NETWORK_PREFIX + session


def _remove_owned(kind: str, name: str, session: str) -> None:
    inspected = subprocess.run(
        [DOCKER, kind, "inspect", name],
        capture_output=True,
        text=True,
        check=False,
    )
    if inspected.returncode != 0:
        diagnostic = f"{inspected.stdout}\n{inspected.stderr}".lower()
        if "no such" in diagnostic or "not found" in diagnostic:
            return
        raise RuntimeError(f"Docker {kind} ownership check failed")
    records = json.loads(inspected.stdout)
    if not isinstance(records, list) or len(records) != 1:
        raise RuntimeError(f"Docker {kind} ownership record is invalid")
    labels = records[0].get("Config", {}).get("Labels", {}) if kind == "container" else records[0].get("Labels", {})
    if not isinstance(labels, dict) or labels.get("partitura.session") != session:
        raise ValueError(f"Docker {kind} session label does not match")
    action = {"container": "rm", "network": "network rm", "volume": "volume rm"}[kind]
    result = subprocess.run(
        [DOCKER, *action.split(), "-f", name] if kind == "container" else [DOCKER, *action.split(), name],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Docker {kind} removal failed; retry teardown")


async def _docker_api_json(
    method: str, path: str, body: dict[str, Any] | None = None
) -> dict[str, Any]:
    reader, writer = await asyncio.open_unix_connection(DOCKER_SOCKET)
    payload = json.dumps(body or {}).encode()
    writer.write(
        f"{method} /v1.41{path} HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode()
        + payload
    )
    await writer.drain()
    status = await reader.readline()
    headers: dict[str, str] = {}
    while line := await reader.readline():
        if line == b"\r\n":
            break
        key, _, value = line.decode("latin1").partition(":")
        headers[key.lower()] = value.strip()
    body_length = int(headers.get("content-length", "0"))
    response = await reader.readexactly(body_length) if body_length else b""
    writer.close()
    await writer.wait_closed()
    if b" 2" not in status:
        raise RuntimeError("Docker API request failed")
    return json.loads(response) if response else {}


def provision(request: dict[str, Any]) -> dict[str, Any]:
    session = _session(request.get("sessionId"))
    worker_uid = _worker_uid(request.get("workerUid"))
    workspace = _workspace(request.get("workspacePath"))
    if not SANDBOX_IMAGE:
        raise ValueError("PARTITURA_SANDBOX_IMAGE must be pinned by the host operator")
    if not GATEWAY_CONTAINER:
        raise ValueError("PARTITURA_GATEWAY_CONTAINER must name the gateway container")
    if not GATEWAY_NETWORK:
        raise ValueError("PARTITURA_GATEWAY_NETWORK must name the gateway's Docker network")
    if not GATEWAY_NETWORK_CONTAINER:
        raise ValueError("PARTITURA_GATEWAY_NETWORK_CONTAINER must name the network owner")
    container = _container(session)
    network = _network(session)
    _run(["network", "create", "--internal", "--label", f"partitura.session={session}", network])
    try:
        relay_ip = _run(
            ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network]
        )
        if ipaddress.ip_address(relay_ip).version != 4:
            raise ValueError("sandbox egress proxy requires an IPv4 bridge gateway")
        egress_proxy = f"http://{relay_ip}:{EGRESS_PROXY_PORT}"
        _run(["volume", "create", "--label", f"partitura.session={session}", f"partitura-mise-{session}"])
        volume = json.loads(_run(["volume", "inspect", f"partitura-mise-{session}"]))[0]
        if volume.get("Labels", {}).get("partitura.session") != session:
            raise ValueError("Mise volume session label does not match")
        _run(
            [
                "create",
                "--name",
                container,
                "--label",
                f"partitura.session={session}",
                "--label",
                f"partitura.workspace={workspace}",
                "--label",
                f"partitura.worker_uid={worker_uid}",
                "--runtime=sysbox-runc",
                "--network",
                network,
                "--memory",
                MEMORY_LIMIT,
                "--cpus",
                CPU_LIMIT,
                "--pids-limit",
                str(PIDS_LIMIT),
                "--env",
                "SYSBOX_HONOR_CAPS=FALSE",
                "--env",
                f"PARTITURA_WORKER_UID={worker_uid}",
                "--security-opt=no-new-privileges",
                "--env",
                f"HTTP_PROXY={egress_proxy}",
                "--env",
                f"HTTPS_PROXY={egress_proxy}",
                "--env",
                f"NO_PROXY=localhost,127.0.0.1,::1,host.docker.internal,{relay_ip}",
                "--mount",
                f"type=bind,src={workspace},dst=/workspace,rw",
                "--mount",
                f"type=volume,src=partitura-mise-{session},dst=/mise,rw",
                "--tmpfs",
                "/run:rw,nosuid,nodev,size=64m",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,size=1g",
                SANDBOX_IMAGE,
            ]
        )
        _run(["start", container])
        worker_ip = _run(
            ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}', container]
        )
        gateway_ip = _run(
            ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{GATEWAY_NETWORK}").IPAddress}}}}', GATEWAY_NETWORK_CONTAINER]
        )
        if not worker_ip or not gateway_ip or not relay_ip:
            raise RuntimeError("Docker did not assign required network addresses")
    except Exception:
        try:
            destroy({"sessionId": session})
        except Exception as cleanup_error:
            raise RuntimeError("sandbox provisioning failed; retry teardown") from cleanup_error
        raise
    return {"container": container, "workspace": "/workspace", "workerAddress": worker_ip, "gatewayAddress": gateway_ip, "relayAddress": relay_ip}


def destroy(request: dict[str, Any]) -> dict[str, Any]:
    session = _session(request.get("sessionId"))
    _remove_owned("container", _container(session), session)
    _remove_owned("network", _network(session), session)
    _remove_owned("volume", f"partitura-mise-{session}", session)
    return {"destroyed": True}


def recover(request: dict[str, Any]) -> dict[str, Any]:
    session = _session(request.get("sessionId"))
    worker_uid = _worker_uid(request.get("workerUid"))
    workspace = _workspace(request.get("workspacePath"))
    container = _container(session)
    result = subprocess.run(
        [DOCKER, "inspect", "--format", "{{.State.Running}}", container],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return {"exists": False, "running": False}
    labels = subprocess.run(
        [DOCKER, "inspect", "--format", "{{json .Config.Labels}}", container],
        capture_output=True,
        text=True,
        check=False,
    )
    if labels.returncode != 0:
        return {"exists": False, "running": False}
    label_record = json.loads(labels.stdout)
    if label_record.get("partitura.session") != session:
        raise ValueError("sandbox container session label does not match")
    if label_record.get("partitura.workspace") != str(workspace):
        raise ValueError("sandbox container workspace does not match")
    if label_record.get("partitura.worker_uid") != worker_uid:
        raise ValueError("sandbox container worker uid does not match")
    network = _network(session)
    network_info = subprocess.run(
        [DOCKER, "network", "inspect", network],
        capture_output=True,
        text=True,
        check=False,
    )
    if network_info.returncode != 0:
        raise ValueError("sandbox network is missing")
    network_record = json.loads(network_info.stdout)[0]
    if network_record.get("Labels", {}).get("partitura.session") != session:
        raise ValueError("sandbox network session label does not match")
    volume_info = subprocess.run(
        [DOCKER, "volume", "inspect", f"partitura-mise-{session}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if volume_info.returncode != 0:
        raise ValueError("sandbox Mise volume is missing")
    volume_record = json.loads(volume_info.stdout)[0]
    if volume_record.get("Labels", {}).get("partitura.session") != session:
        raise ValueError("sandbox Mise volume session label does not match")
    worker_ip = _run(
        ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}', container]
    )
    gateway_ip = _run(
        ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{GATEWAY_NETWORK}").IPAddress}}}}', GATEWAY_NETWORK_CONTAINER]
    )
    relay_ip = _run(
        ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network]
    )
    if not worker_ip or not gateway_ip or not relay_ip:
        raise ValueError("sandbox network addresses are missing")
    subprocess.run([DOCKER, "restart", container], check=True, capture_output=True)
    return {
        "exists": True,
        "running": True,
        "container": container,
        "workspace": "/workspace",
        "workerAddress": worker_ip,
        "gatewayAddress": gateway_ip,
        "relayAddress": relay_ip,
    }


async def _stream_exec(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, request: dict[str, Any]) -> None:
    session = _session(request.get("sessionId"))
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
        "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "CLIPROXYAPI_BASE_URL", "CLIPROXYAPI_API_KEY",
    }
    if set(env) - allowed_env:
        raise ValueError("environment contains unsupported variables")
    container_record = await _docker_api_json(
        "GET", f"/containers/{_container(session)}/json"
    )
    container_config = container_record.get("Config")
    labels = container_config.get("Labels") if isinstance(container_config, dict) else None
    if not isinstance(labels, dict) or labels.get("partitura.session") != session:
        raise ValueError("sandbox container session label does not match")
    if labels.get("partitura.worker_uid") != worker_uid:
        raise ValueError("sandbox container worker uid does not match")
    exec_record = await _docker_api_json(
        "POST",
        f"/containers/{_container(session)}/exec",
        {
            "AttachStdin": True,
            "AttachStdout": True,
            "AttachStderr": True,
            "Tty": False,
            "Cmd": argv,
            "Env": [f"{key}={value}" for key, value in env.items()],
            "WorkingDir": cwd,
            "User": f"{worker_uid}:{worker_uid}",
        },
    )
    exec_id = exec_record.get("Id")
    if not isinstance(exec_id, str) or not re.fullmatch(r"[a-f0-9]{12,64}", exec_id):
        raise ValueError("Docker API returned an invalid exec id")
    docker_reader, docker_writer = await asyncio.open_unix_connection(DOCKER_SOCKET)
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
                if kind == b"C":
                    break
                if kind != b"I" or length > 4 * 1024 * 1024:
                    raise ValueError("invalid input frame")
                docker_writer.write(await reader.readexactly(length))
                await docker_writer.drain()
        except asyncio.IncompleteReadError:
            pass
        except ConnectionError:
            docker_writer.close()
            return
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
    exit_info = await _docker_api_json("GET", f"/exec/{exec_id}/json")
    code = exit_info.get("ExitCode", 1)
    if not isinstance(code, int) or code < 0 or code > 255:
        code = 1
    writer.write(b"X" + code.to_bytes(4, "big"))


async def _stream_relay(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, request: dict[str, Any]
) -> None:
    session = _session(request.get("sessionId"))
    target = request.get("target")
    port = request.get("targetPort")
    if target not in ("gateway", "worker"):
        raise ValueError("relay target must be gateway or worker")
    if not isinstance(port, int) or isinstance(port, bool) or port < 1 or port > 65535:
        raise ValueError("relay target port is invalid")
    network = _network(session)
    container = _container(session)
    worker_ip = _run(
        ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}', container]
    )
    gateway_ip = _run(
        ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{GATEWAY_NETWORK}").IPAddress}}}}', GATEWAY_NETWORK_CONTAINER]
    )
    relay_ip = _run(
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
    writer.write((json.dumps({"ok": True, "result": {"address": relay_ip, "port": relay_port}}) + "\n").encode())
    await writer.drain()
    try:
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


async def _stream_egress(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, request: dict[str, Any]
) -> None:
    if not EGRESS_HOSTS:
        raise ValueError("PARTITURA_SANDBOX_EGRESS_HOSTS must not be empty")
    session = _session(request.get("sessionId"))
    network = _network(session)
    container = _container(session)
    worker_ip = _run(
        ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}', container]
    )
    relay_ip = _run(
        ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network]
    )
    if not all(ipaddress.ip_address(value).version == 4 for value in (worker_ip, relay_ip)):
        raise ValueError("egress proxy requires IPv4 Docker addresses")
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
            if not isinstance(peer, tuple) or peer[0] != worker_ip:
                return
            try:
                header = await asyncio.wait_for(client_reader.readuntil(b"\r\n\r\n"), timeout=5)
            except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError):
                return
            if len(header) > 8192:
                client_writer.write(b"HTTP/1.1 413 Request Too Large\r\nConnection: close\r\n\r\n")
                await client_writer.drain()
                return
            first = header.split(b"\r\n", 1)[0].decode("ascii", "ignore")
            match = re.fullmatch(r"CONNECT ([A-Za-z0-9.-]+):443 HTTP/1\.[01]", first)
            host = match.group(1).lower() if match else ""
            if not host or host not in EGRESS_HOSTS:
                client_writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
                await client_writer.drain()
                return
            try:
                answers = await asyncio.get_running_loop().getaddrinfo(
                    host, 443, type=socket.SOCK_STREAM
                )
                addresses = {answer[4][0] for answer in answers}
                if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
                    raise ValueError("host resolved to a non-public address")
                remote_reader, remote_writer = await asyncio.open_connection(sorted(addresses)[0], 443)
                active_writers.add(remote_writer)
            except (OSError, ValueError):
                client_writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
                await client_writer.drain()
                return
            client_writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await client_writer.drain()
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

    server = await asyncio.start_server(
        proxy_client, relay_ip, EGRESS_PROXY_PORT, limit=8192
    )
    proxy_port = server.sockets[0].getsockname()[1]
    writer.write((json.dumps({"ok": True, "result": {"address": relay_ip, "port": proxy_port}}) + "\n").encode())
    await writer.drain()
    try:
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
            await _stream_exec(reader, writer, request)
            return
        if operation == "relay":
            await _stream_relay(reader, writer, request)
            return
        if operation == "egress":
            await _stream_egress(reader, writer, request)
            return
        if operation == "provision":
            result = await asyncio.to_thread(provision, request)
        elif operation == "destroy":
            result = await asyncio.to_thread(destroy, request)
        elif operation == "recover":
            result = await asyncio.to_thread(recover, request)
        else:
            raise ValueError("unsupported operation")
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


if __name__ == "__main__":
    asyncio.run(main())
