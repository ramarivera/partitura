#!/usr/bin/env python3
"""Single lifecycle broker for Firecracker and selectable Sysbox sandboxes.

The broker accepts one JSON request per Unix socket connection. It deliberately
does not implement the Docker Engine API. Docker's socket stays on the host.
"""

from __future__ import annotations

import asyncio
import errno
import json
import ipaddress
import os
import re
import shlex
import secrets
import sys
import socket
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

# Direct-script loading also works in isolated importlib-based broker tests.
_source_root = Path(__file__).resolve().parents[1]
# In a zipapp __file__ is inside broker.py; firecracker.py stays beside it.
if _source_root.is_file():
    _source_root = _source_root.parent
sys.path.insert(0, str(_source_root))
import firecracker as vm

SESSION_RE = re.compile(r"^[a-zA-Z0-9_-]{1,96}$")
CONTAINER_PREFIX = "partitura-session-"
NETWORK_PREFIX = "partitura-network-"
SANDBOX_IMAGE = os.environ.get("PARTITURA_SANDBOX_IMAGE", "")
GATEWAY_CONTAINER = os.environ.get("PARTITURA_GATEWAY_CONTAINER", "")
GATEWAY_NETWORK = os.environ.get("PARTITURA_GATEWAY_NETWORK", "")
GATEWAY_ADDRESS = os.environ.get("PARTITURA_GATEWAY_ADDRESS", "")
GATEWAY_RELAY_ADDRESS = os.environ.get("PARTITURA_GATEWAY_RELAY_ADDRESS", "")
GATEWAY_INTERFACE = os.environ.get("PARTITURA_GATEWAY_INTERFACE", "")
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
EGRESS_MODE = os.environ.get("PARTITURA_SANDBOX_EGRESS_MODE", "public-web")
if EGRESS_MODE not in ("public-web", "allowlist"):
    raise ValueError("sandbox egress mode must be public-web or allowlist")
MANAGE_FIREWALL = os.environ.get("PARTITURA_SANDBOX_MANAGE_FIREWALL", "false") == "true"
IPTABLES = "/usr/bin/iptables"
EGRESS_HOSTS = frozenset(
    host.strip().lower()
    for host in os.environ.get("PARTITURA_SANDBOX_EGRESS_HOSTS", "").split(",")
    if host.strip()
)


def private_egress_addresses(raw: str) -> dict[str, frozenset[str]]:
    """Root-configured exact address pins, never a blanket private-network grant."""
    mapping = json.loads(raw)
    if not isinstance(mapping, dict):
        raise ValueError("private egress pins must be an object")
    result = {}
    for host, values in mapping.items():
        if host not in EGRESS_HOSTS or not isinstance(values, list) or not values or not all(isinstance(value, str) for value in values):
            raise ValueError("private egress pins require an allowed hostname and addresses")
        addresses = frozenset(str(ipaddress.ip_address(value)) for value in values)
        for value in addresses:
            address = ipaddress.ip_address(value)
            if address.is_global or address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified or address.is_reserved:
                raise ValueError("private egress pin is not an eligible private address")
        result[host] = addresses
    return result


PRIVATE_EGRESS_ADDRESSES = private_egress_addresses(
    os.environ.get("PARTITURA_SANDBOX_PRIVATE_EGRESS_ADDRESSES_JSON", "{}")
)


def egress_addresses(host: str, addresses: set[str], port: int = 443) -> list[str]:
    if port not in (80, 443) or not addresses or (EGRESS_MODE == "allowlist" and host not in EGRESS_HOSTS):
        raise ValueError("egress target is not allowed")
    normalized = {str(ipaddress.ip_address(value)) for value in addresses}
    pinned = PRIVATE_EGRESS_ADDRESSES.get(host)
    if pinned is not None:
        if port != 443 or not normalized.issubset(pinned):
            raise ValueError("egress DNS differs from approved address pins")
    elif any(not ipaddress.ip_address(value).is_global for value in normalized):
        raise ValueError("host resolved to a non-public address")
    return sorted(normalized)


