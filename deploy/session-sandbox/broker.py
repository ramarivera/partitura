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

# Direct-script loading also works in isolated importlib-based broker tests.
sys.path.insert(0, str(Path(__file__).resolve().parent))
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


def egress_addresses(host: str, addresses: set[str]) -> list[str]:
    if host not in EGRESS_HOSTS or not addresses:
        raise ValueError("egress target is not allowed")
    normalized = {str(ipaddress.ip_address(value)) for value in addresses}
    pinned = PRIVATE_EGRESS_ADDRESSES.get(host)
    if pinned is not None:
        if not normalized.issubset(pinned):
            raise ValueError("egress DNS differs from approved address pins")
    elif any(not ipaddress.ip_address(value).is_global for value in normalized):
        raise ValueError("host resolved to a non-public address")
    return sorted(normalized)


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
    if vm.load(session) is None:
        _save_docker_owner(session, {"sessionId": session, "runtime": "sysbox", "workerUid": worker_uid, "workspaceHost": str(workspace)})
    _docker_mutate(session, ["restart", container])
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
        if record is not None and record["runtime"] == "firecracker":
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
        "PI_CLAUDE_DRIVER", "PI_CLAUDE_AUTH", "PI_CLAUDE_EXECUTABLE",
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
            "Cmd": ["/opt/partitura/bin/python3", "-I", "-S", "-c", SYSBOX_EXEC_WRAPPER, *argv],
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
    try:
        _allow_listener(expected_peer, relay_ip, relay_port, network if target == "gateway" else GATEWAY_NETWORK)
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
        _cleanup_firewall()


async def _stream_egress(
    reader: asyncio.StreamReader, writer: asyncio.StreamWriter, request: dict[str, Any], record: dict[str, Any] | None = None
) -> None:
    if not EGRESS_HOSTS:
        raise ValueError("PARTITURA_SANDBOX_EGRESS_HOSTS must not be empty")
    session = _session(request.get("sessionId"))
    network = _network(session)
    container = _container(session)
    if record is None:
        worker_ip = _run(
            ["inspect", "--format", f'{{{{(index .NetworkSettings.Networks "{network}").IPAddress}}}}', container]
        )
        relay_ip = _run(
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
                addresses = egress_addresses(host, {answer[4][0] for answer in answers})
                remote_reader, remote_writer = await asyncio.open_connection(addresses[0], 443)
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

    guest_writer = None
    unix_path = None
    if record is None:
        server = await asyncio.start_server(proxy_client, relay_ip, EGRESS_PROXY_PORT, limit=8192)
        proxy_port = server.sockets[0].getsockname()[1]
    else:
        unix_path = vm.VM_ROOT / vm.key(session) / "v.sock_1081"
        unix_path.unlink(missing_ok=True)
        server = await asyncio.start_unix_server(proxy_client, path=str(unix_path), limit=8192)
        os.chmod(unix_path, 0o666)
        proxy_port = EGRESS_PROXY_PORT
    try:
        if record is None:
            _allow_listener(worker_ip, relay_ip, proxy_port, network)
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
            _cleanup_firewall()


async def _vm_relay(reader, writer, request, record):
    target, port = request.get("target"), request.get("targetPort")
    if target not in ("gateway", "worker") or not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError("relay target or port is invalid")
    gateway_ip, bridge_ip = _gateway_routing()
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
            if GATEWAY_INTERFACE:
                _allow_interface_listener(gateway_ip, relay_ip, relay_port, GATEWAY_INTERFACE)
            else:
                _allow_listener(gateway_ip, relay_ip, relay_port, GATEWAY_NETWORK)
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
            _cleanup_firewall()

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
            record = _owned_runtime(request)
            if record["runtime"] == "firecracker":
                await _vm_exec(reader, writer, request, record)
            else:
                await _stream_exec(reader, writer, request)
            return
        if operation == "relay":
            record = _owned_runtime(request)
            if record["runtime"] == "firecracker":
                await _vm_relay(reader, writer, request, record)
            else:
                await _stream_relay(reader, writer, request)
            return
        if operation == "egress":
            record = _owned_runtime(request)
            await _stream_egress(reader, writer, request, record if record["runtime"] == "firecracker" else None)
            return
        if operation == "provision":
            result = await asyncio.to_thread(provision, request)
        elif operation == "destroy":
            result = await asyncio.to_thread(destroy, request)
        elif operation == "recover":
            result = await asyncio.to_thread(recover, request)
        else:
            raise ValueError("unsupported operation")
        if operation in ("provision", "recover") and result.get("runtime") == "firecracker" and result.get("exists", True):
            record = _owned_runtime(request)
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


if __name__ == "__main__":
    if sys.argv[1:] == ["--cleanup-firewall"]:
        _cleanup_firewall()
    elif sys.argv[1:]:
        raise SystemExit("unsupported broker arguments")
    else:
        asyncio.run(main())
