"""Exercise the installer's log-file checks without root or macOS tools."""
import grp
import os
from pathlib import Path
import pwd
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MaintenanceLogInstallerTests(unittest.TestCase):
    def test_private_log_creation_preservation_and_unsafe_inode_refusals(self):
        installer = (ROOT / 'deploy/mac-build/install-host.sh').read_text()
        block = installer.split('log=/Library/Partitura/NativeBuild/maintenance.stderr.log\n', 1)[1].split('/usr/bin/ditto', 1)[0]
        block = block.replace("/usr/bin/stat -f '%l:%Su:%Lp'", "/usr/bin/stat -c '%h:%U:%a'")
        block = block.replace('-g staff', '-g ' + grp.getgrgid(os.getgid()).gr_name)
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as root:
            log = Path(root) / 'maintenance.stderr.log'
            def run():
                return subprocess.run(['bash', '-eu', '-c', block], env=dict(os.environ, log=str(log), account=pwd.getpwuid(os.getuid()).pw_name), capture_output=True)
            self.assertEqual(run().returncode, 0)
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)
            self.assertEqual(log.stat().st_uid, os.getuid())
            log.write_text('previous diagnostics')
            self.assertEqual(run().returncode, 0)
            self.assertEqual(log.read_text(), 'previous diagnostics')
            log.chmod(0o644)
            self.assertEqual(run().returncode, 75)
            log.chmod(0o600)
            other = Path(root) / 'other'
            os.link(log, other)
            self.assertEqual(run().returncode, 75)
            log.unlink()
            log.symlink_to(other)
            self.assertEqual(run().returncode, 75)
            self.assertEqual(other.read_text(), 'previous diagnostics')


if __name__ == '__main__':
    unittest.main()
