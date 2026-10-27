"""One-shot host provisioning helpers: sshd admission, password entry, settings."""
import contextlib
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('provision', ROOT / 'deploy/mac-build/provision.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

KEY_ONLY = '''PermitRootLogin no
PasswordAuthentication no
AllowUsers ramarivera openclaw-ssh
'''


class AccessPlanTests(unittest.TestCase):
    def test_reads_repeated_and_space_separated_values(self):
        values = module.sshd_values('allowusers ramarivera\nallowusers a b\npermittty no\n')
        self.assertEqual(values['allowusers'], ['ramarivera', 'a', 'b'])

    def test_plans_only_an_append_to_an_existing_allowlist(self):
        empty = module.sshd_values('')
        self.assertEqual(module.access_plan('builder', ['staff'], empty), 'allowed')
        listed = module.sshd_values('allowusers ramarivera\n')
        self.assertEqual(module.access_plan('builder', ['staff'], listed), 'append')
        self.assertEqual(module.access_plan('ramarivera', ['staff'], listed), 'allowed')
        patterned = module.sshd_values('allowusers build*@10.0.0.1\n')
        self.assertEqual(module.access_plan('builder', ['staff'], patterned), 'append')

    def test_refuses_denials_including_patterns_and_group_allowlists(self):
        for output in ('denyusers builder\n', 'denyusers build*\n', 'denyusers bui?der@10.0.0.1\n',
                       'denygroups staff\n', 'denygroups st*\n', 'allowgroups admin\n',
                       'allowusers !root\n'):
            with self.subTest(output=output), self.assertRaises(ValueError):
                module.access_plan('builder', ['staff'], module.sshd_values(output))
        self.assertEqual(module.access_plan('builder', ['staff'], module.sshd_values('allowgroups st*\n')), 'allowed')


class AllowUsersEditTests(unittest.TestCase):
    def test_appends_before_an_inline_comment(self):
        self.assertEqual(module.append_allowed_user('AllowUsers a b\n', 'builder'), 'AllowUsers a b builder\n')
        self.assertEqual(module.append_allowed_user('AllowUsers a  # approved\n', 'builder'),
                         'AllowUsers a builder  # approved\n')

    def tree(self, files):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        base = Path(directory.name)
        (base / 'd').mkdir()
        for name, text in files.items():
            (base / name).write_text(text)
        return base

    def test_follows_sshd_parse_order_through_includes(self):
        base = self.tree({'sshd_config': 'Include d/*\nAllowUsers main\n', 'd/90-b.conf': 'AllowUsers b\n',
                          'd/100-a.conf': 'PermitTTY no\n'})
        path, index = module.first_allowlist(base / 'sshd_config')
        self.assertEqual((path.name, index), ('90-b.conf', 0))
        base = self.tree({'sshd_config': 'AllowUsers main\nInclude d/*\n', 'd/90-b.conf': 'AllowUsers b\n'})
        self.assertEqual(module.first_allowlist(base / 'sshd_config')[0].name, 'sshd_config')

    def test_ignores_match_blocks_and_comments(self):
        base = self.tree({'sshd_config': '# AllowUsers old\nInclude d/*\nMatch User x\n    AllowUsers y\n',
                          'd/90-b.conf': 'Match User z\n  AllowUsers z\n'})
        self.assertIsNone(module.first_allowlist(base / 'sshd_config'))


class AdmitSshdTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        base = Path(self.directory.name)
        (base / 'sshd_config.d').mkdir()
        self.main = base / 'sshd_config'
        self.main.write_text('Include sshd_config.d/*\n')
        self.config = base / 'sshd_config.d' / '90-key-only.conf'
        self.config.write_text(KEY_ONLY)
        os.chmod(self.config, 0o644)
        self.backups = base / 'backups'
        self.commands = []

    def tearDown(self):
        self.directory.cleanup()

    def runner(self, syntax_ok=True, groups='staff'):
        def run(argv, **kwargs):
            self.commands.append(argv)
            status, output = 0, ''
            if argv[0].endswith('/id'):
                output = groups
            elif argv[1:] == ['-t']:
                status = 0 if syntax_ok else 255
            elif '-T' in argv:
                output = ''.join(f'allowusers {name}\n' for line in self.config.read_text().splitlines()
                                 if line.startswith('AllowUsers') for name in line.split('#')[0].split()[1:])
            result = subprocess.CompletedProcess(argv, status, output, '')
            if kwargs.get('check'):
                result.check_returncode()
            return result
        return run

    def admit(self, apply, **options):
        return module.admit_sshd('builder', apply, self.runner(**options), self.main, self.backups, os.getuid())

    def test_check_mode_changes_nothing(self):
        self.assertIn('needs builder appended', self.admit(False))
        self.assertEqual(self.config.read_text(), KEY_ONLY)
        self.assertFalse(self.backups.exists())

    def test_apply_appends_and_keeps_the_backup_outside_the_include_directory(self):
        self.assertIn('sshd admits builder', self.admit(True))
        self.assertIn('AllowUsers ramarivera openclaw-ssh builder\n', self.config.read_text())
        self.assertEqual(oct(self.config.stat().st_mode & 0o777), '0o644')
        backups = list(self.backups.iterdir())
        self.assertEqual([path.read_text() for path in backups], [KEY_ONLY])
        self.assertEqual(list(self.config.parent.iterdir()), [self.config])
        self.assertIn('already admits', self.admit(True))

    def test_restores_the_file_when_sshd_rejects_it(self):
        with self.assertRaises(ValueError):
            self.admit(True, syntax_ok=False)
        self.assertEqual(self.config.read_text(), KEY_ONLY)

    def test_refuses_privileged_accounts(self):
        with self.assertRaises(ValueError):
            self.admit(True, groups='staff admin')
        self.assertEqual(self.config.read_text(), KEY_ONLY)


FAKE_PASSWD = r'''
import os, sys, termios
tty = sys.stdin.fileno()
attributes = termios.tcgetattr(tty)
attributes[3] &= ~termios.ECHO
termios.tcsetattr(tty, termios.TCSANOW, attributes)
print('Changing password for builder.')
sys.stdout.write('New password:'); sys.stdout.flush()
first = sys.stdin.readline()
sys.stdout.write('\nRetype new password:'); sys.stdout.flush()
second = sys.stdin.readline()
open(sys.argv[1], 'w').write('same' if first == second == 'secret value\n' else 'differs')
sys.exit(0 if first == second else 1)
'''


ECHO_PROBE = r'''
import sys, termios
echo = termios.tcgetattr(sys.stdin.fileno())[3] & termios.ECHO
sys.stdout.write('New password:'); sys.stdout.flush(); sys.stdin.readline()
sys.stdout.write('Retype new password:'); sys.stdout.flush(); sys.stdin.readline()
open(sys.argv[1], 'w').write('echo' if echo else 'quiet')
'''


class DrivePasswdTests(unittest.TestCase):
    def run_script(self, text, *extra, timeout=30):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        script = Path(directory.name) / 'passwd.py'
        script.write_text(text)
        result = Path(directory.name) / 'result'
        module.drive_passwd([sys.executable, str(script), str(result), *extra], bytearray(b'secret value'), timeout=timeout)
        return result.read_text()

    def test_answers_both_hidden_prompts_without_argv_or_environment(self):
        self.assertEqual(self.run_script(FAKE_PASSWD), 'same')

    def test_echo_is_off_before_the_child_starts(self):
        self.assertEqual(self.run_script(ECHO_PROBE), 'quiet')

    def test_reports_a_failed_change(self):
        with self.assertRaises(ValueError):
            self.run_script('import sys\nsys.exit(1)\n')

    def test_stops_a_silent_child_at_the_deadline(self):
        started = time.monotonic()
        with self.assertRaises(ValueError):
            self.run_script('import time\ntime.sleep(30)\n', timeout=0.5)
        self.assertLess(time.monotonic() - started, 5)


class CredentialTests(unittest.TestCase):
    def test_rejects_wrong_mode_and_multiline_content(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            credential = home / module.CREDENTIAL
            credential.write_bytes(b'value')
            os.chmod(credential, 0o600)
            self.assertEqual(bytes(module.read_credential(home)), b'value')
            os.chmod(credential, 0o644)
            with self.assertRaises(ValueError):
                module.read_credential(home)
            os.chmod(credential, 0o600)
            credential.write_bytes(b'two\nlines')
            with self.assertRaises(ValueError):
                module.read_credential(home)


class RenderSettingsTests(unittest.TestCase):
    def test_renders_a_fresh_install_that_host_setup_accepts(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            tart = base / 'tart.app/Contents/MacOS/tart'
            tart.parent.mkdir(parents=True)
            tart.write_bytes(b'tart')
            os.chmod(tart, 0o755)
            receipt = base / 'receipt.json'
            receipt.write_text(json.dumps({
                'base': 'partitura-native-macos-base-test', 'basePath': '/Volumes/B/tart/vms/partitura-native-macos-base-test',
                'baseSha256': 'a' * 64, 'miseSha256': 'b' * 64, 'miseVersion': '2026.10.15',
                'nodeVersion': '24.22.1', 'pythonVersion': '3.13.17', 'sourceName': 'macos-base', 'sourceSha256': 'c' * 64,
            }))
            out = base / 'out'
            argv = ['settings', '--clone', str(ROOT), '--receipt', str(receipt), '--root-dir', '/private/var/root/p',
                    '--tart-app', str(base / 'tart.app'), '--tart-sha256', hashlib.sha256(b'tart').hexdigest(),
                    '--mise-binary', '/x/mise', '--source-path', '/x/vms/macos-base', '--host', 'test-mac',
                    '--account', 'partitura-build', '--guest-user', 'partitura',
                    '--authorized-key', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJWUSojwlYbZc7ccQiCYdtCdTKTqvYQJZ/MvepiDMGSh k',
                    '--runtime-root', '/Users/partitura-build/dev/agentic-scratchpads/partitura/native-build',
                    '--tart-home', '/Volumes/B/tart', '--out', str(out)]
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                self.assertEqual(module.main(argv), 0)
            self.assertIn('manifest_sha256=', printed.getvalue())
            settings = json.loads((out / 'settings.json').read_text())
            self.assertEqual(settings['predecessor_manifest_sha256'], '')
            self.assertEqual(settings['tart']['source_app'], '/private/var/root/p/tart.app')
            self.assertEqual(settings['source']['partitura_repository'], '/private/var/root/p/checkout')
            manifest = json.loads((out / 'managed-files.json').read_text())
            entry = manifest['files']['/Library/Partitura/NativeBuild/tart.app/Contents/MacOS/tart']
            self.assertEqual(entry['mode'], 0o755)


if __name__ == '__main__':
    unittest.main()
