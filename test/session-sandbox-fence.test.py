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


class DockerMutationFenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.root = Path(self.directory.name)
        state = patch.object(broker.vm, "STATE_ROOT", self.root / "state")
        state.start()
        self.addCleanup(state.stop)
        self.addCleanup(self.directory.cleanup)
        self.session = "late-create-session"
        self.request = {"sessionId": self.session, "runtime": "sysbox", "workerUid": "1001", "workspacePath": "/app/workspaces/session"}
        self.owner = {"sessionId": self.session, "runtime": "sysbox", "workerUid": "1001", "workspaceHost": "/host/session"}
        broker.vm.save(self.session, self.owner)

    def operation(self):
        return {"unit": "partitura-docker-" + broker.vm.key(self.session) + "-" + "a" * 32 + ".service", "completed": False}

    def test_real_delayed_create_outlives_caller_and_blocks_absence_cleanup_until_finished(self):
        marker = self.root / "late-created"
        units = {}
        stops = []
        inspections = []
        launch = subprocess.Popen
        real_settle = broker._settle_docker_operation
        def managed(args, **kwargs):
            if args[0] == "/usr/bin/systemd-run":
                operation_unit = args[args.index("--unit") + 1]
                self.assertEqual(broker.vm.load(self.session)["dockerOperation"]["unit"], operation_unit)
                self.assertNotIn("--wait", args)
                self.assertNotIn("--collect", args)
                self.assertIn("--property=RemainAfterExit=yes", args)
                config = "/run/" + operation_unit.removesuffix(".service")
                self.assertEqual(args[args.index(broker.DOCKER) + 1:args.index(broker.DOCKER) + 5], ["--config", config, "--host", "unix://" + broker.DOCKER_SOCKET])
                self.assertIn("--property=RuntimeDirectory=" + config.removeprefix("/run/"), args)
                mutation = args[args.index(broker.DOCKER) + 5:]
                if mutation[0] == "create":
                    code = "import pathlib,time; time.sleep(.25); pathlib.Path(" + repr(str(marker)) + ").write_text('created')"
                elif mutation[0] == "rm":
                    code = "import pathlib; pathlib.Path(" + repr(str(marker)) + ").unlink()"
                else:
                    self.fail("unexpected fake mutation " + repr(mutation))
                units[operation_unit] = launch([sys.executable, "-c", code])
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            if args[:2] == ["/usr/bin/systemctl", "show"]:
                process = units.get(args[2])
                if process is None:
                    output = "LoadState=not-found\nActiveState=inactive\nSubState=dead\nExecMainCode=0\nExecMainStatus=0\n"
                elif process.poll() is None:
                    output = "LoadState=loaded\nActiveState=active\nSubState=running\nExecMainCode=0\nExecMainStatus=0\n"
                else:
                    output = "LoadState=loaded\nActiveState=active\nSubState=exited\nExecMainCode=1\nExecMainStatus=" + str(process.returncode) + "\n"
                return SimpleNamespace(returncode=0, stdout=output, stderr="")
            if args[:2] == ["/usr/bin/systemctl", "stop"]:
                process = units[args[2]]
                self.assertIsNotNone(process.poll(), "a caller must never stop its pending mutation")
                stops.append(args[2])
                del units[args[2]]
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            if args[0] == broker.DOCKER and args[2] == "inspect":
                inspections.append(args)
                if args[1] == "container" and marker.exists():
                    return SimpleNamespace(returncode=0, stdout=json.dumps([{"Config": {"Labels": {"partitura.session": self.session}}, "State": {"Running": False}}]), stderr="")
                return SimpleNamespace(returncode=1, stdout="", stderr="No such object")
            self.fail("unexpected manager call " + repr(args))
        try:
            with patch.object(broker.subprocess, "run", side_effect=managed):
                with self.assertRaisesRegex(broker.DockerMutationFenceError, "still pending"):
                    broker._docker_mutate(self.session, ["create", "--name", broker._container(self.session)], timeout=.01)
                pending = list(units.values())[0]
                self.assertIsNone(pending.poll())
                self.assertFalse(marker.exists())
                self.assertEqual(stops, [])
                # Reload the actual broker code to prove ownership is on disk,
                # independent of the original request/module's memory.
                fresh_spec = importlib.util.spec_from_file_location("sandbox_broker.restarted_core", SOURCE.parent / "sandbox_broker/core.py")
                fresh = importlib.util.module_from_spec(fresh_spec)
                fresh_spec.loader.exec_module(fresh)
                with patch.object(fresh, "_settle_docker_operation", side_effect=lambda session, timeout=60: real_settle(session, timeout=0)), patch.object(fresh, "_workspace", return_value=Path("/host/session")):
                    for action in (fresh.destroy, fresh.recover):
                        with self.assertRaisesRegex(broker.DockerMutationFenceError, "still pending"):
                            action(self.request)
                self.assertEqual(inspections, [])
                self.assertIsNotNone(broker.vm.load(self.session))
                pending.wait(timeout=3)
                self.assertTrue(marker.exists())
                self.assertEqual(broker.destroy(self.request), {"destroyed": True})
                self.assertFalse(marker.exists())
                self.assertIsNone(broker.vm.load(self.session))
                self.assertEqual(len(stops), 2)
        finally:
            for process in units.values():
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=3)

    def test_missing_failed_or_killed_operation_keeps_owner_and_never_inspects_absence(self):
        for state in ({"LoadState": "not-found"}, {"LoadState": "loaded", "SubState": "failed", "ExecMainCode": "2", "ExecMainStatus": "9"}, {"LoadState": "loaded", "SubState": "exited", "ExecMainCode": "1", "ExecMainStatus": "1"}):
            with self.subTest(state=state):
                broker.vm.save(self.session, {**self.owner, "dockerOperation": self.operation()})
                with patch.object(broker, "_docker_operation_status", return_value=state), patch.object(broker.subprocess, "run") as command:
                    with self.assertRaises(broker.DockerMutationFenceError):
                        broker.destroy(self.request)
                    command.assert_not_called()
                self.assertIn("dockerOperation", broker.vm.load(self.session))

    def test_submission_failure_keeps_durable_intent_for_reconciliation(self):
        with patch.object(broker.subprocess, "run", side_effect=subprocess.TimeoutExpired(["systemd-run"], 10)):
            with self.assertRaisesRegex(broker.DockerMutationFenceError, "submission is ambiguous"):
                broker._docker_mutate(self.session, ["create"], timeout=.01)
        self.assertIn("dockerOperation", broker.vm.load(self.session))

    def test_verified_completion_survives_crash_before_manager_cleanup(self):
        operation = {**self.operation(), "completed": True}
        broker.vm.save(self.session, {**self.owner, "dockerOperation": operation})
        with patch.object(broker, "_docker_operation_status") as status, patch.object(broker.subprocess, "run", return_value=SimpleNamespace(returncode=4, stderr="Unit not loaded")):
            broker._settle_docker_operation(self.session, timeout=0)
        status.assert_not_called()
        self.assertNotIn("dockerOperation", broker.vm.load(self.session))

    def test_queued_inactive_operation_does_not_clear_intent_before_execution(self):
        broker.vm.save(self.session, {**self.owner, "dockerOperation": self.operation()})
        queued = {"LoadState": "loaded", "ActiveState": "inactive", "SubState": "dead", "ExecMainCode": "0", "ExecMainStatus": "0"}
        with patch.object(broker, "_docker_operation_status", return_value=queued), patch.object(broker.subprocess, "run") as command:
            with self.assertRaisesRegex(broker.DockerMutationFenceError, "still pending"):
                broker._settle_docker_operation(self.session, timeout=0)
            command.assert_not_called()
        self.assertIn("dockerOperation", broker.vm.load(self.session))

    def test_legacy_destroy_persists_owner_before_managed_removal(self):
        broker.vm.state_path(self.session).unlink()
        mutations = []
        def command(args, **kwargs):
            if args[0] == "/usr/bin/systemd-run":
                owner = broker.vm.load(self.session)
                self.assertEqual(owner["runtime"], "sysbox")
                self.assertIn("dockerOperation", owner)
                mutations.append(args[args.index(broker.DOCKER) + 5:])
            elif args[:2] == ["/usr/bin/systemctl", "show"]:
                return SimpleNamespace(returncode=0, stdout="LoadState=loaded\nSubState=exited\nExecMainCode=1\nExecMainStatus=0\n", stderr="")
            elif args[0] == broker.DOCKER:
                if args[1] == "container":
                    return SimpleNamespace(returncode=0, stdout=json.dumps([{"Config": {"Labels": {"partitura.session": self.session}}, "State": {"Running": False}}]), stderr="")
                return SimpleNamespace(returncode=1, stdout="", stderr="No such object")
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        with patch.object(broker.subprocess, "run", side_effect=command):
            self.assertEqual(broker.destroy(self.request), {"destroyed": True})
        self.assertEqual(mutations, [["rm", broker._container(self.session)]])
        self.assertIsNone(broker.vm.load(self.session))

    def test_legacy_recovery_validates_metadata_before_managed_restart(self):
        for valid in (True, False):
            with self.subTest(valid=valid):
                broker.vm.state_path(self.session).unlink(missing_ok=True)
                mutations = []
                def command(args, **kwargs):
                    if args[0] == "/usr/bin/systemd-run":
                        owner = broker.vm.load(self.session)
                        for field in ("runtime", "workerUid", "workspaceHost"):
                            self.assertEqual(owner[field], self.owner[field])
                        self.assertIn("dockerOperation", owner)
                        mutations.append(args[args.index(broker.DOCKER) + 5:])
                    elif args[:2] == ["/usr/bin/systemctl", "show"]:
                        return SimpleNamespace(returncode=0, stdout="LoadState=loaded\nSubState=exited\nExecMainCode=1\nExecMainStatus=0\n", stderr="")
                    elif args[0] == broker.DOCKER:
                        if args[1] == "inspect":
                            output = "false" if args[3] == "{{.State.Running}}" else json.dumps({"partitura.session": self.session, "partitura.workspace": "/host/session", "partitura.worker_uid": "1001" if valid else "9999"})
                        else:
                            output = json.dumps([{"Labels": {"partitura.session": self.session}}])
                        return SimpleNamespace(returncode=0, stdout=output, stderr="")
                    return SimpleNamespace(returncode=0, stdout="", stderr="")
                def address(args):
                    # Docker drops a stopped endpoint's IP and may assign a new
                    # one on restart. Only post-restart inspect is meaningful.
                    if not mutations:
                        return ""
                    if args[0] == "network":
                        return "172.19.0.1"
                    return "172.19.0.9" if args[-1] == broker._container(self.session) else "172.18.0.4"
                with patch.object(broker.subprocess, "run", side_effect=command), patch.object(broker, "_workspace", return_value=Path("/host/session")), patch.object(broker, "_run", side_effect=address):
                    if valid:
                        recovered = broker.recover(self.request)
                        self.assertTrue(recovered["running"])
                        self.assertEqual(recovered["workerAddress"], "172.19.0.9")
                        self.assertEqual(mutations, [["restart", broker._container(self.session)]])
                        self.assertNotIn("dockerOperation", broker.vm.load(self.session))
                    else:
                        with self.assertRaisesRegex(ValueError, "worker uid"):
                            broker.recover(self.request)
                        self.assertEqual(mutations, [])
                        self.assertIsNone(broker.vm.load(self.session))

    def test_recovery_daemon_failure_preserves_existing_owner(self):
        with patch.object(broker, "_workspace", return_value=Path("/host/session")), patch.object(broker.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="Cannot connect to the Docker daemon")):
            with self.assertRaisesRegex(RuntimeError, "ownership check failed"):
                broker.recover(self.request)
        self.assertEqual(broker.vm.load(self.session), self.owner)


if __name__ == "__main__":
    unittest.main()