def proxy_target(header: bytes) -> tuple[str, int, bytes | None]:
    """Parse a public web proxy request without forwarding proxy credentials."""
    first, *lines = header[:-4].split(b"\r\n")
    method, target, version = first.decode("ascii").split(" ")
    if not re.fullmatch(r"[A-Z]+", method) or version not in ("HTTP/1.0", "HTTP/1.1"):
        raise ValueError("invalid proxy request")
    parsed = urlsplit("//" + target if method == "CONNECT" else target)
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host or parsed.username is not None or parsed.password is not None or parsed.fragment:
        raise ValueError("invalid proxy authority")
    port = parsed.port or (443 if method == "CONNECT" else 80)
    if port not in (80, 443):
        raise ValueError("proxy supports public HTTP and HTTPS only")
    if method == "CONNECT":
        if parsed.path or parsed.query:
            raise ValueError("invalid CONNECT target")
        return host, port, None
    if parsed.scheme != "http" or port != 80:
        raise ValueError("HTTP proxy requests must use an http URL on port 80")
    path = (parsed.path or "/") + ("?" + parsed.query if parsed.query else "")
    forwarded = [f"{method} {path} {version}".encode("ascii")]
    for line in lines:
        name, separator, _ = line.partition(b":")
        if not separator or not name or name.strip() != name:
            raise ValueError("invalid proxy header")
        if name.lower() not in (b"host", b"proxy-authorization", b"proxy-connection", b"connection"):
            forwarded.append(line)
    authority = f"[{host}]" if ":" in host else host
    forwarded.extend([f"Host: {authority}".encode("ascii"), b"Connection: close", b"", b""])
    return host, port, b"\r\n".join(forwarded)


def _firewall_tag() -> str:
    invocation = os.environ.get("INVOCATION_ID", "")
    if not re.fullmatch(r"[a-f0-9]{32}", invocation):
        raise ValueError("managed firewall requires a systemd invocation id")
    return "partitura-sandbox-" + invocation


def _allow_listener(peer: str, address: str, port: int, network: str) -> None:
    """Allow only this listener's expected peer through the host INPUT chain."""
    if not MANAGE_FIREWALL:
        return
    if not all(ipaddress.ip_address(value).version == 4 for value in (peer, address)):
        raise ValueError("managed firewall requires IPv4 listener addresses")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError("managed firewall requires a valid listener port")
    tag = _firewall_tag()
    metadata = json.loads(_run(["network", "inspect", network]))[0]
    if metadata.get("Driver") != "bridge" or not re.fullmatch(r"[a-f0-9]{64}", metadata.get("Id", "")):
        raise ValueError("managed firewall requires a Docker bridge network")
    bridge = metadata.get("Options", {}).get("com.docker.network.bridge.name") or "br-" + metadata["Id"][:12]
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,15}", bridge):
        raise ValueError("managed firewall requires a valid bridge interface")
    _allow_interface_listener(peer, address, port, bridge)


def _allow_interface_listener(peer: str, address: str, port: int, bridge: str) -> None:
    if not MANAGE_FIREWALL:
        return
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,15}", bridge):
        raise ValueError("managed firewall requires a valid interface")
    if not all(ipaddress.ip_address(value).version == 4 for value in (peer, address)):
        raise ValueError("managed firewall requires IPv4 listener addresses")
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError("managed firewall requires a valid listener port")
    tag = _firewall_tag()
    subprocess.run(
        [IPTABLES, "-w", "5", "-I", "INPUT", "1", "-i", bridge, "-p", "tcp",
         "-s", peer + "/32", "-d", address + "/32", "--dport", str(port),
         "-m", "comment", "--comment", tag, "-j", "ACCEPT"],
        check=True, capture_output=True, timeout=10,
    )


