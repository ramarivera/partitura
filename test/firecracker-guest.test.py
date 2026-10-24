"""Guest protocol checks. Run as root in a disposable worker container."""
import asyncio
import importlib.util
import json
import os
import socket
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "deploy/session-sandbox/firecracker/guest-agent.py"
spec = importlib.util.spec_from_file_location("firecracker_guest", SOURCE)
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)
TOKEN = "a" * 64


class GuestTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="guest-test-", dir="/run" if os.geteuid() == 0 else None)
        self.workspace = Path(self.temp.name)
        self.uid = 1001 if os.geteuid() == 0 else os.getuid()
        if os.geteuid() == 0:
            os.chown(self.workspace, self.uid, self.uid)
        self.workspace_patch = patch.object(guest, "WORKSPACE", self.workspace)
        self.workspace_patch.start()
        self.docker_path = self.workspace / "docker.sock"
        self.docker_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.docker_socket.bind(str(self.docker_path))
        self.docker_path.chmod(0o666)
        self.docker_patch = patch.object(guest, "DOCKER_SOCKET", self.docker_path)
        self.docker_patch.start()
        self.agent = guest.Agent(TOKEN, self.uid)
        self.server = await asyncio.start_server(self.agent.handle, "127.0.0.1", 0)
        self.address = self.server.sockets[0].getsockname()

    async def asyncTearDown(self):
        self.server.close()
        await self.server.wait_closed()
        self.workspace_patch.stop()
        self.docker_patch.stop()
        self.docker_socket.close()
        self.temp.cleanup()

    async def connect(self, request):
        reader, writer = await asyncio.open_connection(*self.address)
        writer.write(json.dumps({"token": TOKEN, **request}).encode() + b"\n")
        await writer.drain()
        return reader, writer

    async def test_ping_requires_session_secret(self):
        for token, expected in [(TOKEN, True), ("b" * 64, False), ("é" * 64, False)]:
            reader, writer = await self.connect({"operation": "ping", "token": token})
            self.assertEqual(json.loads(await reader.readline())["ok"], expected)
            writer.close()
            await writer.wait_closed()

    async def test_ping_waits_for_worker_docker_socket_access(self):
        for mode, expected in ((0o600, False), (0o660, False), (0o666, True)):
            self.docker_path.chmod(mode)
            reader, writer = await self.connect({"operation": "ping"})
            self.assertEqual(json.loads(await reader.readline())["ok"], expected)
            writer.close()
            await writer.wait_closed()
        self.docker_path.unlink()
        for regular_file in (False, True):
            if regular_file:
                self.docker_path.write_text("not a socket")
                self.docker_path.chmod(0o666)
            reader, writer = await self.connect({"operation": "ping"})
            self.assertFalse(json.loads(await reader.readline())["ok"])
            writer.close()
            await writer.wait_closed()

    async def test_shutdown_requires_session_secret_and_signals_only_init(self):
        with patch.object(guest.os, "kill") as kill:
            reader, writer = await self.connect({"operation": "shutdown", "token": "b" * 64})
            self.assertFalse(json.loads(await reader.readline())["ok"])
            writer.close()
            await writer.wait_closed()
            kill.assert_not_called()
            reader, writer = await self.connect({"operation": "shutdown"})
            self.assertTrue(json.loads(await reader.readline())["ok"])
            writer.close()
            await writer.wait_closed()
            kill.assert_called_once_with(1, guest.signal.SIGTERM)

    def test_exec_rejects_symlink_escape_and_unapproved_environment(self):
        request = {"workerUid": str(self.uid), "argv": ["true"], "cwd": str(self.workspace)}
        (self.workspace / "escape").symlink_to("/etc", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "inside /workspace"):
            guest.validate_exec(request | {"cwd": str(self.workspace / "escape")}, self.uid)
        for env in [{"OPENAI_API_KEY": "secret"}, {"LD_PRELOAD": "evil"}, {"PATH": 42}]:
            with self.assertRaises(ValueError):
                guest.validate_exec(request | {"env": env}, self.uid)
        with self.assertRaisesRegex(ValueError, "identity"):
            guest.validate_exec(request | {"workerUid": "0"}, self.uid)

    @unittest.skipUnless(os.geteuid() == 0, "real privilege dropping requires disposable root container")
    async def test_real_exec_drops_uid_groups_and_inherited_secrets(self):
        script = "import os,sys; print(os.getuid(),os.getgid(),os.getgroups(),os.getenv('HOST_SECRET')); print(sys.stdin.read()); print('err',file=sys.stderr); sys.exit(7)"
        with patch.dict(os.environ, {"HOST_SECRET": "must-not-cross"}):
            reader, writer = await self.connect({"operation": "exec", "workerUid": str(self.uid), "argv": ["python3", "-c", script], "cwd": str(self.workspace)})
            writer.write(b"I" + (5).to_bytes(4, "big") + b"hello" + b"C\0\0\0\0")
            await writer.drain()
            output, errors = b"", b""
            while True:
                header = await asyncio.wait_for(reader.readexactly(5), 5)
                kind, size = header[:1], int.from_bytes(header[1:], "big")
                if kind == b"X":
                    self.assertEqual(size, 7)
                    break
                data = await reader.readexactly(size)
                if kind == b"O":
                    output += data
                elif kind == b"E":
                    errors += data
                else:
                    self.fail(f"unexpected frame {kind!r}")
            self.assertIn(b"1001 1001 [] None", output)
            self.assertIn(b"hello", output)
            self.assertEqual(errors, b"err\n")
            writer.close()
            await writer.wait_closed()

    @unittest.skipUnless(os.geteuid() == 0, "real privilege dropping requires disposable root container")
    async def test_disconnect_terminates_idle_exec_after_close_input(self):
        reader, writer = await self.connect({"operation": "exec", "workerUid": str(self.uid), "argv": ["python3", "-c", "import os,time; print(os.getpid(),flush=True); time.sleep(60)"], "cwd": str(self.workspace)})
        writer.write(b"C\0\0\0\0")
        await writer.drain()
        header = await asyncio.wait_for(reader.readexactly(5), 5)
        self.assertEqual(header[:1], b"O")
        pid = int(await reader.readexactly(int.from_bytes(header[1:], "big")))
        writer.close()
        await writer.wait_closed()
        for _ in range(100):
            if not Path(f"/proc/{pid}").exists():
                break
            await asyncio.sleep(0.01)
        self.assertFalse(Path(f"/proc/{pid}").exists())

    async def test_listener_lifetime_follows_control_connection(self):
        reader, writer = await self.connect({"operation": "listen", "port": 0, "targetPort": 1081})
        response = json.loads(await reader.readline())
        allocated = response["port"]
        self.assertTrue(response["ok"])
        self.assertIn(allocated, self.agent.listeners)
        writer.close()
        await writer.wait_closed()
        for _ in range(100):
            if allocated not in self.agent.listeners:
                break
            await asyncio.sleep(0.01)
        self.assertNotIn(allocated, self.agent.listeners)
        with self.assertRaises(OSError):
            await asyncio.open_connection("127.0.0.1", allocated)


if __name__ == "__main__":
    unittest.main()
