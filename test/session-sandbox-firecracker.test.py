"""Firecracker lifecycle ownership and real Unix/vsock stream contract tests."""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, AsyncMock

SOURCE = Path(__file__).resolve().parents[1] / "deploy/session-sandbox/broker.py"
spec = importlib.util.spec_from_file_location("firecracker_broker", SOURCE)
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)
vm = broker.vm


class FirecrackerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.root = Path(self.directory.name)
        self.state = patch.object(vm, "STATE_ROOT", self.root / "state")
        self.artifacts = patch.object(vm, "VM_ROOT", self.root / "vms")
        self.state.start()
        self.artifacts.start()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.state.stop)
        self.addCleanup(self.artifacts.stop)
        self.request = {"sessionId": "test-session", "workerUid": "1001", "workspacePath": "/app/workspaces/session"}
        self.record = {"sessionId": "test-session", "runtime": "firecracker", "workerUid": "1001", "workspaceHost": "/host/session", "token": "a" * 64}

    def test_readonly_base_image_becomes_private_writable_copy(self):
        source, destination = self.root / "base.ext4", self.root / "session.ext4"
        source.write_bytes(b"rootfs-content")
        source.chmod(0o444)
        with patch.object(vm, "ROOTFS", str(source)):
            vm.copy_rootfs(destination)
        self.assertEqual(source.stat().st_mode & 0o777, 0o444)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        with destination.open("r+b") as disk:
            disk.write(b"private")
        self.assertEqual(source.read_bytes(), b"rootfs-content")

    def test_default_runtime_never_silently_falls_back_to_sysbox(self):
        with patch.object(broker, "_workspace", return_value=Path("/host/session")), patch.object(vm, "provision", side_effect=RuntimeError("KVM unavailable")), patch.object(broker, "_sysbox_provision") as sysbox:
            with self.assertRaisesRegex(RuntimeError, "KVM unavailable"):
                broker.provision(self.request)
            sysbox.assert_not_called()

    def test_explicit_sysbox_is_persisted_by_same_owner(self):
        with patch.object(broker, "_workspace", return_value=Path("/host/session")), patch.object(broker, "_sysbox_provision", return_value={"container": "opaque"}):
            result = broker.provision({**self.request, "runtime": "sysbox"})
        self.assertEqual(result["runtime"], "sysbox")
        self.assertEqual(vm.load("test-session")["runtime"], "sysbox")
        with patch.object(broker, "_workspace", return_value=Path("/host/session")):
            with self.assertRaisesRegex(ValueError, "runtime does not match"):
                broker.recover(self.request)

    def test_missing_recovery_explicitly_returns_requested_runtime(self):
        with patch.object(broker, "_workspace", return_value=Path("/host/session")), patch.object(broker, "_sysbox_recover", return_value={"exists": False, "running": False}):
            for runtime in ("firecracker", "sysbox"):
                self.assertEqual(broker.recover({**self.request, "runtime": runtime}), {"runtime": runtime, "exists": False, "running": False})

    def test_all_stream_operations_fence_supplied_worker_uid(self):
        vm.save("test-session", self.record)
        for operation in ("exec", "relay", "egress"):
            with self.assertRaisesRegex(ValueError, "uid does not match"):
                broker._owned_runtime({**self.request, "workerUid": "1002", "operation": operation})

    def test_record_identity_is_checked_and_unknown_streams_fail_closed(self):
        vm.save("test-session", {**self.record, "sessionId": "different"})
        with self.assertRaisesRegex(ValueError, "record is invalid"):
            vm.load("test-session")
        with self.assertRaisesRegex(ValueError, "no lifecycle owner"):
            broker._owned_runtime({"sessionId": "missing"})

    def test_vmm_is_bounded_and_has_no_guest_network(self):
        vm.save("test-session", self.record)
        directory = vm.VM_ROOT / vm.key("test-session")
        directory.mkdir(parents=True)
        (directory / "rootfs.ext4").write_bytes(b"rootfs")
        (directory / "config.ext4").write_bytes(b"config")
        with patch.object(vm, "run") as run, patch.object(vm.subprocess, "run"):
            vm.start("test-session")
        args = run.call_args.args[0]
        for required in ("--property=User=1001", "--property=Group=1001", "--property=SupplementaryGroups=kvm", "--property=CapabilityBoundingSet=", "--property=DeviceAllow=/dev/kvm rw", "--property=PrivateNetwork=yes", "--property=MemoryMax=4352M", "--property=CPUQuota=200%", "--property=TasksMax=128", "--property=RestrictAddressFamilies=AF_UNIX"):
            self.assertIn(required, args)
        self.assertNotIn("--network", args)
        self.assertEqual(args[-1], "/run/partitura-vm-machine.json")

    def test_sftp_server_has_exact_mount_and_no_host_privileges(self):
        args = vm.sftp_command(self.record, "partitura-sftp-test.service")
        for required in ("--property=RootDirectory=" + vm.SFTP_ROOT, "--property=BindPaths=/host/session:/workspace", "--property=User=1001", "--property=Group=1001", "--property=PrivateDevices=yes", "--property=CapabilityBoundingSet=", "--property=NoNewPrivileges=yes", "--property=PrivateNetwork=yes", "--property=ProtectSystem=strict", "--property=ReadWritePaths=/workspace", "--property=RestrictAddressFamilies=AF_UNIX"):
            self.assertIn(required, args)
        self.assertEqual(args[-6:], [vm.SFTP_BINARY, "-e", "-d", "/workspace", "-u", "0077"])

    def test_recovery_rejects_guest_owned_symlink_disks(self):
        vm.save("test-session", self.record)
        directory = vm.VM_ROOT / vm.key("test-session")
        directory.mkdir(parents=True)
        (directory / "rootfs.ext4").symlink_to("/etc/passwd")
        with patch.object(vm, "run") as run:
            with self.assertRaisesRegex(ValueError, "bounded regular files"):
                vm.start("test-session")
            run.assert_not_called()

    async def test_vsock_connect_authenticates_and_preserves_live_stream(self):
        directory = vm.VM_ROOT / vm.key("test-session")
        directory.mkdir(parents=True)
        requests = []
        async def guest(reader, writer):
            self.assertEqual(await reader.readline(), b"CONNECT 52\n")
            writer.write(b"OK 53\n")
            await writer.drain()
            requests.append(json.loads(await reader.readline()))
            writer.write(b'{"ok":true}\n')
            await writer.drain()
            self.assertEqual(await reader.readexactly(3), b"abc")
            writer.write(b"xyz")
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        server = await asyncio.start_unix_server(guest, path=str(directory / "v.sock"))
        try:
            reader, writer = await vm.connect(self.record, {"operation": "tunnel", "targetPort": 1234})
            self.assertEqual(json.loads(await reader.readline()), {"ok": True})
            writer.write(b"abc")
            await writer.drain()
            self.assertEqual(await reader.read(), b"xyz")
            writer.close()
            await writer.wait_closed()
        finally:
            server.close()
            await server.wait_closed()
        self.assertEqual(requests, [{"operation": "tunnel", "targetPort": 1234, "token": "a" * 64}])

    async def test_vm_exec_rejects_uid_mismatch_before_transport(self):
        with patch.object(vm, "connect", new=AsyncMock()) as connect:
            with self.assertRaisesRegex(ValueError, "uid does not match"):
                await broker._vm_exec(None, None, {**self.request, "workerUid": "1002"}, self.record)
            connect.assert_not_called()

    def test_destroy_does_not_release_identity_after_vm_stop_failure(self):
        vm.save("test-session", self.record)
        with patch.object(vm, "destroy", side_effect=RuntimeError("still running")):
            with self.assertRaisesRegex(RuntimeError, "still running"):
                broker.destroy(self.request)
        self.assertIsNotNone(vm.load("test-session"))


if __name__ == "__main__":
    unittest.main()
