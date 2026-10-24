"""Host broker contract tests. Run with TMPDIR in owned scratch storage."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'deploy/mac-build/broker.py'
spec = importlib.util.spec_from_file_location('native_broker', SOURCE)
broker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(broker)

FAKE_TART = '''#!/usr/bin/python3
import json, pathlib, sys, time
root = pathlib.Path(__file__).parent
args = sys.argv[1:]
with (root/'trace').open('a') as out: out.write(json.dumps(args)+'\\n')
scenario = (root/'scenario').read_text()
if args[0]=='run': time.sleep(120)
if args[0]=='clone' and scenario=='clone-failure': sys.exit(1)
if args[0]=='delete' and scenario=='cleanup-failure': sys.exit(1)
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
        self.config = dict(root=str(self.root), tart=str(self.tart), tartHome=str(self.root), base='sealed-native-base', guestRunnerSha256='b'*64, qualifierSha256='c'*64)
        self.job = 'a'*32
        self.request = ('run', self.job, 'd'*40, '12', 'archive', 6)

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self):
        reader, writer = os.pipe()
        os.write(writer, b'bundle')
        os.close(writer)
        output = io.StringIO()
        with os.fdopen(reader, 'rb', buffering=0) as source, patch.object(broker.sys, 'stdin', type('Input', (), {'buffer': source})()), contextlib.redirect_stdout(output):
            code = broker.run_job(self.config, self.request)
        return code, json.loads(output.getvalue())

    def trace(self):
        return [json.loads(line) for line in (self.root / 'trace').read_text().splitlines()]

    def test_rejects_shell_and_path_injection_and_oversized_bundles(self):
        command = f'run {self.job} {"d"*40} 12 archive 6'
        self.assertEqual(broker.parse_command(command), self.request)
        for value in ['', 'bash', command+'; id', command+'\n', 'artifact ../escape', command.replace('archive', 'upload'), command[:-1]+str(broker.MAX_BUNDLE+1)]:
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
        self.assertIn('previewrunner', guest)
        self.assertNotIn('--upload', guest)
        self.assertEqual(receipt['artifactBytes'], len(b'opaque-guest-artifact'))

    def test_failed_build_destroys_vm_and_never_fetches_artifact(self):
        (self.root / 'scenario').write_text('build-failure')
        code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['state'], 'failed')
        self.assertIn(['delete', 'partitura-job-'+self.job], self.trace())
        self.assertFalse(any('/usr/bin/tar' in args for args in self.trace()))

    def test_failed_clone_still_attempts_cleanup(self):
        (self.root / 'scenario').write_text('clone-failure')
        code, _ = self.invoke()
        self.assertEqual(code, 1)
        self.assertIn(['delete', 'partitura-job-'+self.job], self.trace())
        self.assertFalse(any(args[0] == 'run' for args in self.trace()))

    def test_cleanup_failure_blocks_the_next_request(self):
        (self.root / 'scenario').write_text('cleanup-failure')
        code, receipt = self.invoke()
        self.assertEqual(code, 1)
        self.assertEqual(receipt['cause'], 'cleanup-required')
        with self.assertRaisesRegex(ValueError, 'operator reconciliation'):
            self.invoke()

    def test_truncated_input_is_refused_before_any_vm(self):
        self.request = (*self.request[:-1], 8)
        with self.assertRaisesRegex(ValueError, 'truncated'):
            self.invoke()
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
