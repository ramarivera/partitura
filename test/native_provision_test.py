"""One-shot host provisioning helpers: sshd admission, password entry, settings."""
import contextlib
import ctypes
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
from types import SimpleNamespace
from unittest.mock import patch

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
            first_id = settings['broker']['host_id']
            self.assertEqual(settings['broker']['profile'], 'legacy')
            self.assertEqual(settings['broker']['minimum_free_bytes'], 53687091200)
            self.assertFalse(settings['broker']['daemon_relock_qualified'])
            self.assertIn('/Library/LaunchDaemons/net.partitura.native-build-maintenance.plist', manifest['files'])
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(module.main(argv), 0)
            self.assertEqual(json.loads((out / 'settings.json').read_text())['broker']['host_id'], first_id)
            # Fresh rendering and staging use precisely the same bytes/targets.
            hs_spec = importlib.util.spec_from_file_location('render_stage', ROOT / 'deploy/mac-build/host_setup.py')
            hs = importlib.util.module_from_spec(hs_spec)
            hs_spec.loader.exec_module(hs)
            names = ('broker.py', 'guest-run.sh', 'qualify-base.sh', 'native_host.py', 'install-host.sh', 'credential-writer.py')
            blobs = tuple(subprocess.run(['/usr/bin/git', '-C', str(ROOT), 'show', 'HEAD:deploy/mac-build/' + name], check=True, capture_output=True).stdout for name in names)
            stage = base / 'stage'
            def ditto(argv, **kwargs):
                import shutil
                shutil.copytree(argv[-2], argv[-1])
            with patch.object(hs.os, 'uname', return_value=SimpleNamespace(sysname='Darwin')), patch.object(hs, 'checked_source_blobs', return_value=blobs), patch.object(hs, 'checked_provision_blob', return_value=(ROOT / 'deploy/mac-build/provision.py').read_bytes()), patch.object(hs, 'verify_tart_source', return_value=tart.parents[2]), patch.object(hs, 'verify_qualified_base'), patch.object(hs, 'verify_account'), patch.object(hs, 'verify_private_runtime'), patch.object(hs, 'verify_runtime_capacity'), patch.object(hs, 'sshd_effective'), patch.object(hs.subprocess, 'run', side_effect=ditto):
                # Source Tart mode is identical in the root copy.
                settings['tart']['source_app'] = str(tart.parents[2])
                hs.stage(settings, stage)
            self.assertEqual((stage / 'managed-files.json').read_bytes(), (out / 'managed-files.json').read_bytes())
            config = hs.resolve_broker_policy(hs.validate_settings(settings))
            managed = hs.expected_host_files(config, blobs)
            self.assertEqual(hs.expected_managed_manifest(managed, config), (stage / 'managed-files.json').read_bytes())
            for target, (payload, _) in managed.items():
                name = 'sshd_config' if target == hs.ROOT_SSHD_DROPIN else 'maintenance.plist' if target == hs.ROOT_PLIST else target.name
                self.assertEqual((stage / name).read_bytes(), payload)


