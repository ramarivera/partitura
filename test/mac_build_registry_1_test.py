from mac_build_broker_support import *

class RegistryBrokerTests(RegistryFixture, unittest.TestCase):
    def test_keychain_settings_require_unlock_and_policy_is_opt_in_before_clone(self):
        from types import SimpleNamespace
        state = dict(lockOnSleep=False, lockInterval=2147483647)
        locked = [True]
        def copy(ref, pointer):
            if locked[0]: return -25308  # securityd makeUnlocked(false).
            # Real CopySettings never writes useLockInterval.
            for key, value in state.items(): setattr(pointer._obj, key, value)
            return 0
        def update(ref, pointer):
            if locked[0]: return -25308
            state.update({key: bool(getattr(pointer._obj, key)) if key != 'lockInterval' else pointer._obj.lockInterval for key in state})
            return 0
        chain = RealLoginKeychain.__new__(RealLoginKeychain)
        chain.ref = broker.C.c_void_p(1)
        chain.security = SimpleNamespace(SecKeychainCopySettings=copy, SecKeychainSetSettings=update)
        chain.check = RealLoginKeychain.check
        policy = dict(lockOnSleep=True, lockInterval=300)
        with self.assertRaisesRegex(broker.KeychainError, 'policy-read:-25308'):
            chain.apply_policy(policy, self.root / 'keychain-policy.json')
        self.keychain.unlock.side_effect = lambda: locked.__setitem__(0, False)
        self.keychain.apply_policy.side_effect = chain.apply_policy
        self.keychain.lock.side_effect = lambda: locked.__setitem__(0, True)
        self.keychain.state.side_effect = lambda: 'locked' if locked[0] else 'unlocked'
        self.config['keychainPolicy'] = policy
        original = broker.owned
        def owned(args, *rest, **kwargs):
            if args[1] == 'clone':
                self.assertEqual(state, policy)
                self.assertFalse(locked[0])
            return original(args, *rest, **kwargs)
        with patch.object(broker, 'owned', side_effect=owned):
            code, receipt = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(receipt['keychainPolicy']['before']['lockInterval'], 2147483647)
        self.assertEqual(receipt['keychainPolicy']['actual'], policy)
        self.assertEqual(receipt['preRelockState'], 'unlocked')
        self.assertTrue(locked[0])
        self.assertEqual(self.wire('status ' + self.job)[1]['keychainPolicy'], receipt['keychainPolicy'])
        with patch.object(broker, 'LoginKeychain', side_effect=AssertionError('health accessed keychain')):
            self.assertEqual(self.wire('health')[1]['keychainPolicy']['lastReadback']['actual'], policy)


    def test_first_policy_snapshot_survives_policy_changes_revert_and_no_timeout(self):
        from types import SimpleNamespace
        original = dict(lockOnSleep=False, lockInterval=2147483647)
        state = dict(original)
        def copy(ref, pointer):
            pointer._obj.lockOnSleep = state['lockOnSleep']
            pointer._obj.lockInterval = state['lockInterval']
            # useLockInterval is deliberately untouched, matching Apple source.
            return 0
        def update(ref, pointer):
            state.update(lockOnSleep=bool(pointer._obj.lockOnSleep), lockInterval=pointer._obj.lockInterval)
            return 0
        chain = RealLoginKeychain.__new__(RealLoginKeychain)
        chain.ref = broker.C.c_void_p(1)
        chain.security = SimpleNamespace(SecKeychainCopySettings=copy, SecKeychainSetSettings=update)
        evidence = self.root / 'keychain-policy.json'
        for policy in (dict(lockOnSleep=True, lockInterval=300), dict(lockOnSleep=True, lockInterval=600), original):
            result = chain.apply_policy(policy, evidence)
            self.assertEqual(result, dict(before=original, requested=policy, actual=policy))
            self.assertEqual(state, policy)
            self.assertEqual(broker.policy_evidence(self.root)['before'], original)
        self.assertEqual(chain.settings()['lockInterval'], 2147483647)
        # Invalid evidence mustn't silently reset the original snapshot.
        evidence.write_text('{broken')
        with self.assertRaisesRegex(broker.KeychainError, '^policy-evidence$'):
            chain.apply_policy(dict(lockOnSleep=True, lockInterval=300), evidence)
        self.assertEqual(evidence.read_text(), '{broken')
        self.assertEqual(state, original)


    def test_policy_readback_mismatch_keeps_prior_evidence_and_pre_relock_state_detects_autolock(self):
        from types import SimpleNamespace
        chain = RealLoginKeychain.__new__(RealLoginKeychain)
        chain.ref = broker.C.c_void_p(1)
        before = dict(lockOnSleep=False, lockInterval=7200)
        chain.security = SimpleNamespace(SecKeychainSetSettings=lambda *args: 0)
        policy = dict(lockOnSleep=True, lockInterval=600)
        with patch.object(chain, 'settings', return_value=before):
            with self.assertRaisesRegex(broker.KeychainError, '^policy-readback$'):
                chain.apply_policy(policy, self.root / 'keychain-policy.json')
        self.assertEqual(broker.policy_evidence(self.root), dict(before=before, requested=policy, actual=None))
        # A timer may have locked it again by cleanup. Record that independently
        # of the broker's mandatory relock and its locked-state readback.
        self.keychain.state.return_value = 'locked'
        code, receipt = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(receipt['preRelockState'], 'locked')
        self.keychain.lock.assert_called_once()


    def test_keychain_policy_mismatch_fails_before_clone_and_legacy_default_preserves_settings(self):
        self.config['keychainPolicy'] = dict(lockOnSleep=True, lockInterval=600)
        self.keychain.apply_policy.side_effect = broker.KeychainError('policy-readback')
        code, receipt = self.invoke()
        self.assertEqual((code, receipt['stage'], receipt['failureCode']), (1, 'keychain-policy', 'keychain-policy-unavailable'))
        self.assertFalse((self.root / 'trace').exists())
        self.keychain.lock.assert_called_once()
        self.config['profile'] = 'legacy'
        def legacy(job):
            request = ('run', job, 'd'*40, '12', 'archive', 6, 0)
            output = io.StringIO()
            reader, writer = os.pipe()
            os.write(writer, b'bundle'); os.close(writer)
            with os.fdopen(reader, 'rb', buffering=0) as source, patch.object(broker.sys, 'stdin', type('Input', (), {'buffer': source})()), contextlib.redirect_stdout(output), preserved_shutdown_signals():
                code = broker.run_job(self.config, request)
            return code, json.loads(output.getvalue())
        code, receipt = legacy('b'*32)
        self.assertEqual((code, receipt['stage'], receipt['failureCode']), (1, 'unlock', 'unlock-failed'))
        self.assertEqual(self.wire('status ' + 'b'*32)[1]['stage'], 'unlock')
        self.assertFalse((self.root / 'trace').exists())
        self.keychain.apply_policy.reset_mock()
        self.config['keychainPolicy'] = None
        self.assertEqual(legacy('c'*32)[0], 0)
        self.keychain.apply_policy.assert_not_called()


    def test_legacy_run_recovers_main_era_running_receipt_and_pending_daemon_relock_before_input(self):
        self.config['profile'] = 'legacy'
        old = self.root / ('b'*32)
        old.mkdir()
        broker.record(old, job='b'*32, commit='d'*40, action='archive', state='running')
        broker.durable_write(self.root / 'inventory-required', 'installation\n')
        self.assertEqual(self.maintenance(), 1)
        self.assertTrue((self.root / 'keychain-relock-pending').exists())
        # The live gateway still sends the legacy command and needs no new verb.
        reader, writer = os.pipe()
        os.write(writer, b'bundle'); os.close(writer)
        request = ('run', self.job, 'd'*40, '12', 'archive', 6, 0)
        original = broker.receive
        def receive(*args, **kwargs):
            self.assertFalse((self.root / 'keychain-relock-pending').exists())
            self.assertEqual(json.loads((old / 'receipt.json').read_text())['state'], 'failed')
            return original(*args, **kwargs)
        with os.fdopen(reader, 'rb', buffering=0) as source, patch.object(broker.sys, 'stdin', type('Input', (), {'buffer': source})()), patch.object(broker, 'receive', side_effect=receive), contextlib.redirect_stdout(io.StringIO()), preserved_shutdown_signals():
            self.assertEqual(broker.run_job(self.config, request), 0)


    def test_ssh_reconcile_cannot_clear_or_replace_installation_fences(self):
        token = 'f'*32
        for cleanup in (token, self.job):
            broker.durable_write(self.root / 'cleanup-required', cleanup + '\n')
            broker.durable_write(self.root / 'maintenance-blocked', 'installation-incomplete ' + token + '\n')
            self.assertEqual(self.reconcile()[1]['kind'], 'cleanup-required')
            self.assertEqual((self.root / 'cleanup-required').read_text(), cleanup + '\n')
            self.assertEqual((self.root / 'maintenance-blocked').read_text(), 'installation-incomplete ' + token + '\n')


    def test_exact_new_commands_and_legacy_grammar(self):
        command = f'run-v2 {self.job} {"d"*40} 12 archive 6 0 {self.epoch} {self.attempt} {self.request[9]}'
        self.assertEqual(broker.parse_command(command), self.request)
        self.assertEqual(broker.parse_command('health'), ('health',))
        self.assertEqual(broker.parse_command('reconcile ' + self.job), ('reconcile', self.job))
        invalid = ['health ', 'health ' + self.job, 'health\n', 'local-maintenance', 'reconcile', 'reconcile ' + self.job + ' extra', command + '\n', command + '; true', command.replace(' 6 0 ', ' 0 0 '), command.replace(' 6 0 ', ' 1073741825 0 '), command.replace(' 6 0 ', ' 6 65537 '), command.replace(' 12 ', ' 012 '), command.replace(self.attempt, 'E'*32), command.rsplit(' ', 1)[0] + ' -1', 'x'*513]
        for text in invalid:
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, 'unsupported|limit'):
                broker.parse_command(text)


    def test_installed_config_keeps_old_shape_and_requires_complete_sealed_profile(self):
        path = self.root / 'installed.json'
        config = dict(self.config, tartSha256=broker.hashlib.sha256(self.tart.read_bytes()).hexdigest(), keychainPath='/fixture/keychain', keychainCredentialPath='/fixture/credential')
        legacy = {key: value for key, value in config.items() if key not in ('hostId', 'profile', 'daemonRelockQualified', 'daemonRelockMacOSBuild')}
        with patch.object(broker, 'CONFIG', path), patch.object(broker, 'sealed', side_effect=Path), patch.object(broker, 'validate_keychain_paths'):
            for value in (legacy, config, dict(config, profile='legacy'), dict(config, minimumFreeBytes=broker.DISK_FLOOR), dict(config, minimumFreeBytes=2 * broker.DISK_FLOOR)):
                path.write_text(json.dumps(value))
                self.assertEqual(broker.load_config(), value)
            for value in (dict(legacy, profile='registry-only'), dict(config, hostId='not-a-host'), dict(config, profile='mixed'), dict(config, daemonRelockQualified=True), dict(config, daemonRelockQualified=1)):
                path.write_text(json.dumps(value))
                with self.assertRaisesRegex(ValueError, 'configuration|identity|qualification'):
                    broker.load_config()
            for policy in (None, dict(lockOnSleep=True, lockInterval=300), dict(lockOnSleep=False, lockInterval=2147483647), dict(lockOnSleep=True, lockInterval=0)):
                value = dict(config, keychainPolicy=policy)
                path.write_text(json.dumps(value))
                self.assertEqual(broker.load_config(), value)
            for policy in ('preserve', {}, dict(lockOnSleep=1, lockInterval=600), dict(lockOnSleep=True, lockInterval=True), dict(lockOnSleep=True, lockInterval=-1), dict(lockOnSleep=True, lockInterval=2147483648), dict(lockOnSleep=True, useLockInterval=False, lockInterval=300), dict(lockOnSleep=False, useLockInterval=True, lockInterval=2147483647)):
                path.write_text(json.dumps(dict(config, keychainPolicy=policy)))
                with self.assertRaisesRegex(ValueError, 'invalid keychain policy'):
                    broker.load_config()
            for floor in (True, '53687091200', broker.DISK_FLOOR - 1, 2**63):
                path.write_text(json.dumps(dict(config, minimumFreeBytes=floor)))
                with self.assertRaisesRegex(ValueError, 'invalid installed disk floor'):
                    broker.load_config()


    def test_remote_cannot_invoke_local_maintenance(self):
        with patch.object(broker, 'local_maintenance') as maintenance:
            with patch.dict(os.environ, SSH_ORIGINAL_COMMAND='local-maintenance'):
                with self.assertRaisesRegex(ValueError, 'unsupported native'):
                    broker.main()
                with self.assertRaisesRegex(ValueError, 'unsupported local'):
                    broker.main(['local-maintenance'])
            maintenance.assert_not_called()


    def test_health_is_zero_argument_and_never_touches_lock_keychain_or_history(self):
        broker.record_maintenance(self.root, 'fixture-boot')
        with patch.object(broker, 'run_lock', side_effect=AssertionError('health took lock')), patch.object(broker, 'inventory_obligations', side_effect=AssertionError('health scanned history')), patch.object(broker, 'prune_artifacts', side_effect=AssertionError('health pruned')):
            code, result = self.wire('health')
        self.assertEqual(code, 0)
        self.assertEqual((result['kind'], result['status'], result['accepting'], result['capacity']), ('health', 'ready', True, 1))
        self.assertEqual(result['epoch'], self.epoch)
        self.assertEqual(result['hostFloorBytes'], 50 * 1024**3)
        self.assertFalse((self.root / 'runner.lock').exists())
        broker.LoginKeychain.assert_not_called()


    def test_busy_health_skips_global_inventory_and_disk_but_unrelated_fence_wins(self):
        self.marker(stage='workflow')
        broker.durable_write(self.root / 'active-vm', self.job + '\n')
        with patch.object(broker, 'verify_vm_capacity', side_effect=AssertionError('busy inventory')), patch.object(broker, 'disk_space', side_effect=AssertionError('busy disk')):
            self.assertEqual(self.wire('health')[1]['status'], 'busy')
            broker.durable_write(self.root / 'cleanup-required', 'b'*32 + '\n')
            result = self.wire('health')[1]
            self.assertEqual(result['status'], 'blocked')
            self.assertFalse(result['accepting'])


    def test_stale_marker_is_uncertain_and_reports_exact_maintenance_job(self):
        self.marker(age=61)
        result = self.wire('health')[1]
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['maintenanceJobId'], self.job)
        self.assertEqual(result['reasons'], ['runner-stale'])
        self.assertTrue((self.root / 'runner.json').exists())


    def test_idle_maintenance_is_lock_free_and_does_not_rotate_epoch(self):
        self.assertEqual(self.maintenance(), 0)  # One migration/boot inventory.
        before = (self.root / 'runner.lock').stat().st_mtime_ns
        with patch.object(broker, 'run_lock', side_effect=AssertionError('idle maintenance took lock')), patch.object(broker, 'inventory_obligations', side_effect=AssertionError('minute pass scanned history')):
            self.assertEqual(self.maintenance(), 0)
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)
        self.assertEqual((self.root / 'runner.lock').stat().st_mtime_ns, before)


    def test_maintenance_cannot_touch_a_live_lock_owner_even_on_first_boot(self):
        self.marker(stage='workflow')
        clone = self.clone()
        broker.durable_write(self.root / 'active-vm', self.job + '\n')
        with broker.run_lock(self.config, 0), patch.object(broker, 'inventory_obligations', side_effect=AssertionError('inventoried while live')):
            self.assertEqual(self.maintenance(), 0)
        self.assertTrue(clone.exists())
        self.assertFalse((self.root / 'trace').exists())
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)


    def test_run_waits_for_short_maintenance_then_executes_once_and_replay_cannot_run(self):
        held = threading.Event()
        def maintenance_lock():
            with broker.run_lock(self.config, 0) as acquired:
                self.assertTrue(acquired)
                held.set()
                time.sleep(0.15)
        child = threading.Thread(target=maintenance_lock)
        child.start()
        self.assertTrue(held.wait(2))
        code, result = self.invoke()
        child.join(2)
        self.assertEqual(code, 0)
        self.assertEqual((result['kind'], result['state'], result['attempt']), ('known', 'succeeded', self.attempt))
        self.assertEqual(self.invoke()[1]['code'], 'duplicate-job')
        self.assertEqual(sum(args[0] == 'clone' for args in self.trace()), 1)
        self.assertFalse((self.root / 'runner.json').exists())
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)


    def test_held_lock_is_identified_host_busy_without_input_receipt_or_recovery(self):
        with broker.run_lock(self.config, 0):
            with patch.object(broker, 'receive', side_effect=AssertionError('read busy stdin')), patch.object(broker, 'reconcile_locked', side_effect=AssertionError('busy recovery')):
                start = time.monotonic()
                code, result = self.invoke()
                elapsed = time.monotonic() - start
        self.assertEqual(code, 1)
        self.assertEqual(result, dict(protocolVersion=2, hostId=self.config['hostId'], kind='refused', job=self.job, commit='d'*40, action='archive', attempt=self.attempt, accepted=False, code='host-busy'))
        self.assertGreaterEqual(elapsed, 4.9)
        self.assertLess(elapsed, 8)
        self.assertFalse((self.root / self.job).exists())
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)


    def test_expiry_is_checked_after_wait_and_before_receive(self):
        now = int(time.time())
        request = (*self.request[:9], now + 1)
        held = threading.Event()
        with patch.object(broker.time, 'time', return_value=now) as clock:
            def release_after_expiry():
                with broker.run_lock(self.config, 0) as acquired:
                    self.assertTrue(acquired)
                    held.set()
                    time.sleep(0.3)
                    clock.return_value = now + 2
            owner = threading.Thread(target=release_after_expiry)
            owner.start()
            self.assertTrue(held.wait(2))
            try:
                with patch.object(broker, 'receive') as receive:
                    self.assertEqual(self.invoke(request)[1]['code'], 'submission-expired')
                    receive.assert_not_called()
            finally:
                owner.join(2)


    def test_expiry_is_rechecked_after_preparation_before_input(self):
        def delayed_prune(_root):
            clock.return_value = self.request[9] + 1
        with patch.object(broker.time, 'time', return_value=self.request[9] - 1) as clock, patch.object(broker, 'prune_artifacts', side_effect=delayed_prune), patch.object(broker, 'receive') as receive:
            self.assertEqual(self.invoke()[1]['code'], 'submission-expired')
            receive.assert_not_called()


    def test_stale_epoch_precedes_recovery_and_impossible_expiry_is_refused(self):
        self.marker()
        with patch.object(broker, 'reconcile_locked', side_effect=AssertionError('recovered before epoch')):
            stale = (*self.request[:7], 'f'*32, *self.request[8:])
            self.assertEqual(self.invoke(stale)[1]['code'], 'stale-epoch')
        self.assertTrue((self.root / 'runner.json').exists())
        self.assertEqual(broker.admission_epoch(self.config), self.epoch)
        future = (*self.request[:1], 'b'*32, *self.request[2:9], int(time.time()) + 151)
        self.assertEqual(self.invoke(future)[1]['code'], 'submission-expired')


    def test_attempt_replay_with_different_job_never_executes(self):
        self.assertEqual(self.invoke()[0], 0)
        request = (self.request[0], 'b'*32, *self.request[2:])
        self.assertEqual(self.invoke(request)[1]['code'], 'duplicate-attempt')
        self.assertEqual(sum(args[0] == 'clone' for args in self.trace()), 1)


    def test_profiles_preserve_legacy_receipts_and_never_allow_mixed_run_bypass(self):
        self.assertEqual(self.wire('run ' + self.job + ' ' + 'd'*40 + ' 12 archive 6')[1]['code'], 'legacy-run-disabled')
        self.config['profile'] = 'legacy'
        self.assertEqual(self.invoke()[1]['code'], 'legacy-profile')
        self.assertFalse(self.wire('health')[1]['accepting'])
        directory = self.root / self.job
        directory.mkdir()
        broker.record(directory, job=self.job, commit='d'*40, action='archive', state='succeeded')
        result = self.wire('status ' + self.job)[1]
        self.assertNotIn('protocolVersion', result)
        self.assertEqual(result['state'], 'succeeded')


    def test_legacy_cancel_can_recover_new_receiving_marker_without_changing_its_ack(self):
        self.config['profile'] = 'legacy'
        directory = self.root / self.job
        directory.mkdir()
        broker.record(directory, job=self.job, commit='d'*40, action='archive', state='receiving')
        (directory / 'source.bundle').write_bytes(b'partial')
        self.marker()
        code, result = self.wire('cancel ' + self.job)
        self.assertEqual((code, result), (0, dict(job=self.job, state='cancellation-requested')))
        self.assertFalse((self.root / 'runner.json').exists())
        self.assertFalse((directory / 'source.bundle').exists())
        self.assertEqual(json.loads((directory / 'receipt.json').read_text())['failureCode'], 'receive-interrupted')
        broker.LoginKeychain.assert_not_called()


    def test_legacy_cancel_completes_daemon_fallback_without_leaving_recovery_marker(self):
        self.config['profile'] = 'legacy'
        self.clone()
        broker.durable_write(self.root / 'active-vm', self.job + '\n')
        self.assertEqual(self.maintenance(), 1)
        self.assertTrue((self.root / 'recovery.json').exists())
        code, result = self.wire('cancel ' + self.job)
        self.assertEqual((code, result), (0, dict(job=self.job, state='cancellation-requested')))
        self.keychain.lock.assert_called_once()
        self.assertFalse((self.root / 'recovery.json').exists())
        self.assertFalse((self.root / 'keychain-relock-pending').exists())
        self.assertFalse((self.root / 'cleanup-required').exists())
        self.assertNotEqual(broker.admission_epoch(self.config), self.epoch)



if __name__ == '__main__':
    unittest.main()
