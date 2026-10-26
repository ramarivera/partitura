#!/usr/bin/env python3
"""Opt-in deployed broker acceptance. See deploy/session-sandbox/ACCEPTANCE.md.

Without PARTITURA_SANDBOX_LIVE=1 only the local wire fixtures run. Live tests
create disposable sessions, pull one Docker image, and exercise real T3 auth,
but never open a model turn or mutate gateway configuration.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import tempfile
import unittest


MAX_FRAME = 4 * 1024 * 1024
BASE_ENV = {
    "PATH": "/mise/shims:/mise/bin:/opt/partitura/bin:/opt/t3:/opt/codex/bin:/opt/claude/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "HOME": "/workspace/.omp-home", "LANG": "C.UTF-8",
    "MISE_DATA_DIR": "/mise", "MISE_CACHE_DIR": "/mise/cache",
    "MISE_CONFIG_DIR": "/workspace/.omp-home/mise/config",
    "MISE_TRUSTED_CONFIG_PATHS": "/workspace",
    "T3CODE_NO_BROWSER": "true", "T3CODE_TELEMETRY_ENABLED": "false",
    "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
}
GATEWAY_BIND_SERVER = """
const p=JSON.parse(await Bun.stdin.text());
let timer;
const server=Bun.serve({hostname:p.host,port:0,fetch(request){
  const path=new URL(request.url).pathname;
  if(path==='/stop/'+p.marker){
    setTimeout(()=>{clearTimeout(timer);server.stop(true);process.exit(0)},20);
    return new Response('stopping');
  }
  return path==='/'+p.marker?new Response(p.marker):new Response('missing',{status:404});
}});
timer=setTimeout(()=>{server.stop(true);process.exit(1)},90000);
console.log(JSON.stringify({address:p.host,port:server.port}));
"""


async def close(writer):
    writer.close()
    try:
        await writer.wait_closed()
    except (ConnectionError, BrokenPipeError):
        pass


class Wire:
    """Production JSON control and binary exec protocol, without importing broker."""

    def __init__(self, socket_path):
        self.socket_path = str(socket_path)

    async def connect(self, request):
        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(self.socket_path), 10)
        writer.write(json.dumps(request).encode() + b"\n")
        await writer.drain()
        return reader, writer

    async def control(self, request):
        reader, writer = await self.connect(request)
        try:
            response = json.loads(await asyncio.wait_for(reader.readline(), 240))
            if response.get("ok") is not True:
                raise RuntimeError(response.get("error", "broker rejected request"))
            return response["result"]
        finally:
            await close(writer)

    async def lease(self, request):
        reader, writer = await self.connect(request)
        try:
            response = json.loads(await asyncio.wait_for(reader.readline(), 30))
            if response.get("ok") is not True:
                raise RuntimeError(response.get("error", "broker rejected lease"))
            return response["result"], writer
        except BaseException:
            await close(writer)
            raise

    async def execute(self, request, stdin=b"", timeout=120):
        reader, writer = await self.connect(request)
        try:
            if stdin:
                writer.write(b"I" + len(stdin).to_bytes(4, "big") + stdin)
            writer.write(b"C\0\0\0\0")
            await writer.drain()
            return await asyncio.wait_for(read_exec(reader), timeout)
        finally:
            await close(writer)


async def read_exec(reader):
    stdout, stderr = bytearray(), bytearray()
    while True:
        header = await reader.readexactly(5)
        kind, length = header[:1], int.from_bytes(header[1:], "big")
        if kind == b"X":
            return length, bytes(stdout), bytes(stderr)
        if kind not in (b"O", b"E") or length > MAX_FRAME:
            raise ValueError("invalid exec output frame")
        target = stdout if kind == b"O" else stderr
        if len(target) + length > 8 * 1024 * 1024:
            raise ValueError("acceptance output exceeds limit")
        target.extend(await reader.readexactly(length))


def assert_guest_network(details):
    if set(details["net"]) != {"lo", "docker0"} or not details["dockerBridge"]:
        raise AssertionError("guest must have only loopback and the internal Docker bridge")
    if details["ipv4DefaultRoutes"] or details["ipv6DefaultRoutes"]:
        raise AssertionError("guest must not have an external default route")


class SandboxWireTests(unittest.IsolatedAsyncioTestCase):
    def test_guest_network_accepts_internal_bridge_and_rejects_external_routes(self):
        details = {"net": ["docker0", "lo"], "dockerBridge": True,
                   "ipv4DefaultRoutes": [], "ipv6DefaultRoutes": []}
        assert_guest_network(details)
        for difference in ({"net": ["lo", "docker0", "eth0"]},
                           {"net": ["lo"]}, {"dockerBridge": False},
                           {"ipv4DefaultRoutes": [{"gateway": "192.0.2.1"}]},
                           {"ipv6DefaultRoutes": [{"gateway": "2001:db8::1"}]}):
            with self.subTest(difference=difference), self.assertRaises(AssertionError):
                assert_guest_network(details | difference)

    async def test_exec_frames_keep_control_open_until_exit(self):
        observed = []

        async def handler(reader, writer):
            observed.append(json.loads(await reader.readline()))
            observed.append(await reader.readexactly(8))
            observed.append(await reader.readexactly(5))
            writer.write(b"O\0\0\0\x03outE\0\0\0\x03err")
            await writer.drain()
            # A C frame closes process stdin, not the owning connection.
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(reader.read(1), 0.02)
            writer.write(b"X\0\0\0\x17")
            await writer.drain()
            await close(writer)

        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            path = Path(directory) / "broker.sock"
            server = await asyncio.start_unix_server(handler, path=str(path))
            async with server:
                self.assertEqual(await Wire(path).execute({"operation": "exec"}, b"abc"), (23, b"out", b"err"))
        self.assertEqual(observed, [{"operation": "exec"}, b"I\0\0\0\x03abc", b"C\0\0\0\0"])

    async def test_exec_rejects_invalid_and_truncated_frames(self):
        for payload, error in ((b"O\0\0\0\x03x", asyncio.IncompleteReadError),
                               (b"Q\0\0\0\0", ValueError),
                               (b"O\xff\xff\xff\xff", ValueError)):
            with self.subTest(payload=payload):
                reader = asyncio.StreamReader()
                reader.feed_data(payload)
                reader.feed_eof()
                with self.assertRaises(error):
                    await read_exec(reader)

    async def test_control_rejection_and_lease_ownership(self):
        released = asyncio.Event()

        async def handler(reader, writer):
            request = json.loads(await reader.readline())
            if request["operation"] == "denied":
                writer.write(b'{"ok":false,"error":"ownership mismatch"}\n')
            else:
                writer.write(b'{"ok":true,"result":{"port":1234}}\n')
            await writer.drain()
            await reader.read()
            released.set()
            await close(writer)

        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as directory:
            path = Path(directory) / "broker.sock"
            server = await asyncio.start_unix_server(handler, path=str(path))
            async with server:
                with self.assertRaisesRegex(RuntimeError, "ownership mismatch"):
                    await Wire(path).control({"operation": "denied"})
                await asyncio.wait_for(released.wait(), 1)
                released.clear()
                result, writer = await Wire(path).lease({"operation": "relay"})
                self.assertEqual(result, {"port": 1234})
                self.assertFalse(released.is_set())
                await close(writer)
                await asyncio.wait_for(released.wait(), 1)


@unittest.skipUnless(os.environ.get("PARTITURA_SANDBOX_LIVE") == "1", "requires explicit live acceptance opt-in")
class SandboxLiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertEqual(os.geteuid(), 0, "run on the sandbox host as root")
        self.uid = int(os.environ["PARTITURA_SANDBOX_LIVE_UID"])
        self.peer_uid = int(os.environ["PARTITURA_SANDBOX_LIVE_PEER_UID"])
        self.assertNotEqual(self.uid, self.peer_uid)
        self.host_root = Path(os.environ["PARTITURA_SANDBOX_LIVE_WORKSPACE_HOST_ROOT"])
        self.logical_root = Path(os.environ.get("PARTITURA_SANDBOX_LIVE_WORKSPACE_ROOT", "/app/workspaces"))
        self.state_root = Path(os.environ.get("PARTITURA_SANDBOX_LIVE_STATE_ROOT", "/var/lib/partitura-sandbox"))
        self.vm_root = Path(os.environ.get("PARTITURA_SANDBOX_LIVE_VM_ROOT", "/var/lib/partitura-vms"))
        self.gateway = os.environ["PARTITURA_SANDBOX_LIVE_GATEWAY_CONTAINER"]
        self.gateway_port = int(os.environ.get("PARTITURA_SANDBOX_LIVE_GATEWAY_PORT", "3000"))
        self.docker = os.environ.get("PARTITURA_SANDBOX_LIVE_DOCKER", "/usr/bin/docker")
        self.wire = Wire(os.environ.get("PARTITURA_SANDBOX_LIVE_SOCKET", "/run/partitura-sandbox/broker.sock"))
        self.sessions, self.leases, self.owners, self.workspaces = [], [], [], []
        self.provisioned = {}
        self.firewall_before = set((await self.run_host(["/usr/bin/iptables", "-w", "5", "-S", "INPUT"])).splitlines())
        self.assertTrue(self.host_root.is_dir())
        self.assertFalse(self.host_root.is_symlink())
        self.assertTrue(self.logical_root.is_absolute())
        for uid in (self.uid, self.peer_uid):
            self.assertTrue(1000 <= uid <= 65535)
            with self.assertRaises(KeyError, msg="dedicated UID must not name a host account"):
                pwd.getpwuid(uid)
            for record in self.state_root.glob("*.json"):
                metadata = json.loads(record.read_text())
                self.assertNotEqual(metadata.get("workerUid"), str(uid), "UID already owns a sandbox")
            for entry in Path("/proc").iterdir():
                if entry.name.isdigit():
                    try:
                        self.assertNotEqual(entry.stat().st_uid, uid, "UID already owns a host process")
                    except FileNotFoundError:
                        pass

    async def asyncTearDown(self):
        errors = []
        for writer in reversed(self.owners + self.leases):
            try:
                await close(writer)
            except Exception as error:
                errors.append(str(error))
        for session in reversed(self.sessions):
            try:
                await self.wire.control({"operation": "destroy", "sessionId": session})
                await self.assert_absent(session)
            except Exception as error:
                errors.append(f"{session}: {error}")
        # Preserve workspace evidence if any resource teardown failed. Never
        # recursively remove while a VM/container could still be writing.
        if not errors:
            for path in self.workspaces:
                shutil.rmtree(path)
            async with asyncio.timeout(10):
                while True:
                    rules = set((await self.run_host(["/usr/bin/iptables", "-w", "5", "-S", "INPUT"])).splitlines())
                    remaining = {rule for rule in rules - self.firewall_before if "partitura-sandbox-" in rule}
                    if not remaining:
                        break
                    await asyncio.sleep(0.1)
        self.assertEqual(errors, [], "owned cleanup failed; inspect these exact acceptance sessions")

    def request(self, session, uid, operation, **fields):
        return {"operation": operation, "sessionId": session, "workerUid": str(uid), **fields}

    def exec_request(self, session, uid, argv, env=None):
        return self.request(session, uid, "exec", argv=argv, cwd="/workspace", env=BASE_ENV | (env or {}))

    async def execute(self, session, uid, argv, env=None, timeout=120):
        code, stdout, stderr = await self.wire.execute(self.exec_request(session, uid, argv, env), timeout=timeout)
        self.assertEqual(code, 0, f"worker command failed: {argv[0]}: {stderr.decode(errors='replace')[-2000:]}")
        return stdout.decode()

    async def python(self, session, uid, code, timeout=120, env=None):
        return await self.execute(session, uid, ["python3", "-c", code], env=env, timeout=timeout)

    async def lease(self, session, uid, operation, **fields):
        result, writer = await self.wire.lease(self.request(session, uid, operation, **fields))
        self.leases.append(writer)
        return result

    async def wait_file(self, path, timeout=30):
        async with asyncio.timeout(timeout):
            while not path.exists():
                await asyncio.sleep(0.1)

    async def create_session(self, runtime, uid):
        session = "acceptance-" + secrets.token_hex(8)
        workspace = self.host_root / session
        workspace.mkdir(mode=0o700)
        os.chown(workspace, uid, uid)
        home = workspace / ".omp-home"
        home.mkdir(mode=0o700)
        os.chown(home, uid, uid)
        self.workspaces.append(workspace)
        self.sessions.append(session)  # Register cleanup before the first request.
        print(f"LIVE owned session {session}, UID {uid}", flush=True)
        fields = {} if runtime == "firecracker" else {"runtime": runtime}
        result = await self.wire.control(self.request(session, uid, "provision", workspacePath=str(self.logical_root / session), **fields))
        self.assertEqual(result["runtime"], runtime)
        self.assertEqual(result["workspace"], "/workspace")
        self.provisioned[session] = result
        return session, workspace

    async def assert_absent(self, session):
        digest = hashlib.sha256(session.encode()).hexdigest()[:24]
        self.assertFalse((self.state_root / (digest + ".json")).exists())
        self.assertFalse((self.state_root / (digest + ".machine.json")).exists())
        self.assertFalse((self.state_root / (digest + ".sftp-root")).exists())
        self.assertFalse((self.vm_root / digest).exists())
        units = await self.run_host(["/usr/bin/systemctl", "list-units", "--all", "--no-legend", "--plain", "partitura-vm-" + digest + "*", "partitura-workspace-" + digest + "*", "partitura-sftp-" + digest + "*", "partitura-docker-" + digest + "*"])
        self.assertEqual(units.strip(), "", "owned transient systemd units remain")
        for kind in ("container", "network", "volume"):
            options = ["--all"] if kind == "container" else []
            output = await self.run_host([self.docker, kind, "ls", *options, "--filter", "label=partitura.session=" + session, "--quiet"])
            self.assertEqual(output.strip(), "", f"owned Docker {kind} remains")
        # Cross-request lock files intentionally persist. Unlinking an active
        # flock path would permit two concurrent lifecycle owners.

    async def run_host(self, argv, stdin=None):
        process = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(stdin), 30)
        except BaseException:
            process.kill()
            await process.wait()
            raise
        self.assertEqual(process.returncode, 0, f"host probe failed: {argv[0]}: {stderr.decode(errors='replace')[-1000:]}")
        return stdout.decode()

    async def gateway_fetch(self, relay, path, token="", method="GET"):
        code = "const p=JSON.parse(await Bun.stdin.text());const r=await fetch(p.url,{method:p.method,headers:p.token?{authorization:'Bearer '+p.token}:{},signal:AbortSignal.timeout(5000)});console.log(JSON.stringify({status:r.status,body:await r.text()}));"
        payload = json.dumps({"url": f"http://{relay['address']}:{relay['port']}{path}", "method": method, "token": token}).encode()
        output = await self.run_host([self.docker, "exec", "-i", self.gateway, "bun", "-e", code], payload)
        return json.loads(output)

    async def test_default_firecracker_lifecycle(self):
        await self.qualify("firecracker")

    async def test_explicit_sysbox_lifecycle(self):
        await self.qualify("sysbox")

    async def qualify(self, runtime):
        print(f"LIVE {runtime}: provisioning two isolated sessions", flush=True)
        session, workspace = await self.create_session(runtime, self.uid)
        peer, peer_workspace = await self.create_session(runtime, self.peer_uid)
        # Match gateway startup ordering: tool startup can itself need the
        # approved HTTPS proxy, including Mise's version update check.
        proxy = await self.lease(session, self.uid, "egress")
        env = {"HTTP_PROXY": f"http://{proxy['address']}:{proxy['port']}", "HTTPS_PROXY": f"http://{proxy['address']}:{proxy['port']}", "NO_PROXY": "localhost,127.0.0.1,::1"}
        (peer_workspace / "private-marker").write_text("peer-private")
        os.chown(peer_workspace / "private-marker", self.peer_uid, self.peer_uid)
        os.chmod(peer_workspace / "private-marker", 0o600)
        # Wait for dockerd before inspecting interfaces. Its internal bridge is
        # expected, while any VMM NIC or external default route is forbidden.
        await self.execute(session, self.uid, ["/bin/sh", "-ec", """
