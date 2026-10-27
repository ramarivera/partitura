from mac_build_broker_support import *

class RegistryBrokerTests(RegistryFixture, unittest.TestCase):
    def test_migration_inventory_is_capped_and_unowned_objects_require_host_admin(self):
        malformed = self.root / 'vms' / 'partitura-job-operator'
        malformed.mkdir()
        self.assertEqual(self.maintenance(), 1)
        self.assertTrue(malformed.exists())
        self.assertTrue((self.root / 'maintenance-blocked').exists())
        self.assertFalse(self.wire('health')[1]['accepting'])
        with patch.object(broker, 'HISTORY_PASS_SECONDS', 0):
            with self.assertRaises(broker.InventoryPending):
                broker.inventory_obligations(self.config)


    def test_reconcile_refuses_linked_clone_without_touching_target(self):
        target = self.root / 'operator'
        target.mkdir()
        clone = self.root / 'vms' / ('partitura-job-' + self.job)
        clone.symlink_to(target, target_is_directory=True)
        self.assertEqual(self.reconcile()[1]['kind'], 'cleanup-required')
        self.assertTrue(target.exists())
        self.assertFalse((self.root / 'trace').exists())


    def test_disk_refusal_precedes_all_keychain_apis_input_and_capacity(self):
        for failure in ('low', 'measurement'):
            with self.subTest(failure=failure):
                request = (self.request[0], ('a' if failure == 'low' else 'b')*32, *self.request[2:8], ('c' if failure == 'low' else 'd')*32, self.request[9])
                with patch.object(broker, 'disk_space', side_effect=OSError('fixture private path')) if failure == 'measurement' else patch.object(broker, 'disk_space', return_value=({}, False)):
                    with patch.object(broker, 'receive', side_effect=AssertionError('disk refusal read input')):
                        code, result = self.invoke(request)
                self.assertEqual((code, result['failureCode'], result['stage']), (1, 'host-disk-space-unavailable', 'disk-preflight'))
                self.assertNotIn('private', json.dumps(result))
        broker.LoginKeychain.assert_not_called()
        broker.verify_vm_capacity.assert_not_called()


    def test_full_storage_still_emits_identified_preinput_disk_refusal_without_receipt(self):
        self.assertEqual(self.maintenance(), 0)
        with patch.object(broker, 'durable_write', side_effect=OSError('fixture storage full')), patch.object(broker, 'receive', side_effect=AssertionError('read full-storage stdin')):
            code, result = self.invoke()
        self.assertEqual((code, result['kind'], result['failureCode'], result['stage']), (1, 'known', 'host-disk-space-unavailable', 'disk-preflight'))
        self.assertEqual((result['job'], result['commit'], result['action'], result['attempt']), (self.job, 'd'*40, 'archive', self.attempt))
        self.assertFalse((self.root / self.job / 'receipt.json').exists())
        broker.LoginKeychain.assert_not_called()


    def test_pruning_precedes_preflight_and_post_transfer_refusal_never_opens_keychain(self):
        order = []
        original_receive = broker.receive
        def receive(*args, **kwargs):
            order.append('receive')
            return original_receive(*args, **kwargs)
        def disk(_config, incoming=0):
            order.append('pre' if incoming else 'post')
            if not incoming:
                raise broker.DiskUnavailable()
        with patch.object(broker, 'prune_artifacts', side_effect=lambda _root: order.append('prune')), patch.object(broker, 'require_disk', side_effect=disk), patch.object(broker, 'receive', side_effect=receive):
            code, result = self.invoke()
        self.assertEqual(order, ['prune', 'pre', 'receive', 'post'])
        self.assertEqual((code, result['failureCode'], result['stage']), (1, 'host-disk-space-unavailable', 'disk-post-transfer'))
        broker.LoginKeychain.assert_not_called()
        self.assertFalse((self.root / self.job / 'source.bundle').exists())
        self.assertFalse((self.root / 'runner.json').exists())
        self.assertFalse((self.root / 'unlock-attempt').exists())


    def test_receiving_and_unlock_fences_are_durable_before_any_keychain_api(self):
        factory = broker.LoginKeychain
        def construct(_config):
            self.assertEqual((self.root / 'unlock-attempt').read_text(), self.job + '\n')
            self.assertEqual((self.root / 'active-vm').read_text(), self.job + '\n')
            self.assertEqual(json.loads((self.root / 'runner.json').read_text())['stage'], 'unlock')
            self.assertEqual(json.loads((self.root / self.job / 'receipt.json').read_text())['state'], 'running')
            return self.keychain
        factory.side_effect = construct
        self.assertEqual(self.invoke()[0], 0)
        self.assertFalse((self.root / 'unlock-attempt').exists())


    def test_disk_uses_account_available_bytes_and_never_sums_shared_free_space(self):
        from types import SimpleNamespace
        floor = broker.DISK_FLOOR
        for free, incoming, accepted in ((floor, 0, True), (floor, 1, False), (floor + 10, 10, True)):
            with patch.object(broker.os, 'statvfs', return_value=SimpleNamespace(f_bavail=free, f_frsize=1, f_bfree=free*10)):
                values, sufficient = broker.disk_space(self.config, incoming)
                self.assertEqual(sufficient, accepted)
                self.assertEqual(values['jobRootFreeBytes'], free)
                self.assertEqual(values['tartRootFreeBytes'], free)


    def test_separate_filesystems_each_need_the_floor_and_only_job_root_needs_input(self):
        from types import SimpleNamespace
        config = dict(self.config, tartHome=str(self.root / 'separate-tart'))
        floor = broker.DISK_FLOOR
        for job_free, tart_free, accepted in ((floor + 6, floor, True), (floor + 5, floor * 2, False), (floor * 2, floor - 1, False)):
            def available(path):
                return SimpleNamespace(f_bavail=job_free if path == self.root else tart_free, f_frsize=1)
            with patch.object(broker.os, 'statvfs', side_effect=available), patch.object(Path, 'stat', lambda path: SimpleNamespace(st_dev=1 if path == self.root else 2)):
                self.assertEqual(broker.disk_space(config, incoming=6)[1], accepted)


    def test_receiving_observes_tombstone_during_secret_and_bundle_wait(self):
        for secret in (False, True):
            with self.subTest(secret=secret):
                job = ('a' if secret else 'b')*32
                request = ('run-v2', job, *self.request[2:6], 10 if secret else 0, self.epoch, ('c' if secret else 'd')*32, int(time.time()) + 100)
                reader, writer = os.pipe()
                def cancel():
                    time.sleep(0.1)
                    broker.tombstone(self.config, job)
                watcher = threading.Thread(target=cancel)
                watcher.start()
                output = io.StringIO()
                start = time.monotonic()
                try:
                    with os.fdopen(reader, 'rb', buffering=0) as source, patch.object(broker.sys, 'stdin', type('Input', (), {'buffer': source})()), contextlib.redirect_stdout(output):
                        self.assertEqual(broker.run_v2(self.config, request), 1)
                finally:
                    os.close(writer)
                    watcher.join(2)
                self.assertLess(time.monotonic() - start, 2.5)
                result = json.loads(output.getvalue())
                self.assertEqual((result['kind'], result['state']), ('known', 'cancelled'))
                self.assertFalse((self.root / job / 'source.bundle').exists())
                self.assertFalse((self.root / 'runner.json').exists())
        broker.LoginKeychain.assert_not_called()


    def test_closed_transport_and_durable_marker_failure_refuse_before_keychain(self):
        request = (*self.request[:5], 7, *self.request[6:])
        self.assertEqual(self.invoke(request)[1]['failureCode'], 'receive-interrupted')
        broker.LoginKeychain.assert_not_called()
        self.assertFalse((self.root / 'runner.json').exists())
        request = (self.request[0], 'b'*32, *self.request[2:8], 'c'*32, self.request[9])
        original = broker.durable_write
        def fail_marker(path, text):
            if path.name == 'runner.json':
                raise OSError('fixture full storage')
            return original(path, text)
        with patch.object(broker, 'durable_write', side_effect=fail_marker), patch.object(broker, 'receive', side_effect=AssertionError('read before durable marker')):
            self.assertEqual(self.invoke(request)[1]['failureCode'], 'receive-interrupted')


    def test_registry_upgrade_thousands_of_receipts_and_markers_does_not_block_inventory_or_build(self):
        self.old_history(aged=True)
        self.assertEqual(broker.inventory_obligations(self.config), set())
        self.assertEqual(self.invoke()[0], 0)
        self.assertFalse((self.root / 'maintenance-blocked').exists())
        self.assertEqual(self.maintenance(), 0)
        request = (self.request[0], 'b'*32, *self.request[2:7], broker.admission_epoch(self.config), 'f'*32, self.request[9])
        self.assertEqual(self.invoke(request)[0], 0)


    def test_registry_history_gc_preserves_epoch_when_expiring_receipts_tombstones_and_attempts(self):
        self.old_history(count=3, aged=True)
        original = broker.durable_remove
        def remove(path):
            self.assertEqual(broker.admission_epoch(self.config), self.epoch)
            original(path)
        with patch.object(broker, 'durable_remove', side_effect=remove):
            broker.prune_history(self.config)
        for index in range(1, 4):
            self.assertFalse((self.root / f'{index:032x}').exists())
            self.assertFalse((self.root / (f'{index:032x}' + '.cancel')).exists())
            self.assertFalse((self.root / ('attempt-' + f'{index + 3:032x}')).exists())
        self.assertEqual(self.wire('status ' + self.job)[1]['kind'], 'unknown-job')
        self.assertEqual(self.invoke()[0], 0)


    def test_gc_backlog_keeps_health_epoch_valid_for_submissions(self):
        self.old_history(count=100, aged=True)
        broker.record_maintenance(self.root, 'fixture-boot')
        epoch = self.wire('health')[1]['epoch']
        for index in range(2):
            broker.prune_history(self.config)
            self.assertEqual(broker.admission_epoch(self.config), epoch)
            request = (self.request[0], f'{10000 + index:032x}', *self.request[2:7], epoch, f'{20000 + index:032x}', self.request[9])
            self.assertEqual(self.invoke(request)[0], 0)


    def test_housekeeping_anomalies_stay_retained_and_counted_across_reconciliation(self):
        self.old_history(count=1, aged=True)
        directory = self.root / f'{1:032x}'
        abandoned = directory / 'tmpab12cd34'
        abandoned.write_bytes(b'keep crash debris')
        outside = self.root / 'outside'
        outside.write_bytes(b'keep linked output')
        artifact = BrokerFixture.retained_artifact(self, 'b'*32, 'succeeded', 3, 1)
        artifact.unlink()
        os.link(outside, artifact)
        # An actual inventory fault still blocks until repaired and explicitly
        # revalidated. Retained housekeeping anomalies must not re-block it.
        malformed = self.root / 'vms' / 'partitura-job-operator'
        malformed.mkdir()
        self.assertEqual(self.maintenance(), 1)
        self.assertTrue((self.root / 'maintenance-blocked').exists())
        self.assertEqual(self.reconcile()[1]['kind'], 'cleanup-required')
        malformed.rmdir()
        self.assertEqual(self.reconcile()[0], 0)
        for _ in range(2):
            broker.durable_remove(self.root / 'history-gc.json')
            with contextlib.redirect_stderr(io.StringIO()) as log:
                self.assertEqual(self.maintenance(), 0)
            self.assertIn('housekeeping-history-skipped: 1', log.getvalue())
            self.assertIn('housekeeping-artifacts-skipped: 1', log.getvalue())
            self.assertNotIn(str(directory), log.getvalue())
            health = self.wire('health')[1]
            self.assertEqual((health['status'], health['housekeepingSkippedEntries']), ('ready', dict(artifacts=1, history=1)))
            self.assertFalse((self.root / 'maintenance-blocked').exists())
            self.assertEqual(abandoned.read_bytes(), b'keep crash debris')
            self.assertEqual(artifact.stat().st_nlink, 2)
            self.assertEqual(self.reconcile()[0], 0)
        self.assertEqual(outside.read_bytes(), b'keep linked output')


    def test_transient_housekeeping_failure_retries_without_invalidating_inventory(self):
        with patch.object(broker, 'prune_artifacts', side_effect=OSError('one-off IO')):
            self.assertEqual(self.maintenance(), 1)
        previous = json.loads((self.root / 'maintenance.json').read_text())
        self.assertTrue(previous['inventoryComplete'])
        self.assertFalse((self.root / 'maintenance-blocked').exists())
        self.assertEqual(self.wire('health')[1]['status'], 'ready')
        with patch.object(broker.time, 'time', return_value=previous['nextAt'] + 1):
            self.assertEqual(self.maintenance(), 0)


    def test_invalid_history_identity_is_retained_and_counted(self):
        marker = self.root / ('attempt-' + 'f'*32)
        broker.durable_write(marker, 'invalid identity\n')
        os.utime(marker, (1, 1))
        self.assertEqual(self.maintenance(), 0)
        self.assertEqual(marker.read_text(), 'invalid identity\n')
        self.assertEqual(self.wire('health')[1]['housekeepingSkippedEntries']['history'], 1)


    def test_history_gc_is_batched_and_preserves_live_obligations_and_artifact_leases(self):
        self.old_history(count=100, aged=True)
        protected = f'{1:032x}'
        self.marker(job=protected)
        artifact_job = self.root / f'{2:032x}'
        (artifact_job / 'artifacts.tar').write_bytes(b'old but still retained')
        broker.prune_history(self.config)
        self.assertTrue((self.root / protected / 'receipt.json').exists())
        self.assertTrue((artifact_job / 'artifacts.tar').exists())
        remaining = [p for p in self.root.iterdir() if p.name.endswith('.cancel') or p.name.startswith('attempt-') or broker.re.fullmatch(broker.JOB, p.name)]
        self.assertEqual(len(remaining), 300 - 64)
        self.assertLessEqual(json.loads((self.root / 'history-gc.json').read_text())['nextAt'], time.time() + 60)


    def test_transient_first_inventory_failure_backs_off_and_retries_without_permanent_flag(self):
        with patch.object(broker, 'inventory_obligations', side_effect=OSError('one-off EIO')):
            self.assertEqual(self.invoke()[1]['code'], 'host-maintenance')
        self.assertFalse((self.root / 'maintenance-blocked').exists())
        previous = json.loads((self.root / 'maintenance.json').read_text())
        self.assertFalse(previous['inventoryComplete'])
        with patch.object(broker, 'inventory_obligations', side_effect=AssertionError('ignored backoff')):
            self.assertEqual(self.maintenance(), 1)
            request = (self.request[0], 'b'*32, *self.request[2:])
            self.assertEqual(self.invoke(request)[1]['code'], 'host-maintenance')
        with patch.object(broker.time, 'time', return_value=previous['nextAt'] + 1):
            self.assertEqual(self.maintenance(), 0)
        self.assertFalse((self.root / 'inventory-required').exists())
        self.assertEqual(self.wire('health')[1]['status'], 'ready')


    def test_local_transient_inventory_failure_retries_at_recorded_next_at(self):
        with patch.object(broker, 'inventory_obligations', side_effect=OSError('one-off IO')):
            self.assertEqual(self.maintenance(), 1)
        first = json.loads((self.root / 'maintenance.json').read_text())
        with patch.object(broker, 'run_lock', side_effect=AssertionError('ignored boot backoff')):
            self.assertEqual(self.maintenance(), 1)
        with patch.object(broker.time, 'time', return_value=first['nextAt'] + 1):
            self.assertEqual(self.maintenance(), 0)
        self.assertFalse((self.root / 'maintenance-blocked').exists())


    def test_operator_block_requires_repaired_full_inventory_and_explicit_reconcile(self):
        malformed = self.root / 'vms' / 'partitura-job-operator'
        malformed.mkdir()
        self.assertEqual(self.maintenance(), 1)
        self.assertEqual(self.maintenance(), 1)
        self.assertEqual(self.reconcile()[1]['kind'], 'cleanup-required')
        self.assertTrue((self.root / 'maintenance-blocked').exists())
        malformed.rmdir()  # Fake host-admin repair, not a production host action.
        self.assertEqual(self.reconcile()[1]['kind'], 'reconciled-unknown')
        self.assertFalse((self.root / 'maintenance-blocked').exists())
        self.assertEqual(self.wire('health')[1]['status'], 'ready')


    def test_more_than_one_cleanup_batch_makes_progress_without_oversized_operator_block(self):
        for index in range(1, 130):
            self.clone(f'{index:032x}')
        def destroy(config, job, deadline=None):
            shutil.rmtree(Path(config['tartHome']) / 'vms' / ('partitura-job-' + job))
        with patch.object(broker, 'destroy_vm', side_effect=destroy):
            self.assertEqual(self.maintenance(), 1)
            with patch.object(broker, 'inventory_obligations', side_effect=AssertionError('ignored boot backoff')):
                self.assertEqual(self.invoke()[1]['code'], 'host-reconciled')
            for _ in range(5):
                code, result = self.reconcile()
                if code == 0:
                    break
        self.assertEqual((code, result['kind']), (0, 'reconciled-terminal'))
        self.assertFalse((self.root / 'maintenance-blocked').exists())
        self.assertFalse((self.root / 'inventory-required').exists())
        self.assertEqual(list((self.root / 'vms').iterdir()), [self.root / 'vms' / self.config['base']])
        self.assertEqual(self.wire('health')[1]['status'], 'ready')


    def test_legacy_cancel_acknowledges_multiple_pending_jobs_even_when_relock_fails(self):
        self.config['profile'] = 'legacy'
        self.clone()
        self.clone('b'*32)
        broker.durable_write(self.root / 'active-vm', self.job + '\n')
        self.assertEqual(self.maintenance(), 1)
        self.assertEqual(set(json.loads((self.root / 'recovery.json').read_text())['jobs']), {self.job, 'b'*32})
        self.keychain.lock.side_effect = broker.KeychainError('lock failed')
        code, result = self.wire('cancel ' + self.job)
        self.assertEqual((code, result), (0, dict(job=self.job, state='cancellation-requested')))
        self.assertTrue((self.root / 'cleanup-required').exists())
        self.keychain.lock.side_effect = None
        self.assertEqual(self.wire('cancel ' + self.job)[0], 0)
        self.assertFalse((self.root / 'recovery.json').exists())
        self.assertFalse((self.root / 'cleanup-required').exists())


    def test_expiry_accepts_qualified_thirty_second_clock_skew(self):
        request = (*self.request[:9], int(time.time()) + 125)
        self.assertEqual(self.invoke(request)[0], 0)


    def test_configured_sealed_disk_floor_is_reported_and_enforced(self):
        self.config['minimumFreeBytes'] = 120 * 1024**3
        broker.record_maintenance(self.root, 'fixture-boot')
        result = self.wire('health')[1]
        self.assertEqual((result['accepting'], result['hostFloorBytes']), (False, self.config['minimumFreeBytes']))
        self.assertEqual(self.invoke()[1]['failureCode'], 'host-disk-space-unavailable')
        broker.LoginKeychain.assert_not_called()


    def test_backwards_clock_step_keeps_runner_reconcilable_and_maintenance_retryable(self):
        self.marker()
        broker.record_maintenance(self.root, 'fixture-boot', failures=5)
        now = time.time()
        with patch.object(broker.time, 'time', return_value=now - 120):
            self.assertEqual(self.wire('health')[1]['reasons'], ['runner-stale'])
            previous, _ = broker.maintenance_state(self.root, 'fixture-boot')
            self.assertEqual(previous['nextAt'], 0)
            self.assertEqual(self.reconcile()[1]['kind'], 'reconciled-unknown')
        self.assertEqual(self.wire('health')[1]['status'], 'ready')


    def test_health_distinguishes_pending_daemon_relock_from_failed_ssh_cleanup(self):
        self.clone()
        self.assertEqual(self.maintenance(), 1)
        self.assertFalse((self.root / 'cleanup-required').exists())
        self.assertEqual(self.wire('health')[1]['reasons'], ['keychain-relock-pending'])
        self.keychain.lock.side_effect = broker.KeychainError('failed SSH relock')
        self.assertEqual(self.reconcile()[1]['kind'], 'cleanup-required')
        self.assertEqual(self.wire('health')[1]['reasons'], ['cleanup-required'])


    def test_health_never_admits_before_successful_current_boot_inventory(self):
        self.clone('b'*32)
        with patch.object(broker, 'inventory_obligations', side_effect=AssertionError('health inventory')), patch.object(broker, 'run_lock', side_effect=AssertionError('health lock')):
            self.assertEqual(self.wire('health')[1]['reasons'], ['inventory-pending'])
        self.assertFalse((self.root / 'runner.lock').exists())
        broker.record_maintenance(self.root, 'older-boot')
        self.assertEqual(self.wire('health')[1]['reasons'], ['inventory-pending'])


    def test_slice_one_prefixed_fences_and_pending_receipt_files_upgrade_safely(self):
        directory = self.root / self.job
        directory.mkdir()
        (directory / 'receipt.json.new').write_text('{partial')
        (self.root / (self.job + '.cancel')).touch(mode=0o600)
        broker.durable_write(self.root / 'cleanup-required', 'partitura-job-' + self.job + '\n')
        self.assertEqual(self.reconcile()[1]['kind'], 'reconciled-unknown')
        self.assertFalse(directory.exists())
        self.keychain.lock.assert_called_once()


    def test_delayed_tombstoned_or_stale_submission_preserves_unknown_recovery_result(self):
        self.reconcile()
        self.assertEqual(self.invoke()[1]['code'], 'stale-epoch')
        self.assertEqual(self.wire('status ' + self.job)[1]['kind'], 'unknown-job')
        request = (*self.request[:7], broker.admission_epoch(self.config), *self.request[8:])
        self.assertEqual(self.invoke(request)[1]['code'], 'cancelled')
        self.assertEqual(self.wire('status ' + self.job)[1]['kind'], 'unknown-job')
        expired = (*request[:9], int(time.time()) - 5)
        self.assertEqual(self.invoke(expired)[1]['code'], 'cancelled')
        status = self.wire('status ' + self.job)[1]
        self.assertEqual((status['kind'], status['tombstonePresent']), ('unknown-job', True))


    def test_vm_era_crash_is_not_classified_as_receive_interrupted(self):
        directory = self.root / self.job
        directory.mkdir()
        broker.record(directory, job=self.job, commit='d'*40, action='archive', state='receiving')
        self.clone()
        self.assertEqual(self.reconcile()[1]['kind'], 'reconciled-terminal')
        receipt = json.loads((directory / 'receipt.json').read_text())
        self.assertEqual(receipt['failureCode'], 'execution-interrupted')


    def test_disk_stages_require_disk_failure_in_both_directions(self):
        directory = self.root / self.job
        directory.mkdir()
        for fields in (dict(stage='disk-post-transfer'), dict(stage='capacity', failureCode='host-disk-space-unavailable')):
            broker.record(directory, job=self.job, state='failed', **fields)
            self.assertEqual(self.wire('status ' + self.job)[1]['kind'], 'error')
        with patch.object(broker, 'require_disk', side_effect=[None, InterruptedError('SIGHUP')]):
            self.job = 'b'*32
            request = (self.request[0], self.job, *self.request[2:])
            receipt = self.invoke(request)[1]
        self.assertNotEqual(receipt.get('stage'), 'disk-post-transfer')


    def test_pinned_tart_directory_layout_is_accepted_without_accepting_arbitrary_files(self):
        clone = self.clone()
        for name in ('state.vzvmsave', 'manifest.json', 'overlay.asif', '.explicitly-pulled'):
            (clone / name).write_bytes(b'pinned Tart metadata fixture')
        self.assertTrue(broker.verify_owned_clone(self.config, self.job))
        (clone / 'unexpected').write_bytes(b'unknown')
        with self.assertRaisesRegex(ValueError, 'unsafe owned clone'):
            broker.verify_owned_clone(self.config, self.job)


    def test_uninitialized_epoch_and_invalid_registry_requests_have_typed_responses(self):
        (self.root / 'admission-epoch').unlink()
        self.assertEqual(self.wire('health')[1]['reasons'], ['inventory-pending'])
        self.assertRegex(broker.admission_epoch(self.config), '^' + broker.JOB + '$')
        for command in ('health extra', 'run-v2 invalid', 'reconcile invalid', 'health'):
            output = io.StringIO()
            with patch.dict(os.environ, SSH_ORIGINAL_COMMAND=command), patch.object(broker, 'load_config', side_effect=ValueError('private config detail')), contextlib.redirect_stdout(output):
                self.assertEqual(broker.cli(), 1)
            self.assertEqual(json.loads(output.getvalue()), dict(protocolVersion=2, kind='error', code='broker-request-refused'))



if __name__ == '__main__':
    unittest.main()
