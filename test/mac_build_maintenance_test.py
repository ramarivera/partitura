"""Reboot inventory and dead-owner recovery, using the broker's fake host."""
from mac_build_broker_support import *

from partitura_broker.state import process_start as real_process_start


class MaintenanceTrialTests(RegistryFixture, unittest.TestCase):
    def crashed_job(self):
        directory = self.root / self.job
        directory.mkdir()
        broker.record(directory, job=self.job, commit='d'*40, action='archive', state='running')
        (directory / 'source.bundle').write_bytes(b'partial input')
        (directory / 'keychain.json').write_text('{"preUnlockState":"locked"}')
        self.marker(stage='workflow')
        broker.durable_write(self.root / 'active-vm', self.job + '\n')
        return directory, self.clone()

    def test_reboot_inventory_ignores_backoff_from_previous_boot_for_legacy_history(self):
        self.config['profile'] = 'legacy'
        self.old_history(count=11)
        broker.record_maintenance(self.root, 'previous-boot', failures=4, inventory_complete=False)
        self.assertEqual(self.maintenance(), 0)
        state = json.loads((self.root / 'maintenance.json').read_text())
        self.assertEqual((state['boot'], state['inventoryComplete'], state['failures']), ('fixture-boot', True, 0))
        self.assertFalse((self.root / 'inventory-required').exists())
        self.assertEqual(self.wire('health')[1]['reasons'], ['legacy-profile'])
        self.assertFalse((self.root / 'trace').exists())
        self.keychain.lock.assert_not_called()

    def test_inventory_io_failure_has_specific_health_and_backoff_is_normal_exit(self):
        with patch.object(broker, 'inventory_obligations', side_effect=OSError('fixture volume unavailable')):
            self.assertEqual(self.maintenance(), 1)
        self.assertEqual(self.wire('health')[1]['reasons'], ['inventory-unavailable'])
        state = json.loads((self.root / 'maintenance.json').read_text())
        with patch.object(broker, 'inventory_obligations', side_effect=AssertionError('retried during backoff')):
            self.assertEqual(self.maintenance(), 0)
        with patch.object(broker.time, 'time', return_value=state['nextAt'] + 1):
            self.assertEqual(self.maintenance(), 0)
        self.assertEqual(self.wire('health')[1]['status'], 'ready')
        self.assertFalse((self.root / 'maintenance-reason').exists())

    def test_dead_broker_automatically_stops_exact_vm_and_runs_manual_cleanup(self):
        self.config.update(daemonRelockQualified=True, daemonRelockMacOSBuild='26B123')
        directory, clone = self.crashed_job()
        operator = self.root / 'vms' / 'operator-vm'
        operator.mkdir()
        (operator / 'keep').write_bytes(b'untouched')
        with patch.object(broker, 'process_start', return_value=None), patch.object(broker, 'macos_build', return_value='26B123'):
            self.assertEqual(self.maintenance(), 0)
        self.assertFalse(clone.exists())
        self.assertEqual(self.trace(), [['stop', 'partitura-job-' + self.job], ['delete', 'partitura-job-' + self.job]])
        self.assertEqual((operator / 'keep').read_bytes(), b'untouched')
        self.assertTrue((self.root / 'vms' / self.config['base']).exists())
        self.assertFalse((directory / 'source.bundle').exists())
        receipt = json.loads((directory / 'receipt.json').read_text())
        self.assertEqual((receipt['state'], receipt['stage'], receipt['failureCode']), ('failed', 'cleanup', 'execution-interrupted'))
        self.keychain.lock.assert_called_once()
        self.assertFalse((self.root / 'runner.json').exists())
        self.assertFalse((self.root / 'recovery.json').exists())
        self.assertNotEqual(broker.admission_epoch(self.config), self.epoch)
        self.assertEqual(self.wire('health')[1]['status'], 'ready')

    def test_unqualified_relock_stops_orphan_then_waits_without_failure_loop(self):
        directory, clone = self.crashed_job()
        with patch.object(broker, 'process_start', return_value=None):
            self.assertEqual(self.maintenance(), 0)
        self.assertFalse(clone.exists())
        self.assertFalse((directory / 'source.bundle').exists())
        self.assertIn('keychain-relock-pending', self.wire('health')[1]['reasons'])
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)
        state = json.loads((self.root / 'maintenance.json').read_text())
        with patch.object(broker.time, 'time', return_value=state['nextAt'] + 1), patch.object(broker, 'reconcile_locked', side_effect=AssertionError('unqualified relock repeated')):
            self.assertEqual(self.maintenance(), 0)
        self.assertEqual(self.reconcile()[1]['kind'], 'reconciled-terminal')
        self.assertFalse((self.root / 'maintenance-reason').exists())
        self.assertEqual(self.wire('health')[1]['status'], 'ready')

    def test_pid_reuse_is_dead_owner_but_matching_start_is_never_cleaned(self):
        _, clone = self.crashed_job()
        with patch.object(broker, 'process_start', return_value='Mon Oct 26 11:00:00 2026'):
            code = self.maintenance()
        self.assertTrue(clone.exists())
        self.assertEqual(code, 0)
        self.assertIn('runner-owner-alive', self.wire('health')[1]['reasons'])
        self.assertFalse((self.root / 'trace').exists())
        with patch.object(broker, 'process_start', return_value='Mon Oct 26 12:00:00 2026'):
            self.assertEqual(self.maintenance(), 0)
        self.assertFalse(clone.exists())
        self.assertIn('keychain-relock-pending', self.wire('health')[1]['reasons'])

    def test_missing_or_unreadable_owner_stays_blocked_without_touching_vm(self):
        _, clone = self.crashed_job()
        marker = json.loads((self.root / 'runner.json').read_text())
        for failure in (ValueError('ps unavailable'), OSError('ps unavailable')):
            with patch.object(broker, 'process_start', side_effect=failure):
                self.assertEqual(self.maintenance(), 0)
            self.assertIn('runner-owner-unavailable', self.wire('health')[1]['reasons'])
            self.assertTrue(clone.exists())
        del marker['owner']
        broker.durable_write(self.root / 'runner.json', json.dumps(marker) + '\n')
        self.assertEqual(self.maintenance(), 0)
        self.assertIn('runner-owner-missing', self.wire('health')[1]['reasons'])
        self.assertTrue(clone.exists())
        self.assertFalse((self.root / 'trace').exists())
        self.assertEqual(self.reconcile()[1]['kind'], 'reconciled-terminal')

    def test_prior_boot_proves_owner_dead_even_if_pid_now_has_matching_start(self):
        _, clone = self.crashed_job()
        marker = json.loads((self.root / 'runner.json').read_text())
        marker['owner']['boot'] = '11111111-1111-4111-8111-111111111111'
        broker.durable_write(self.root / 'runner.json', json.dumps(marker) + '\n')
        with patch.object(broker, 'process_start', side_effect=AssertionError('old boot PID inspected')):
            self.assertEqual(self.maintenance(), 0)
        self.assertFalse(clone.exists())

    def test_markerless_or_malformed_owner_never_authorizes_automatic_vm_cleanup(self):
        _, clone = self.crashed_job()
        marker = broker.runner_state(self.root)
        for owner in ({'pid': 12345}, 'invalid', dict(pid=True, start='x', boot='previous-boot'), dict(pid=12345, start='x', boot='fixture-boot')):
            marker['owner'] = owner
            broker.durable_write(self.root / 'runner.json', json.dumps(marker) + '\n')
            self.assertEqual(self.maintenance(), 0)
            self.assertIn('runner-owner-unavailable', self.wire('health')[1]['reasons'])
            self.assertTrue(clone.exists())
        (self.root / 'runner.json').unlink()
        self.assertEqual(self.maintenance(), 0)
        self.assertIn('runner-owner-missing', self.wire('health')[1]['reasons'])
        self.assertTrue(clone.exists())
        self.assertFalse((self.root / 'trace').exists())

    def test_live_lock_always_wins_over_dead_process_evidence(self):
        _, clone = self.crashed_job()
        with broker.run_lock(self.config, 0), patch.object(broker, 'process_start', side_effect=AssertionError('inspected live lock owner')):
            self.assertEqual(self.maintenance(), 0)
        self.assertTrue(clone.exists())
        self.assertFalse((self.root / 'trace').exists())

    def test_runner_publishes_private_birth_identity_before_receiving_and_never_on_wire(self):
        real_receive = broker.receive
        def receive(*args, **kwargs):
            marker = broker.runner_state(self.root)
            self.assertEqual(marker['owner'], dict(pid=os.getpid(), start='Mon Oct 26 12:00:00 2026', boot='fixture-boot'))
            self.assertNotIn('owner', self.wire('health')[1]['runner'])
            return real_receive(*args, **kwargs)
        with patch.object(broker, 'receive', side_effect=receive):
            self.assertEqual(self.invoke()[0], 0)
        self.assertFalse((self.root / 'runner.json').exists())

    def test_process_birth_probe_distinguishes_absence_errors_and_malformed_output(self):
        from types import SimpleNamespace
        with patch.object(broker.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=b'Mon Oct 26 11:00:00 2026\n', stderr=b'')) as run:
            self.assertEqual(real_process_start(12345), 'Mon Oct 26 11:00:00 2026')
        self.assertEqual(run.call_args.args[0], ['/bin/ps', '-p', '12345', '-o', 'lstart='])
        for code, output, error, absent in ((1, b'', b'', True), (1, b'', b'permission denied', False), (0, b'', b'', False), (0, b'private garbage', b'', False), (0, b'x'*129, b'', False)):
            with self.subTest(code=code, output=output), patch.object(broker.subprocess, 'run', return_value=SimpleNamespace(returncode=code, stdout=output, stderr=error)):
                if absent:
                    self.assertIsNone(real_process_start(12345))
                else:
                    with self.assertRaises(ValueError):
                        real_process_start(12345)


if __name__ == '__main__':
    unittest.main()