def _cleanup_firewall() -> None:
    """Also runs in ExecStopPost, including after a killed broker request."""
    if not MANAGE_FIREWALL:
        return
    tag = _firewall_tag()
    result = subprocess.run(
        [IPTABLES, "-w", "5", "-S", "INPUT"], check=True,
        capture_output=True, text=True, timeout=10,
    )
    for line in result.stdout.splitlines():
        rule = shlex.split(line)
        if rule[:2] != ["-A", "INPUT"]:
            continue
        if not any(rule[index:index + 2] == ["--comment", tag] for index in range(len(rule) - 1)):
            continue
        subprocess.run(
            [IPTABLES, "-w", "5", "-D", *rule[1:]], check=True,
            capture_output=True, timeout=10,
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


class DockerMutationFenceError(RuntimeError):
    """An unfinished or ambiguous mutation still owns its session resources."""


def _save_docker_owner(session: str, record: dict[str, Any]) -> None:
    vm.save(session, record)
    descriptor = os.open(vm.STATE_ROOT, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _docker_operation_status(unit: str) -> dict[str, str]:
    try:
        result = subprocess.run(
            ["/usr/bin/systemctl", "show", unit,
             "--property=LoadState,ActiveState,SubState,ExecMainCode,ExecMainStatus"],
            check=True, capture_output=True, text=True, timeout=5,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        raise DockerMutationFenceError("Docker mutation status unavailable; ownership retained") from None
    return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)


def _finish_docker_operation(session: str, record: dict[str, Any]) -> None:
    operation = record["dockerOperation"]
    # Only a previously verified normal successful exit permits stopping this
    # RemainAfterExit unit. Pending Docker clients are never signalled here.
    try:
        result = subprocess.run(["/usr/bin/systemctl", "stop", operation["unit"]],
            check=False, capture_output=True, text=True, timeout=5)
    except (subprocess.TimeoutExpired, OSError):
        raise DockerMutationFenceError("Docker mutation cleanup pending; ownership retained") from None
    if result.returncode != 0 and "not loaded" not in result.stderr.lower() and "not found" not in result.stderr.lower():
        raise DockerMutationFenceError("Docker mutation cleanup failed; ownership retained")
    record.pop("dockerOperation")
    _save_docker_owner(session, record)


def _settle_docker_operation(session: str, timeout: float = 60) -> None:
    record = vm.load(session)
    if record is None or "dockerOperation" not in record:
        return
    operation = record["dockerOperation"]
    expected = r"partitura-docker-" + vm.key(session) + r"-[a-f0-9]{32}\.service"
    if not isinstance(operation, dict) or not isinstance(operation.get("unit"), str) or not re.fullmatch(expected, operation["unit"]):
        raise DockerMutationFenceError("Docker mutation ownership is invalid; ownership retained")
    if operation.get("completed") is True:
        _finish_docker_operation(session, record)
        return
    deadline = time.monotonic() + timeout
    while True:
        state = _docker_operation_status(operation["unit"])
        if state.get("LoadState") == "not-found":
            # This also fences a broker crash between saving intent and unit
            # submission, and lost transient-unit evidence after a host reboot.
            raise DockerMutationFenceError("Docker mutation result is missing; ownership retained")
        terminal = state.get("SubState") in ("exited", "dead", "failed") and (state.get("ExecMainCode") != "0" or state.get("SubState") == "failed")
        if terminal:
            if state.get("ExecMainCode") != "1" or state.get("ExecMainStatus") != "0":
                # A killed client, daemon disconnect or nonzero CLI exit does
                # not prove that the daemon abandoned its asynchronous work.
                raise DockerMutationFenceError("Docker mutation result is ambiguous; ownership retained")
            operation["completed"] = True
            _save_docker_owner(session, record)
            _finish_docker_operation(session, record)
            return
        if time.monotonic() >= deadline:
            raise DockerMutationFenceError("Docker mutation still pending; retry teardown")
        time.sleep(min(0.1, max(0, deadline - time.monotonic())))


def _docker_mutate(session: str, args: list[str], timeout: float = 60) -> subprocess.CompletedProcess:
    _settle_docker_operation(session, timeout=timeout)
    record = vm.load(session)
    if record is None or record["runtime"] != "sysbox":
        raise DockerMutationFenceError("Docker mutation has no lifecycle owner")
    operation_unit = "partitura-docker-" + vm.key(session) + "-" + secrets.token_hex(16) + ".service"
    config_directory = operation_unit.removesuffix(".service")
    record["dockerOperation"] = {"unit": operation_unit, "completed": False}
    # Persist the intent before the system manager can submit a daemon request.
    _save_docker_owner(session, record)
    try:
        subprocess.run(
            ["/usr/bin/systemd-run", "--quiet", "--no-block", "--unit", operation_unit,
             "--property=Type=exec", "--property=RemainAfterExit=yes",
             "--property=NoNewPrivileges=yes", "--property=CapabilityBoundingSet=",
             "--property=PrivateNetwork=yes", "--property=PrivateTmp=yes",
             "--property=ProtectSystem=strict", "--property=ProtectHome=yes",
             "--property=RuntimeDirectory=" + config_directory, "--property=RuntimeDirectoryMode=0700",
             "--property=RestrictAddressFamilies=AF_UNIX", "--property=TasksMax=64",
             "--property=MemoryMax=256M", "--property=StandardOutput=null", "--property=StandardError=null",
             DOCKER, "--config", "/run/" + config_directory, "--host", "unix://" + DOCKER_SOCKET, *args],
            check=True, capture_output=True, text=True, timeout=10,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        raise DockerMutationFenceError("Docker mutation submission is ambiguous; ownership retained") from None
    # Only this caller's wait is bounded. Its timeout never kills the managed
    # Docker client or forgets the daemon request that client still owns.
    _settle_docker_operation(session, timeout=timeout)
    return subprocess.CompletedProcess([DOCKER, *args], 0, "", "")


def _container(session: str) -> str:
    return CONTAINER_PREFIX + session


def _network(session: str) -> str:
    return NETWORK_PREFIX + session


def _remove_owned(kind: str, name: str, session: str, stopped: bool = False) -> None:
    try:
        inspected = subprocess.run(
            [DOCKER, kind, "inspect", name],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Docker {kind} ownership check timed out; retry teardown") from None
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
    if kind == "container" and records[0].get("State", {}).get("Running") is True:
        if stopped:
            raise RuntimeError("Docker container remained running after stop; retry teardown")
        _docker_mutate(session, ["stop", "--timeout", "10", name], timeout=20)
        # Stop lets worker-init deliver TERM to nested dockerd before Docker's
        # own bounded kill deadline. Re-inspect ownership after that mutation.
        return _remove_owned(kind, name, session, stopped=True)
    action = {"container": "rm", "network": "network rm", "volume": "volume rm"}[kind]
    # Sysbox may spend over a minute reverting the shifted filesystem. The
    # mutation owner fences pending or ambiguous results before another request
    # can inspect resources or submit a retry.
    _docker_mutate(session, [*action.split(), name], timeout=120 if kind == "container" else 30)


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
    try:
        limit = 8 * 1024 * 1024
        if "chunked" in headers.get("transfer-encoding", "").lower():
            response = bytearray()
            while True:
                size = int((await reader.readline()).split(b";", 1)[0].strip(), 16)
                if size < 0 or len(response) + size > limit:
                    raise ValueError("Docker response exceeds limit")
                if size == 0:
                    while await reader.readline() not in (b"\r\n", b""):
                        pass
                    break
                response.extend(await reader.readexactly(size))
                if await reader.readexactly(2) != b"\r\n":
                    raise ValueError("invalid Docker response chunk")
        elif "content-length" in headers:
            body_length = int(headers["content-length"])
            if not 0 <= body_length <= limit:
                raise ValueError("Docker response exceeds limit")
            response = await reader.readexactly(body_length)
        else:
            response = bytearray()
            while chunk := await reader.read(65536):
                response.extend(chunk)
                if len(response) > limit:
                    raise ValueError("Docker response exceeds limit")
    finally:
        writer.close()
        await writer.wait_closed()
    if b" 2" not in status:
        raise RuntimeError("Docker API request failed")
    return json.loads(response) if response else {}


def _sysbox_provision(request: dict[str, Any]) -> dict[str, Any]:
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
    try:
        _docker_mutate(session, ["network", "create", "--internal", "--label", f"partitura.session={session}", network])
        relay_ip = _run(
            ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network]
        )
        if ipaddress.ip_address(relay_ip).version != 4:
            raise ValueError("sandbox egress proxy requires an IPv4 bridge gateway")
        egress_proxy = f"http://{relay_ip}:{EGRESS_PROXY_PORT}"
        _docker_mutate(session, ["volume", "create", "--label", f"partitura.session={session}", f"partitura-mise-{session}"])
        volume = json.loads(_run(["volume", "inspect", f"partitura-mise-{session}"]))[0]
        if volume.get("Labels", {}).get("partitura.session") != session:
            raise ValueError("Mise volume session label does not match")
        _docker_mutate(session,
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
                "--env",
                "DOCKER_DATA_ROOT=/var/lib/docker",
                "--security-opt=no-new-privileges",
                "--env",
                f"HTTP_PROXY={egress_proxy}",
                "--env",
                f"HTTPS_PROXY={egress_proxy}",
                "--env",
                "NODE_USE_ENV_PROXY=1",
                "--env",
                f"NO_PROXY=localhost,127.0.0.1,::1,host.docker.internal,{relay_ip}",
                "--mount",
                f"type=bind,src={workspace},dst=/workspace,readonly=false",
                "--mount",
                f"type=volume,src=partitura-mise-{session},dst=/mise,readonly=false",
                "--tmpfs",
                "/run:rw,nosuid,nodev,size=64m",
                "--tmpfs",
                "/tmp:rw,nosuid,nodev,size=1g",
                SANDBOX_IMAGE,
            ]
        )
        _docker_mutate(session, ["start", container])
        worker_ip = _run(
            ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}', container]
        )
        gateway_ip = _run(
            ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{GATEWAY_NETWORK}").IPAddress}}}}', GATEWAY_NETWORK_CONTAINER]
        )
        if not worker_ip or not gateway_ip or not relay_ip:
            raise RuntimeError("Docker did not assign required network addresses")
    except DockerMutationFenceError:
        raise
    except Exception:
        try:
            _sysbox_destroy({"sessionId": session})
        except Exception as cleanup_error:
            raise RuntimeError("sandbox provisioning failed; retry teardown") from cleanup_error
        raise
    return {"container": container, "workspace": "/workspace", "workerAddress": worker_ip, "gatewayAddress": gateway_ip, "relayAddress": relay_ip}


def _sysbox_destroy(request: dict[str, Any]) -> dict[str, Any]:
    session = _session(request.get("sessionId"))
    _settle_docker_operation(session)
    _remove_owned("container", _container(session), session)
    _remove_owned("network", _network(session), session)
    _remove_owned("volume", f"partitura-mise-{session}", session)
    return {"destroyed": True}


def _sysbox_recover(request: dict[str, Any]) -> dict[str, Any]:
    session = _session(request.get("sessionId"))
    _settle_docker_operation(session)
    worker_uid = _worker_uid(request.get("workerUid"))
    workspace = _workspace(request.get("workspacePath"))
    container = _container(session)
    result = subprocess.run(
        [DOCKER, "inspect", "--format", "{{.State.Running}}", container],
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    if result.returncode != 0:
        diagnostic = f"{result.stdout}\n{result.stderr}".lower()
        if "no such" in diagnostic or "not found" in diagnostic:
            return {"exists": False, "running": False}
        raise RuntimeError("Docker recovery ownership check failed; ownership retained")
    labels = subprocess.run(
        [DOCKER, "inspect", "--format", "{{json .Config.Labels}}", container],
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    if labels.returncode != 0:
        raise RuntimeError("Docker recovery ownership check failed; ownership retained")
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
        timeout=10,
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
        timeout=10,
    )
    if volume_info.returncode != 0:
        raise ValueError("sandbox Mise volume is missing")
    volume_record = json.loads(volume_info.stdout)[0]
    if volume_record.get("Labels", {}).get("partitura.session") != session:
        raise ValueError("sandbox Mise volume session label does not match")
    if vm.load(session) is None:
        _save_docker_owner(session, {"sessionId": session, "runtime": "sysbox", "workerUid": worker_uid, "workspaceHost": str(workspace)})
    _docker_mutate(session, ["restart", container])
    # A stopped endpoint has no address, and restart can assign a different IP.
    # Validate ownership before restarting, then read the resulting network.
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
    return {
        "exists": True,
        "running": True,
        "container": container,
        "workspace": "/workspace",
        "workerAddress": worker_ip,
        "gatewayAddress": gateway_ip,
        "relayAddress": relay_ip,
    }


def _runtime(request: dict[str, Any]) -> str:
    runtime = request.get("runtime", "firecracker")
    if runtime not in ("firecracker", "sysbox"):
        raise ValueError("runtime must be firecracker or sysbox")
    return runtime


def _gateway_routing() -> tuple[str, str]:
    if GATEWAY_ADDRESS or GATEWAY_RELAY_ADDRESS or GATEWAY_INTERFACE:
        if not GATEWAY_ADDRESS or not GATEWAY_RELAY_ADDRESS or not GATEWAY_INTERFACE:
            raise ValueError("native gateway routing requires address, relay address and interface")
        gateway_ip, bridge_ip = GATEWAY_ADDRESS, GATEWAY_RELAY_ADDRESS
    else:
        gateway_ip = _run(["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{GATEWAY_NETWORK}").IPAddress}}}}', GATEWAY_NETWORK_CONTAINER])
        bridge_ip = _run(["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", GATEWAY_NETWORK])
    if not all(ipaddress.ip_address(value).version == 4 for value in (gateway_ip, bridge_ip)):
        raise ValueError("gateway relay requires IPv4 addresses")
    return gateway_ip, bridge_ip


