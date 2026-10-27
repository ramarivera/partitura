from mac_build_broker_support import *

class RegistryBrokerTests(RegistryFixture, unittest.TestCase):
    def test_status_known_unknown_inconsistent_expired_and_invalid_are_distinct(self):
        result = self.wire('status ' + self.job)[1]
        self.assertEqual((result['kind'], result['tombstonePresent'], result['inconsistentDirectory']), ('unknown-job', False, False))
        self.wire('cancel ' + self.job)
        directory = self.root / self.job
        directory.mkdir()
        (directory / 'source.bundle').write_bytes(b'partial')
        result = self.wire('status ' + self.job)[1]
        self.assertEqual((result['kind'], result['tombstonePresent'], result['inconsistentDirectory']), ('unknown-job', True, True))
        for state in ('receiving', 'running', 'succeeded', 'failed', 'cancelled'):
            broker.record(directory, job=self.job, state=state, artifactExpired=True, cause='private detail', futurePrivate='private value')
            result = self.wire('status ' + self.job)[1]
            self.assertEqual((result['kind'], result['state'], result['artifactExpired']), ('known', state, True))
            self.assertNotIn('private', json.dumps(result))
        (directory / 'receipt.json').write_text('{malformed-private-data')
        code, result = self.wire('status ' + self.job)
        self.assertEqual((code, result['kind'], result['code']), (1, 'error', 'broker-state-unavailable'))
        self.assertNotIn('malformed', json.dumps(result))


    def test_status_refuses_symlink_fifo_oversized_duplicate_key_and_foreign_receipt(self):
        directory = self.root / self.job
        directory.mkdir()
        receipt = directory / 'receipt.json'
        outside = self.root / 'outside'
        outside.write_text(json.dumps(dict(job=self.job, state='succeeded')))
        receipt.symlink_to(outside)
        self.assertEqual(self.wire('status ' + self.job)[1]['kind'], 'error')
        receipt.unlink()
        os.mkfifo(receipt)
        self.assertEqual(self.wire('status ' + self.job)[1]['kind'], 'error')
        receipt.unlink()
        for text in ('x'*4097, '{"job":"' + self.job + '","state":"failed","state":"succeeded"}', json.dumps(dict(job='b'*32, state='failed'))):
            receipt.write_text(text)
            self.assertEqual(self.wire('status ' + self.job)[1]['kind'], 'error')


    def test_cancel_ack_only_tombstones_and_busy_reconcile_never_deletes_live_vm(self):
        self.marker(stage='workflow')
        clone = self.clone()
        broker.durable_write(self.root / 'active-vm', self.job + '\n')
        with broker.run_lock(self.config, 0):
            result = self.wire('cancel ' + self.job)[1]
            self.assertEqual(result['kind'], 'cancellation-requested')
            self.assertTrue(clone.exists())
            result = self.reconcile()[1]
            self.assertEqual(result['kind'], 'busy')
            self.assertEqual(result['runner']['stage'], 'workflow')
        self.assertTrue(clone.exists())
        self.assertFalse((self.root / 'trace').exists())
        self.assertTrue((self.root / (self.job + '.cancel')).exists())


    def test_unknown_reconciliation_is_finite_durable_and_never_fabricates_receipt(self):
        code, result = self.reconcile()
        self.assertEqual((code, result['kind']), (0, 'reconciled-unknown'))
        self.assertNotEqual(result['epoch'], self.epoch)
        self.assertRegex(result['nonce'], '^' + broker.JOB + '$')
        self.assertTrue((self.root / (self.job + '.cancel')).exists())
        self.assertFalse((self.root / self.job / 'receipt.json').exists())
        self.assertFalse((self.root / 'cleanup-required').exists())
        broker.LoginKeychain.assert_not_called()
        # Late submission is fenced even after an operator removes the tombstone.
        (self.root / (self.job + '.cancel')).unlink()
        self.assertEqual(self.invoke()[1]['code'], 'stale-epoch')


    def test_unknown_private_unlock_evidence_requires_relock_and_removes_only_validated_debris(self):
        directory = self.root / self.job
        directory.mkdir()
        (directory / 'keychain.json').write_text('{"preUnlockState":"locked"}')
        (directory / 'source.bundle').write_bytes(b'partial')
        code, result = self.reconcile()
        self.assertEqual((code, result['kind']), (0, 'reconciled-unknown'))
        self.keychain.lock.assert_called_once()
        self.assertFalse(directory.exists())
        self.assertTrue((self.root / (self.job + '.cancel')).exists())
        self.assertFalse(self.wire('status ' + self.job)[1]['inconsistentDirectory'])


    def test_unknown_directory_with_unexpected_or_linked_object_requires_host_repair(self):
        directory = self.root / self.job
        directory.mkdir()
        outside = self.root / 'outside'
        outside.write_text('keep')
        (directory / 'boot.log').symlink_to(outside)
        self.assertEqual(self.reconcile()[1]['kind'], 'cleanup-required')
        self.assertEqual(outside.read_text(), 'keep')
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)
        self.assertTrue((self.root / 'cleanup-required').exists())


    def test_abandoned_receive_terminalizes_partial_input_without_keychain(self):
        directory = self.root / self.job
        directory.mkdir()
        broker.record(directory, job=self.job, commit='d'*40, action='archive', attempt=self.attempt, state='receiving')
        (directory / 'source.bundle').write_bytes(b'\xffpartial')
        self.marker()  # A free lock is authoritative even with a fresh heartbeat.
        code, result = self.reconcile()
        self.assertEqual((code, result['kind']), (0, 'reconciled-terminal'))
        receipt = json.loads((directory / 'receipt.json').read_text())
        self.assertEqual((receipt['state'], receipt['failureCode']), ('failed', 'receive-interrupted'))
        self.assertFalse((directory / 'source.bundle').exists())
        self.assertFalse((self.root / 'runner.json').exists())
        broker.LoginKeychain.assert_not_called()


    def test_missing_marker_exact_clone_cleanup_preserves_operator_and_base_vms(self):
        clone = self.clone()
        operator = self.root / 'vms' / 'operator-macos'
        operator.mkdir()
        (operator / 'keep').write_bytes(b'operator data')
        code, result = self.reconcile()
        self.assertEqual((code, result['kind']), (0, 'reconciled-unknown'))
        self.assertFalse(clone.exists())
        self.assertEqual((operator / 'keep').read_bytes(), b'operator data')
        self.assertTrue((self.root / 'vms' / self.config['base']).exists())
        self.keychain.lock.assert_called_once()


    def test_reconciliation_reports_other_abandoned_jobs_and_preserves_all_on_failure(self):
        other = 'b'*32
        clone = self.clone(other)
        self.marker(other, stage='workflow')
        self.keychain.lock.side_effect = broker.KeychainError('fixture lock failure')
        self.assertEqual(self.reconcile()[1]['kind'], 'cleanup-required')
        self.assertFalse(clone.exists())
        self.assertEqual(set(json.loads((self.root / 'recovery.json').read_text())['jobs']), {self.job, other})
        self.assertFalse(self.wire('health')[1]['accepting'])
        self.keychain.lock.side_effect = None
        result = self.reconcile()[1]
        self.assertEqual(result['kind'], 'reconciled-unknown')
        self.assertEqual(set(result['reconciledJobs']), {self.job, other})


    def test_expired_cleanup_deadline_preserves_fences_without_starting_more_work(self):
        clone = self.clone()
        with broker.run_lock(self.config, 0), patch.object(broker, 'destroy_vm') as destroy:
            result, _ = broker.reconcile_locked(self.config, [self.job], deadline=time.monotonic() - 1)
        self.assertEqual(result, 'cleanup-required')
        self.assertTrue(clone.exists())
        self.assertTrue((self.root / 'recovery.json').exists())
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)
        destroy.assert_not_called()
        broker.LoginKeychain.assert_not_called()


    def test_preinput_recovery_rotates_then_refuses_without_receiving_new_job(self):
        abandoned = 'b'*32
        self.marker(abandoned)
        with patch.object(broker, 'receive', side_effect=AssertionError('received after recovery')):
            code, result = self.invoke()
        self.assertEqual((code, result['code'], result['accepted']), (1, 'host-reconciled', False))
        self.assertNotEqual(broker.admission_epoch(self.config), self.epoch)
        self.assertEqual(self.invoke()[1]['code'], 'stale-epoch')
        self.assertFalse((self.root / 'trace').exists())


    def test_run_winning_boot_race_inventories_missing_marker_debris_before_input(self):
        orphan = 'b'*32
        clone = self.clone(orphan)
        with patch.object(broker, 'receive', side_effect=AssertionError('read before boot cleanup')):
            code, result = self.invoke()
        self.assertEqual((code, result['code']), (1, 'host-reconciled'))
        self.assertFalse(clone.exists())
        self.assertNotEqual(broker.admission_epoch(self.config), self.epoch)
        self.keychain.lock.assert_called_once()
        self.assertTrue((self.root / 'maintenance.json').exists())


    def test_cleanup_failure_and_failed_epoch_write_keep_fence_and_execution_outcome(self):
        directory = self.root / self.job
        directory.mkdir()
        broker.record(directory, job=self.job, state='succeeded')
        clone = self.clone()
        (self.root / 'scenario').write_text('cleanup-failure')
        self.assertEqual(self.reconcile()[1]['kind'], 'cleanup-required')
        self.assertTrue(clone.exists())
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)
        self.assertEqual(json.loads((directory / 'receipt.json').read_text())['state'], 'succeeded')
        (self.root / 'scenario').write_text('success')
        original = broker.durable_write
        def fail_epoch(path, text):
            if path.name == 'admission-epoch':
                raise OSError('fixture storage failure')
            return original(path, text)
        with patch.object(broker, 'durable_write', side_effect=fail_epoch):
            self.assertEqual(self.reconcile()[1]['kind'], 'cleanup-required')
        self.assertFalse(clone.exists())
        self.assertTrue((self.root / 'recovery.json').exists())
        self.assertTrue((self.root / 'cleanup-required').exists())
        self.assertEqual(self.reconcile()[1]['kind'], 'reconciled-terminal')


    def test_unqualified_daemon_cleans_vm_and_input_but_retains_relock_fence_and_epoch(self):
        clone = self.clone()
        self.marker(stage='workflow')
        broker.durable_write(self.root / 'unlock-attempt', self.job + '\n')
        broker.durable_write(self.root / 'active-vm', self.job + '\n')
        self.assertEqual(self.maintenance(), 1)
        self.assertFalse(clone.exists())
        broker.LoginKeychain.assert_not_called()
        self.keychain.lock.assert_not_called()
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)
        self.assertTrue((self.root / 'keychain-relock-pending').exists())
        self.assertFalse(self.wire('health')[1]['accepting'])
        self.assertEqual(self.reconcile()[1]['kind'], 'reconciled-unknown')
        self.keychain.lock.assert_called_once()
        self.assertNotEqual(broker.admission_epoch(self.config), self.epoch)


    def test_completed_inventory_pending_relock_is_not_rescanned_and_run_can_recover_during_backoff(self):
        self.clone('b'*32)
        with patch.object(broker, 'inventory_obligations', wraps=broker.inventory_obligations) as inventory:
            self.assertEqual(self.maintenance(), 1)
            self.assertEqual(inventory.call_count, 1)
            self.assertFalse((self.root / 'inventory-required').exists())
            previous = json.loads((self.root / 'maintenance.json').read_text())
            self.assertTrue(previous['inventoryComplete'])
            with patch.object(broker.time, 'time', return_value=previous['nextAt'] + 1):
                self.assertEqual(self.maintenance(), 1)
            self.assertEqual(inventory.call_count, 1)
            self.assertEqual(self.invoke()[1]['code'], 'host-reconciled')
            self.assertEqual(inventory.call_count, 1)
        self.keychain.lock.assert_called_once()
        self.assertEqual(self.wire('health')[1]['status'], 'ready')


    def test_daemon_build_mismatch_disables_relock_and_backoff_skips_until_due(self):
        self.config.update(daemonRelockQualified=True, daemonRelockMacOSBuild='25A1')
        self.clone()
        with patch.object(broker, 'macos_build', return_value='25B2'):
            self.assertEqual(self.maintenance(), 1)
        self.keychain.lock.assert_not_called()
        with patch.object(broker, 'run_lock', side_effect=AssertionError('backoff took lock')):
            self.assertEqual(self.maintenance(), 1)
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)
        self.assertTrue(self.config['daemonRelockQualified'])  # No sealed-setting rewrite.


    def test_qualified_daemon_requires_locked_readback_and_preserves_fence_on_failure(self):
        self.config.update(daemonRelockQualified=True, daemonRelockMacOSBuild='25A1')
        self.clone()
        self.keychain.state.return_value = 'unlocked'
        with patch.object(broker, 'macos_build', return_value='25A1'):
            self.assertEqual(self.maintenance(), 1)
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)
        self.assertTrue((self.root / 'cleanup-required').exists())


    def test_qualified_daemon_rotates_only_after_locked_readback(self):
        self.config.update(daemonRelockQualified=True, daemonRelockMacOSBuild='25A1')
        self.clone()
        with patch.object(broker, 'macos_build', return_value='25A1'):
            self.assertEqual(self.maintenance(), 0)
        self.keychain.lock.assert_called_once()
        self.assertNotEqual(broker.admission_epoch(self.config), self.epoch)
        self.assertFalse((self.root / 'cleanup-required').exists())


    def test_relock_helper_execs_sealed_script_without_lock_or_ssh_stdio_and_checks_locked_state(self):
        self.assertEqual(broker.keychain_relock_entry(self.config), 0)
        self.keychain.state.return_value = 'unlocked'
        with self.assertRaisesRegex(broker.KeychainError, 'relock-state'):
            broker.keychain_relock_entry(self.config)
        with patch.object(broker, 'sealed', side_effect=Path), patch.object(broker, 'owned') as owned:
            real_relock_keychain(self.config, time.monotonic() + 30)
        args, kwargs = owned.call_args
        self.assertEqual(args[0], [broker.sys.executable, '-I', str(SOURCE), 'local-relock'])
        self.assertTrue(kwargs['close_fds'])
        self.assertEqual((kwargs['stdin'], kwargs['stdout'], kwargs['stderr']), (broker.subprocess.DEVNULL,)*3)
        self.assertNotIn('SSH_CONNECTION', args[1])
        with self.assertRaisesRegex(TimeoutError, 'relock deadline'):
            real_relock_keychain(self.config, time.monotonic() - 1)



if __name__ == '__main__':
    unittest.main()
