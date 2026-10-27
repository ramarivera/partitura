"""Host broker contract tests. Run with TMPDIR in owned scratch storage."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import shutil
import threading
import tarfile
import time
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'deploy/mac-build/broker.py'
spec = importlib.util.spec_from_file_location('native_broker', SOURCE)
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)

real_verify_vm_capacity = broker.verify_vm_capacity
real_relock_keychain = broker.relock_keychain
RealLoginKeychain = broker.LoginKeychain

FAKE_TART = '''#!/usr/bin/python3
import json, pathlib, shutil, sys, time
root = pathlib.Path(__file__).parent
args = sys.argv[1:]
with (root/'trace').open('a') as out: out.write(json.dumps(args)+'\\n')
scenario = (root/'scenario').read_text()
if args[0]=='clone' and scenario=='clone-failure': sys.exit(1)
if args[0]=='clone': shutil.copytree(root/'vms'/args[1], root/'vms'/args[2])
if args[0]=='run' and scenario in ('boot-failure', 'host-key-failure'):
    print('VZErrorDomain Code=-9: Failed to get current host key; Failed to create new HostKey; private fixture detail' if scenario=='host-key-failure' else 'fixture virtualization startup refusal', file=sys.stderr)
    sys.exit(42)
if args[0]=='run':
    if any(not (root/'vms'/args[1]/name).stat().st_mode & 0o200 for name in ['config.json','disk.img','nvram.bin']): sys.exit(1)
    time.sleep(120)
if args[0]=='delete' and scenario in ('cleanup-failure', 'build-cleanup-failure'): sys.exit(1)
if args[0]=='delete':
    target=root/'vms'/args[1]
    if not target.exists(): sys.exit(1)
    shutil.rmtree(target)
if args[0]=='exec' and scenario in ('boot-failure', 'host-key-failure'):  sys.exit(1)
if args[0]=='exec' and '-i' in args:
    data=sys.stdin.buffer.read()
    (root/'received').write_bytes(data)
    if scenario.startswith('build-'):
        print('fixture guest runner refusal', file=sys.stderr)
        sys.exit(3)
if args[0]=='exec' and '/usr/bin/tail' in args:
    if scenario=='build-no-log': sys.exit(1)
    sys.stdout.buffer.write(b'fixture repository build log')
if args[0]=='exec' and '/usr/bin/tar' in args: sys.stdout.buffer.write(b'opaque-guest-artifact')
'''


@contextlib.contextmanager
def preserved_shutdown_signals():
    # Each real broker handles one request, then exits. Tests reuse this process;
    # cleanup's SIG_IGN must not leak into the next fixture Tart subprocess.
    previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mac-broker-', dir=os.environ['TMPDIR'])
        self.root = Path(self.temp.name)
        self.tart = self.root / 'tart'
        self.tart.write_text(FAKE_TART)
        self.tart.chmod(0o700)
        (self.root / 'scenario').write_text('success')
        self.config = dict(root=str(self.root), tart=str(self.tart), tartHome=str(self.root), base='sealed-native-base', guestUser='partitura', guestHome='/Users/partitura', guestRunnerSha256='b'*64, qualifierSha256='c'*64)
        base = self.root / 'vms' / self.config['base']
        base.mkdir(parents=True)
        for name in ('config.json', 'disk.img', 'nvram.bin'):
            (base / name).write_bytes(b'sealed input')
            (base / name).chmod(0o444)
        self.keychain_patch = patch.object(broker, 'LoginKeychain')
        self.keychain = self.keychain_patch.start().return_value
        self.keychain.state.return_value = 'locked'
        self.addCleanup(self.keychain_patch.stop)
        def fake_relock(_config, _deadline):
            try:
                self.keychain.lock()
                if self.keychain.state() != 'locked':
                    raise broker.KeychainError('relock-state')
            finally:
                self.keychain.close()
        self.relock_patch = patch.object(broker, 'relock_keychain', side_effect=fake_relock)
        self.relock_patch.start()
        self.addCleanup(self.relock_patch.stop)
        self.capacity_patch = patch.object(broker, 'verify_vm_capacity')
        self.capacity_patch.start()
        self.addCleanup(self.capacity_patch.stop)
        self.disk_patch = patch.object(broker.os, 'statvfs', return_value=type('Space', (), {'f_bavail': 100 * 1024**3, 'f_frsize': 1})())
        self.disk_patch.start()
        self.addCleanup(self.disk_patch.stop)
        self.job = 'a'*32
        self.request = ('run', self.job, 'd'*40, '12', 'archive', 6)

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, prefix=b'', request=None):
        reader, writer = os.pipe()
        os.write(writer, prefix + b'bundle')
        os.close(writer)
        output = io.StringIO()
        with preserved_shutdown_signals(), os.fdopen(reader, 'rb', buffering=0) as source, patch.object(broker.sys, 'stdin', type('Input', (), {'buffer': source})()), contextlib.redirect_stdout(output):
            code = broker.run_job(self.config, request or self.request)
        return code, json.loads(output.getvalue())

    def trace(self):
        return [json.loads(line) for line in (self.root / 'trace').read_text().splitlines()]

    def old_history(self, count=2200, aged=False):
        modified = time.time() - 30 * 24 * 60 * 60 - 10
        for index in range(1, count + 1):
            job = f'{index:032x}'
            directory = self.root / job
            directory.mkdir(mode=0o700)
            receipt = directory / 'receipt.json'
            receipt.write_text(json.dumps(dict(job=job, commit='d'*40, action='archive', state='failed', cause='TimeoutError')))
            cancel = self.root / (job + '.cancel')
            cancel.touch(mode=0o600)  # Slice-1 tombstones were empty files.
            attempt = self.root / ('attempt-' + f'{index + count:032x}')
            attempt.write_text(job + '\n')
            if aged:
                for path in (receipt, cancel, attempt):
                    os.utime(path, (modified, modified))

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

    def archive_members(self):
        with tarfile.open(self.root / self.job / 'artifacts.tar') as archive:
            return {member.name: archive.extractfile(member).read() for member in archive.getmembers()}

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

    def retained_artifact(self, job, state, size, modified):
        directory = self.root / job
        directory.mkdir()
        broker.record(directory, job=job, state=state)
        artifact = directory / 'artifacts.tar'
        with artifact.open('wb') as handle:
            handle.truncate(size)
        os.utime(artifact, (modified, modified))
        return artifact

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


class RegistryBrokerTests(unittest.TestCase):
    tearDown = BrokerTests.tearDown
    trace = BrokerTests.trace
    old_history = BrokerTests.old_history

    def setUp(self):
        BrokerTests.setUp(self)
        self.config.update(hostId='20faf704-1af9-4791-b023-a07843b00547', profile='registry-only', daemonRelockQualified=False, daemonRelockMacOSBuild='')
        self.epoch = broker.initialize_epoch(self.config)
        self.attempt = 'e'*32
        self.request = ('run-v2', self.job, 'd'*40, '12', 'archive', 6, 0, self.epoch, self.attempt, int(time.time()) + 100)
        self.boot_patch = patch.object(broker, 'boot_id', return_value='fixture-boot')
        self.boot_patch.start()
        self.addCleanup(self.boot_patch.stop)

    def test_keychain_settings_require_unlock_and_policy_is_opt_in_before_clone(self):
        from types import SimpleNamespace
        state = dict(lockOnSleep=False, useLockInterval=False, lockInterval=7200)
        locked = [True]
        def copy(ref, pointer):
            if locked[0]: return -25308  # securityd makeUnlocked(false).
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
        policy = dict(lockOnSleep=True, useLockInterval=True, lockInterval=600)
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
        self.assertEqual(receipt['keychainPolicy']['before']['lockInterval'], 7200)
        self.assertEqual(receipt['keychainPolicy']['actual'], policy)
        self.assertEqual(receipt['preRelockState'], 'unlocked')
        self.assertTrue(locked[0])
        self.assertEqual(self.wire('status ' + self.job)[1]['keychainPolicy'], receipt['keychainPolicy'])
        with patch.object(broker, 'LoginKeychain', side_effect=AssertionError('health accessed keychain')):
            self.assertEqual(self.wire('health')[1]['keychainPolicy']['lastReadback']['actual'], policy)

    def test_policy_readback_mismatch_keeps_prior_evidence_and_pre_relock_state_detects_autolock(self):
        from types import SimpleNamespace
        chain = RealLoginKeychain.__new__(RealLoginKeychain)
        chain.ref = broker.C.c_void_p(1)
        before = dict(lockOnSleep=False, useLockInterval=False, lockInterval=7200)
        chain.security = SimpleNamespace(SecKeychainSetSettings=lambda *args: 0)
        policy = dict(lockOnSleep=True, useLockInterval=True, lockInterval=600)
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
        self.config['keychainPolicy'] = dict(lockOnSleep=True, useLockInterval=True, lockInterval=600)
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

    def invoke(self, request=None, prefix=b''):
        reader, writer = os.pipe()
        os.write(writer, prefix + b'bundle')
        os.close(writer)
        output = io.StringIO()
        with preserved_shutdown_signals(), os.fdopen(reader, 'rb', buffering=0) as source, patch.object(broker.sys, 'stdin', type('Input', (), {'buffer': source})()), contextlib.redirect_stdout(output):
            code = broker.run_v2(self.config, request or self.request)
        value = json.loads(output.getvalue())
        self.assertEqual(value['protocolVersion'], 2)
        self.assertEqual(value['hostId'], self.config['hostId'])
        self.assertLessEqual(len(output.getvalue().encode()), 4096)
        return code, value

    def wire(self, command):
        output = io.StringIO()
        with patch.object(broker, 'load_config', return_value=self.config), patch.dict(os.environ, SSH_ORIGINAL_COMMAND=command), contextlib.redirect_stdout(output):
            code = broker.main()
        return code, json.loads(output.getvalue())

    def reconcile(self, job=None):
        return self.wire('reconcile ' + (job or self.job))

    def marker(self, job=None, age=0, stage='receiving'):
        value = dict(job=job or self.job, attempt=self.attempt, commit='d'*40, action='archive', stage=stage, heartbeat=time.time() - age)
        broker.durable_write(self.root / 'runner.json', json.dumps(value) + '\n')
        return value

    def clone(self, job=None):
        target = self.root / 'vms' / ('partitura-job-' + (job or self.job))
        shutil.copytree(self.root / 'vms' / self.config['base'], target)
        return target

    def maintenance(self, boot='fixture-boot'):
        with patch.object(broker, 'boot_id', return_value=boot):
            return broker.local_maintenance(self.config)

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
            for policy in (None, dict(lockOnSleep=True, useLockInterval=True, lockInterval=600)):
                value = dict(config, keychainPolicy=policy)
                path.write_text(json.dumps(value))
                self.assertEqual(broker.load_config(), value)
            for policy in ('preserve', {}, dict(lockOnSleep=1, useLockInterval=True, lockInterval=600), dict(lockOnSleep=True, useLockInterval=True, lockInterval=True), dict(lockOnSleep=True, useLockInterval=True, lockInterval=-1)):
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
        artifact = BrokerTests.retained_artifact(self, 'b'*32, 'succeeded', 3, 1)
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
