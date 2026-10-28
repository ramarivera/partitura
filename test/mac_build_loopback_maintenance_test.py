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

    def test_identity_checks_sshd_verified_key_and_loopback_not_client_command(self):
        public = self.root / 'maintenance.pub'
        public.write_text('ssh-ed25519 dummy-public-key\n')
        auth = self.root / 'sshauth'
        auth.write_text('publickey ssh-ed25519 dummy-public-key\n')
        auth.chmod(0o600)
        environment = dict(SSH_CONNECTION='127.0.0.1 49152 127.0.0.1 22', SSH_USER_AUTH=str(auth))
        with patch.object(maintenance, 'MAINTENANCE_PUBLIC', public), patch.object(broker, 'sealed', side_effect=lambda path: path), patch.dict(os.environ, environment, clear=True):
            self.assertTrue(broker.maintenance_identity())
            auth.write_text('publickey ssh-ed25519 gateway-key\n')
            self.assertFalse(broker.maintenance_identity())
            auth.write_text('publickey ssh-ed25519 dummy-public-key\n')
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
            with self.assertRaises(PermissionError):
                broker.load_config()
            self.assertEqual(broker.load_config(allow_storage_denial=True), config)
        self.assertEqual((self.root / 'maintenance-reason').read_text(), 'storage-access-denied\n')

    def test_volume_denial_is_durable_and_health_explains_remote_login_prerequisite(self):
        for number in (errno.EPERM, errno.EACCES):
            error = PermissionError(number, 'private filesystem path must not be logged', str(Path(self.config['tartHome']) / 'vms'))
            stderr = io.StringIO()
            with patch.object(broker, 'inventory_obligations', side_effect=error), contextlib.redirect_stderr(stderr):
                (self.root / 'maintenance.json').unlink(missing_ok=True)
                self.assertEqual(self.maintenance(), 1)
            self.assertEqual((self.root / 'maintenance-reason').read_text(), 'storage-access-denied\n')
            health = self.wire('health')[1]
            self.assertIn('storage-access-denied', health['reasons'])
            self.assertFalse(health['accepting'])
            self.assertIn('Remote Login > Allow full disk access for remote users', health['storageAccessHint'])
            self.assertIn('Remote Login > Allow full disk access for remote users', stderr.getvalue())
            self.assertNotIn(self.config['tartHome'], stderr.getvalue())
            self.assertFalse((self.root / 'maintenance-blocked').exists())
        for error in (PermissionError(errno.EPERM, 'unrelated', str(self.root.parent / 'unrelated')), OSError(errno.EIO, 'IO', str(Path(self.config['tartHome']) / 'vms'))):
            self.assertFalse(broker.storage_access_denied(self.config, error))

    def test_probe_enumerates_volume_even_when_inventory_would_back_off(self):
        with patch.object(maintenance.os, 'scandir', side_effect=PermissionError(errno.EPERM, 'denied', str(Path(self.config['tartHome']) / 'vms'))), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(PermissionError):
                broker.check_maintenance_storage(self.config)
        self.assertEqual((self.root / 'maintenance-reason').read_text(), 'storage-access-denied\n')

    def test_hup_term_and_dead_ssh_stdout_do_not_interrupt_bounded_pass_or_exit_code(self):
        class DeadOutput:
            def write(self, _):
                raise BrokenPipeError('client gone')
        def finish(config):
            for number in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
                os.kill(os.getpid(), number)
            broker.durable_write(self.root / 'fixture-completed', 'durable completion\n')
            return 7
        with preserved_shutdown_signals(), patch.object(broker, 'check_maintenance_storage') as storage, patch.object(broker, 'local_maintenance', side_effect=finish), patch.object(broker, 'read_state', return_value='existing reason'), patch.object(broker.sys, 'stdout', DeadOutput()):
            self.assertEqual(broker.loopback_maintenance(self.config), 7)
        storage.assert_called_once()
        self.assertEqual((self.root / 'fixture-completed').read_text(), 'durable completion\n')

    def test_probe_is_read_only_and_avoids_runner_lock_held_by_installer(self):
        with preserved_shutdown_signals(), patch.object(broker, 'check_maintenance_storage') as storage, patch.object(broker, 'local_maintenance', side_effect=AssertionError('preflight must not take lock')), contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(broker.loopback_maintenance(self.config, check=True), 0)
        storage.assert_called_once()
        self.assertIn('PARTITURA_MAINTENANCE_STORAGE_OK', stdout.getvalue())


if __name__ == '__main__':
    unittest.main()
