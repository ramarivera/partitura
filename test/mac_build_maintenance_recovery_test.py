"""Trial-review regressions for inert debris, owner guards and diagnostics."""
from mac_build_broker_support import *


class MaintenanceRecoveryTests(RegistryFixture, unittest.TestCase):
    def assert_inert_recovered(self):
        directory = self.root / self.job
        self.assertTrue(directory.is_dir())
        self.assertEqual(list(directory.iterdir()), [])
        self.assertFalse((self.root / 'runner.json').exists())
        # Both a reboot and an upgrade force inventory independently of backoff.
        broker.record_maintenance(self.root, 'previous-boot', failures=4)
        self.assertEqual(self.maintenance(), 0)
        self.assertFalse(directory.exists())
        self.assertEqual(self.wire('health')[1]['status'], 'ready')
        self.assertFalse((self.root / 'inventory-required').exists())
        self.assertFalse((self.root / 'maintenance-reason').exists())
        self.assertFalse((self.root / 'trace').exists())
        self.keychain.lock.assert_not_called()

    def test_disk_full_refusal_directory_is_inert_after_reboot(self):
        with patch.object(broker, 'record', side_effect=OSError(28, 'No space left')), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(broker.refuse(self.config, self.request, 'submission-expired'), 1)
        self.assert_inert_recovered()

    def test_disk_preflight_receipt_failure_directory_is_inert_after_reboot(self):
        with patch.object(broker, 'require_disk', side_effect=broker.DiskUnavailable()), patch.object(broker, 'record', side_effect=OSError(28, 'No space left')):
            self.assertEqual(self.invoke()[1]['failureCode'], 'host-disk-space-unavailable')
        self.assert_inert_recovered()

    def test_kill_before_marker_leaves_inert_directory_after_upgrade(self):
        with patch.object(broker, 'RunnerMarker', side_effect=SystemExit('fixture abrupt pre-marker exit')):
            with self.assertRaises(SystemExit):
                self.invoke()
        broker.record_maintenance(self.root, 'fixture-boot', failures=4)
        state = json.loads((self.root / 'maintenance.json').read_text())
        state['revision'] = 'previous-revision'
        broker.durable_write(self.root / 'maintenance.json', json.dumps(state))
        self.assertEqual(list((self.root / self.job).iterdir()), [])
        self.assertEqual(self.maintenance(), 0)
        self.assertFalse((self.root / self.job).exists())
        self.assertEqual(self.wire('health')[1]['status'], 'ready')
        self.assertFalse((self.root / 'trace').exists())

    def test_partial_input_and_receiving_receipt_do_not_need_owner_proof(self):
        directory = self.root / self.job
        directory.mkdir()
        broker.record(directory, job=self.job, state='receiving')
        (directory / 'source.bundle').write_bytes(b'partial')
        self.assertEqual(self.maintenance(), 0)
        self.assertFalse((directory / 'source.bundle').exists())
        self.assertEqual(json.loads((directory / 'receipt.json').read_text())['failureCode'], 'receive-interrupted')
        self.assertEqual(self.wire('health')[1]['status'], 'ready')
        self.keychain.lock.assert_not_called()

    def test_owner_block_keeps_backoff_and_collects_only_unrelated_history(self):
        self.old_history(count=1, aged=True)
        old = self.root / f'{1:032x}'
        artifact = self.retained_artifact(self.job, 'failed', 1, time.time() - 40*86400)
        clone = self.clone()
        cancel = self.root / (self.job + '.cancel')
        broker.durable_write(cancel, self.job + '\n')
        os.utime(cancel, (time.time() - 40*86400,) * 2)
        broker.record_maintenance(self.root, 'fixture-boot', failures=3, inventory_complete=False)
        first = json.loads((self.root / 'maintenance.json').read_text())
        with patch.object(broker.time, 'time', return_value=first['nextAt'] + 1):
            self.assertEqual(self.maintenance(), 0)
            state = json.loads((self.root / 'maintenance.json').read_text())
            self.assertEqual(state['failures'], 4)
            self.assertEqual(state['nextAt'], first['nextAt'] + 1 + 480)
        self.assertFalse(old.exists())
        self.assertTrue(artifact.exists())
        self.assertTrue(cancel.exists())
        self.assertTrue(clone.exists())
        self.assertEqual((self.root / 'maintenance-reason').read_text(), 'runner-owner-missing\n')
        self.assertFalse(state['inventoryComplete'])
        with patch.object(broker.time, 'time', return_value=first['nextAt'] + 61), patch.object(broker, 'inventory_obligations', side_effect=AssertionError('inventory repeated during owner backoff')):
            self.assertEqual(self.maintenance(), 0)
        self.assertFalse((self.root / 'trace').exists())

    def test_owner_gate_publishes_inventory_fence_even_after_complete_inventory(self):
        broker.record_maintenance(self.root, 'fixture-boot')
        self.clone()
        broker.durable_write(self.root / 'active-vm', self.job + '\n')
        self.assertEqual(self.maintenance(), 0)
        self.assertTrue((self.root / 'inventory-required').exists())
        self.assertEqual((self.root / 'inventory-required').read_text(), 'inventory-pending\n')
        state = json.loads((self.root / 'maintenance.json').read_text())
        self.assertEqual(state['failures'], 1)
        self.assertFalse(state['inventoryComplete'])

    def test_incomplete_inventory_defers_retention_until_all_resources_are_known(self):
        artifact = self.retained_artifact(self.job, 'failed', 1, time.time() - 40*86400)
        clone = self.clone()
        with patch.object(broker, 'inventory_obligations', side_effect=broker.InventoryPending({self.job})), patch.object(broker, 'prune_artifacts') as artifacts, patch.object(broker, 'prune_history') as history:
            self.assertEqual(self.maintenance(), 0)
        artifacts.assert_not_called()
        history.assert_not_called()
        self.assertTrue(artifact.exists())
        self.assertTrue(clone.exists())

    def test_running_unlock_fence_and_recovery_each_require_owner_evidence(self):
        for index, resource in enumerate(('running', 'unlock', 'fence', 'recovery'), 100):
            with self.subTest(resource=resource):
                job = f'{index:032x}'
                directory = self.root / job
                directory.mkdir()
                if resource == 'running':
                    broker.record(directory, job=job, state='running')
                elif resource == 'unlock':
                    (directory / 'keychain.json').write_text('{}')
                elif resource == 'fence':
                    broker.durable_write(self.root / 'active-vm', job + '\n')
                else:
                    broker.durable_write(self.root / 'recovery.json', json.dumps(dict(jobs=[job], relock=False)))
                broker.record_maintenance(self.root, 'fixture-boot', inventory_complete=False)
                locks = self.keychain.lock.call_count
                self.assertEqual(self.maintenance(), 0)
                self.assertTrue(directory.exists())
                self.assertEqual(self.keychain.lock.call_count, locks)
                self.assertEqual((self.root / 'maintenance-reason').read_text(), 'runner-owner-missing\n')
                self.assertEqual(self.reconcile(job)[0], 0)

    def test_valid_dead_runner_cannot_authorize_another_jobs_resources(self):
        self.marker(stage='workflow')
        own = self.clone()
        other = self.clone('b'*32)
        with patch.object(broker, 'process_start', return_value=None):
            self.assertEqual(self.maintenance(), 0)
        self.assertTrue(own.exists())
        self.assertTrue(other.exists())
        self.assertEqual((self.root / 'maintenance-reason').read_text(), 'runner-owner-ambiguous\n')
        self.assertIn('runner-owner-ambiguous', self.wire('health')[1]['reasons'])
        self.assertFalse((self.root / 'trace').exists())

    def test_invalid_boot_is_rejected_independently_of_pid_and_start(self):
        runner = self.marker(stage='workflow')
        runner['owner']['boot'] = 'previous-boot'
        with patch.object(broker, 'process_start', side_effect=AssertionError('malformed boot must not probe PID')):
            self.assertEqual(broker.owner_block_reason(runner, 'fixture-boot'), 'runner-owner-unavailable')

    def test_invalid_pid_range_is_rejected_independently_of_start_and_boot(self):
        runner = self.marker(stage='workflow')
        for pid in (0, -1, 2**31, True):
            with self.subTest(pid=pid), patch.object(broker, 'process_start', return_value=None):
                runner['owner']['pid'] = pid
                self.assertEqual(broker.owner_block_reason(runner, 'fixture-boot'), 'runner-owner-unavailable')

    def test_relock_wait_reason_is_published_only_under_exclusive_lock(self):
        broker.durable_write(self.root / 'keychain-relock-pending', self.job + '\n')
        real_write = broker.durable_write
        def write(path, data):
            if path.name == 'maintenance-reason':
                with broker.run_lock(self.config, 0) as acquired:
                    self.assertFalse(acquired, 'relock diagnostic raced SSH reconcile')
            return real_write(path, data)
        with patch.object(broker, 'durable_write', side_effect=write):
            self.assertEqual(self.maintenance(), 0)
        self.assertTrue((self.root / 'maintenance-reason').exists())
        self.assertEqual((self.root / 'maintenance-reason').read_text(), 'keychain-relock-pending\n')

    def test_relock_wait_rechecks_fence_after_ssh_reconcile_wins_lock(self):
        broker.durable_write(self.root / 'keychain-relock-pending', self.job + '\n')
        real_lock = broker.run_lock
        @contextlib.contextmanager
        def lock(config, seconds):
            with patch.object(broker, 'run_lock', real_lock):
                self.assertEqual(self.reconcile()[0], 0)
            with real_lock(config, seconds) as acquired:
                yield acquired
        with patch.object(broker, 'run_lock', side_effect=lock):
            self.assertEqual(self.maintenance(), 0)
        self.assertFalse((self.root / 'maintenance-reason').exists())
        self.assertEqual(self.wire('health')[1]['status'], 'ready')

    def test_ready_health_ignores_unknown_diagnostic_but_blocks_known_reason(self):
        broker.record_maintenance(self.root, 'fixture-boot')
        broker.durable_write(self.root / 'maintenance-reason', 'private-unrecognized-text\n')
        health = self.wire('health')[1]
        self.assertEqual((health['status'], health['accepting'], health['capacity'], health['reasons']), ('ready', True, 1, []))
        broker.durable_write(self.root / 'maintenance-reason', 'runner-owner-unavailable\n')
        health = self.wire('health')[1]
        self.assertEqual((health['status'], health['accepting'], health['capacity'], health['reasons']), ('blocked', False, 0, ['runner-owner-unavailable']))

    def test_direct_reconcile_clears_reason_without_wrapper_or_maintenance(self):
        (self.root / self.job).mkdir()
        broker.durable_write(self.root / 'maintenance-reason', 'runner-owner-missing\n')
        with broker.run_lock(self.config, 0) as acquired:
            self.assertTrue(acquired)
            self.assertEqual(broker.reconcile_locked(self.config, {self.job})[0], 'reconciled')
        self.assertFalse((self.root / 'maintenance-reason').exists())

    def test_successful_maintenance_record_clears_reason_independently(self):
        broker.durable_write(self.root / 'maintenance-reason', 'inventory-unavailable\n')
        broker.record_maintenance(self.root, 'fixture-boot', failures=1, inventory_complete=False)
        self.assertTrue((self.root / 'maintenance-reason').exists())
        broker.record_maintenance(self.root, 'fixture-boot')
        self.assertFalse((self.root / 'maintenance-reason').exists())

    def test_missing_own_birth_time_refuses_before_reading_input(self):
        with patch.object(broker, 'process_start', return_value=None), patch.object(broker, 'receive') as receive:
            self.assertEqual(self.invoke()[0], 1)
        receive.assert_not_called()
        self.assertFalse((self.root / 'runner.json').exists())
        self.assertFalse((self.root / 'trace').exists())


if __name__ == '__main__':
    unittest.main()