def provision(request: dict[str, Any]) -> dict[str, Any]:
    session = _session(request.get("sessionId"))
    runtime = _runtime(request)
    uid = _worker_uid(request.get("workerUid"))
    workspace = _workspace(request.get("workspacePath"))
    with vm.SessionLock(session):
        if vm.load(session) is not None:
            raise ValueError("sandbox already exists; recover or destroy it first")
        if runtime == "firecracker":
            vm.provision(session, uid, workspace)
            vm.start_workspace(session)
            return {"runtime": runtime, "container": _container(session), "workspace": "/workspace",
                    "workerAddress": "127.0.0.1", "gatewayAddress": _gateway_routing()[0], "relayAddress": "127.0.0.1"}
        vm.save(session, {"sessionId": session, "runtime": runtime, "workerUid": uid,
                          "workspaceHost": str(workspace)})
        result = _sysbox_provision(request)
        return {**result, "runtime": runtime}


def recover(request: dict[str, Any]) -> dict[str, Any]:
    session = _session(request.get("sessionId"))
    runtime = _runtime(request)
    uid = _worker_uid(request.get("workerUid"))
    workspace = _workspace(request.get("workspacePath"))
    with vm.SessionLock(session):
        record = vm.load(session)
        if record is None:
            # Legacy Sysbox resources retain their Docker ownership checks.
            if runtime == "sysbox":
                result = _sysbox_recover(request)
                if result.get("exists"):
                    vm.save(session, {"sessionId": session, "runtime": runtime, "workerUid": uid,
                                      "workspaceHost": str(workspace)})
                return {**result, "runtime": runtime}
            return {"runtime": runtime, "exists": False, "running": False}
        if record["runtime"] != runtime or record["workerUid"] != uid or record["workspaceHost"] != str(workspace):
            raise ValueError("sandbox recovery ownership or runtime does not match")
        if runtime == "sysbox":
            return {**_sysbox_recover(request), "runtime": runtime}
        # Let PID 1 stop Docker and flush completed writes before retiring all
        # orphan execs. A hard VMM stop can lose ext4 delayed-allocation data.
        vm.stop_for_recovery(record)
        vm.start(session)
        vm.start_workspace(session)
        return {"runtime": runtime, "exists": True, "running": True, "container": _container(session),
                "workspace": "/workspace", "workerAddress": "127.0.0.1", "gatewayAddress": _gateway_routing()[0], "relayAddress": "127.0.0.1"}


