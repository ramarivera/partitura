"""Docker Engine stream-protocol tests without a Docker daemon."""
import asyncio
import importlib.util
import json
import os
import socket
import subprocess
import sys
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

SANDBOX_DIR = Path(__file__).resolve().parents[1] / "deploy/session-sandbox"
sys.path.insert(0, str(SANDBOX_DIR))
from sandbox_broker import core as broker


def http_response(status: str, body: bytes = b"") -> bytes:
    return (
        f"HTTP/1.1 {status}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
        + body
    )


async def read_request(reader: asyncio.StreamReader) -> tuple[str, bytes]:
    line = await reader.readline()
    headers = {}
    while (header := await reader.readline()) != b"\r\n":
        key, _, value = header.decode().partition(":")
        headers[key.lower()] = value.strip()
    length = int(headers.get("content-length", "0"))
    return line.decode().strip(), await reader.readexactly(length)


class CaptureWriter:
    def __init__(self):
        self.data = bytearray()

    def write(self, data: bytes) -> None:
        self.data.extend(data)

    async def drain(self) -> None:
        return None


class SandboxBrokerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Existing Docker protocol tests isolate the daemon seam. Dedicated
        # lifetime tests below exercise the real durable mutation owner.
        def mutate(session, args, timeout=60):
            try:
                result = broker.subprocess.run([broker.DOCKER, *args], capture_output=True, text=True, check=False, timeout=timeout)
            except subprocess.TimeoutExpired:
                raise broker.DockerMutationFenceError("Docker mutation still pending; retry teardown") from None
            if result.returncode != 0:
                raise broker.DockerMutationFenceError("Docker mutation result is ambiguous; ownership retained")
            return result
        patcher = patch.object(broker, "_docker_mutate", side_effect=mutate)
        patcher.start()
        self.addCleanup(patcher.stop)


    async def test_exec_streams_input_output_and_exit_code_over_engine_hijack(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            socket_path = str(Path(directory) / "docker.sock")
            requests = []
            received_stdin = bytearray()

            async def engine(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
                index = len(requests)
                request, body = await read_request(reader)
                requests.append((request, body))
                if index == 0:
                    self.assertIn(
                        "GET /v1.41/containers/partitura-session-session-1/json",
                        request,
                    )
                    writer.write(
                        http_response(
                            "200 OK",
                            json.dumps(
                                {
                                    "Config": {
                                        "Labels": {
                                            "partitura.session": "session-1",
                                            "partitura.worker_uid": "1001",
                                        }
                                    }
                                }
                            ).encode(),
                        )
                    )
                elif index == 1:
                    writer.write(http_response("201 Created", b'{"Id":"0123456789abcdef"}'))
                elif index == 2:
                    writer.write(
                        b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
                    )
                    await writer.drain()
                    received_stdin.extend(await reader.read())
                    stdout = b"hello from sandbox"
                    stderr = b"build notice"
                    writer.write(
                        b"\x01\x00\x00\x00"
                        + len(stdout).to_bytes(4, "big")
                        + stdout
                        + b"\x02\x00\x00\x00"
                        + len(stderr).to_bytes(4, "big")
                        + stderr
                    )
                else:
                    writer.write(http_response("200 OK", b'{"ExitCode":7}'))
                await writer.drain()
                writer.close()
                await writer.wait_closed()

            server = await asyncio.start_unix_server(engine, path=socket_path)
            previous_socket = broker.DOCKER_SOCKET
            broker.DOCKER_SOCKET = socket_path
            client_reader = asyncio.StreamReader()
            client_reader.feed_data(b"I\x00\x00\x00\x03abcC\x00\x00\x00\x00")
            client_reader.feed_eof()
            client_writer = CaptureWriter()
            try:
                await broker._stream_exec(
                    client_reader,
                    client_writer,
                    {
                        "sessionId": "session-1",
                        "workerUid": "1001",
                        "argv": ["/usr/local/bin/omp", "--version"],
                        "cwd": "/workspace/repo",
                        "env": {
                            "PATH": "/usr/local/bin:/usr/bin",
                            "HTTP_PROXY": "http://172.19.0.1:3128",
                            "HTTPS_PROXY": "http://172.19.0.1:3128",
                            "NODE_USE_ENV_PROXY": "1",
                            "NO_PROXY": "localhost,127.0.0.1",
                            "T3CODE_HOME": "/workspace/.omp-home/t3",
                            "T3CODE_NO_BROWSER": "true",
                            "T3CODE_TELEMETRY_ENABLED": "false",
                            "NIX_SSL_CERT_FILE": "/etc/ssl/certs/ca-certificates.crt",
                            "PI_CLAUDE_DRIVER": "claude-cliproxy",
                            "PI_CLAUDE_AUTH": "credential-ref",
                            "PI_CLAUDE_EXECUTABLE": "/usr/local/bin/claude",
                        },
                    },
                )
            finally:
                broker.DOCKER_SOCKET = previous_socket
                server.close()
                await server.wait_closed()

            self.assertEqual(received_stdin, b"I\x00\x00\x00\x03abcC\x00\x00\x00\x00")
            self.assertIn(b"O\x00\x00\x00\x12hello from sandbox", client_writer.data)
            self.assertIn(b"E\x00\x00\x00\x0cbuild notice", client_writer.data)
            self.assertTrue(client_writer.data.endswith(b"X\x00\x00\x00\x07"))
            create_request, create_body = requests[1]
            self.assertIn("POST /v1.41/containers/partitura-session-session-1/exec", create_request)
            self.assertEqual(json.loads(create_body)["User"], "1001:1001")
            self.assertIn("HTTP_PROXY=http://172.19.0.1:3128", json.loads(create_body)["Env"])
            self.assertIn("NODE_USE_ENV_PROXY=1", json.loads(create_body)["Env"])
            self.assertIn("T3CODE_HOME=/workspace/.omp-home/t3", json.loads(create_body)["Env"])
            self.assertIn("PI_CLAUDE_DRIVER=claude-cliproxy", json.loads(create_body)["Env"])
            self.assertIn("PI_CLAUDE_AUTH=credential-ref", json.loads(create_body)["Env"])
            self.assertIn("PI_CLAUDE_EXECUTABLE=/usr/local/bin/claude", json.loads(create_body)["Env"])
            self.assertIn("POST /v1.41/exec/0123456789abcdef/start", requests[2][0])
            self.assertIn("GET /v1.41/exec/0123456789abcdef/json", requests[3][0])


    async def test_exec_closes_engine_stream_after_a_truncated_frame(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            socket_path = str(Path(directory) / "docker.sock")
            engine_closed = asyncio.Event()
            connection_number = 0

            async def engine(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
                nonlocal connection_number
                current = connection_number
                connection_number += 1
                request, _ = await read_request(reader)
                if current == 0:
                    self.assertIn(
                        "GET /v1.41/containers/partitura-session-session-4/json",
                        request,
                    )
                    writer.write(
                        http_response(
                            "200 OK",
                            json.dumps(
                                {
                                    "Config": {
                                        "Labels": {
                                            "partitura.session": "session-4",
                                            "partitura.worker_uid": "1004",
                                        }
                                    }
                                }
                            ).encode(),
                        )
                    )
                    await writer.drain()
                    writer.close()
                    await writer.wait_closed()
                    return
                elif current == 1:
                    self.assertIn("POST /v1.41/containers/partitura-session-session-4/exec", request)
                    writer.write(http_response("201 Created", b'{"Id":"abcdef123456"}'))
                    await writer.drain()
                    writer.close()
                    await writer.wait_closed()
                    return
                else:
                    self.assertIn("POST /v1.41/exec/abcdef123456/start", request)
                    writer.write(
                        b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
                    )
                    await writer.drain()
                    await reader.read()
                    writer.write(b"\x01\x00\x00\x00\x00\x00\x00\x03x")
                    await writer.drain()
                    writer.close()
                    await writer.wait_closed()
                    engine_closed.set()

            server = await asyncio.start_unix_server(engine, path=socket_path)
            previous_socket = broker.DOCKER_SOCKET
            broker.DOCKER_SOCKET = socket_path
            client_reader = asyncio.StreamReader()
            client_reader.feed_eof()
            client_writer = CaptureWriter()
            try:
                with self.assertRaisesRegex(ValueError, "truncated exec payload"):
                    await broker._stream_exec(
                        client_reader,
                        client_writer,
                        {
                            "sessionId": "session-4",
                            "workerUid": "1004",
                            "argv": ["/usr/local/bin/omp", "--version"],
                            "cwd": "/workspace",
                            "env": {"PATH": "/usr/local/bin:/usr/bin"},
                        },
                    )
                await asyncio.wait_for(engine_closed.wait(), timeout=1)
            finally:
                broker.DOCKER_SOCKET = previous_socket
                server.close()
                await server.wait_closed()


    async def test_exec_output_eof_cancels_open_stdin(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            socket_path = str(Path(directory) / "docker.sock")
            connection_number = 0

            async def engine(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
                nonlocal connection_number
                current = connection_number
                connection_number += 1
                request, _ = await read_request(reader)
                if current == 0:
                    self.assertIn(
                        "GET /v1.41/containers/partitura-session-session-5/json",
                        request,
                    )
                    writer.write(
                        http_response(
                            "200 OK",
                            json.dumps(
                                {
                                    "Config": {
                                        "Labels": {
                                            "partitura.session": "session-5",
                                            "partitura.worker_uid": "1005",
                                        }
                                    }
                                }
                            ).encode(),
                        )
                    )
                    await writer.drain()
                    writer.close()
                    await writer.wait_closed()
                    return
                elif current == 1:
                    self.assertIn("POST /v1.41/containers/partitura-session-session-5/exec", request)
                    writer.write(http_response("201 Created", b'{"Id":"abcdef123456"}'))
                    await writer.drain()
                elif current == 2:
                    self.assertIn("POST /v1.41/exec/abcdef123456/start", request)
                    writer.write(
                        b"HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
                    )
                    await writer.drain()
                else:
                    self.assertIn("GET /v1.41/exec/abcdef123456/json", request)
                    writer.write(http_response("200 OK", b'{"ExitCode":9}'))
                    await writer.drain()
                writer.close()
                await writer.wait_closed()

            server = await asyncio.start_unix_server(engine, path=socket_path)
            previous_socket = broker.DOCKER_SOCKET
            broker.DOCKER_SOCKET = socket_path
            client_reader = asyncio.StreamReader()
            client_writer = CaptureWriter()
            try:
                await asyncio.wait_for(
                    broker._stream_exec(
                        client_reader,
                        client_writer,
                        {
                            "sessionId": "session-5",
                            "workerUid": "1005",
                            "argv": ["/usr/local/bin/omp", "--version"],
                            "cwd": "/workspace",
                            "env": {"PATH": "/usr/local/bin:/usr/bin"},
                        },
                    ),
                    timeout=1,
                )
            finally:
                broker.DOCKER_SOCKET = previous_socket
                server.close()
                await server.wait_closed()

            self.assertTrue(client_writer.data.endswith(b"X\x00\x00\x00\x09"))


    async def test_relay_control_close_closes_active_streams(self):
        target_connected = asyncio.Event()
        target_closed = asyncio.Event()

        async def target(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
            target_connected.set()
            await reader.read()
            target_closed.set()
            writer.close()
            await writer.wait_closed()

        target_server = await asyncio.start_server(target, "127.0.0.1", 0)
        target_port = target_server.sockets[0].getsockname()[1]

        control_reader = asyncio.StreamReader()
        control_writer = CaptureWriter()
        relay_reader = None
        relay_writer = None
        relay_task = None
        try:
            with patch.object(broker, "_run", side_effect=["127.0.0.1"] * 3):
                relay_task = asyncio.create_task(
                    broker._stream_relay(
                        control_reader,
                        control_writer,
                        {"sessionId": "session-6", "target": "gateway", "targetPort": target_port},
                    )
                )
                while b"\n" not in control_writer.data:
                    await asyncio.sleep(0)
            response = bytes(control_writer.data).split(b"\n", 1)[0]
            relay = json.loads(response)["result"]
            relay_reader, relay_writer = await asyncio.open_connection(
                relay["address"], relay["port"]
            )
            await asyncio.wait_for(target_connected.wait(), timeout=1)
            control_reader.feed_eof()
            await asyncio.wait_for(relay_task, timeout=1)
            self.assertEqual(await asyncio.wait_for(relay_reader.read(), timeout=1), b"")
            await asyncio.wait_for(target_closed.wait(), timeout=1)
        finally:
            if relay_task is not None and not relay_task.done():
                relay_reader.feed_eof()
                await relay_task
            if relay_writer is not None:
                relay_writer.close()
                await relay_writer.wait_closed()
            target_server.close()
            await target_server.wait_closed()


    async def test_vm_gateway_relay_uses_guest_port_range_and_preserves_colliding_socket(self):
        for samples, expected_port in (([65535 - 2000], 65535), ([0, 1], 2001)):
            with self.subTest(samples=samples), tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
                root = Path(directory)
                record = {"sessionId": "relay-session"}
                machine = root / broker.vm.key(record["sessionId"])
                machine.mkdir()
                occupied = machine / "v.sock_2000"
                existing = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                existing.bind(str(occupied))
                existing.listen()
                inode = occupied.stat().st_ino
                guest_reader = asyncio.StreamReader()
                guest_reader.feed_data(b'{"ok":true,"port":1234}\n')
                guest_writer = SimpleNamespace(close=Mock(), wait_closed=AsyncMock())
                control_reader = asyncio.StreamReader()
                control_reader.feed_eof()
                control_writer = CaptureWriter()
                connect = AsyncMock(return_value=(guest_reader, guest_writer))
                try:
                    with patch.object(broker.vm, "VM_ROOT", root), patch.object(broker, "_gateway_routing", return_value=("127.0.0.1", "127.0.0.1")), patch.object(broker.secrets, "randbelow", side_effect=samples) as random, patch.object(broker.vm, "connect", new=connect):
                        await broker._vm_relay(control_reader, control_writer, {"target": "gateway", "targetPort": 8080}, record)
                    connect.assert_awaited_once_with(record, {"operation": "listen", "port": 0, "targetPort": expected_port})
                    self.assertEqual(random.call_count, len(samples))
                    for call in random.call_args_list:
                        self.assertEqual(call.args, (65536 - 2000,))
                    self.assertEqual(json.loads(control_writer.data)["result"]["port"], 1234)
                    self.assertFalse((machine / ("v.sock_" + str(expected_port))).exists())
                    self.assertEqual(occupied.stat().st_ino, inode)
                    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    try:
                        probe.connect(str(occupied))
                    finally:
                        probe.close()
                    guest_writer.close.assert_called_once_with()
                    guest_writer.wait_closed.assert_awaited_once_with()
                finally:
                    existing.close()


    async def test_public_web_proxy_forwards_http_and_connect_and_denies_private_dns(self):
        received = []

        async def origin(reader, writer):
            received.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(http_response("200 OK", b"registry response"))
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        upstream = await asyncio.start_server(origin, "127.0.0.1", 0)
        port = upstream.sockets[0].getsockname()[1]
        connect = asyncio.open_connection
        destinations = []

        async def dial(address, target_port):
            destinations.append((address, target_port))
            return await connect("127.0.0.1", port)

        async def resolve(host, target_port, **kwargs):
            address = "127.0.0.1" if host == "private.example" else "1.1.1.1"
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, target_port))]

        control = asyncio.StreamReader()
        status = CaptureWriter()
        with (
            patch.object(broker, "_run", side_effect=["127.0.0.1"] * 2),
            patch.object(broker, "EGRESS_MODE", "public-web"),
            patch.object(broker, "EGRESS_HOSTS", frozenset()),
            patch.object(broker, "EGRESS_PROXY_PORT", 0),
            patch.object(asyncio.get_running_loop(), "getaddrinfo", side_effect=resolve),
            patch.object(broker.asyncio, "open_connection", side_effect=dial),
        ):
            task = asyncio.create_task(broker._stream_egress(control, status, {"sessionId": "session-web"}))
            try:
                async with asyncio.timeout(2):
                    while b"\n" not in status.data:
                        await asyncio.sleep(0)
                    proxy = json.loads(bytes(status.data).split(b"\n", 1)[0])["result"]
                    for kind in ("http", "connect", "private"):
                        reader, writer = await connect(proxy["address"], proxy["port"])
                        try:
                            if kind == "connect":
                                writer.write(b"CONNECT registry.example:443 HTTP/1.1\r\n\r\n")
                                await writer.drain()
                                self.assertIn(b"200 Connection Established", await reader.readuntil(b"\r\n\r\n"))
                                writer.write(b"GET /tls-fixture HTTP/1.1\r\nHost: registry.example\r\n\r\n")
                            else:
                                host = "private.example" if kind == "private" else "registry.example"
                                writer.write(f"GET http://{host}/package HTTP/1.1\r\nProxy-Authorization: Basic hidden\r\n\r\n".encode())
                            await writer.drain()
                            response = await reader.read()
                            self.assertIn(b"403 Forbidden" if kind == "private" else b"registry response", response)
                        finally:
                            writer.close()
                            await writer.wait_closed()
                    self.assertEqual(destinations, [("1.1.1.1", 80), ("1.1.1.1", 443)])
                    self.assertTrue(received[0].startswith(b"GET /package HTTP/1.1\r\n"))
                    self.assertNotIn(b"Proxy-Authorization", received[0])
            finally:
                control.feed_eof()
                await asyncio.wait_for(task, 2)
                upstream.close()
                await upstream.wait_closed()


    async def test_egress_partial_header_closes_client_before_control_ends(self):
        control_reader = asyncio.StreamReader()
        control_writer = CaptureWriter()
        proxy_task = None
        client_writer = None
        with (
            patch.object(broker, "_run", side_effect=["127.0.0.1"] * 2),
            patch.object(broker, "EGRESS_HOSTS", frozenset({"example.com"})),
            patch.object(broker, "EGRESS_PROXY_PORT", 0),
        ):
            proxy_task = asyncio.create_task(
                broker._stream_egress(
                    control_reader,
                    control_writer,
                    {"sessionId": "session-7"},
                )
            )
            while b"\n" not in control_writer.data:
                await asyncio.sleep(0)
            response = bytes(control_writer.data).split(b"\n", 1)[0]
            proxy = json.loads(response)["result"]
            try:
                client_reader, client_writer = await asyncio.open_connection(
                    proxy["address"], proxy["port"]
                )
                client_writer.write(b"CONNECT")
                client_writer.write_eof()
                await client_writer.drain()
                self.assertEqual(await asyncio.wait_for(client_reader.read(), timeout=1), b"")
            finally:
                control_reader.feed_eof()
                await asyncio.wait_for(proxy_task, timeout=1)
                if client_writer is not None:
                    client_writer.close()
                    await client_writer.wait_closed()


if __name__ == "__main__":
    unittest.main()
