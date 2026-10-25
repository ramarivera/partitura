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


class NativeHostSetupTests(unittest.TestCase):
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
            ]
        )
        calls = []

        def run(arguments, **kwargs):
            calls.append((arguments, kwargs))
            return subprocess.CompletedProcess(
                arguments, 0, stdout=expected if "-T" in arguments else "", stderr=""
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
                self.assertEqual(arguments[:4], ['/usr/bin/sudo', '--non-interactive', '-u', 'partitura-build'])
                self.assertEqual(kwargs['timeout'], 15)
                return subprocess.run(arguments[4:], **kwargs)

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