mkdir -p /workspace/.omp-home
git init -q
apply_patch <<'PATCH'
*** Begin Patch
*** Add File: .omp-home/patch-helper-probe
+Worker patch helper verified.
*** End Patch
PATCH
test "$(cat .omp-home/patch-helper-probe)" = 'Worker patch helper verified.'
rm .omp-home/patch-helper-probe
mise exec -- node --version
mise exec -- python --version
timeout 120 /bin/sh -ec '
  while ! timeout 2 docker info >/dev/null 2>&1; do
    if [ -f /run/docker.pid ]; then
      read -r docker_pid </run/docker.pid
      case "$docker_pid" in
        ""|*[!0-9]*) echo "nested Docker has an invalid pidfile" >&2; exit 1 ;;
      esac
      if [ ! -d "/proc/$docker_pid" ]; then
        echo "nested Docker exited before becoming ready" >&2
        exit 1
      fi
    fi
    sleep 1
  done
' || { echo "nested Docker failed to become ready within 120 seconds" >&2; exit 1; }
"""], env=env, timeout=135)
        # Boot, nonroot identity, independent kernel/network, and actual tools.
        details = json.loads(await self.python(session, self.uid,
            "import json,os,pathlib,subprocess; print(json.dumps({'uid':os.getuid(),'kernel':os.uname().release,'net':os.listdir('/sys/class/net'),'dockerBridge':pathlib.Path('/sys/class/net/docker0/bridge').is_dir(),'ipv4DefaultRoutes':json.loads(subprocess.check_output(['ip','-j','-4','route','show','default'],text=True)),'ipv6DefaultRoutes':json.loads(subprocess.check_output(['ip','-j','-6','route','show','default'],text=True)) if pathlib.Path('/proc/net/ipv6_route').exists() else [],'node':subprocess.check_output(['node','--version'],text=True).strip(),'python':subprocess.check_output(['python3','--version'],text=True).strip(),'mise':subprocess.check_output(['mise','--version'],text=True).strip()}))", env=env))
        self.assertEqual(details["uid"], self.uid)
        self.assertTrue(details["node"].startswith("v24."))
        self.assertTrue(details["python"].startswith("Python 3.13."))
        self.assertRegex(details["mise"], r"^2026\.10\.15 linux-x64\b")
        print("LIVE worker details: " + json.dumps(details, sort_keys=True), flush=True)
        if runtime == "firecracker":
            assert_guest_network(details)
            self.assertNotEqual(details["kernel"], os.uname().release)
        # Actual stdin/stdout/stderr framing and nonzero status.
        code, stdout, stderr = await self.wire.execute(self.exec_request(session, self.uid, ["python3", "-c", "import sys; print(sys.stdin.read(),end=''); print('stderr-marker',file=sys.stderr); sys.exit(23)"]), b"stdin-marker")
        self.assertEqual((code, stdout, stderr), (23, b"stdin-marker", b"stderr-marker\n"))
        await self.live_workspace(session, workspace)
        if runtime == "firecracker":
            await self.python(session, self.uid, "import os; from pathlib import Path; root=Path('/workspace/node_modules'); assert root.stat().st_dev != Path('/workspace').stat().st_dev; assert root.stat().st_uid == os.getuid(); (root/'.partitura-local-dependency').write_text('session-disk')")
            self.assertFalse((workspace / "node_modules/.partitura-local-dependency").exists(), "dependencies leaked onto the SFTP source workspace")
            self.assertEqual((await self.python(peer, self.peer_uid, "from pathlib import Path; print(Path('/workspace/node_modules/.partitura-local-dependency').exists())")).strip(), "False")
        await self.isolation(session, peer, workspace, peer_workspace, runtime)
        await self.execute(session, self.uid, ["curl", "--fail", "--silent", "--show-error", "--max-time", "30", "https://registry.npmjs.org/-/ping"], env)
        code, _, stderr = await self.wire.execute(self.exec_request(session, self.uid, ["curl", "--fail", "--silent", "--show-error", "--max-time", "10", "https://partitura-acceptance-denied.invalid/"], env))
        self.assertNotEqual(code, 0)
        self.assertIn(b"403", stderr)
        await self.python(session, self.uid, "import socket\ntry: socket.create_connection(('1.1.1.1',443),timeout=2)\nexcept OSError: pass\nelse: raise AssertionError('direct external TCP route exists')")
        print(f"LIVE {runtime}: real nested Docker run and build", flush=True)
        image = os.environ["PARTITURA_SANDBOX_LIVE_DOCKER_IMAGE"]
        self.assertIn("@sha256:", image, "acceptance image must be digest pinned")
        self.assertEqual(await self.execute(session, self.uid, ["docker", "run", "--rm", image, "/bin/sh", "-ec", "printf nested-run-ok"], timeout=240), "nested-run-ok")
        dependency_copy = "COPY node_modules/.partitura-local-dependency /dependency-proof\n" if runtime == "firecracker" else ""
        (workspace / "Dockerfile.acceptance").write_text(f"FROM {image}\n{dependency_copy}RUN printf nested-build-ok > /proof\nCMD [\"cat\",\"/proof\"]\n")
        await self.execute(session, self.uid, ["docker", "build", "--network=none", "-f", "Dockerfile.acceptance", "-t", "partitura-acceptance:local", "."], timeout=240)
        self.assertEqual((await self.execute(session, self.uid, ["docker", "run", "--rm", "partitura-acceptance:local"])).strip(), "nested-build-ok")
        if runtime == "firecracker":
            self.assertEqual((await self.execute(session, self.uid, ["docker", "run", "--rm", "partitura-acceptance:local", "cat", "/dependency-proof"])).strip(), "session-disk")
        await self.relays_and_t3(session, peer, env)
        await self.cancellation(session, workspace)
        for writer in reversed(self.owners + self.leases):
            await close(writer)
        self.owners.clear()
        self.leases.clear()
        # Recovery must retire orphan processes, retain the same disk and mount.
        await self.python(session, self.uid, "from pathlib import Path; Path('/mise/recovery-marker').write_text('persisted')")
        _, orphan = await self.wire.connect(self.exec_request(session, self.uid, ["python3", "-c", "import time; from pathlib import Path; p=Path('/workspace/recovery-heartbeat')\nwhile True: p.write_text(str(time.monotonic_ns())); time.sleep(.05)"]))
        self.owners.append(orphan)
        await self.wait_file(workspace / "recovery-heartbeat")
        recovery = await self.wire.control(self.request(session, self.uid, "recover", runtime=runtime, workspacePath=str(self.logical_root / session)))
        self.assertTrue(recovery["exists"] and recovery["running"])
        self.assertEqual(recovery["runtime"], runtime)
        self.assertEqual((await self.python(session, self.uid, "from pathlib import Path; print(Path('/mise/recovery-marker').read_text())")).strip(), "persisted")
        if runtime == "firecracker":
            self.assertEqual((await self.python(session, self.uid, "from pathlib import Path; print(Path('/workspace/node_modules/.partitura-local-dependency').read_text())")).strip(), "session-disk")
        self.assertEqual((await self.python(session, self.uid, "from pathlib import Path; print(Path('/workspace/worker-live').read_text())")).strip(), "host-update-seen")
        before = (workspace / "recovery-heartbeat").read_text()
        await asyncio.sleep(0.3)
        self.assertEqual((workspace / "recovery-heartbeat").read_text(), before, "recovery retained an orphan worker")
        await close(orphan)
        self.owners.remove(orphan)
        await self.execute(session, self.uid, ["docker", "info"])
        for owned in (peer, session):
            await self.wire.control({"operation": "destroy", "sessionId": owned})
            await self.assert_absent(owned)
            await self.wire.control({"operation": "destroy", "sessionId": owned})
            self.sessions.remove(owned)
        print(f"LIVE {runtime}: passed; owned runtime resources absent", flush=True)

    async def live_workspace(self, session, workspace):
        links = """import os
