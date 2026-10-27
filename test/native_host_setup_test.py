"""Standalone host setup contract tests. Set TMPDIR to owned scratch storage."""
import importlib.util
import hashlib
import json
import os
import socket
from pathlib import Path
from types import SimpleNamespace
import subprocess
import unittest
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "deploy/mac-build/host_setup.py"
spec = importlib.util.spec_from_file_location("partitura_host_setup", MODULE_PATH)
host_setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_setup)


SCRATCH = Path(os.environ.get('TMPDIR') or Path.home() / 'dev/agentic-scratchpads/partitura/builder-registry-impl/python-tests').resolve()
SCRATCH.mkdir(mode=0o700, parents=True, exist_ok=True)


class NativeHostSetupTests(unittest.TestCase):
    def test_root_identity_journal_survives_reruns_and_refuses_conflicts(self):
        loader = importlib.util.spec_from_file_location('native_identity', ROOT / 'deploy/mac-build/native_host.py')
        launcher = importlib.util.module_from_spec(loader)
        loader.loader.exec_module(launcher)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            journal = Path(directory) / 'installation.json'
            config = dict(hostId='12345678-1234-1234-1234-123456789abc')
            actual_lstat = Path.lstat
            def root_metadata(path):
                info = actual_lstat(path)
                return SimpleNamespace(st_mode=info.st_mode, st_uid=0)
            def installed(path):
                return path.read_bytes() if path == journal and path.exists() else None
            with patch.object(launcher, 'IDENTITY_PATH', journal), patch.object(launcher, 'read_installed', side_effect=installed), patch.object(Path, 'lstat', root_metadata):
                old_umask = os.umask(0o777)
                try:
                    launcher.ensure_identity(config, 'builder')
                finally:
                    os.umask(old_umask)
                first = journal.read_bytes()
                launcher.ensure_identity(config, 'builder')
                self.assertEqual(journal.read_bytes(), first)
                self.assertEqual(journal.stat().st_mode & 0o777, 0o444)
                with self.assertRaisesRegex(ValueError, 'identity journal differs'):
                    launcher.ensure_identity(dict(config, hostId='aaaaaaaa-1234-1234-1234-123456789abc'), 'builder')
                with self.assertRaisesRegex(ValueError, 'identity journal differs'):
                    launcher.ensure_identity(config, 'other-account')
                self.assertEqual(journal.read_bytes(), first)

    def test_root_apply_checks_exact_predecessor_and_every_payload(self):
        loader = importlib.util.spec_from_file_location('native_predecessor', ROOT / 'deploy/mac-build/native_host.py')
        launcher = importlib.util.module_from_spec(loader)
        loader.loader.exec_module(launcher)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            broker, writer, plist, tart = [root / name for name in ('broker', 'writer', 'plist', 'tart')]
            manifest_path = root / 'manifest'
            for path in (broker, writer, tart):
                path.write_bytes(path.name.encode())
                path.chmod(0o555)
            manifest = dict(schema=1, files={str(path): dict(sha256=hashlib.sha256(path.read_bytes()).hexdigest(), mode=0o555) for path in (broker, writer, tart)})
            payload = json.dumps(manifest).encode()
            pin = hashlib.sha256(payload).hexdigest()
            real_lstat = Path.lstat
            def root_metadata(path):
                info = real_lstat(path)
                return SimpleNamespace(st_mode=info.st_mode, st_uid=0)
            with patch.object(launcher, 'MANIFEST_PATH', manifest_path), patch.object(launcher, 'TART_TARGET', str(tart)), patch.object(launcher, 'PLIST_TARGET', str(plist)), patch.object(launcher, 'WRITER_TARGET', str(writer)), patch.object(launcher, 'STAGED_FILES', {str(broker): 'broker', str(writer): 'writer', str(plist): 'plist'}), patch.object(launcher, 'read_installed', return_value=payload), patch.object(Path, 'lstat', root_metadata):
                launcher.verify_predecessor({}, pin)
                for invalid in ('', 'f' * 64):
                    with self.assertRaisesRegex(ValueError, 'exact predecessor'):
                        launcher.verify_predecessor({}, invalid)
                plist.write_bytes(b'unmanaged')
                with self.assertRaisesRegex(ValueError, 'unmanaged installation target'):
                    launcher.verify_predecessor({}, pin)
                plist.unlink()
                broker.chmod(0o755)
                broker.write_bytes(b'changed')
                broker.chmod(0o555)
                with self.assertRaisesRegex(ValueError, 'payload differs'):
                    launcher.verify_predecessor({}, pin)

    def test_qualification_mount_check_is_portable_and_fails_on_awk_errors(self):
        source = (ROOT / "deploy/mac-build/qualify-base.sh").read_text()
        check = source[source.index("mount_check=$("):source.index("\nprintf 'PARTITURA_NATIVE_BASE_QUALIFIED")]
        for mounts, accepted in [
            ("/dev/disk1 on / (apfs, local)\n", True),
            ("share on /Volumes/workspace (virtiofs)\n", False),
            ("server on /mnt/build (smbfs)\n", False),
            ("share on /Volumes/workspace (other)\n", False),
        ]:
            with self.subTest(mounts=mounts):
                result = subprocess.run(
                    ["bash", "-c", 'set -euo pipefail; fail() { exit 1; }; mount() { printf "%s" "$MOUNT_FIXTURE"; }; ' + check],
                    env={**os.environ, "MOUNT_FIXTURE": mounts}, capture_output=True,
                )
                self.assertEqual(result.returncode == 0, accepted, result.stderr)
        result = subprocess.run(
            ["bash", "-c", 'set -euo pipefail; fail() { exit 1; }; mount() { :; }; awk() { return 23; }; ' + check],
            capture_output=True,
        )
        self.assertEqual(result.returncode, 23)
        self.assertIn("export MISE_OFFLINE=true", source)

    def test_base_sealing_removes_only_a_stale_owned_control_socket(self):
        source = (ROOT / "deploy/mac-build/prepare-base.sh").read_text()
        block = source.split('/usr/bin/python3 - "$base_vm/control.sock" <<\'PY\'\n', 1)[1].split("\nPY\n", 1)[0]
        with tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"]) as directory:
            control = Path(directory) / "control.sock"

            def seal():
                return subprocess.run(["/usr/bin/python3", "-c", block, str(control)], capture_output=True)

            self.assertEqual(seal().returncode, 0)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(control))
                server.listen(1)
                self.assertNotEqual(seal().returncode, 0)
                self.assertTrue(control.exists())
            self.assertEqual(seal().returncode, 0)
            self.assertFalse(control.exists())
            control.write_text("unexpected")
            self.assertNotEqual(seal().returncode, 0)
            self.assertEqual(control.read_text(), "unexpected")
            control.unlink()
            control.symlink_to(Path(directory) / "missing")
            self.assertNotEqual(seal().returncode, 0)
            self.assertTrue(control.is_symlink())

    def test_root_launcher_snapshots_only_manifest_pinned_payloads(self):
        loader = importlib.util.spec_from_file_location('native_installer', ROOT / 'deploy/mac-build/native_host.py')
        launcher = importlib.util.module_from_spec(loader)
        loader.loader.exec_module(launcher)
        self.assertEqual(launcher.INSTALL_HOST_SHA256, hashlib.sha256((ROOT / 'deploy/mac-build/install-host.sh').read_bytes()).hexdigest())
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            stage = Path(directory)
            entries = {}
            for target, name in launcher.STAGED_FILES.items():
                payload = name.encode()
                (stage / name).write_bytes(payload)
                entries[target] = {'sha256': hashlib.sha256(payload).hexdigest(), 'mode': 0o444}
            entries[launcher.TART_TARGET] = {'sha256': 'a'*64, 'mode': 0o555}
            manifest = json.dumps({'schema': 1, 'files': entries}).encode()
            (stage / 'managed-files.json').write_bytes(manifest)
            pin = hashlib.sha256(manifest).hexdigest()
            (stage / 'provision.py').write_bytes((ROOT / 'deploy/mac-build/provision.py').read_bytes())
            snapshot = launcher.verified_payloads(stage, pin, 'a'*64)
            self.assertEqual(snapshot['broker.py'], b'broker.py')
            (stage / 'broker.py').write_bytes(b'tampered')
            self.assertEqual(snapshot['broker.py'], b'broker.py')
            with self.assertRaisesRegex(ValueError, 'approved manifest'):
                launcher.verified_payloads(stage, pin, 'a'*64)
            with self.assertRaisesRegex(ValueError, 'approved pin'):
                launcher.verified_payloads(stage, 'b'*64, 'a'*64)
            (stage / 'broker.py').unlink()
            (stage / 'broker.py').symlink_to(stage / 'config.json')
            with self.assertRaises(OSError):
                launcher.verified_payloads(stage, pin, 'a'*64)

    def test_root_staging_uses_account_home_when_sudo_preserves_administrator_home(self):
        loader = importlib.util.spec_from_file_location('native_root_home', ROOT / 'deploy/mac-build/native_host.py')
        launcher = importlib.util.module_from_spec(loader)
        loader.loader.exec_module(launcher)
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            root_home = Path(directory)
            actual_lstat = Path.lstat

            def root_metadata(path):
                info = actual_lstat(path)
                return SimpleNamespace(st_mode=info.st_mode, st_uid=0)

            with patch.dict(os.environ, {'HOME': '/untrusted/administrator'}), patch.object(launcher.pwd, 'getpwuid', return_value=SimpleNamespace(pw_dir=str(root_home))), patch.object(Path, 'lstat', root_metadata), patch.object(Path, 'home', side_effect=AssertionError('environment home must not be used')):
                scratch = launcher.root_scratch_directory()
            self.assertEqual(scratch, root_home / 'dev/agentic-scratchpads/partitura/native-host/root-installer')
            self.assertEqual(scratch.stat().st_mode & 0o777, 0o700)

    def test_standalone_cli_exposes_check_and_stage_host(self):
        result = subprocess.run(
            ["/usr/bin/python3", str(MODULE_PATH), "--help"],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertIn("--check", result.stdout)
        self.assertIn("--stage-host", result.stdout)

    def test_sshd_preflight_uses_bounded_noninteractive_sudo(self):
        settings = {"account": "partitura-build"}
        expected = "\n".join(
            [
                f"authorizedkeysfile {host_setup.ROOT_AUTHORIZED_KEYS}",
                "passwordauthentication no",
                "kbdinteractiveauthentication no",
                "authenticationmethods publickey",
                f"forcecommand {host_setup.FORCED_COMMAND}",
                "allowtcpforwarding no",
                "allowagentforwarding no",
                "x11forwarding no",
                "permittty no",
                "permituserenvironment no",
                "clientaliveinterval 15",
                "clientalivecountmax 3",
            ]
        )
        calls = []

        def run(arguments, **kwargs):
            calls.append((arguments, kwargs))
            return subprocess.CompletedProcess(
                arguments, 0,
                stdout="\n".join(line[0].upper() + line[1:] for line in expected.splitlines()) if "-T" in arguments else "",
                stderr=""
            )

        with patch.object(Path, "read_text", return_value="Include /etc/ssh/sshd_config.d/*"):
            effective = host_setup.sshd_effective(settings, run)
        host_setup.verify_effective_sshd(settings, effective)
        self.assertEqual(len(calls), 2)
        self.assertTrue(
            all(
                call[0][:3] == ["/usr/bin/sudo", "--non-interactive", "/usr/sbin/sshd"]
                and call[1]["timeout"] == 15
                for call in calls
            )
        )

    def test_private_runtime_is_checked_as_its_owner_without_relaxing_permissions(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            root = Path(directory)
            runtime, tart = root / 'private-home' / 'runtime', root / 'tart'
            runtime.mkdir(parents=True, mode=0o700)
            runtime.parent.chmod(0o700)
            tart.mkdir(mode=0o700)
            calls = []

            def run(arguments, **kwargs):
                calls.append((arguments, kwargs))
                self.assertEqual(arguments[:5], ['/usr/bin/sudo', '--non-interactive', '-H', '-u', 'partitura-build'])
                self.assertEqual(kwargs['timeout'], 15)
                # A process-scoped DEVELOPER_DIR selection may precede the shim.
                self.assertEqual(arguments[arguments.index('-c') - 2:arguments.index('-c')], ['/usr/bin/python3', '-I'])
                self.assertEqual(kwargs['cwd'], '/')
                return subprocess.run(arguments[5:], **kwargs)

            settings = {'account': 'partitura-build', 'runtime': {'root': str(runtime), 'tart_home': str(tart)}}
            with patch.object(Path, 'lstat', side_effect=PermissionError('administrator cannot traverse private home')):
                host_setup.verify_private_runtime(settings, run)
            self.assertEqual(runtime.parent.stat().st_mode & 0o777, 0o700)
            runtime.chmod(0o755)
            with self.assertRaises(subprocess.CalledProcessError):
                host_setup.verify_private_runtime(settings, run)
            runtime.chmod(0o700)
            link = root / 'link'
            link.symlink_to(tart, target_is_directory=True)
            settings['runtime']['tart_home'] = str(link)
            with self.assertRaises(subprocess.CalledProcessError):
                host_setup.verify_private_runtime(settings, run)

    def test_root_interpreter_and_developer_selection_must_be_root_owned(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            operator_python = Path(directory) / 'python3'
            operator_python.write_text('')
            loader = importlib.util.spec_from_file_location('native_interpreter', ROOT / 'deploy/mac-build/native_host.py')
            native_host = importlib.util.module_from_spec(loader)
            loader.loader.exec_module(native_host)
            for module in (host_setup, native_host):
                with self.subTest(module=module.__name__), patch.object(module.os, 'geteuid', return_value=0):
                    with patch.object(module.sys, 'executable', '/bin/sh'), patch.object(module.sys, 'prefix', '/usr'):
                        if module is host_setup:
                            host_setup.verify_root_interpreter()
                        else:
                            self.assertIsNone(native_host.untrusted_root_interpreter())
                    with patch.object(module.sys, 'executable', str(operator_python)), patch.object(module.sys, 'prefix', '/usr'):
                        if module is host_setup:
                            with self.assertRaisesRegex(host_setup.NativeHostError, 'root Python interpreter'):
                                host_setup.verify_root_interpreter()
                        else:
                            self.assertIsNotNone(native_host.untrusted_root_interpreter())
            with patch.dict(os.environ, {'DEVELOPER_DIR': '/usr'}):
                self.assertEqual(
                    host_setup.account_python('partitura-build'),
                    ['/usr/bin/sudo', '--non-interactive', '-H', '-u', 'partitura-build',
                     '/usr/bin/env', 'DEVELOPER_DIR=/usr', '/usr/bin/python3', '-I'],
                )
            with patch.dict(os.environ, {'DEVELOPER_DIR': directory}):
                with self.assertRaisesRegex(host_setup.NativeHostError, 'developer directory'):
                    host_setup.account_python('partitura-build')
            with patch.dict(os.environ, {'DEVELOPER_DIR': 'relative'}):
                with self.assertRaisesRegex(host_setup.NativeHostError, 'developer directory'):
                    host_setup.account_python('partitura-build')
            # /usr/bin/git is also an xcode-select shim; root must keep the selection.
            with patch.dict(os.environ, {'DEVELOPER_DIR': '/usr', 'GIT_DIR': '/untrusted'}):
                environment = host_setup.git_environment()
                self.assertEqual(environment['DEVELOPER_DIR'], '/usr')
                self.assertEqual(environment['GIT_CONFIG_NOSYSTEM'], '1')
                self.assertNotIn('GIT_DIR', environment)
            with patch.dict(os.environ, {'DEVELOPER_DIR': directory}):
                with self.assertRaisesRegex(host_setup.NativeHostError, 'developer directory'):
                    host_setup.git_environment()

    def test_installer_checks_staged_and_live_sshd_and_restores_dropin_on_failure(self):
        installer = (ROOT / "deploy/mac-build/install-host.sh").read_text()
        swap = installer.index('/bin/mv -f "$dropin.new" "$dropin"')
        live_check = installer.index("/usr/sbin/sshd -t", swap)
        completed = installer.index("completed=1", live_check)
        self.assertLess(swap, live_check)
        self.assertLess(live_check, completed)
        self.assertIn("/usr/sbin/sshd -t -f", installer)
        self.assertIn(
            'restore_managed_file dropin "$dropin" || rollback_failed=1', installer
        )
        self.assertIn('"$preflight/sshd_config"', installer)
        self.assertIn("sshd -T -f", installer)

    def test_sshd_keyword_normalization_preserves_case_sensitive_paths(self):
        installer = (ROOT / "deploy/mac-build/install-host.sh").read_text()
        normalize = installer.split("normalize_sshd_keywords() {\n", 1)[1].split("\n}", 1)[0]
        result = subprocess.run(
            ["bash", "-c", normalize],
            input="AuthorizedKeysFile /Library/Partitura/NativeBuild/authorized_keys\nForceCommand /usr/bin/python3 /Library/Partitura/NativeBuild/broker.py\n",
            capture_output=True, text=True, check=True,
        )
        self.assertEqual(result.stdout, "authorizedkeysfile /Library/Partitura/NativeBuild/authorized_keys\nforcecommand /usr/bin/python3 /Library/Partitura/NativeBuild/broker.py\n")
        self.assertEqual(installer.count("| normalize_sshd_keywords)"), 2)

    def test_base_preparation_promotes_and_binds_the_destination_receipt(self):
        preparation = (ROOT / "deploy/mac-build/prepare-base.sh").read_text()
        bootstrap = (ROOT / "deploy/mac-build/bootstrap-host.sh").read_text()
        self.assertIn("--dedicated-tart-home PATH --dedicated-account NAME", preparation)
        self.assertIn('vms="$tart_home/vms"', bootstrap)
        self.assertIn('"$account:staff:700"', bootstrap)
        self.assertIn('sudo -n /usr/bin/ditto --rsrc "$base_vm" "$dedicated_vm"', preparation)
        self.assertIn('sudo -n /usr/sbin/chown -R "$dedicated_account":staff "$dedicated_vm"', preparation)
        self.assertIn('"$receipt_base_path"', preparation)
        self.assertIn('base_sha=$(sudo -n -u "$dedicated_account"', preparation)
        self.assertIn('[ "$base_sha" = "$qualified_sha" ] || fail', preparation)
        self.assertIn('sudo -n /usr/bin/python3 - "$dedicated_vm"', preparation)


if __name__ == "__main__":
    unittest.main()
