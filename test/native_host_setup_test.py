"""Standalone host setup contract tests. Set TMPDIR to owned scratch storage."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "deploy/mac-build/host_setup.py"
spec = importlib.util.spec_from_file_location("partitura_host_setup", MODULE_PATH)
host_setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host_setup)


class NativeHostSetupTests(unittest.TestCase):
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
        self.assertIn('sudo -n /usr/bin/python3 - "$dedicated_vm"', preparation)


if __name__ == "__main__":
    unittest.main()