class KeychainPolicyTests(unittest.TestCase):
    def test_install_guard_fences_until_commit_and_failed_install_can_resume(self):
        import fcntl
        import select
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, tart = root / 'runtime', root / 'tart'
            runtime.mkdir(mode=0o700)
            (tart / 'vms').mkdir(parents=True)
            command = [sys.executable, '-I', '-c', module.INSTALL_GUARD_SCRIPT, str(runtime), str(tart)]
            child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertTrue(select.select([child.stdout], [], [], 5)[0])
                self.assertEqual(child.stdout.readline(), b'ready\n')
                self.assertEqual((runtime / 'maintenance-blocked').read_text(), 'installation-incomplete\n')
                with (runtime / 'runner.lock').open('rb') as lock:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                # The root installer inherits the pipe's write end. Losing its
                # wrapper must not release runner.lock before that child exits.
                transaction = subprocess.Popen([sys.executable, '-c', 'import sys; print("ready", flush=True); sys.stdin.read()'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, pass_fds=(child.stdin.fileno(),))
                try:
                    self.assertTrue(select.select([transaction.stdout], [], [], 5)[0])
                    self.assertEqual(transaction.stdout.readline(), b'ready\n')
                    child.stdin.close()
                    child.stdin = None
                    with self.assertRaises(subprocess.TimeoutExpired):
                        child.wait(timeout=0.1)
                    with (runtime / 'runner.lock').open('rb') as lock:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    transaction.communicate(b'', timeout=5)
                failed = child.communicate(timeout=5)
                self.assertNotEqual(child.returncode, 0, failed)
            finally:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=5)
            self.assertTrue((runtime / 'cleanup-required').exists())
            retry = subprocess.run(command, input=b'commit\n', capture_output=True, timeout=5)
            self.assertEqual(retry.returncode, 0, retry.stderr)
            self.assertFalse((runtime / 'cleanup-required').exists())
            self.assertFalse((runtime / 'maintenance-blocked').exists())
            self.assertRegex((runtime / 'admission-epoch').read_text(), r'^[a-f0-9]{32}\n$')
            self.assertTrue((runtime / 'inventory-required').exists())
            refused = subprocess.run(command, input=b'commit\n', capture_output=True, timeout=5)
            self.assertNotEqual(refused.returncode, 0)
            self.assertIn(b'drain and reconcile', refused.stderr)

    def policy(self, mode, state, ignore_set=False, snapshot=None):
        class Api:
            def __init__(self, call): self.call = call
            def __call__(self, *args): return self.call(*args)
        def copy(handle, pointer):
            for key, value in state.items(): setattr(pointer._obj, key, value)
            return 0
        def update(handle, pointer):
            if not ignore_set:
                state.update({key: getattr(pointer._obj, key) for key in state})
            return 0
        security = SimpleNamespace(SecKeychainSetUserInteractionAllowed=Api(lambda allowed: 0), SecKeychainOpen=Api(lambda path, handle: 0), SecKeychainCopySettings=Api(copy), SecKeychainSetSettings=Api(update))
        cf = SimpleNamespace(CFRelease=Api(lambda handle: None))
        info = SimpleNamespace(st_mode=0o100600, st_uid=1000, st_nlink=1)
        argv = ['policy', mode] + ([json.dumps(snapshot)] if snapshot is not None else [])
        with patch('sys.argv', argv), patch('os.getuid', return_value=1000), patch('pwd.getpwuid', return_value=SimpleNamespace(pw_dir='/Users/builder', pw_name='builder')), patch.object(Path, 'is_symlink', return_value=False), patch.object(Path, 'lstat', return_value=info), patch('os.path.lexists', return_value=True), patch.object(ctypes, 'CDLL', side_effect=[security, cf]), contextlib.redirect_stdout(io.StringIO()) as printed:
            exec(module.KEYCHAIN_POLICY_SCRIPT, {})
        return printed.getvalue()

    def test_settings_apply_readback_restore_without_unlock_or_credentials(self):
        old = dict(lockOnSleep=False, useLockInterval=False, lockInterval=7200)
        state = dict(old)
        snapshot = json.loads(self.policy('snapshot', state))
        self.policy('apply', state)
        self.assertEqual(state, dict(lockOnSleep=1, useLockInterval=1, lockInterval=300))
        self.policy('check', state)
        self.policy('restore', state, snapshot=snapshot)
        self.assertEqual(state, old)
        with self.assertRaisesRegex(SystemExit, 'readback differs'):
            self.policy('apply', state, ignore_set=True)
        with self.assertRaisesRegex(SystemExit, 'readback differs'):
            self.policy('check', state)

    def test_policy_only_branch_preserves_existing_password_and_keychain(self):
        source = (ROOT / 'deploy/mac-build/provision-host.sh').read_text()
        lifecycle = source.split('step "5a initialize missing fresh-host credentials"', 1)[1].split('case $rc in', 1)[0]
        # Execute the real shell branch with fake commands. Any lifecycle call
        # beyond metadata inspection/directory creation fails this regression.
        for policy_only in (0, 1):
            script = '''set -euo pipefail
account=builder; INSTALL=/sealed; policy_only=$1
step() { :; }; die() { echo "$*" >&2; exit 1; }
sudo() {
  case "$1" in
    install|test) return 0 ;;
    *) echo "unexpected credential mutation: $*" >&2; return 97 ;;
  esac
}
''' + lifecycle
            result = subprocess.run(['/bin/bash', '-c', script, '--', str(policy_only)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('password is unchanged', result.stdout)
        self.assertNotIn('delete-keychain', source)
        self.assertNotIn('$ROOT/password-set', source)
        self.assertIn('if [ "$policy_only" -eq 0 ]; then\nstep "2', source)
        self.assertLess(source.index('step "4'), source.index('step "5'))
        self.assertIn('MIN_INTERNAL_KB=$((50 * 1024 * 1024))', source)
        self.assertIn('MIN_STORAGE_KB=$((120 * 1024 * 1024))', source)

    def test_one_shot_floor_flag_matches_the_sealed_config_range(self):
        source = (ROOT / 'deploy/mac-build/provision-host.sh').read_text()
        block = source.split('if [ -n "$minimum_free_bytes" ]; then', 1)[1].split('\nfi', 1)[0]
        script = 'set -euo pipefail; minimum_free_bytes=$1; PY=("$2"); die() { exit 2; }; ' + block + '\nprintf "%s" "$MIN_INTERNAL_KB"'
        for floor, accepted in ((53687091200, True), (2**63 - 1, True), (53687091199, False), (2**63, False), ('abc', False)):
            with self.subTest(floor=floor):
                result = subprocess.run(['/bin/bash', '-c', script, '--', str(floor), sys.executable], capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, accepted, result.stderr)
                if accepted:
                    self.assertEqual(int(result.stdout), (floor + 1023) // 1024)


if __name__ == '__main__':
    unittest.main()
