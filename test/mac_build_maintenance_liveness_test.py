"""Admission liveness and real descriptor redirection without SSH or host state."""
import errno
import importlib
from mac_build_broker_support import *

maintenance = importlib.import_module('partitura_broker.maintenance')


class MaintenanceLivenessTests(RegistryFixture, unittest.TestCase):
    def installed(self):
        public = self.root / 'maintenance-ssh/id_ed25519.pub'
        public.parent.mkdir()
        return patch.object(maintenance, 'MAINTENANCE_PUBLIC', public)

    def test_every_admitted_pass_beats_even_when_backed_off_or_runner_busy(self):
        self.assertEqual(self.maintenance(), 0)
        with self.installed(), preserved_shutdown_signals(), patch.object(broker, 'maintenance_stderr', return_value=True), contextlib.redirect_stdout(io.StringIO()):
            with patch.object(maintenance.time, 'time', return_value=time.time()) as clock:
                self.assertEqual(broker.loopback_maintenance(self.config), 0)
                first = broker.json_state(self.root / 'maintenance-heartbeat')
                self.assertEqual(first['admittedAt'], clock.return_value)
                # Nothing due still refreshes the heartbeat.
                clock.return_value += 60
                self.assertEqual(broker.loopback_maintenance(self.config), 0)
                self.assertEqual(broker.json_state(self.root / 'maintenance-heartbeat')['admittedAt'], clock.return_value)
                self.assertEqual(self.wire('health')[1]['status'], 'ready')
                # No subsequent admitted pass: broken key/auth/listener cannot stay ready.
                clock.return_value += maintenance.MAINTENANCE_STALE_SECONDS + 1
                health = self.wire('health')[1]
                self.assertIn('maintenance-stale', health['reasons'])
                self.assertFalse(health['accepting'])
                # Hold the actual lock, not a mocked early return. Probe and beat
                # still run, although cleanup cannot acquire it.
                with broker.run_lock(self.config, 0) as held:
                    self.assertIsNotNone(held)
                    with patch.object(broker, 'check_maintenance_storage', wraps=broker.check_maintenance_storage) as probe:
                        self.assertEqual(broker.loopback_maintenance(self.config), 0)
                    probe.assert_called_once_with(self.config)
                    self.assertEqual(broker.json_state(self.root / 'maintenance-heartbeat')['admittedAt'], clock.return_value)
                    self.assertNotIn('maintenance-stale', self.wire('health')[1]['reasons'])

    def test_missing_malformed_and_previous_boot_heartbeat_fail_closed(self):
        self.assertEqual(self.maintenance(), 0)
        with self.installed():
            for value in (None, '{}', 'not JSON', json.dumps(dict(boot='previous', admittedAt=time.time())), json.dumps(dict(boot='fixture-boot', admittedAt=True))):
                if value is not None:
                    broker.durable_write(self.root / 'maintenance-heartbeat', value)
                self.assertIn('maintenance-stale', self.wire('health')[1]['reasons'])

    def test_probe_is_read_only_on_denial_and_preserves_locked_recovery_reason(self):
        broker.durable_write(self.root / 'maintenance-reason', 'runner-owner-alive\n')
        log = self.root / 'log'
        log.write_bytes(b'x' * 600000)
        before = {path: path.read_bytes() for path in self.root.iterdir() if path.is_file()}
        failure = broker.StorageProbeError(self.config, PermissionError(errno.EPERM, 'fixture'))
        with preserved_shutdown_signals(), patch.object(broker, 'check_maintenance_storage', side_effect=failure), patch.object(broker, 'maintenance_stderr', side_effect=AssertionError('read-only check cannot touch log')), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(broker.loopback_maintenance(self.config, check=True), 1)
        self.assertEqual(before, {path: path.read_bytes() for path in self.root.iterdir() if path.is_file()})
        with preserved_shutdown_signals(), patch.object(broker, 'check_maintenance_storage', side_effect=failure), patch.object(broker, 'maintenance_stderr', return_value=True), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(broker.loopback_maintenance(self.config), 1)
        self.assertEqual((self.root / 'maintenance-reason').read_text(), 'runner-owner-alive\n')
        self.assertIn('storage-access-denied', self.wire('health')[1]['reasons'])

    def test_dead_stderr_is_replaced_and_unsafe_inode_never_receives_writes(self):
        log = self.root / 'maintenance.log'
        log.touch(mode=0o600)
        previous = os.dup(2)
        limits = maintenance.resource.getrlimit(maintenance.resource.RLIMIT_FSIZE)
        reader, writer = os.pipe()
        os.close(reader)
        try:
            os.dup2(writer, 2)
            with self.assertRaises(BrokenPipeError):
                os.write(2, b'closed SSH pipe')
            with patch.object(maintenance, 'MAINTENANCE_LOG', log):
                # Exercise the production SSH handler, including its unguarded
                # housekeeping stderr print, with the actual descriptor path.
                with preserved_shutdown_signals(), contextlib.redirect_stdout(io.StringIO()), patch.object(broker, 'prune_history', side_effect=ValueError('fixture')):
                    self.assertEqual(broker.loopback_maintenance(self.config), 1)
                self.assertLessEqual(maintenance.resource.getrlimit(maintenance.resource.RLIMIT_FSIZE)[0], 1048576)
                os.write(2, b'private diagnostic\n')
                self.assertIsNotNone(broker.json_state(self.root / 'maintenance.json'))
                alias = self.root / 'unsafe-alias'
                os.link(log, alias)
                contents = log.read_bytes()
                self.assertFalse(broker.maintenance_stderr())
                os.write(2, b'must go to devnull')
                self.assertEqual(log.read_bytes(), contents)
        finally:
            maintenance.resource.setrlimit(maintenance.resource.RLIMIT_FSIZE, limits)
            os.dup2(previous, 2)
            os.close(previous)
            os.close(writer)
        self.assertIn(b'private diagnostic', log.read_bytes())
        self.assertIn(b'housekeeping-pass-failed', log.read_bytes())

    def test_health_reports_denied_root_under_tart_as_fixed_error_envelope(self):
        config_path = self.root / 'installed.json'
        config = dict(self.config, tartSha256=broker.hashlib.sha256(self.tart.read_bytes()).hexdigest(), keychainPath='/fixture/keychain', keychainCredentialPath='/fixture/credential')
        config_path.write_text(json.dumps(config))
        original = Path.lstat
        def denied(path, *args, **kwargs):
            if path == self.root:
                raise PermissionError(errno.EPERM, 'private path must not leak', str(path))
            return original(path, *args, **kwargs)
        with patch.object(broker, 'CONFIG', config_path), patch.object(broker, 'sealed', side_effect=Path), patch.object(broker, 'validate_keychain_paths'), patch.object(Path, 'lstat', denied), patch.dict(os.environ, SSH_ORIGINAL_COMMAND='health'), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(broker.cli(), 1)
        value = json.loads(output.getvalue())
        self.assertEqual(value['kind'], 'error')
        self.assertEqual(value['code'], 'storage-access-denied')
        self.assertEqual(value['storageAccessHint'], broker.STORAGE_ACCESS_HINT)
        self.assertNotIn(str(self.root), output.getvalue())


if __name__ == '__main__':
    unittest.main()
