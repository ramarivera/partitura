from mac_build_broker_support import *

class BrokerTests(BrokerFixture, unittest.TestCase):
    def test_legacy_upgrade_with_thousands_of_receipts_and_empty_tombstones_keeps_building(self):
        self.old_history(aged=True)
        code, receipt = self.invoke()
        self.assertEqual((code, receipt['state']), (0, 'succeeded'))
        self.assertTrue((self.root / f'{1:032x}' / 'receipt.json').exists())
        broker.prune_history(self.config)
        # Legacy input has no epoch/expiry, so replay IDs survive until cutover.
        self.assertTrue((self.root / (f'{1:032x}' + '.cancel')).exists())


    def test_inventory_identity_uses_boot_session_uuid_and_source_revision(self):
        identity = '20FAF704-1AF9-4791-B023-A07843B00547'
        with patch.object(broker.subprocess, 'run', return_value=type('Result', (), {'stdout': (identity + '\n').encode()})()) as run:
            self.assertEqual(broker.boot_id(), identity.lower())
        self.assertEqual(run.call_args.args[0], ['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'])
        self.assertEqual(broker.BROKER_REVISION, broker.hashlib.sha256(SOURCE.read_bytes()).hexdigest())


    def test_capacity_inventory_counts_operator_and_other_frontends(self):
        from types import SimpleNamespace
        for inventory, accepted in ((b'/tools/tart\n/System/com.apple.Virtualization.VirtualMachine\n', True),
                                    (b'/tools/tart\n/tools/tart\n', False),
                                    (b'/System/com.apple.Virtualization.VirtualMachine\n' * 2, False),
                                    (b'/tools/qemu-system-aarch64\n', False)):
            with self.subTest(inventory=inventory), patch.object(broker.subprocess, 'run', return_value=SimpleNamespace(stdout=inventory)):
                if accepted:
                    real_verify_vm_capacity()
                else:
                    with self.assertRaises(ValueError):
                        real_verify_vm_capacity()
        with patch.object(broker.subprocess, 'run', side_effect=OSError('inventory unavailable')):
            with self.assertRaises(OSError):
                real_verify_vm_capacity()


    def test_unlock_failure_never_clones_and_locks_before_releasing_fence(self):
        def reject():
            self.assertTrue((self.root / 'active-vm').exists())
            self.assertEqual((self.root / self.job / 'source.bundle').read_bytes(), b'bundle')
            raise broker.KeychainError('unlock:-25293')
        self.keychain.unlock.side_effect = reject
        code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['failureCode'], 'unlock-failed')
        self.assertEqual(receipt['stage'], 'unlock')
        self.keychain.lock.assert_called_once()
        self.keychain.close.assert_called_once()
        self.assertFalse((self.root / 'trace').exists())
        self.assertFalse((self.root / 'active-vm').exists())
        self.assertEqual(json.loads((self.root / self.job / 'keychain.json').read_text()), {'preUnlockState': 'locked'})


    def test_capacity_failure_precedes_keychain_access_and_clone(self):
        with patch.object(broker, 'verify_vm_capacity', side_effect=ValueError('capacity')):
            code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['failureCode'], 'host-capacity-unavailable')
        self.keychain.unlock.assert_not_called()
        self.assertFalse((self.root / 'trace').exists())
        self.assertFalse((self.root / 'active-vm').exists())


    def test_keychain_lock_failure_fences_future_jobs(self):
        self.keychain.unlock.side_effect = broker.KeychainError('unlock:-25293')
        self.keychain.lock.side_effect = broker.KeychainError('lock:-1')
        code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['failureCode'], 'cleanup-required')
        self.assertTrue((self.root / 'active-vm').exists())
        self.assertTrue((self.root / 'cleanup-required').exists())
        with self.assertRaisesRegex(ValueError, 'cleanup'):
            self.invoke()


    def test_crash_recovery_locks_without_reading_credential_and_keeps_fence_on_error(self):
        (self.root / 'active-vm').write_text(self.job + '\n')
        self.keychain.lock.side_effect = broker.KeychainError('lock:-1')
        broker.cancel_job(self.config, self.job)  # Acknowledges the durable tombstone.
        self.assertTrue((self.root / 'active-vm').exists())
        self.keychain.unlock.assert_not_called()
        self.keychain.close.assert_called_once()


    def test_explicit_credential_read_refuses_missing_links_modes_and_wrong_password(self):
        from unittest.mock import Mock
        credential = self.root / 'credential'
        # Instantiate without loading Apple's framework on the Linux test host.
        chain = RealLoginKeychain.__new__(RealLoginKeychain)
        chain.config = {'keychainCredentialPath': str(credential)}
        chain.ref = None
        chain.security = Mock()
        chain.security.SecKeychainUnlock.return_value = -25293
        with self.assertRaises(FileNotFoundError):
            chain.unlock()
        credential.write_bytes(b'private-fixture-password')
        credential.chmod(0o644)
        with self.assertRaisesRegex(broker.KeychainError, 'metadata'):
            chain.unlock()
        credential.chmod(0o600)
        with self.assertRaisesRegex(broker.KeychainError, 'unlock:-25293'):
            chain.unlock()
        credential.rename(self.root / 'original')
        credential.symlink_to(self.root / 'original')
        with self.assertRaises(OSError):
            chain.unlock()


    def test_secret_prefix_is_bounded_and_kept_out_of_named_host_state(self):
        secret = b'{"repository-age-identity":"fixture-job-identity"}'
        request = (*self.request, len(secret))
        command = f'run {self.job} {"d"*40} 12 archive 6 {len(secret)}'
        self.assertEqual(broker.parse_command(command), request)
        for size in (0, 65537, 100000):
            with self.assertRaises(ValueError):
                broker.parse_command(f'run {self.job} {"d"*40} 12 archive 6 {size}')
        code, receipt = self.invoke(secret, request)
        self.assertEqual(code, 0)
        self.assertEqual((self.root / 'received').read_bytes(), secret + b'bundle')
        self.assertNotIn('fixture-job-identity', json.dumps(receipt))
        self.assertNotIn('fixture-job-identity', (self.root / 'trace').read_text())
        self.assertEqual(sorted(p.name for p in (self.root / self.job).iterdir()), ['artifacts.tar', 'keychain.json', 'receipt.json'])


    def test_secret_path_injection_is_rejected_before_creating_a_vm(self):
        secret = b'{"../escape":"fixture-job-identity"}'
        with self.assertRaises(ValueError):
            self.invoke(secret, (*self.request, len(secret)))
        self.assertFalse((self.root / 'trace').exists())
        self.assertFalse((self.root / self.job / 'source.bundle').exists())


    def test_rejects_shell_and_path_injection_and_oversized_bundles(self):
        command = f'run {self.job} {"d"*40} 12 archive 6'
        self.assertEqual(broker.parse_command(command), self.request)
        for value in ['', 'bash', command+'; id', command+'\n', 'artifact ../escape', command.replace('archive', '../upload'), command[:-1]+str(broker.MAX_BUNDLE+1)]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                broker.parse_command(value)


    def test_complete_lifecycle_transfers_only_bundle_and_returns_receipt(self):
        code, receipt = self.invoke()
        self.assertEqual(code, 0)
        self.assertEqual(receipt['state'], 'succeeded')
        self.assertEqual((self.root / 'received').read_bytes(), b'bundle')
        self.assertFalse((self.root / self.job / 'source.bundle').exists())
        trace = self.trace()
        self.assertEqual(trace[0], ['clone', 'sealed-native-base', 'partitura-job-'+self.job])
        self.assertIn(['delete', 'partitura-job-'+self.job], trace)
        boot = next(args for args in trace if args[0] == 'run')
        for flag in ['--no-graphics', '--no-audio', '--no-usb-accessories', '--no-clipboard']:
            self.assertIn(flag, boot)
        self.assertFalse(any('--dir' in arg for args in trace for arg in args))
        guest = next(args for args in trace if '-i' in args)
        self.assertIn('partitura', guest)
        self.assertNotIn('--upload', guest)
        self.assertEqual(receipt['artifactBytes'], len(b'opaque-guest-artifact'))
        for name in ('config.json', 'disk.img', 'nvram.bin'):
            path = self.root / 'vms' / self.config['base'] / name
            self.assertEqual(path.read_bytes(), b'sealed input')
            self.assertEqual(path.stat().st_mode & 0o777, 0o444)


    def test_clone_rejects_hardlinks_and_symlinks_without_changing_base_modes(self):
        base = self.root / 'vms' / self.config['base']
        for kind in ('hardlink', 'symlink'):
            with self.subTest(kind=kind):
                clone = self.root / 'vms' / ('unsafe-' + kind)
                clone.mkdir()
                target = base / 'config.json'
                path = clone / 'config.json'
                if kind == 'hardlink':
                    os.link(target, path)
                else:
                    path.symlink_to(target)
                with self.assertRaises((ValueError, OSError)):
                    broker.prepare_clone(self.config, clone.name)
                self.assertEqual(target.stat().st_mode & 0o777, 0o444)


    def test_boot_failure_has_private_diagnostics_and_keeps_cleanup(self):
        (self.root / 'scenario').write_text('boot-failure')
        code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['stage'], 'boot')
        self.assertEqual(receipt['bootExitCode'], 42)
        self.assertNotIn('failureCode', receipt)
        self.assertIn('fixture virtualization startup refusal', (self.root / self.job / 'boot.log').read_text())
        self.assertIn(['delete', 'partitura-job-'+self.job], self.trace())
        self.assertFalse((self.root / 'active-vm').exists())


    def test_host_key_failure_exposes_only_fixed_diagnostic_and_preserves_cleanup(self):
        (self.root / 'scenario').write_text('host-key-failure')
        code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['failureCode'], 'host-key-unavailable')
        self.assertNotIn('private fixture detail', json.dumps(receipt))
        self.assertNotIn('Failed to create new HostKey', json.dumps(receipt))
        self.assertFalse((self.root / 'active-vm').exists())
        self.assertFalse((self.root / 'vms' / ('partitura-job-' + self.job)).exists())
        # Status can classify old failed receipts without rewriting their history.
        del receipt['failureCode']
        broker.record(self.root / self.job, **receipt)
        before = (self.root / self.job / 'receipt.json').read_bytes()
        output = io.StringIO()
        with patch.object(broker, 'load_config', return_value=self.config), patch.dict(os.environ, SSH_ORIGINAL_COMMAND='status ' + self.job), contextlib.redirect_stdout(output):
            self.assertEqual(broker.main(), 0)
        self.assertEqual(json.loads(output.getvalue())['failureCode'], 'host-key-unavailable')
        self.assertEqual((self.root / self.job / 'receipt.json').read_bytes(), before)


    def test_diagnostics_ignore_unknown_unsafe_or_oversized_logs(self):
        directory = self.root / self.job
        directory.mkdir()
        target = directory / 'boot.log'
        receipt = dict(state='failed', stage='boot')
        signature = b'VZErrorDomain Code=-9: Failed to get current host key; Failed to create new HostKey'
        for data in (b'unknown private detail', signature + b'x' * broker.MAX_BOOT_LOG):
            target.write_bytes(data)
            self.assertNotIn('failureCode', broker.diagnostic_receipt(directory, receipt))
        target.unlink()
        outside = self.root / 'private.log'
        outside.write_bytes(signature)
        target.symlink_to(outside)
        self.assertNotIn('failureCode', broker.diagnostic_receipt(directory, receipt))
        target.unlink()
        os.mkfifo(target)
        self.assertNotIn('failureCode', broker.diagnostic_receipt(directory, receipt))
        self.assertEqual(broker.diagnostic_receipt(directory, dict(receipt, cause='cleanup-required'))['failureCode'], 'cleanup-required')


    def test_boot_log_drains_excess_bytes_without_growing_the_file(self):
        source = io.BytesIO(b'x' * (broker.MAX_BOOT_LOG * 3))
        target = self.root / 'boot.log'
        broker.capture_boot_log(source, target)
        self.assertTrue(source.closed)
        self.assertEqual(target.read_bytes(), b'x' * broker.MAX_BOOT_LOG)


    def test_failed_build_destroys_vm_and_never_fetches_artifact(self):
        (self.root / 'scenario').write_text('build-failure')
        code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['state'], 'failed')
        self.assertIn(['delete', 'partitura-job-'+self.job], self.trace())
        self.assertFalse(any('/usr/bin/tar' in args for args in self.trace()))


    def test_failed_workflow_returns_repository_logs_and_exit_code(self):
        (self.root / 'scenario').write_text('build-failure')
        code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual((receipt['state'], receipt['stage'], receipt['failureCode']), ('failed', 'workflow', 'workflow-failed'))
        self.assertEqual(receipt['workflowExitCode'], 3)
        tail = next(args for args in self.trace() if '/usr/bin/tail' in args)
        self.assertEqual(tail[-1], '/Users/partitura/dev/agentic-scratchpads/partitura/' + self.job + '/build.log')
        self.assertEqual(tail[tail.index('-c') + 1], str(broker.MAX_WORKFLOW_LOG))
        self.assertLess(self.trace().index(tail), self.trace().index(['delete', 'partitura-job-'+self.job]))
        self.assertEqual(self.archive_members(), {
            'runner.log': b'fixture guest runner refusal\n',
            'build.log': b'fixture repository build log',
        })
        self.assertEqual(receipt['artifactBytes'], (self.root / self.job / 'artifacts.tar').stat().st_size)
        self.assertFalse((self.root / self.job / 'runner.log').exists())
        self.assertFalse((self.root / self.job / 'build.log').exists())
        output = io.BytesIO()
        stdout = type('Output', (), {'buffer': output})()
        with patch.object(broker, 'load_config', return_value=self.config), patch.dict(os.environ, SSH_ORIGINAL_COMMAND='artifact ' + self.job), patch.object(broker.sys, 'stdout', stdout):
            self.assertEqual(broker.main(), 0)
        self.assertEqual(output.getvalue(), (self.root / self.job / 'artifacts.tar').read_bytes())


    def test_failure_before_repository_step_returns_runner_log_only(self):
        (self.root / 'scenario').write_text('build-no-log')
        code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['failureCode'], 'workflow-failed')
        self.assertEqual(self.archive_members(), {'runner.log': b'fixture guest runner refusal\n'})


    def test_workflow_logs_survive_the_next_job_but_other_failures_do_not(self):
        (self.root / 'scenario').write_text('build-failure')
        self.invoke()
        logs = self.root / self.job / 'artifacts.tar'
        other = self.retained_artifact('1'*32, 'failed', 3, 1)
        (self.root / 'scenario').write_text('success')
        self.job = 'b'*32
        self.request = ('run', self.job, 'd'*40, '12', 'archive', 6)
        self.assertEqual(self.invoke()[0], 0)
        self.assertTrue(logs.exists())
        self.assertFalse(other.exists())


    def test_cleanup_failure_withdraws_workflow_logs(self):
        (self.root / 'scenario').write_text('build-cleanup-failure')
        code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['failureCode'], 'cleanup-required')
        self.assertNotIn('workflowExitCode', receipt)
        self.assertNotIn('artifactSha256', receipt)
        self.assertFalse((self.root / self.job / 'artifacts.tar').exists())


    def test_retention_prunes_expired_and_oldest_archives_but_preserves_receipts(self):
        now = time.time()
        expired = self.retained_artifact('1'*32, 'succeeded', 1, now-broker.ARTIFACT_RETENTION_SECONDS-1)
        oldest = self.retained_artifact('2'*32, 'succeeded', 4, now-10)
        newest = self.retained_artifact('3'*32, 'succeeded', 4, now-1)
        with patch.object(broker, 'ARTIFACT_STORAGE_LIMIT', broker.MAX_ARTIFACT + 6):
            broker.prune_artifacts(self.root, now)
        self.assertFalse(expired.exists())
        self.assertFalse(oldest.exists())
        self.assertTrue(newest.exists())
        self.assertTrue(json.loads((oldest.parent / 'receipt.json').read_text())['artifactExpired'])
        self.assertEqual(json.loads((expired.parent / 'receipt.json').read_text())['state'], 'succeeded')


    def test_new_job_prunes_failed_archives_and_preserves_unfinished_output(self):
        failed = self.retained_artifact('1'*32, 'failed', 3, 1)
        running = self.retained_artifact('2'*32, 'running', 3, 1)
        code, _ = self.invoke()
        self.assertEqual(code, 0)
        self.assertFalse(failed.exists())
        self.assertTrue(running.exists())


    def test_failed_artifact_transfer_removes_partial_archive(self):
        def partial_transfer(_arguments, _environment, destination, _timeout):
            destination.write_bytes(b'partial')
            raise TimeoutError('interrupted artifact transfer')
        with patch.object(broker, 'bounded_output', side_effect=partial_transfer):
            code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['state'], 'failed')
        self.assertFalse((self.root / self.job / 'artifacts.tar').exists())
        self.assertFalse((self.root / 'active-vm').exists())


    def test_retention_skips_symlinks_and_hardlinks_without_touching_targets(self):
        artifact = self.retained_artifact('1'*32, 'succeeded', 3, 1)
        outside = self.root / 'outside'
        outside.write_bytes(b'keep')
        artifact.unlink()
        artifact.symlink_to(outside)
        broker.prune_artifacts(self.root)
        self.assertEqual(broker.housekeeping_counts(self.root)['artifacts'], 1)
        self.assertTrue(artifact.is_symlink())
        self.assertEqual(outside.read_bytes(), b'keep')
        artifact.unlink()
        os.link(outside, artifact)
        broker.prune_artifacts(self.root)
        self.assertEqual(broker.housekeeping_counts(self.root)['artifacts'], 1)
        self.assertEqual(artifact.stat().st_nlink, 2)
        self.assertEqual(outside.read_bytes(), b'keep')


    def test_failed_clone_still_attempts_cleanup(self):
        (self.root / 'scenario').write_text('clone-failure')
        code, _ = self.invoke()
        self.assertEqual(code, 1)
        self.assertIn(['delete', 'partitura-job-'+self.job], self.trace())
        self.assertFalse(any(args[0] == 'run' for args in self.trace()))
        self.assertFalse((self.root / 'cleanup-required').exists())
        self.assertFalse((self.root / 'active-vm').exists())
        (self.root / 'scenario').write_text('success')
        self.job = 'b'*32
        self.request = ('run', self.job, 'd'*40, '12', 'archive', 6)
        self.assertEqual(self.invoke()[0], 0)


    def test_cleanup_failure_blocks_the_next_request(self):
        (self.root / 'scenario').write_text('cleanup-failure')
        code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['cause'], 'cleanup-required')
        self.assertEqual(receipt['failureCode'], 'cleanup-required')
        with self.assertRaisesRegex(ValueError, 'operator reconciliation'):
            self.invoke()


    def test_truncated_input_is_refused_before_any_vm(self):
        self.request = (*self.request[:-1], 8)
        with self.assertRaisesRegex(ValueError, 'truncated'):
            self.invoke()
        self.assertFalse((self.root / 'trace').exists())
        self.assertFalse((self.root / self.job / 'source.bundle').exists())
        receipt = json.loads((self.root / self.job / 'receipt.json').read_text())
        self.assertEqual(receipt['state'], 'failed')
        self.assertEqual(receipt['cause'], 'ValueError')


    def test_receiving_termination_removes_partial_bundle_and_preserves_exception(self):
        error = InterruptedError('terminated while receiving')
        with patch.object(broker, 'receive', side_effect=error):
            with self.assertRaises(InterruptedError) as caught:
                self.invoke()
        self.assertIs(caught.exception, error)
        self.assertFalse((self.root / self.job / 'source.bundle').exists())
        receipt = json.loads((self.root / self.job / 'receipt.json').read_text())
        self.assertEqual(receipt['state'], 'failed')
        self.assertEqual(receipt['cause'], 'InterruptedError')
        self.assertFalse((self.root / 'trace').exists())


    def test_cancellation_before_submission_fences_future_launch(self):
        broker.cancel_job(self.config, self.job)
        with self.assertRaisesRegex(ValueError, 'cancelled before submission'):
            self.invoke()
        self.assertFalse((self.root / 'trace').exists())


    def test_crash_fence_blocks_new_job_and_cancel_reconciles_exact_orphan(self):
        shutil.copytree(self.root / 'vms' / self.config['base'], self.root / 'vms' / ('partitura-job-' + self.job))
        (self.root / 'active-vm').write_text(self.job+'\n')
        with self.assertRaisesRegex(ValueError, 'crash recovery'):
            self.invoke()
        broker.cancel_job(self.config, self.job)
        self.assertFalse((self.root / 'active-vm').exists())
        self.assertIn(['delete', 'partitura-job-'+self.job], self.trace())


    def test_cancelling_different_job_cannot_delete_active_vm(self):
        (self.root / 'active-vm').write_text('b'*32+'\n')
        broker.cancel_job(self.config, self.job)
        self.assertTrue((self.root / 'active-vm').exists())
        self.assertFalse((self.root / 'trace').exists())


    def test_repeated_shutdown_signal_cannot_interrupt_vm_cleanup(self):
        shutdown_signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
        previous = {number: signal.getsignal(number) for number in shutdown_signals}

        def interrupt(_number, _frame):
            raise InterruptedError('signal')

        signal.signal(signal.SIGTERM, interrupt)
        owned = broker.owned
        destroy = broker.destroy_vm
        interrupted = False

        def owned_with_initial_interrupt(arguments, *args, **kwargs):
            nonlocal interrupted
            if arguments[1] == 'clone' and not interrupted:
                interrupted = True
                raise InterruptedError('initial shutdown signal')
            return owned(arguments, *args, **kwargs)

        def destroy_with_repeat(config, job):
            os.kill(os.getpid(), signal.SIGTERM)
            return destroy(config, job)

        try:
            with patch.object(broker, 'owned', side_effect=owned_with_initial_interrupt), patch.object(broker, 'destroy_vm', side_effect=destroy_with_repeat):
                code, receipt = self.invoke()
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)

        self.assertEqual(code, 1)
        self.assertEqual(receipt['state'], 'failed')
        self.assertFalse((self.root / 'active-vm').exists())
        self.assertIn(['delete', 'partitura-job-'+self.job], self.trace())



if __name__ == '__main__':
    unittest.main()
