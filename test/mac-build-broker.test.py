"""Host broker contract tests. Run with TMPDIR in owned scratch storage."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import time
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'deploy/mac-build/broker.py'
spec = importlib.util.spec_from_file_location('native_broker', SOURCE)
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)

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
if args[0]=='delete' and scenario=='cleanup-failure': sys.exit(1)
if args[0]=='delete':
    target=root/'vms'/args[1]
    if not target.exists(): sys.exit(1)
    shutil.rmtree(target)
if args[0]=='exec' and scenario in ('boot-failure', 'host-key-failure'):  sys.exit(1)
if args[0]=='exec' and '-i' in args:
    data=sys.stdin.buffer.read()
    (root/'received').write_bytes(data)
    if scenario=='build-failure': sys.exit(1)
if args[0]=='exec' and '/usr/bin/tar' in args: sys.stdout.buffer.write(b'opaque-guest-artifact')
'''


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
        self.job = 'a'*32
        self.request = ('run', self.job, 'd'*40, '12', 'archive', 6)

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, prefix=b'', request=None):
        reader, writer = os.pipe()
        os.write(writer, prefix + b'bundle')
        os.close(writer)
        output = io.StringIO()
        with os.fdopen(reader, 'rb', buffering=0) as source, patch.object(broker.sys, 'stdin', type('Input', (), {'buffer': source})()), contextlib.redirect_stdout(output):
            code = broker.run_job(self.config, request or self.request)
        return code, json.loads(output.getvalue())

    def trace(self):
        return [json.loads(line) for line in (self.root / 'trace').read_text().splitlines()]

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
        self.assertEqual(sorted(p.name for p in (self.root / self.job).iterdir()), ['artifacts.tar', 'receipt.json'])

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

    def test_retention_refuses_symlinks_and_hardlinks_without_touching_targets(self):
        artifact = self.retained_artifact('1'*32, 'succeeded', 3, 1)
        outside = self.root / 'outside'
        outside.write_bytes(b'keep')
        artifact.unlink()
        artifact.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'unsafe retained artifact'):
            broker.prune_artifacts(self.root)
        self.assertEqual(outside.read_bytes(), b'keep')
        artifact.unlink()
        os.link(outside, artifact)
        with self.assertRaisesRegex(ValueError, 'unsafe retained artifact'):
            broker.prune_artifacts(self.root)
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
