"""Credential publication and real TTY echo checks without host changes."""
import importlib.util
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'deploy/mac-build/credential-writer.py'
spec = importlib.util.spec_from_file_location('credential_writer', SOURCE)
writer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(writer)


class CredentialWriterTests(unittest.TestCase):
    def test_home_mismatch_is_rejected_before_any_config_or_secret_read(self):
        account = SimpleNamespace(pw_dir='/Users/partitura-build', pw_name='partitura-build')
        with patch.object(writer.pwd, 'getpwuid', return_value=account), patch.object(writer.os, 'getuid', return_value=502), patch.dict(os.environ, HOME='/Users/operator'):
            with self.assertRaisesRegex(ValueError, 'sudo -H'):
                writer.dedicated_home()

    def test_publish_is_private_atomic_and_never_replaces_existing_file_or_symlink(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            home = Path(directory)
            final = home / '.partitura-native-login.password'
            writer.publish(home, b'fixture-one')
            self.assertEqual(final.read_bytes(), b'fixture-one')
            self.assertEqual(final.stat().st_mode & 0o777, 0o600)
            self.assertEqual(final.stat().st_nlink, 1)
            with self.assertRaises(FileExistsError):
                writer.publish(home, b'fixture-two')
            self.assertEqual(final.read_bytes(), b'fixture-one')
            final.unlink()
            final.symlink_to(home / 'missing')
            with self.assertRaises(FileExistsError):
                writer.publish(home, b'fixture-three')
            self.assertFalse((home / 'missing').exists())
            self.assertEqual(list(home.iterdir()), [final])

    def test_real_tty_never_echoes_and_mismatched_input_does_not_publish(self):
        for second, expected in ((b'fixture-password', 0), (b'different-password', 1)):
            with self.subTest(expected=expected), tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
                tty, slave = pty.openpty()
                # Open the slave after exec to acquire the controlling terminal.
                # Avoid forkpty: Apple's Python framework can deadlock after fork.
                program = "import importlib.util,os,sys; from pathlib import Path; os.close(os.open(sys.argv[3],os.O_RDWR)); s=importlib.util.spec_from_file_location('writer',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.dedicated_home=lambda:Path(sys.argv[2]); sys.exit(m.main())"
                child = subprocess.Popen([sys.executable, '-I', '-c', program, str(SOURCE), directory, os.ttyname(slave)], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
                os.close(slave)
                output = b''
                try:
                    for prompt, value in ((b'Dedicated account password: ', b'fixture-password'), (b'Repeat dedicated account password: ', second)):
                        while prompt not in output:
                            self.assertTrue(select.select([tty], [], [], 5)[0], 'TTY prompt timed out')
                            output += os.read(tty, 4096)
                        os.write(tty, value + b'\n')
                    # Keep draining the master until the child is reaped. A macOS
                    # session leader cannot finish exiting while its controlling
                    # terminal still holds unread output, so wait() alone hangs.
                    deadline = time.monotonic() + 5
                    while child.poll() is None or select.select([tty], [], [], 0)[0]:
                        self.assertLess(time.monotonic(), deadline, 'writer did not exit')
                        if not select.select([tty], [], [], 0.1)[0]:
                            continue
                        try:
                            data = os.read(tty, 4096)
                        except OSError:
                            break
                        if not data:
                            break
                        output += data
                    self.assertEqual(child.wait(timeout=5), expected)
                    self.assertNotIn(b'fixture-password', output)
                    self.assertNotIn(b'different-password', output)
                    final = Path(directory) / '.partitura-native-login.password'
                    self.assertEqual(final.exists(), expected == 0)
                    if expected == 0:
                        self.assertEqual(final.read_bytes(), b'fixture-password')
                finally:
                    if child.poll() is None:
                        child.kill()
                    # Closing the master first releases a child blocked in exit.
                    os.close(tty)
                    child.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
