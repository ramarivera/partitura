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
            stack.enter_context(patch.object(module, 'snapshot_admission'))
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
            module.snapshot_admission.assert_called_once_with(account, first, run)
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

    def test_unexpected_identity_entries_are_refused_without_keygen(self):
        with self.installation() as (root, run, calls, _):
            account = pwd.getpwuid(os.getuid()).pw_name
            module.SSH_ROOT.mkdir(mode=0o755)
            (module.SSH_ROOT / 'unexpected').touch()
            backup = root / 'backup'
            backup.mkdir(mode=0o700)
            with self.assertRaisesRegex(ValueError, 'unexpected loopback'):
                module.prepare(account, backup, run)
            self.assertEqual(calls, [])

    def test_unsafe_private_mode_is_repaired_and_added_acl_is_removed_on_rollback(self):
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
            module.prepare(account, backup, run)
            self.assertEqual(module.KEY.stat().st_mode & 0o777, 0o400)
            self.assertEqual(sum('-t' in command and command[0].endswith('ssh-keygen') for command in calls), 3)
            module.finish(backup)

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
            with self.assertRaisesRegex(ValueError, 'transport, authentication or pinned host-key'):
                module.self_test('builder', checking, runner(255, ''))
            with self.assertRaisesRegex(ValueError, 'refused by sudo or broker'):
                module.self_test('builder', checking, runner(1, ''))
            with self.assertRaisesRegex(ValueError, 'Remote Login > Allow full disk access for remote users'):
                module.self_test('builder', checking, runner(1, 'PARTITURA_MAINTENANCE_STORAGE_ERROR=storage-access-denied\n'))
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


    def test_repair_keeps_no_private_backup_and_rolls_back_original_inode(self):
        with self.installation() as (root, run, calls, _):
            account = pwd.getpwuid(os.getuid()).pw_name
            first = root / 'first'
            first.mkdir(mode=0o700)
            module.prepare(account, first, run)
            # The fake parser rejects corrupt content as the unprivileged user.
            module.KEY.chmod(0o600)
            module.KEY.write_bytes(b'corrupt private fixture')
            module.KEY.chmod(0o400)
            original = module.KEY.stat().st_ino
            def damaged(args, **kwargs):
                if '-y' in args:
                    self.assertEqual(args[:5], ['/usr/bin/sudo', '--non-interactive', '-H', '-u', account])
                    raise subprocess.CalledProcessError(1, args)
                return run(args, **kwargs)
            backup = root / 'repair'
            backup.mkdir(mode=0o700)
            module.prepare(account, backup, damaged)
            self.assertNotEqual(module.KEY.stat().st_ino, original)
            self.assertEqual(module.KEY.with_name('id_ed25519.previous').stat().st_ino, original)
            self.assertFalse(any(path.name == 'id_ed25519' for path in backup.rglob('*')))
            module.rollback(account, backup, run)
            self.assertEqual(module.KEY.stat().st_ino, original)
            self.assertEqual(module.KEY.read_bytes(), b'corrupt private fixture')
            # A hardlink is repaired too, without parsing it as root or uid.
            os.link(module.KEY, root / 'untrusted-alias')
            backup = root / 'hardlink-repair'
            backup.mkdir(mode=0o700)
            previous_calls = len(calls)
            module.prepare(account, backup, run)
            self.assertFalse(any('-y' in args for args in calls[previous_calls:]))
            self.assertEqual(module.KEY.stat().st_nlink, 1)
            module.finish(backup)
            self.assertFalse(module.KEY.with_name('id_ed25519.previous').exists())

    def test_failed_acl_rollback_raises_instead_of_claiming_no_mutation(self):
        with self.installation() as (root, run, _, admission):
            account = pwd.getpwuid(os.getuid()).pw_name
            admission.admit.return_value = 'needs explicit Remote Login membership approval'
            backup = root / 'backup'
            backup.mkdir(mode=0o700)
            module.prepare(account, backup, run)
            def cannot_remove(args, **kwargs):
                self.assertEqual(kwargs['timeout'], 15)
                if '-d' in args:
                    raise subprocess.CalledProcessError(1, args)
                return run(args, **kwargs)
            with self.assertRaises(subprocess.CalledProcessError):
                module.rollback(account, backup, cannot_remove)
            self.assertTrue((backup / 'membership.json').exists())

    def test_allowusers_is_admitted_inside_prepare_and_restored_on_rollback(self):
        snapshot = module.snapshot_admission
        with self.installation() as (root, run, _, _):
            helper = module.load_provision()
            config = root / 'sshd_config'
            config.write_text('AllowUsers operator\n')
            config.chmod(0o644)
            original_admit = helper.admit_sshd
            def admit(account, apply=False, **kwargs):
                return original_admit(account, apply, main=config, owner=os.getuid(), **kwargs)
            helper.admit_sshd = admit
            original_first = helper.first_allowlist
            helper.first_allowlist = lambda main=config: original_first(main)
            def policy(args, **kwargs):
                self.assertEqual(kwargs['timeout'], 15)
                if args[0].endswith('/id'):
                    return subprocess.CompletedProcess(args, 0, 'staff', '')
                return subprocess.CompletedProcess(args, 0, 'allowusers ' + config.read_text().split(' ', 1)[1], '')
            backup = root / 'backup'
            backup.mkdir(mode=0o700)
            (backup / 'membership.json').write_text('{"account":"builder","added":false}')
            with patch.object(module, 'load_provision', return_value=helper), patch.object(module.os, 'chown'):
                snapshot('builder', backup, policy)
                self.assertEqual(config.read_text(), 'AllowUsers operator builder\n')
                module.rollback('builder', backup, policy)
            self.assertEqual(config.read_text(), 'AllowUsers operator\n')

    def test_effective_policy_forbids_environment_spoofing_including_repeated_acceptenv(self):
        for pattern in ('SSH_*', 'SSH_USER_AUTH', '*', 'S*', '?SH_*', '*_AUTH'):
            with self.subTest(pattern=pattern), self.assertRaisesRegex(ValueError, 'AcceptEnv'):
                module.verify_environment('acceptenv ' + pattern + '\nacceptenv LANG LC_*')
        module.verify_environment('acceptenv LANG LC_*\nacceptenv SAFE_*')
        with self.assertRaisesRegex(ValueError, 'permituserenvironment'):
            module.verify_effective_sshd('builder', {'permituserenvironment': 'yes'})

    def test_readonly_preflight_checks_incoming_ssh_volume_before_any_install(self):
        with patch.dict(os.environ, SSH_CONNECTION='10.0.0.2 10000 10.0.0.1 22'), patch.object(module.os, 'scandir') as probe:
            probe.return_value.__enter__.return_value = iter(())
            module.preflight_storage('/Volumes/External/tart')
            probe.assert_called_once_with(Path('/Volumes/External'))
            probe.side_effect = PermissionError(1, 'private path')
            with self.assertRaisesRegex(ValueError, 'Allow full disk access for remote users.*cannot be set by a script'):
                module.preflight_storage('/Volumes/External/tart')
            probe.side_effect = PermissionError(13, 'private path')
            with self.assertRaisesRegex(ValueError, 'permissions or IO; not an FDA diagnosis'):
                module.preflight_storage('/Volumes/External/tart')
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, 'over Remote Login SSH'):
            module.preflight_storage('/Volumes/External/tart')
        script = (ROOT / 'deploy/mac-build/provision-host.sh').read_text()
        self.assertLess(script.index('maintenance_ssh.py" preflight'), script.index('mkdir -p'))

    def test_selftest_timeout_kills_client_process_group_and_reaps(self):
        child = Mock(pid=98765)
        child.communicate.side_effect = [subprocess.TimeoutExpired('fixture', 150), ('', '')]
        with patch.object(module.subprocess, 'Popen', return_value=child) as popen, patch.object(module.os, 'killpg') as kill:
            with self.assertRaises(subprocess.TimeoutExpired):
                module.run_test(['fixture'])
            self.assertTrue(popen.call_args.kwargs['start_new_session'])
            kill.assert_called_once_with(child.pid, module.signal.SIGKILL)
            self.assertEqual(child.communicate.call_count, 2)
        # host_setup passes its default subprocess.run. It must still take the
        # process-group path, rather than kill only sudo on timeout.
        with patch.object(module, 'run_test', return_value=subprocess.CompletedProcess([], 0, 'PARTITURA_MAINTENANCE_STORAGE_OK\n', '')) as grouped:
            module.self_test('builder', run=subprocess.run)
            grouped.assert_called_once()


if __name__ == '__main__':
    unittest.main()
