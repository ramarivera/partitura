"""No SSH/TCC contact: authenticated-key dispatch, denial reasons and disconnect safety."""
import errno
import importlib
from mac_build_broker_support import *

maintenance = importlib.import_module('partitura_broker.maintenance')


class LoopbackMaintenanceTests(RegistryFixture, unittest.TestCase):
    def test_dispatch_preserves_gateway_verbs_and_reserves_maintenance_to_its_identity(self):
        for dedicated in (False, True):
            for command in ('health', *broker.MAINTENANCE_VERBS):
                with self.subTest(dedicated=dedicated, command=command), patch.dict(os.environ, SSH_ORIGINAL_COMMAND=command), patch.object(broker, 'maintenance_identity', return_value=dedicated), patch.object(broker, 'load_config', return_value=self.config), patch.object(broker, 'loopback_maintenance', return_value=7) as run, patch.object(broker, 'health', return_value=0) as health, preserved_shutdown_signals():
                    if dedicated == (command in broker.MAINTENANCE_VERBS):
                        self.assertEqual(broker.main(), 7 if dedicated else 0)
                        if dedicated:
                            run.assert_called_once_with(self.config, check=command == broker.MAINTENANCE_VERBS[1])
                        else:
                            health.assert_called_once()
                    else:
                        with self.assertRaises(ValueError):
                            broker.main()
                        run.assert_not_called()
                        health.assert_not_called()

    def test_identity_requires_sshd_path_single_line_and_handles_both_loopbacks(self):
        public = self.root / 'maintenance.pub'
        public.write_text('ssh-ed25519 dummy-public-key\n')
        auth = self.root / 'sshauth'
        auth.write_text('publickey ssh-ed25519 dummy-public-key\n')
        auth.chmod(0o600)
        name = '/tmp/sshauth.' + 'A'*15
        original = os.open
        def opened(path, *args, **kwargs):
            return original(auth if path == name else path, *args, **kwargs)
        environment = dict(SSH_CONNECTION='127.0.0.1 49152 127.0.0.1 22', SSH_USER_AUTH=name)
        with patch.object(maintenance, 'MAINTENANCE_PUBLIC', public), patch.object(broker, 'sealed', side_effect=lambda path: path), patch.dict(os.environ, environment, clear=True), patch.object(maintenance.os, 'open', side_effect=opened):
            for address in ('127.0.0.1', '::1'):
                with patch.dict(os.environ, SSH_CONNECTION=f'{address} 49152 {address} 22'):
                    self.assertTrue(broker.maintenance_identity())
            auth.write_text('publickey ssh-ed25519 gateway-key\n')
            self.assertFalse(broker.maintenance_identity())
            auth.write_text('publickey gateway-key\npublickey ssh-ed25519 dummy-public-key\n')
            with self.assertRaises(ValueError):
                broker.maintenance_identity()
            auth.write_text('publickey ssh-ed25519 dummy-public-key\n')
            for value in ('', str(auth), '/tmp/sshauth.' + 'x'*14, '/private/tmp/sshauth.' + 'A'*15):
                with patch.dict(os.environ, SSH_USER_AUTH=value), self.assertRaises(ValueError):
                    broker.maintenance_identity()
            with patch.dict(os.environ, SSH_CONNECTION='10.0.0.2 49152 127.0.0.1 22'):
                self.assertFalse(broker.maintenance_identity())
            auth.chmod(0o644)
            with self.assertRaises(ValueError):
                broker.maintenance_identity()
            auth.chmod(0o600)
            auth.unlink()
            auth.symlink_to(public)
            with self.assertRaises(ValueError):
                broker.maintenance_identity()
            public.unlink()
            with self.assertRaises(ValueError):
                broker.maintenance_identity()

    def test_config_denial_keeps_health_available_but_mutating_commands_fail_closed(self):
        path = self.root / 'installed.json'
        home = self.root / 'private-tart'
        home.mkdir(mode=0o700)
        config = dict(self.config, tartHome=str(home), tartSha256=broker.hashlib.sha256(self.tart.read_bytes()).hexdigest(), keychainPath='/fixture/keychain', keychainCredentialPath='/fixture/credential')
        path.write_text(json.dumps(config))
        original = Path.lstat
        def lstat(target, *args, **kwargs):
            if target == home:
                raise PermissionError(errno.EPERM, 'denied', str(home))
            return original(target, *args, **kwargs)
        with patch.object(broker, 'CONFIG', path), patch.object(broker, 'sealed', side_effect=Path), patch.object(broker, 'validate_keychain_paths'), patch.object(Path, 'lstat', lstat), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(broker.StorageProbeError):
                broker.load_config()
            self.assertEqual(broker.load_config(allow_storage_denial=True), config)
        self.assertFalse((self.root / 'maintenance-storage-reason').exists())

    def test_only_explicit_eperm_probe_gets_fda_hint_and_probe_does_not_write(self):
        for number, reason in ((errno.EPERM, 'storage-access-denied'), (errno.EACCES, 'storage-permission-denied'), (errno.EIO, 'inventory-unavailable')):
            broker.durable_remove(self.root / 'maintenance-storage-reason')
            error = PermissionError(number, 'private path', str(Path(self.config['tartHome']) / 'vms'))
            with patch.object(maintenance.os, 'scandir', side_effect=error):
                with self.assertRaises(broker.StorageProbeError) as caught:
                    broker.check_maintenance_storage(self.config)
                self.assertEqual(caught.exception.reason, reason)
                self.assertEqual(broker.storage_access_denied(self.config, caught.exception), number == errno.EPERM)
            self.assertFalse((self.root / 'maintenance-storage-reason').exists())
            self.assertFalse(broker.storage_access_denied(self.config, error))
            # The pass persists probe evidence separately from the locked reason.
            with preserved_shutdown_signals(), patch.object(broker, 'maintenance_stderr', return_value=True), patch.object(maintenance.os, 'scandir', side_effect=error), contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(broker.loopback_maintenance(self.config), 1)
            self.assertIn('STORAGE_ERROR=' + reason, output.getvalue())
            self.assertEqual((self.root / 'maintenance-storage-reason').read_text(), reason + '\n')
            fields = self.wire('health')[1]
            self.assertIn(reason, fields['reasons'])
            self.assertEqual('storageAccessHint' in fields, number == errno.EPERM)
        # EPERM from deletion/immutable flags must NOT send the operator to TCC.
        with patch.object(broker, 'inventory_obligations', side_effect=PermissionError(errno.EPERM, 'immutable', str(self.root / 'vms/clone'))), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.maintenance(), 1)
        self.assertEqual((self.root / 'maintenance-reason').read_text(), 'storage-permission-denied\n')

    def test_hup_term_and_dead_ssh_stdout_do_not_interrupt_bounded_pass_or_exit_code(self):
        class DeadOutput:
            def write(self, _):
                raise BrokenPipeError('client gone')
        def finish(config):
            for number in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
                os.kill(os.getpid(), number)
            broker.durable_write(self.root / 'fixture-completed', 'durable completion\n')
            return 7
        with preserved_shutdown_signals(), patch.object(broker, 'maintenance_stderr', return_value=True), patch.object(broker, 'check_maintenance_storage') as storage, patch.object(broker, 'local_maintenance', side_effect=finish), patch.object(broker, 'read_state', return_value='existing reason'), patch.object(broker.sys, 'stdout', DeadOutput()):
            self.assertEqual(broker.loopback_maintenance(self.config), 7)
        storage.assert_called_once()
        self.assertEqual((self.root / 'fixture-completed').read_text(), 'durable completion\n')

    def test_probe_is_read_only_and_avoids_runner_lock_held_by_installer(self):
        with preserved_shutdown_signals(), patch.object(broker, 'maintenance_stderr', return_value=True), patch.object(broker, 'check_maintenance_storage') as storage, patch.object(broker, 'local_maintenance', side_effect=AssertionError('preflight must not take lock')), contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(broker.loopback_maintenance(self.config, check=True), 0)
        storage.assert_called_once()
        self.assertIn('PARTITURA_MAINTENANCE_STORAGE_OK', stdout.getvalue())


if __name__ == '__main__':
    unittest.main()