def destroy(request: dict[str, Any]) -> dict[str, Any]:
    session = _session(request.get("sessionId"))
    with vm.SessionLock(session):
        record = vm.load(session)
        # Older gateways omitted runtime and may still own legacy Sysbox
        # resources. New callers retain runtime even after teardown removes
        # the lifecycle record, so repeated VM cleanup never needs Docker.
        requested_runtime = _runtime(request) if "runtime" in request else None
        if record is not None and requested_runtime is not None and record["runtime"] != requested_runtime:
            raise ValueError("sandbox teardown runtime does not match")
        runtime = record["runtime"] if record is not None else requested_runtime
        if runtime == "firecracker":
            vm.destroy(session)
        else:
            if record is None:
                _save_docker_owner(session, {"sessionId": session, "runtime": "sysbox"})
            _sysbox_destroy(request)
            vm.state_path(session).unlink(missing_ok=True)
    return {"destroyed": True}


def _owned_runtime(request: dict[str, Any]) -> dict[str, Any]:
    record = vm.load(_session(request.get("sessionId")))
    if record is None:
        raise ValueError("sandbox has no lifecycle owner; provision or recover first")
    if "workerUid" in request and _worker_uid(request["workerUid"]) != record["workerUid"]:
        raise ValueError("sandbox worker uid does not match")
    return record


async def _vm_exec(reader, writer, request, record):
    if _worker_uid(request.get("workerUid")) != record["workerUid"]:
        raise ValueError("sandbox worker uid does not match")
    guest_reader, guest_writer = await vm.connect(record, {**request, "operation": "exec"})
    inputs = asyncio.create_task(vm.pipe(reader, guest_writer))
    outputs = asyncio.create_task(vm.pipe(guest_reader, writer))
    try:
        done, _ = await asyncio.wait({inputs, outputs}, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
        if inputs in done:
            await outputs
    finally:
        inputs.cancel()
        outputs.cancel()
        await asyncio.gather(inputs, outputs, return_exceptions=True)
        guest_writer.close()
        await guest_writer.wait_closed()


from .streams import SYSBOX_EXEC_WRAPPER, _stream_exec, _stream_relay, _stream_egress, _vm_relay, handle, main
