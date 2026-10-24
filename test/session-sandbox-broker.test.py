"""Docker Engine stream-protocol tests without a Docker daemon."""
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
from types import SimpleNamespace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / "deploy/session-sandbox/broker.py"
spec = importlib.util.spec_from_file_location("session_sandbox_broker", SOURCE)
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)


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
    def test_firewall_is_opt_in_and_rejects_unowned_invocations(self):
        with patch.object(broker, "MANAGE_FIREWALL", False), patch.object(broker.subprocess, "run") as run:
            broker._allow_listener("10.1.2.2", "10.1.2.1", 3128, "partitura-network-session-1")
            broker._cleanup_firewall()
            run.assert_not_called()
        with patch.object(broker, "MANAGE_FIREWALL", True), patch.dict(os.environ, {"INVOCATION_ID": ""}), patch.object(broker.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "systemd invocation"):
                broker._allow_listener("10.1.2.2", "10.1.2.1", 3128, "partitura-network-session-1")
            with self.assertRaisesRegex(ValueError, "systemd invocation"):
                broker._cleanup_firewall()
            run.assert_not_called()

    def test_firewall_rule_limits_source_destination_and_listener_port(self):
        with patch.object(broker, "MANAGE_FIREWALL", True), patch.dict(os.environ, {"INVOCATION_ID": "a" * 32}), patch.object(broker, "_run", return_value=json.dumps([{"Driver": "bridge", "Id": "b" * 64, "Options": {}}])), patch.object(broker.subprocess, "run") as run:
            broker._allow_listener("10.1.2.2", "10.1.2.1", 3128, "partitura-network-session-1")
            args = run.call_args.args[0]
            self.assertEqual(args, ["/usr/bin/iptables", "-w", "5", "-I", "INPUT", "1", "-i", "br-" + "b" * 12, "-p", "tcp", "-s", "10.1.2.2/32", "-d", "10.1.2.1/32", "--dport", "3128", "-m", "comment", "--comment", "partitura-sandbox-" + "a" * 32, "-j", "ACCEPT"])
            for port in (0, 65536, True):
                with self.assertRaisesRegex(ValueError, "valid listener port"):
                    broker._allow_listener("10.1.2.2", "10.1.2.1", port, "partitura-network-session-1")
            with self.assertRaisesRegex(ValueError, "IPv4"):
                broker._allow_listener("::1", "10.1.2.1", 3128, "partitura-network-session-1")
            self.assertEqual(run.call_count, 1)

    def test_firewall_cleanup_preserves_other_requests_and_operator_rules(self):
        tag = "partitura-sandbox-" + "a" * 32
        own = f'-A INPUT -s 10.1.2.2/32 -d 10.1.2.1/32 -p tcp -m tcp --dport 3128 -m comment --comment "{tag}" -j ACCEPT'
        rules = "\n".join(["-P INPUT DROP", "-A INPUT -j ufw-before-input", own, own.replace("a" * 32, "b" * 32), own.replace(tag, tag + "-other")])
        with patch.object(broker, "MANAGE_FIREWALL", True), patch.dict(os.environ, {"INVOCATION_ID": "a" * 32}), patch.object(broker.subprocess, "run", return_value=SimpleNamespace(stdout=rules)) as run:
            broker._cleanup_firewall()
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args_list[0].args[0], ["/usr/bin/iptables", "-w", "5", "-S", "INPUT"])
            delete = run.call_args_list[1].args[0]
            self.assertEqual(delete[3:5], ["-D", "INPUT"])
            self.assertIn(tag, delete)
            self.assertNotIn("ufw-before-input", delete)
            run.side_effect = subprocess.CalledProcessError(1, ["iptables"])
            with self.assertRaises(subprocess.CalledProcessError):
                broker._cleanup_firewall()

    async def test_listener_closes_and_cleans_rules_even_when_firewall_setup_fails(self):
        for fail in (False, True):
            with self.subTest(fail=fail):
                reader = asyncio.StreamReader()
                reader.feed_eof()
                writer = CaptureWriter()
                server = SimpleNamespace(sockets=[SimpleNamespace(getsockname=lambda: ("10.1.2.1", 3128, "partitura-network-session-1"))], close=Mock(), wait_closed=AsyncMock())
                with patch.object(broker, "EGRESS_HOSTS", frozenset(["registry.npmjs.org"])), patch.object(broker, "_run", side_effect=["10.1.2.2", "10.1.2.1"]), patch.object(broker.asyncio, "start_server", new=AsyncMock(return_value=server)), patch.object(broker, "_allow_listener", side_effect=RuntimeError("firewall unavailable") if fail else None) as allow, patch.object(broker, "_cleanup_firewall") as cleanup:
                    if fail:
                        with self.assertRaisesRegex(RuntimeError, "firewall unavailable"):
                            await broker._stream_egress(reader, writer, {"sessionId": "session-1"})
                        self.assertEqual(writer.data, b"")
                    else:
                        await broker._stream_egress(reader, writer, {"sessionId": "session-1"})
                        self.assertTrue(json.loads(writer.data)["ok"])
                    allow.assert_called_once_with("10.1.2.2", "10.1.2.1", 3128, "partitura-network-session-1")
                    cleanup.assert_called_once_with()
                server.close.assert_called_once_with()
                server.wait_closed.assert_awaited_once_with()

    async def test_engine_json_accepts_chunked_and_eof_delimited_bodies(self):
        body = b'{"Config":{"Labels":{"partitura.session":"session-1"}}}'
        responses = [
            http_response("200 OK", body),
            b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + body,
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
            + b"5;extension=yes\r\n" + body[:5] + b"\r\n"
            + f"{len(body)-5:x}\r\n".encode() + body[5:] + b"\r\n0\r\nTrailer: done\r\n\r\n",
        ]
        for response in responses:
            with self.subTest(response=response[:70]), tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
                socket = str(Path(directory) / "engine.sock")
                async def engine(reader, writer):
                    await read_request(reader)
                    writer.write(response)
                    await writer.drain()
                    writer.close()
                    await writer.wait_closed()
                server = await asyncio.start_unix_server(engine, path=socket)
                try:
                    with patch.object(broker, 'DOCKER_SOCKET', socket):
                        result = await asyncio.wait_for(broker._docker_api_json('GET', '/containers/test/json'), 5)
                    self.assertEqual(result, json.loads(body))
                finally:
                    server.close()
                    await server.wait_closed()

    async def test_exec_rejects_worker_uid_mismatch_before_creating_exec(self):
        inspect = AsyncMock(
            return_value={
                "Config": {
                    "Labels": {
                        "partitura.session": "session-1",
                        "partitura.worker_uid": "1001",
                    }
                }
            }
        )
        with patch.object(broker, "_docker_api_json", new=inspect):
            with self.assertRaisesRegex(ValueError, "worker uid does not match"):
                await broker._stream_exec(
                    asyncio.StreamReader(),
                    CaptureWriter(),
                    {
                        "sessionId": "session-1",
                        "workerUid": "1002",
                        "argv": ["/usr/local/bin/omp", "--version"],
                        "cwd": "/workspace",
                        "env": {"PATH": "/usr/local/bin:/usr/bin"},
                    },
                )

        inspect.assert_awaited_once_with(
            "GET", "/containers/partitura-session-session-1/json"
        )

    def test_provision_uses_limits_proxy_and_only_the_session_worker_socket(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            workspace = Path(directory) / "session-3"
            workspace.mkdir()
            calls = []

            def docker(args, **_kwargs):
                calls.append(args)
                if args[:2] == ["network", "inspect"]:
                    return "172.19.0.1"
                if args[:2] == ["volume", "inspect"]:
                    return json.dumps([{"Labels": {"partitura.session": "session-3"}}])
                if args[:2] == ["inspect", "--format"]:
                    if args[-1] == "partitura-session-session-3":
                        return "172.19.0.2"
                    if args[-1] == "tailscale-owner":
                        return "172.18.0.4"
                return ""

            settings = {
                "WORKSPACE_ROOT": Path("/app/workspaces"),
                "WORKSPACE_HOST_ROOT": directory,
                "SANDBOX_IMAGE": "registry.example/partitura-worker@sha256:" + "a" * 64,
                "GATEWAY_CONTAINER": "gateway",
                "GATEWAY_NETWORK": "gateway-network",
                "GATEWAY_NETWORK_CONTAINER": "tailscale-owner",
                "MEMORY_LIMIT": "6g",
                "CPU_LIMIT": "3.5",
                "PIDS_LIMIT": 512,
            }
            with patch.object(broker, "_run", side_effect=docker), patch.multiple(
                broker, **settings
            ):
                result = broker._sysbox_provision(
                    {
                        "sessionId": "session-3",
                        "workspacePath": "/app/workspaces/session-3",
                        "workerUid": "1003",
                    }
                )

        self.assertEqual(result["gatewayAddress"], "172.18.0.4")
        create_args = next(args for args in calls if args[0] == "create")
        joined = " ".join(create_args)
        self.assertIn("--memory 6g", joined)
        self.assertIn("--cpus 3.5", joined)
        self.assertIn("--pids-limit 512", joined)
        self.assertIn("HTTP_PROXY=http://172.19.0.1:3128", joined)
        self.assertIn("HTTPS_PROXY=http://172.19.0.1:3128", joined)
        self.assertIn("PARTITURA_WORKER_UID=1003", joined)
        self.assertIn("SYSBOX_HONOR_CAPS=FALSE", joined)
        self.assertIn("src=" + str(workspace), joined)
        self.assertIn("src=partitura-mise-session-3,dst=/mise,readonly=false", joined)
        self.assertNotIn("/var/run/docker.sock", joined)
        self.assertEqual(
            next(args[-1] for args in calls if args[:2] == ["inspect", "--format"]),
            "partitura-session-session-3",
        )

    def test_provision_cleans_up_when_network_creation_fails(self):
        settings = {
            "SANDBOX_IMAGE": "registry.example/partitura-worker@sha256:" + "a" * 64,
            "GATEWAY_CONTAINER": "gateway",
            "GATEWAY_NETWORK": "gateway-network",
            "GATEWAY_NETWORK_CONTAINER": "tailscale-owner",
        }
        with (
            patch.object(broker, "_workspace", return_value=Path("/workspaces/session-8")),
            patch.object(broker, "_run", side_effect=RuntimeError("network create failed")) as run,
            patch.object(broker, "_sysbox_destroy") as destroy,
            patch.multiple(broker, **settings),
        ):
            with self.assertRaisesRegex(RuntimeError, "network create failed"):
                broker._sysbox_provision(
                    {
                        "sessionId": "session-8",
                        "workspacePath": "/app/workspaces/session-8",
                        "workerUid": "1008",
                    }
                )

        self.assertEqual(run.call_args.args[0][:2], ["network", "create"])
        destroy.assert_called_once_with({"sessionId": "session-8"})

    def test_maps_logical_workspace_into_host_volume_and_rejects_escape(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            root = Path(directory)
            workspace = root / "session-1"
            workspace.mkdir()
            previous = (broker.WORKSPACE_ROOT, broker.WORKSPACE_HOST_ROOT)
            broker.WORKSPACE_ROOT = Path("/app/workspaces")
            broker.WORKSPACE_HOST_ROOT = str(root)
            try:
                self.assertEqual(
                    broker._workspace("/app/workspaces/session-1"), workspace
                )
                with self.assertRaisesRegex(ValueError, "inside the configured"):
                    broker._workspace("/app/other/session-1")
                with self.assertRaisesRegex(ValueError, "strict child"):
                    broker._workspace("/app/workspaces/../outside")
                (root / "session-link").symlink_to(workspace)
                with self.assertRaisesRegex(ValueError, "symlinks"):
                    broker._workspace("/app/workspaces/session-link")
            finally:
                broker.WORKSPACE_ROOT, broker.WORKSPACE_HOST_ROOT = previous

    def test_destroy_surfaces_docker_failure_without_removing_network_or_volume(self):
        calls = []

        def docker(args, **_kwargs):
            calls.append(args)
            if args[1:3] == ["container", "inspect"]:
                return type(
                    "Result",
                    (),
                    {
                        "returncode": 0,
                        "stdout": json.dumps(
                            [{"Config": {"Labels": {"partitura.session": "session-2"}}}]
                        ),
                        "stderr": "",
                    },
                )()
            return type(
                "Result",
                (),
                {"returncode": 1, "stdout": "", "stderr": "daemon unavailable"},
            )()

        with patch.object(broker.subprocess, "run", side_effect=docker):
            with self.assertRaisesRegex(RuntimeError, "retry teardown"):
                broker._sysbox_destroy({"sessionId": "session-2"})
        self.assertEqual(calls[0][1:3], ["container", "inspect"])
        self.assertEqual(calls[1][1:], ["rm", "-f", "partitura-session-session-2"])
        self.assertEqual(len(calls), 2)

    def test_docker_teardown_cli_timeouts_are_bounded_and_report_retry(self):
        owned = SimpleNamespace(returncode=0, stdout=json.dumps([{"Config": {"Labels": {"partitura.session": "session-2"}}}]), stderr="")
        timeout = subprocess.TimeoutExpired(["docker"], 30)
        for results, phase, expected_calls in (([timeout], "ownership check", 1), ([owned, timeout], "removal", 2)):
            with self.subTest(phase=phase), patch.object(broker.subprocess, "run", side_effect=results) as run:
                with self.assertRaisesRegex(RuntimeError, phase + " timed out; retry teardown"):
                    broker._remove_owned("container", "partitura-session-session-2", "session-2")
                self.assertEqual(run.call_count, expected_calls)
                self.assertEqual(run.call_args_list[0].kwargs["timeout"], 10)
                if expected_calls == 2:
                    self.assertEqual(run.call_args_list[1].kwargs["timeout"], 30)

    def test_destroy_rechecks_ownership_before_retrying_async_container_kill(self):
        owned = SimpleNamespace(returncode=0, stdout=json.dumps([{"Config": {"Labels": {"partitura.session": "session-2"}}}]), stderr="")
        killing = SimpleNamespace(returncode=1, stdout="", stderr="tried to kill container, but did not receive an exit event")
        removed = SimpleNamespace(returncode=0, stdout="", stderr="")
        with patch.object(broker.subprocess, "run", side_effect=[owned, killing, owned, removed]) as run, patch.object(broker.time, "sleep"):
            broker._remove_owned("container", "partitura-session-session-2", "session-2")
        self.assertEqual([call.args[0][1:3] for call in run.call_args_list], [["container", "inspect"], ["rm", "-f"], ["container", "inspect"], ["rm", "-f"]])
        foreign = SimpleNamespace(returncode=0, stdout=json.dumps([{"Config": {"Labels": {"partitura.session": "other-session"}}}]), stderr="")
        with patch.object(broker.subprocess, "run", side_effect=[owned, killing, foreign]) as run, patch.object(broker.time, "sleep"):
            with self.assertRaisesRegex(ValueError, "label does not match"):
                broker._remove_owned("container", "partitura-session-session-2", "session-2")
        self.assertEqual(run.call_count, 3)

    async def test_sysbox_supervisor_keeps_c_close_alive_then_cancels_only_its_group(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            marker = Path(directory) / "heartbeat"
            grandchild = "import pathlib,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); p=pathlib.Path(" + repr(str(marker)) + ");\nwhile True: p.write_text(str(time.monotonic())); time.sleep(.03)"
            child = "import signal,subprocess,sys,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); subprocess.Popen([sys.executable,'-c'," + repr(grandchild) + "]); print('ready',flush=True);\nwhile True: time.sleep(1)"
            unrelated = await asyncio.create_subprocess_exec(sys.executable, "-I", "-S", "-c", broker.SYSBOX_EXEC_WRAPPER, sys.executable, "-c", "import time; print('ready',flush=True); time.sleep(60)", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
            process = await asyncio.create_subprocess_exec(sys.executable, "-I", "-S", "-c", broker.SYSBOX_EXEC_WRAPPER, sys.executable, "-c", child, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
            try:
                self.assertEqual(await asyncio.wait_for(process.stdout.readline(), 3), b"ready\n")
                self.assertEqual(await asyncio.wait_for(unrelated.stdout.readline(), 3), b"ready\n")
                for _ in range(100):
                    if marker.exists():
                        break
                    await asyncio.sleep(.02)
                self.assertTrue(marker.exists())
                process.stdin.write(b"C\x00\x00\x00\x00")
                await process.stdin.drain()
                previous = marker.read_text()
                await asyncio.sleep(.12)
                self.assertIsNone(process.returncode)
                self.assertNotEqual(marker.read_text(), previous)
                process.stdin.close()
                await asyncio.wait_for(process.wait(), 4)
                previous = marker.read_text()
                await asyncio.sleep(.12)
                self.assertEqual(marker.read_text(), previous)
                self.assertIsNone(unrelated.returncode)
            finally:
                for owned in (process, unrelated):
                    if owned.returncode is None:
                        owned.stdin.close()
                        await asyncio.wait_for(owned.wait(), 4)

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
