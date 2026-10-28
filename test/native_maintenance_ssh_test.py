"""Hermetic key installation, pinning and self-test contracts; no sshd or sudo."""
import base64
import contextlib
import importlib.util
import os
from pathlib import Path
import plistlib
import pwd
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('maintenance_ssh', ROOT / 'deploy/mac-build/maintenance_ssh.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
KEY = 'ssh-ed25519 ' + base64.b64encode(b'\0\0\0\x0bssh-ed25519\0\0\0\x20' + b'x' * 32).decode()
HOST = 'ssh-ed25519 ' + base64.b64encode(b'\0\0\0\x0bssh-ed25519\0\0\0\x20' + b'h' * 32).decode()


class MaintenanceSSHTests(unittest.TestCase):
    def test_plist_starts_ssh_with_no_tofu_agent_forwarding_or_config(self):
        plist = plistlib.loads(module.maintenance_plist('builder'))
        argv = plist['ProgramArguments']
        self.assertEqual(argv[:4], ['/usr/bin/ssh', '-F', '/dev/null', '-n'])
        self.assertEqual(argv[-2:], ['127.0.0.1', module.VERB])
        for option in ('-oBatchMode=yes', '-oIdentitiesOnly=yes', '-oIdentityAgent=none', '-oStrictHostKeyChecking=yes', '-oHostKeyAlgorithms=ssh-ed25519', '-oControlPath=none', '-oClearAllForwardings=yes'):
            self.assertIn(option, argv)
        self.assertIn('-oUserKnownHostsFile=' + str(module.KNOWN_HOSTS), argv)
        self.assertEqual(plist['UserName'], 'builder')
        self.assertTrue(plist['RunAtLoad'])
        self.assertEqual(plist['StartInterval'], 60)
        self.assertNotIn('/usr/bin/python3', argv)

    def test_authorized_line_is_single_loopback_restricted_dispatcher_entry(self):
        line = module.authorized_key(KEY + ' discarded-comment')
        self.assertEqual(line, 'restrict,from="127.0.0.1,::1",command="/usr/bin/python3 /Library/Partitura/NativeBuild/broker.py" ' + KEY + '\n')
        for invalid in ('ssh-rsa ' + KEY.split()[1], 'ssh-ed25519 eA=='):
            with self.assertRaises(ValueError):
                module.authorized_key(invalid)

    @contextlib.contextmanager
    def installation(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as name, contextlib.ExitStack() as stack:
            root = Path(name)
            ssh = root / 'maintenance-ssh'
            host = root / 'host.pub'
            host.write_text(HOST + ' host comment\n')
            (root / 'authorized_keys').write_text('gateway key only\n')
            for key, value in dict(ROOT=root, SSH_ROOT=ssh, KEY=ssh / 'id_ed25519', PUBLIC=ssh / 'id_ed25519.pub', AUTHORIZED=ssh / 'authorized_keys', KNOWN_HOSTS=ssh / 'known_hosts', HOST_PUBLIC=host).items():
                stack.enter_context(patch.object(module, key, value))
            real_protected = module.protected
            def protected(path, owner=0, mode=None, directory=False):
                # The fixture uid stands in for root. Exercise real mode/link/type checks.
                return real_protected(path, os.getuid(), mode, directory)
            stack.enter_context(patch.object(module, 'protected', side_effect=protected))
            stack.enter_context(patch.object(module, 'protected_parents'))
            stack.enter_context(patch.object(module.os, 'fchown'))
            admission = Mock()
            admission.admit.return_value = 'Restricted build account already admitted to Remote Login'
            stack.enter_context(patch.object(module, 'remote_login', return_value=admission))
            calls = []
            def run(args, **kwargs):
                calls.append(args)
                if args[0].endswith('dseditgroup'):
                    return subprocess.CompletedProcess(args, 0, '', '')
                if '-y' in args:
                    return subprocess.CompletedProcess(args, 0, KEY + '\n', '')
                path = Path(args[-1])
                path.write_bytes(b'dummy private test key, not a real credential')
                path.with_suffix('.pub').write_text(KEY + '\n')
                return subprocess.CompletedProcess(args, 0, '', '')
            yield root, run, calls, admission

    def test_prepare_rerun_keeps_private_inode_and_one_auth_line_and_pins_local_host(self):
        with self.installation() as (root, run, calls, admission):
            account = pwd.getpwuid(os.getuid()).pw_name
            first = root / 'backup1'
            first.mkdir(mode=0o700)
            module.prepare(account, first, run)
            before = module.KEY.stat()
            contents = module.KEY.read_bytes()
            self.assertEqual(before.st_mode & 0o777, 0o400)
            self.assertEqual(module.KNOWN_HOSTS.read_text(), '127.0.0.1,::1 ' + HOST + '\n')
            self.assertEqual(module.PUBLIC.stat().st_mode & 0o777, 0o444)
            second = root / 'backup2'
            second.mkdir(mode=0o700)
            module.prepare(account, second, run)
            self.assertEqual(module.KEY.stat().st_ino, before.st_ino)
            self.assertEqual(module.KEY.read_bytes(), contents)
            self.assertEqual(module.AUTHORIZED.read_text().splitlines(), [module.authorized_key(KEY).strip()])
            self.assertEqual(sum('-t' in command for command in calls), 1)
            self.assertFalse(any('dummy private' in ' '.join(command) for command in calls))
            self.assertTrue(any(call.kwargs.get('apply') for call in admission.admit.call_args_list))

    def test_rollback_removes_new_identity_and_restores_prior_host_pin_without_rotating_key(self):
        with self.installation() as (root, run, _, _):
            account = pwd.getpwuid(os.getuid()).pw_name
            backup = root / 'new-backup'
            backup.mkdir(mode=0o700)
            module.prepare(account, backup, run)
            module.rollback(account, backup, run)
            self.assertFalse(module.SSH_ROOT.exists())
            backup = root / 'install'
            backup.mkdir(mode=0o700)
            module.prepare(account, backup, run)
            identity = module.KEY.read_bytes()
            original = module.KNOWN_HOSTS.read_bytes()
            backup = root / 'upgrade'
            backup.mkdir(mode=0o700)
            module.HOST_PUBLIC.write_text(KEY)
            module.prepare(account, backup, run)
            self.assertNotEqual(module.KNOWN_HOSTS.read_bytes(), original)
            module.rollback(account, backup, run)
            self.assertEqual(module.KEY.read_bytes(), identity)
            self.assertEqual(module.KNOWN_HOSTS.read_bytes(), original)

    def test_incomplete_identity_or_unsafe_private_key_is_refused_without_keygen(self):
        with self.installation() as (root, run, calls, _):
            account = pwd.getpwuid(os.getuid()).pw_name
            module.SSH_ROOT.mkdir(mode=0o755)
            (module.SSH_ROOT / 'unexpected').touch()
            backup = root / 'backup'
            backup.mkdir(mode=0o700)
            with self.assertRaisesRegex(ValueError, 'incomplete loopback'):
                module.prepare(account, backup, run)
            self.assertEqual(calls, [])

    def test_unsafe_private_mode_is_refused_and_added_acl_is_removed_on_rollback(self):
        with self.installation() as (root, run, calls, admission):
            account = pwd.getpwuid(os.getuid()).pw_name
            admission.admit.return_value = 'Restricted build account needs explicit Remote Login membership approval'
            backup = root / 'backup'
            backup.mkdir(mode=0o700)
            module.prepare(account, backup, run)
            module.rollback(account, backup, run)
            self.assertIn(['/usr/sbin/dseditgroup', '-o', 'edit', '-d', account, '-t', 'user', 'com.apple.access_ssh'], calls)
            admission.admit.return_value = 'already admitted'
            backup = root / 'prepare-again'
            backup.mkdir(mode=0o700)
            module.prepare(account, backup, run)
            module.KEY.chmod(0o600)
            backup = root / 'unsafe'
            backup.mkdir(mode=0o700)
            with self.assertRaisesRegex(ValueError, 'unsafe loopback'):
                module.prepare(account, backup, run)
            self.assertEqual(sum('-t' in command and command[0].endswith('ssh-keygen') for command in calls), 2)

    def test_self_tests_are_bounded_and_refuse_missing_probe_or_nonzero_maintenance(self):
        def runner(code, output):
            def run(args, **kwargs):
                self.assertEqual(kwargs['timeout'], 150)
                self.assertEqual(args[:5], ['/usr/bin/sudo', '--non-interactive', '-H', '-u', 'builder'])
                self.assertEqual(args[-1], module.CHECK_VERB if checking else module.VERB)
                return subprocess.CompletedProcess(args, code, output, 'private ignored diagnostic')
            return run
        for checking in (True, False):
            module.self_test('builder', checking, runner(0, 'PARTITURA_MAINTENANCE_STORAGE_OK\n'))
            with self.assertRaisesRegex(ValueError, 'Remote Login > Allow full disk access for remote users'):
                module.self_test('builder', checking, runner(255, ''))
            with self.assertRaisesRegex(ValueError, 'maintenance returned failure'):
                module.self_test('builder', checking, runner(1, 'PARTITURA_MAINTENANCE_STORAGE_OK\n'))

    def test_rollback_handles_failure_before_membership_was_added(self):
        with self.installation() as (root, run, _, admission):
            account = pwd.getpwuid(os.getuid()).pw_name
            admission.admit.return_value = 'Restricted build account needs explicit Remote Login membership approval'
            admission.admit.side_effect = [admission.admit.return_value, OSError('admission failed')]
            backup = root / 'backup'
            backup.mkdir(mode=0o700)
            with self.assertRaises(OSError):
                module.prepare(account, backup, run)
            def absent(args, **kwargs):
                self.assertIn('checkmember', args)
                return subprocess.CompletedProcess(args, 67, f'no {account} is NOT a member of com.apple.access_ssh', '')
            module.rollback(account, backup, absent)
            self.assertFalse(module.SSH_ROOT.exists())


if __name__ == '__main__':
    unittest.main()
