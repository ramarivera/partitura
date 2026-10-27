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

SOURCE = Path(__file__).resolve().parents[1] / "deploy/session-sandbox/broker.py"
sys.path.insert(0, str(SOURCE.parent))
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


    def test_public_web_allows_unlisted_registries_but_preserves_private_pins(self):
        with patch.object(broker, "EGRESS_MODE", "public-web"), patch.object(broker, "EGRESS_HOSTS", frozenset()), patch.object(broker, "PRIVATE_EGRESS_ADDRESSES", {"model.example": frozenset({"100.81.163.26"})}):
            for host in ("pypi.org", "files.pythonhosted.org", "sh.rustup.rs", "tuf-repo-cdn.sigstore.dev", "new-mirror.example"):
                for port in (80, 443):
                    self.assertEqual(broker.egress_addresses(host, {"1.1.1.1"}, port), ["1.1.1.1"])
            for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "100.81.163.26", "::1", "fd00::1"):
                with self.assertRaises(ValueError):
                    broker.egress_addresses("unlisted.example", {address})
            self.assertEqual(broker.egress_addresses("model.example", {"100.81.163.26"}), ["100.81.163.26"])
            with self.assertRaises(ValueError):
                broker.egress_addresses("model.example", {"100.81.163.26"}, 80)
            with self.assertRaises(ValueError):
                broker.egress_addresses("new-mirror.example", {"1.1.1.1", "10.0.0.1"})
            with self.assertRaises(ValueError):
                broker.egress_addresses("new-mirror.example", {"1.1.1.1"}, 22)
        with patch.object(broker, "EGRESS_MODE", "allowlist"), patch.object(broker, "EGRESS_HOSTS", frozenset({"pypi.org"})):
            self.assertEqual(broker.egress_addresses("pypi.org", {"1.1.1.1"}), ["1.1.1.1"])
            with self.assertRaises(ValueError):
                broker.egress_addresses("unlisted.example", {"1.1.1.1"})


    def test_proxy_parses_connect_and_rewrites_http_without_proxy_credentials(self):
        self.assertEqual(broker.proxy_target(b"CONNECT pypi.org:443 HTTP/1.1\r\nHost: pypi.org\r\n\r\n"), ("pypi.org", 443, None))
        self.assertEqual(broker.proxy_target(b"CONNECT [2606:4700:4700::1111]:443 HTTP/1.1\r\n\r\n"), ("2606:4700:4700::1111", 443, None))
        host, port, header = broker.proxy_target(b"GET http://packages.example/path?q=1 HTTP/1.1\r\nHost: wrong.example\r\nProxy-Authorization: Basic secret\r\nProxy-Connection: keep-alive\r\nAccept: */*\r\n\r\n")
        self.assertEqual((host, port), ("packages.example", 80))
        self.assertEqual(header, b"GET /path?q=1 HTTP/1.1\r\nAccept: */*\r\nHost: packages.example\r\nConnection: close\r\n\r\n")
        for target in ("CONNECT example.com:22", "GET https://example.com/", "GET http://user:pass@example.com/", "GET http://example.com:8080/", "GET /relative", "CONNECT example.com:443/path"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                broker.proxy_target((target + " HTTP/1.1\r\n\r\n").encode())


    def test_private_egress_requires_exact_host_and_address_pins(self):
        with patch.object(broker, "EGRESS_HOSTS", frozenset({"model.example", "packages.example"})):
            pins = broker.private_egress_addresses('{"model.example":["100.81.163.26"]}')
            with patch.object(broker, "PRIVATE_EGRESS_ADDRESSES", pins):
                self.assertEqual(broker.egress_addresses("model.example", {"100.81.163.26"}), ["100.81.163.26"])
                self.assertEqual(broker.egress_addresses("packages.example", {"1.1.1.1"}), ["1.1.1.1"])
                for host, addresses in [
                    ("packages.example", {"100.81.163.26"}),
                    ("other.example", {"100.81.163.26"}),
                    ("model.example", {"100.81.163.27"}),
                    ("model.example", {"100.81.163.26", "127.0.0.1"}),
                    ("model.example", {"1.1.1.1"}),
                    ("model.example", set()),
                ]:
                    with self.assertRaises(ValueError):
                        broker.egress_addresses(host, addresses)
            with patch.object(broker, "PRIVATE_EGRESS_ADDRESSES", {}):
                with self.assertRaises(ValueError):
                    broker.egress_addresses("model.example", {"100.81.163.26"})
            for address in ["127.0.0.1", "::1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "1.1.1.1"]:
                with self.assertRaises(ValueError):
                    broker.private_egress_addresses(json.dumps({"model.example": [address]}))
            for raw in ['[]', '{"other.example":["100.81.163.26"]}', '{"model.example":[]}', '{"model.example":"100.81.163.26"}']:
                with self.assertRaises(ValueError):
                    broker.private_egress_addresses(raw)


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
            with patch.object(broker, "_run", side_effect=docker), patch.object(broker, "_docker_mutate", side_effect=lambda session, args, **kwargs: docker(args, **kwargs)), patch.multiple(
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
        self.assertIn("NODE_USE_ENV_PROXY=1", joined)
        self.assertIn("PARTITURA_WORKER_UID=1003", joined)
        self.assertIn("DOCKER_DATA_ROOT=/var/lib/docker", joined)
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
            patch.object(broker, "_docker_mutate", side_effect=RuntimeError("network create failed")) as run,
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

        self.assertEqual(run.call_args.args[1][:2], ["network", "create"])
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
            with self.assertRaisesRegex(broker.DockerMutationFenceError, "ambiguous; ownership retained"):
                broker._sysbox_destroy({"sessionId": "session-2"})
        self.assertEqual(calls[0][1:3], ["container", "inspect"])
        self.assertEqual(calls[1][1:], ["rm", "partitura-session-session-2"])
        self.assertEqual(len(calls), 2)


    def test_running_sysbox_stops_gracefully_then_rechecks_ownership_before_remove(self):
        def owned(running, session="session-2"):
            return SimpleNamespace(returncode=0, stdout=json.dumps([{"Config": {"Labels": {"partitura.session": session}}, "State": {"Running": running}}]), stderr="")
        success = SimpleNamespace(returncode=0, stdout="", stderr="")
        with patch.object(broker.subprocess, "run", side_effect=[owned(True), success, owned(False), success]) as run:
            broker._remove_owned("container", "partitura-session-session-2", "session-2")
        self.assertEqual([call.args[0][1:] for call in run.call_args_list], [["container", "inspect", "partitura-session-session-2"], ["stop", "--timeout", "10", "partitura-session-session-2"], ["container", "inspect", "partitura-session-session-2"], ["rm", "partitura-session-session-2"]])
        self.assertEqual(run.call_args_list[1].kwargs["timeout"], 20)
        with patch.object(broker.subprocess, "run", side_effect=[owned(True), success, owned(False, "foreign")]) as run:
            with self.assertRaisesRegex(ValueError, "label does not match"):
                broker._remove_owned("container", "partitura-session-session-2", "session-2")
        self.assertEqual(run.call_count, 3)


    def test_stop_timeout_keeps_container_owned_and_never_overlaps_remove(self):
        owned = SimpleNamespace(returncode=0, stdout=json.dumps([{"Config": {"Labels": {"partitura.session": "session-2"}}, "State": {"Running": True}}]), stderr="")
        for failure in (subprocess.TimeoutExpired(["docker", "stop"], 20), SimpleNamespace(returncode=1, stdout="", stderr="stop failed")):
            with patch.object(broker.subprocess, "run", side_effect=[owned, failure]) as run:
                with self.assertRaises(broker.DockerMutationFenceError):
                    broker._remove_owned("container", "partitura-session-session-2", "session-2")
            self.assertEqual(run.call_count, 2)
            self.assertEqual(run.call_args.args[0][1], "stop")


    def test_docker_teardown_cli_timeouts_are_bounded_and_report_retry(self):
        owned = SimpleNamespace(returncode=0, stdout=json.dumps([{"Config": {"Labels": {"partitura.session": "session-2"}}}]), stderr="")
        timeout = subprocess.TimeoutExpired(["docker"], 30)
        for results, phase, expected_calls in (([timeout], "ownership check", 1), ([owned, timeout], "removal", 2)):
            with self.subTest(phase=phase), patch.object(broker.subprocess, "run", side_effect=results) as run:
                with self.assertRaisesRegex(RuntimeError, "ownership check timed out; retry teardown" if phase == "ownership check" else "still pending; retry teardown"):
                    broker._remove_owned("container", "partitura-session-session-2", "session-2")
                self.assertEqual(run.call_count, expected_calls)
                self.assertEqual(run.call_args_list[0].kwargs["timeout"], 10)
                if expected_calls == 2:
                    self.assertEqual(run.call_args_list[1].kwargs["timeout"], 120)


    def test_ambiguous_removal_never_retries_or_inspects_foreign_replacement(self):
        owned = SimpleNamespace(returncode=0, stdout=json.dumps([{"Config": {"Labels": {"partitura.session": "session-2"}}}]), stderr="")
        killing = SimpleNamespace(returncode=1, stdout="", stderr="tried to kill container, but did not receive an exit event")
        with patch.object(broker.subprocess, "run", side_effect=[owned, killing]) as run:
            with self.assertRaisesRegex(broker.DockerMutationFenceError, "ambiguous; ownership retained"):
                broker._remove_owned("container", "partitura-session-session-2", "session-2")
        self.assertEqual([call.args[0][1:3] for call in run.call_args_list], [["container", "inspect"], ["rm", "partitura-session-session-2"]])


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


if __name__ == "__main__":
    unittest.main()