from pathlib import Path
root=Path('/workspace/symlink-check')
root.mkdir()
(root/'target').write_text('session-owned')
(root/'nested').mkdir()
for link,target in [(root/'absolute','/workspace/symlink-check/target'),
                    (root/'nested/parent','../target')]:
    link.symlink_to(target)
    assert os.readlink(link)==target
    assert link.read_text()=='session-owned'
"""
        await self.python(session, self.uid, links)
        (workspace / "host-live").write_text("initial")
        os.chown(workspace / "host-live", self.uid, self.uid)
        code = "from pathlib import Path; import time; p=Path('/workspace/host-live'); assert p.read_text()=='initial'; Path('/workspace/worker-ready').write_text('ready'); deadline=time.monotonic()+20\nwhile p.read_text()!='host-update':\n assert time.monotonic()<deadline; time.sleep(.05)\nPath('/workspace/worker-live').write_text('host-update-seen')"
        task = asyncio.create_task(self.python(session, self.uid, code))
        try:
            await self.wait_file(workspace / "worker-ready")
            (workspace / "host-live").write_text("host-update")
            await task
            self.assertEqual((workspace / "worker-live").read_text(), "host-update-seen")
            self.assertEqual((workspace / "worker-live").stat().st_uid, self.uid)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    async def isolation(self, session, peer, workspace, peer_workspace, runtime):
        (workspace / "foreign-link").symlink_to(peer_workspace / "private-marker")
        await self.python(session, self.uid, "from pathlib import Path\np=Path('/workspace/foreign-link')\ntry: p.read_text()\nexcept (PermissionError, FileNotFoundError): pass\nelse: raise AssertionError('cross-session workspace readable')")
        self.assertEqual((peer_workspace / "private-marker").read_text(), "peer-private")
        with self.assertRaisesRegex(RuntimeError, "ownership|runtime|match"):
            await self.wire.control(self.request(session, self.peer_uid, "recover", runtime=runtime, workspacePath=str(self.logical_root / peer)))
        for operation, fields in (("egress", {}), ("relay", {"target": "gateway", "targetPort": self.gateway_port})):
            with self.assertRaisesRegex(RuntimeError, "uid|identity|match"):
                await self.wire.lease(self.request(session, self.peer_uid, operation, **fields))
        reader, writer = await self.wire.connect(self.exec_request(session, self.peer_uid, ["id"]))
        try:
            response = json.loads(await asyncio.wait_for(reader.readline(), 10))
            self.assertFalse(response["ok"])
        finally:
            await close(writer)
        if runtime == "firecracker":
            digest = hashlib.sha256(session.encode()).hexdigest()[:24]
            peer_digest = hashlib.sha256(peer.encode()).hexdigest()[:24]
            token = json.loads((self.state_root / (peer_digest + ".json")).read_text())["token"]
            reader, writer = await asyncio.open_unix_connection(str(self.vm_root / digest / "v.sock"))
            try:
                writer.write(b"CONNECT 52\n")
                await writer.drain()
                self.assertTrue((await reader.readline()).startswith(b"OK "))
                writer.write(json.dumps({"operation": "ping", "token": token}).encode() + b"\n")
                await writer.drain()
                response = json.loads(await asyncio.wait_for(reader.readline(), 10))
                self.assertFalse(response["ok"])
            finally:
                await close(writer)

    async def relays_and_t3(self, session, peer, env):
        await self.gateway_bound_listener(session, env)
        gateway_relay = await self.lease(session, self.uid, "relay", target="gateway", targetPort=self.gateway_port)
        root = f"http://{gateway_relay['address']}:{gateway_relay['port']}"
        self.assertEqual((await self.execute(session, self.uid, ["curl", "--noproxy", "*", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}", "--max-time", "10", root + "/health"], env)).strip(), "200")
        self.assertEqual((await self.execute(session, self.uid, ["curl", "--noproxy", "*", "--silent", "--output", "/dev/null", "--write-out", "%{http_code}", "--max-time", "10", root + "/api/admin/runs"], env)).strip(), "401")
        # No model settings or provider key is supplied. Only offline bearer
        # issuance and an authenticated websocket-ticket HTTP request run.
        base = "/workspace/.omp-home/t3-acceptance"
        issued = json.loads(await self.execute(session, self.uid, ["t3", "auth", "session", "issue", "--base-dir", base, "--scope", "orchestration:read", "--scope", "orchestration:operate", "--ttl", "1h", "--json"]))
        token = issued["token"]
        _, server = await self.wire.connect(self.exec_request(session, self.uid, ["t3", "serve", "--host", "0.0.0.0", "--port", "47300", "--base-dir", base, "/workspace"], {"T3CODE_HOME": base}))
        self.owners.append(server)
        relay = await self.lease(session, self.uid, "relay", target="worker", targetPort=47300)
        async with asyncio.timeout(60):
            while True:
                try:
                    result = await self.gateway_fetch(relay, "/.well-known/t3/environment")
                    if result["status"] == 200:
                        break
                except (AssertionError, json.JSONDecodeError):
                    pass
                await asyncio.sleep(0.2)
        self.assertEqual(json.loads(result["body"])["orchestrationProtocolVersion"], 2)
        self.assertIn((await self.gateway_fetch(relay, "/api/auth/websocket-ticket", method="POST"))["status"], (401, 403))
        accepted = await self.gateway_fetch(relay, "/api/auth/websocket-ticket", token, "POST")
        self.assertEqual(accepted["status"], 200)
        self.assertTrue(json.loads(accepted["body"])["ticket"])
        # Another session can't use this bearer, even with an equivalent T3
        # daemon and the same TCP port. Its own offline auth state differs.
        await self.execute(peer, self.peer_uid, ["/bin/sh", "-ec", "mkdir -p /workspace/.omp-home; git init -q"])
        peer_base = "/workspace/.omp-home/t3-acceptance"
        await self.execute(peer, self.peer_uid, ["t3", "auth", "session", "issue", "--base-dir", peer_base, "--scope", "orchestration:read", "--ttl", "1h", "--json"])
        _, peer_server = await self.wire.connect(self.exec_request(peer, self.peer_uid, ["t3", "serve", "--host", "0.0.0.0", "--port", "47300", "--base-dir", peer_base, "/workspace"], {"T3CODE_HOME": peer_base}))
        self.owners.append(peer_server)
        peer_relay = await self.lease(peer, self.peer_uid, "relay", target="worker", targetPort=47300)
        async with asyncio.timeout(60):
            while True:
                try:
                    denied = await self.gateway_fetch(peer_relay, "/api/auth/websocket-ticket", token, "POST")
                    if denied["status"] != 503:
                        break
                except (AssertionError, json.JSONDecodeError):
                    pass
                await asyncio.sleep(0.2)
        self.assertIn(denied["status"], (401, 403), denied)

    async def gateway_bound_listener(self, session, env):
        # Real Git/MCP listeners bind the address returned by provision. A
        # fixture bound there must be reachable over the broker relay too.
        marker = secrets.token_hex(16)
        process = await asyncio.create_subprocess_exec(
            self.docker, "exec", "-i", self.gateway, "bun", "-e", GATEWAY_BIND_SERVER,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        endpoint = None
        try:
            process.stdin.write(json.dumps({"host": self.provisioned[session]["gatewayAddress"], "marker": marker}).encode())
            await process.stdin.drain()
            process.stdin.close()
            endpoint = json.loads(await asyncio.wait_for(process.stdout.readline(), 10))
            relay = await self.lease(session, self.uid, "relay", target="gateway", targetPort=endpoint["port"])
            url = f"http://{relay['address']}:{relay['port']}/{marker}"
            reply = await self.execute(session, self.uid, ["curl", "--noproxy", "*", "--fail", "--silent", "--show-error", "--max-time", "10", url], env=env)
            self.assertEqual(reply, marker, "provision gatewayAddress is unreachable by gateway relay")
        finally:
            if endpoint is not None:
                try:
                    stopped = await self.gateway_fetch(endpoint, "/stop/" + marker)
                    self.assertEqual(stopped["status"], 200)
                finally:
                    try:
                        _, stderr = await asyncio.wait_for(process.communicate(), 5)
                    except TimeoutError:
                        process.kill()
                        await process.wait()
                        self.fail("gateway bind fixture did not stop; its safety timeout is 90 seconds")
                    self.assertEqual(process.returncode, 0, f"gateway bind fixture failed: {stderr.decode(errors='replace')[-1000:]}")
            else:
                process.kill()
                await process.wait()

    async def cancellation(self, session, workspace):
        code = "import subprocess,time; from pathlib import Path; subprocess.Popen(['python3','-c',\"import time; from pathlib import Path; p=Path('/workspace/cancel-child');\\nwhile True: p.write_text(str(time.monotonic_ns())); time.sleep(.05)\"]); p=Path('/workspace/cancel-parent')\nwhile True: p.write_text(str(time.monotonic_ns())); time.sleep(.05)"
        _, writer = await self.wire.connect(self.exec_request(session, self.uid, ["python3", "-c", code]))
        self.owners.append(writer)
        await self.wait_file(workspace / "cancel-parent")
        await self.wait_file(workspace / "cancel-child")
        await close(writer)
        await asyncio.sleep(1)
        previous = [(workspace / name).read_text() for name in ("cancel-parent", "cancel-child")]
        await asyncio.sleep(0.3)
        self.assertEqual([(workspace / name).read_text() for name in ("cancel-parent", "cancel-child")], previous, "disconnect left worker processes running")


if __name__ == "__main__":
    unittest.main()
