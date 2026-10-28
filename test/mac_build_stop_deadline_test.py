"""Forced-stop margin through the real daemon and SSH reconciliation paths."""
from mac_build_broker_support import *
import subprocess


class StopDeadlineTests(RegistryFixture, unittest.TestCase):
    def crashed_job(self):
        directory = self.root / self.job
        directory.mkdir()
        broker.record(directory, job=self.job, commit='d'*40, action='archive', state='running')
        self.marker(stage='workflow')
        broker.durable_write(self.root / 'cleanup-required', self.job + '\n')
        self.clone()
        (self.root / 'scenario').write_text('force-stop-required')
        return Path(self.config['tartHome']) / 'vms' / ('partitura-job-' + self.job)

    def assert_cleaned(self, clone):
        self.assertFalse(clone.exists())
        self.assertFalse((self.root / 'cleanup-required').exists())
        self.assertEqual(self.wire('health')[1]['status'], 'ready')
        self.assertEqual(json.loads((self.root / self.job / 'receipt.json').read_text())['failureCode'], 'execution-interrupted')
        self.assertLessEqual(int((self.root / 'forced-stop').read_text()), 20)
        self.keychain.lock.assert_called_once()

    def test_daemon_force_stops_unresponsive_guest_before_owned_deadline(self):
        clone = self.crashed_job()
        self.config.update(daemonRelockQualified=True, daemonRelockMacOSBuild='26B123')
        with patch.object(broker, 'process_start', return_value=None), patch.object(broker, 'macos_build', return_value='26B123'):
            self.assertEqual(self.maintenance(), 0)
        self.assert_cleaned(clone)

    def test_ssh_reconcile_force_stops_unresponsive_guest_before_owned_deadline(self):
        clone = self.crashed_job()
        self.assertEqual(self.reconcile()[1]['kind'], 'reconciled-terminal')
        self.assert_cleaned(clone)

    def test_all_stop_budgets_leave_force_margin_and_tight_budget_uses_zero(self):
        for deadline, expected_grace, expected_budget in ((None, 30, 45), (220, 20, 30), (125, 0, 5)):
            with self.subTest(deadline=deadline), patch.object(broker.time, 'monotonic', return_value=100), patch.object(broker, 'owned') as owned:
                broker.destroy_vm(self.config, self.job, deadline=deadline)
                stop = owned.call_args_list[0]
                self.assertEqual(stop.args[0], [self.config['tart'], 'stop', 'partitura-job-' + self.job, '--timeout', str(expected_grace)])
                self.assertEqual(stop.args[2], expected_budget)
                self.assertLess(expected_grace, expected_budget)
                if expected_budget >= 10:
                    self.assertGreaterEqual(expected_budget - expected_grace, 10)

    def test_reconciliation_failure_logs_safe_class_message_and_job(self):
        self.crashed_job()
        output = io.StringIO()
        with patch.object(broker, 'destroy_vm', side_effect=ValueError('owned clone remains')), contextlib.redirect_stderr(output):
            self.assertEqual(self.reconcile()[1]['kind'], 'cleanup-required')
        self.assertIn('job=' + self.job + ' ValueError: owned clone remains', output.getvalue())
        self.assertNotIn(str(self.root), output.getvalue())

    def test_inventory_failures_log_class_and_sanitized_message(self):
        for error, expected in ((OSError(5, 'SECRET', '/secret/path'), 'OSError: Input/output error'), (ValueError('unsafe owned clone'), 'ValueError: unsafe owned clone'), (subprocess.TimeoutExpired(['/secret/key'], 30), 'TimeoutExpired: command timed out')):
            with self.subTest(error=type(error).__name__):
                (self.root / 'maintenance-blocked').unlink(missing_ok=True)
                (self.root / 'maintenance.json').unlink(missing_ok=True)
                output = io.StringIO()
                with patch.object(broker, 'inventory_obligations', side_effect=error), contextlib.redirect_stderr(output):
                    self.assertEqual(self.maintenance(), 1)
                self.assertIn(expected, output.getvalue())
                self.assertNotIn('SECRET', output.getvalue())
                self.assertNotIn('/secret', output.getvalue())

    def test_stderr_rotation_preserves_private_inode_and_resets_at_half_cap(self):
        path = self.root / 'stderr.log'
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            inode = os.fstat(descriptor).st_ino
            os.write(descriptor, b'previous diagnostic\n')
            broker.prepare_maintenance_stderr(descriptor)
            self.assertEqual(path.read_bytes(), b'previous diagnostic\n')
            os.ftruncate(descriptor, 524288)
            broker.prepare_maintenance_stderr(descriptor)
            self.assertEqual(os.fstat(descriptor).st_size, 0)
            self.assertEqual(os.fstat(descriptor).st_ino, inode)
            os.write(descriptor, b'next pass\n')
            self.assertEqual(path.read_bytes(), b'next pass\n')
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(ValueError, 'unsafe maintenance stderr'):
                broker.prepare_maintenance_stderr(descriptor)
        finally:
            os.close(descriptor)


if __name__ == '__main__':
    unittest.main()
