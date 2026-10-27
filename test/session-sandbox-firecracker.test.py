"""Firecracker lifecycle ownership and real Unix/vsock stream contract tests."""
import asyncio
import errno
import importlib.util
import json
import os
import sys
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch, AsyncMock, Mock

SOURCE = Path(__file__).resolve().parents[1] / "deploy/session-sandbox/broker.py"
sys.path.insert(0, str(SOURCE.parent))
from sandbox_broker import core as broker
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

    def test_recovery_waits_for_authenticated_graceful_shutdown(self):
        command = AsyncMock(return_value={"ok": True})
        with patch.object(vm, "running", side_effect=[True, True, False]), patch.object(vm, "command", command), patch.object(vm.time, "sleep"):
            vm.stop_for_recovery(self.record)
        command.assert_awaited_once_with(self.record, {"operation": "shutdown"})
        with patch.object(vm, "running", return_value=False), patch.object(vm, "command", command):
            vm.stop_for_recovery(self.record)
        self.assertEqual(command.await_count, 1)
        with patch.object(vm, "running", return_value=True), patch.object(vm, "command", AsyncMock(return_value={"ok": True})), patch.object(vm, "time", SimpleNamespace(monotonic=Mock(side_effect=[0, 46]), sleep=Mock())), patch.object(vm.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "ownership retained"):
                vm.stop_for_recovery(self.record)
            run.assert_not_called()

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
        for required in ("--property=CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_SETPCAP", "--property=DeviceAllow=/dev/kvm rw", "--property=PrivateNetwork=yes", "--property=MemoryMax=4352M", "--property=CPUQuota=200%", "--property=TasksMax=128", "--property=RestrictAddressFamilies=AF_UNIX"):
            self.assertIn(required, args)
        self.assertNotIn("--network", args)
        self.assertEqual(args[-3:], [str(SOURCE.parent / "firecracker.py"), "--vmm-exec", "test-session"])
        self.assertIn("-I", args)
        self.assertIn("-S", args)
        self.assertFalse(any(arg.startswith("--property=User=") or arg.startswith("--property=Group=") for arg in args))

    def test_sftp_server_has_exact_mount_and_no_host_privileges(self):
        args = vm.sftp_command(self.record, "partitura-sftp-test.service")
        for required in ("--property=BindPaths=/host/session:" + str(vm.sftp_jail("test-session")) + "/workspace", "--property=PrivateDevices=yes", "--property=CapabilityBoundingSet=CAP_SYS_CHROOT CAP_SETUID CAP_SETGID CAP_SETPCAP", "--property=NoNewPrivileges=yes", "--property=PrivateNetwork=yes", "--property=ProtectSystem=strict", "--property=ReadWritePaths=" + str(vm.sftp_jail("test-session")) + "/workspace", "--property=RestrictAddressFamilies=AF_UNIX"):
            self.assertIn(required, args)
        self.assertEqual(args[-3:], [str(SOURCE.parent / "firecracker.py"), "--sftp-exec", "test-session"])
        self.assertIn("--property=BindReadOnlyPaths=/dev/null:" + str(vm.sftp_jail("test-session")) + "/dev/null", args)
        self.assertFalse(any(arg.startswith("--property=User=") or arg.startswith("--property=RootDirectory=") for arg in args))

    def test_sftp_private_nss_identity_does_not_change_host_or_base_jail(self):
        base = self.root / "sftp-base"
        (base / "workspace").mkdir(parents=True)
        (base / "server").write_text("immutable executable")
        vm.save("test-session", self.record)
        previous_umask = os.umask(0o077)
        try:
            with patch.object(vm, "SFTP_ROOT", str(base)):
                vm.prepare_sftp_jail("test-session")
        finally:
            os.umask(previous_umask)
        jail = vm.sftp_jail("test-session")
        self.assertEqual((jail / "etc").stat().st_mode & 0o777, 0o755)
        self.assertEqual((jail / "dev").stat().st_mode & 0o777, 0o755)
        self.assertIn("partitura:x:1001:1001:", (jail / "etc/passwd").read_text())
        self.assertEqual((jail / "etc/group").read_text(), "partitura:x:1001:\n")
        self.assertEqual((jail / "server").stat().st_ino, (base / "server").stat().st_ino)
        self.assertFalse((base / "etc").exists())

    def test_sftp_jail_rejects_symlink_and_existing_base_account_configuration(self):
        base = self.root / "sftp-base"
        (base / "workspace").mkdir(parents=True)
        vm.save("test-session", self.record)
        jail = vm.sftp_jail("test-session")
        jail.symlink_to(base, target_is_directory=True)
        with patch.object(vm, "SFTP_ROOT", str(base)):
            with self.assertRaisesRegex(ValueError, "must not be a symlink"):
                vm.prepare_sftp_jail("test-session")
        jail.unlink()
        (base / "etc").mkdir()
        (base / "etc/passwd").write_text("operator:x:1000:1000::/home/operator:/bin/sh\n")
        with patch.object(vm, "SFTP_ROOT", str(base)):
            with self.assertRaisesRegex(ValueError, "must not contain account configuration"):
                vm.prepare_sftp_jail("test-session")
        self.assertTrue((base / "etc/passwd").read_text().startswith("operator:"))

    def test_sysbox_timeout_preserves_runtime_owner_for_retry(self):
        vm.save("test-session", {**self.record, "runtime": "sysbox"})
        with patch.object(broker, "_sysbox_destroy", side_effect=RuntimeError("removal timed out; retry teardown")):
            with self.assertRaisesRegex(RuntimeError, "retry teardown"):
                broker.destroy(self.request)
        self.assertEqual(vm.load("test-session")["runtime"], "sysbox")

    def test_account_free_drop_removes_all_capability_sets_and_saved_ids(self):
        calls = []
        def prctl(option, arg=0, arg2=0):
            calls.append((option, arg, arg2))
            if option in (23, 24) and arg > 40:
                raise OSError(errno.EINVAL, "unsupported capability")
            return 1 if option == 39 else 0
        libc = Mock()
        libc.capset.return_value = 0
        libc.capget.return_value = 0
        with patch.object(vm, "_prctl", side_effect=prctl), patch.object(vm, "LIBC", libc), patch.object(vm.os, "setgroups") as groups, patch.object(vm.os, "setresgid") as gid, patch.object(vm.os, "setresuid") as uid, patch.object(vm.os, "getresuid", return_value=(1064,) * 3), patch.object(vm.os, "getresgid", return_value=(1064,) * 3), patch.object(vm.os, "getgroups", return_value=[992]):
            vm.drop_privileges(1064, [992])
        groups.assert_called_once_with([992])
        gid.assert_called_once_with(1064, 1064, 1064)
        uid.assert_called_once_with(1064, 1064, 1064)
        self.assertIn((38, 1, 0), calls)
        self.assertEqual([arg for option, arg, _ in calls if option == 24], list(range(42)))
        self.assertEqual([arg2 for option, arg, arg2 in calls if option == 47 and arg == 1], list(range(41)))
        libc.capset.assert_called_once()
        libc.capget.assert_called_once()

    def test_sftp_chroots_then_drops_credentials_before_fixed_exec(self):
        vm.save("test-session", self.record)
        calls = []
        with patch.object(vm.os, "chroot", side_effect=lambda path: calls.append(("chroot", path))), patch.object(vm.os, "chdir", side_effect=lambda path: calls.append(("chdir", path))), patch.object(vm, "drop_privileges", side_effect=lambda uid, groups: calls.append(("drop", uid, groups))), patch.object(vm.os, "execve", side_effect=lambda *args: calls.append(("exec", args))):
            vm.exec_owned("test-session", "sftp")
        self.assertEqual(calls[:3], [("chroot", vm.sftp_jail("test-session")), ("chdir", "/"), ("drop", 1001, [])])
        self.assertEqual(calls[3][1], (vm.SFTP_BINARY, [vm.SFTP_BINARY, "-e", "-d", "/workspace", "-u", "0077"], {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}))

    def test_capability_drop_failure_never_executes_untrusted_process(self):
        vm.save("test-session", self.record)
        with patch.object(vm.os, "chroot"), patch.object(vm.os, "chdir"), patch.object(vm, "drop_privileges", side_effect=PermissionError("capability drop failed")), patch.object(vm.os, "execve") as execute:
            with self.assertRaisesRegex(PermissionError, "capability drop failed"):
                vm.exec_owned("test-session", "sftp")
            execute.assert_not_called()

    def test_firecracker_handle_uses_gateway_reachable_bind_address(self):
        with patch.object(broker, "_workspace", return_value=Path("/host/session")), patch.object(vm, "provision"), patch.object(vm, "start_workspace"), patch.object(broker, "_gateway_routing", return_value=("172.18.0.4", "172.18.0.1")):
            result = broker.provision(self.request)
        self.assertEqual(result["gatewayAddress"], "172.18.0.4")
        self.assertEqual(result["workerAddress"], "127.0.0.1")
        self.assertEqual(result["relayAddress"], "127.0.0.1")
        vm.save("test-session", self.record)
        with patch.object(broker, "_workspace", return_value=Path("/host/session")), patch.object(vm, "start"), patch.object(vm, "start_workspace"), patch.object(broker.subprocess, "run"), patch.object(broker, "_gateway_routing", return_value=("172.18.0.4", "172.18.0.1")):
            recovered = broker.recover(self.request)
        self.assertEqual(recovered["gatewayAddress"], "172.18.0.4")

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

    def test_repeated_firecracker_destroy_never_requires_docker(self):
        vm.save("test-session", self.record)
        directory = vm.VM_ROOT / vm.key("test-session")
        directory.mkdir(parents=True)
        (directory / "rootfs.ext4").write_bytes(b"private disk")
        request = {"sessionId": "test-session", "runtime": "firecracker"}
        with patch.object(vm.subprocess, "run", return_value=SimpleNamespace(returncode=0, stderr="")), patch.object(vm, "running", return_value=False), patch.object(broker, "_sysbox_destroy", side_effect=RuntimeError("Docker unavailable")) as docker:
            for _ in range(2):
                self.assertEqual(broker.destroy(request), {"destroyed": True})
                self.assertIsNone(vm.load("test-session"))
                self.assertFalse(directory.exists())
            docker.assert_not_called()

    def test_destroy_rejects_runtime_mismatch_without_stopping_either_runtime(self):
        for runtime, requested in (("firecracker", "sysbox"), ("sysbox", "firecracker")):
            vm.save("test-session", {**self.record, "runtime": runtime})
            with patch.object(vm, "destroy") as firecracker, patch.object(broker, "_sysbox_destroy") as docker:
                with self.assertRaisesRegex(ValueError, "runtime does not match"):
                    broker.destroy({"sessionId": "test-session", "runtime": requested})
                firecracker.assert_not_called()
                docker.assert_not_called()
                self.assertEqual(vm.load("test-session")["runtime"], runtime)


if __name__ == "__main__":
    unittest.main()
