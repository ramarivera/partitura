"""Diagnostic failures never become build or maintenance failures."""
from mac_build_broker_support import *
import errno
import stat
import subprocess


@contextlib.contextmanager
def closed_stderr_pipe():
    reader, writer = os.pipe()
    os.close(reader)
    with os.fdopen(writer, 'w', buffering=1) as output:
        try:
            with contextlib.redirect_stderr(output):
                yield
        finally:
            # A buffered failed flush may fail again when closing the wrapper.
            with contextlib.suppress(OSError, ValueError):
                output.close()


class DiagnosticsTests(RegistryFixture, unittest.TestCase):
    def test_closed_stderr_pipe_keeps_vm_deletion_and_successful_receipt(self):
        with closed_stderr_pipe():
            code, envelope = self.invoke()
        self.assertEqual((code, envelope['state']), (0, 'succeeded'))
        self.assertFalse((self.root / 'vms' / ('partitura-job-' + self.job)).exists())
        receipt = json.loads((self.root / self.job / 'receipt.json').read_text())
        self.assertEqual(receipt['state'], 'succeeded')
        self.assertIn('artifactSha256', receipt)
        self.assertTrue((self.root / self.job / 'artifacts.tar').exists())
        self.assertFalse((self.root / 'cleanup-required').exists())
        self.assertIn('delete', [call[0] for call in self.trace()])

    def test_diagnostics_swallow_write_and_flush_failures(self):
        with closed_stderr_pipe():
            broker.maintenance_error(ValueError('owned clone remains'), self.job)
        for operation in ('write', 'flush'):
            for error in (OSError(errno.ENOSPC, 'full'), BrokenPipeError(), ValueError('closed')):
                with self.subTest(operation=operation, error=type(error).__name__):
                    output = io.StringIO()
                    with patch.object(output, operation, side_effect=error), contextlib.redirect_stderr(output):
                        broker.maintenance_error(ValueError('owned clone remains'), self.job)

    def test_return_codes_render_only_plain_integers(self):
        class HostileInt(int):
            def __str__(self):
                return 'SECRET /private/key'
        for code, expected in ((1, 'command failed with exit 1'), (-9, 'command failed with exit -9'), ('SECRET /private/key', 'command failed'), (True, 'command failed'), (HostileInt(1), 'command failed')):
            with self.subTest(code=type(code).__name__):
                output = io.StringIO()
                with contextlib.redirect_stderr(output):
                    broker.maintenance_error(subprocess.CalledProcessError(code, ['/secret/key']))
                self.assertIn(expected, output.getvalue())
                self.assertNotIn('SECRET', output.getvalue())
                self.assertNotIn('/private', output.getvalue())
                self.assertNotIn('/secret', output.getvalue())

    def test_reconcile_and_maintenance_failure_bookkeeping_survives_closed_pipe(self):
        self.clone()
        with closed_stderr_pipe(), patch.object(broker, 'destroy_vm', side_effect=OSError(errno.EIO, 'SECRET')):
            self.assertEqual(self.reconcile()[1]['kind'], 'cleanup-required')
        self.assertEqual((self.root / 'cleanup-required').read_text().strip(), self.job)
        for error, reason in ((ValueError('unsafe owned clone'), 'inventory-invalid'), (OSError(errno.EIO, 'SECRET'), 'inventory-unavailable')):
            with self.subTest(reason=reason):
                for name in ('maintenance-blocked', 'maintenance.json'):
                    (self.root / name).unlink(missing_ok=True)
                with closed_stderr_pipe(), patch.object(broker, 'inventory_obligations', side_effect=error):
                    self.assertEqual(self.maintenance(), 1)
                self.assertEqual((self.root / 'maintenance-reason').read_text().strip(), reason)
                self.assertEqual(json.loads((self.root / 'maintenance.json').read_text())['failures'], 1)

    def test_unsafe_and_unusable_stderr_fall_back_to_null_and_keep_cleaning(self):
        for failure in ('mode', 'hardlink', 'owner', 'fstat', 'truncate', 'seek'):
            with self.subTest(failure=failure):
                path = self.root / ('stderr-' + failure)
                descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
                try:
                    if failure == 'mode':
                        path.chmod(0o644)
                    elif failure == 'hardlink':
                        os.link(path, self.root / 'stderr-link')
                    elif failure == 'truncate':
                        os.ftruncate(descriptor, 524288)
                    with contextlib.ExitStack() as stack:
                        if failure == 'owner':
                            stack.enter_context(patch.object(broker.os, 'getuid', return_value=os.getuid() + 1))
                        if failure in ('fstat', 'truncate', 'seek'):
                            operation = {'fstat': 'fstat', 'truncate': 'ftruncate', 'seek': 'lseek'}[failure]
                            stack.enter_context(patch.object(broker.os, operation, side_effect=OSError(errno.EBADF, 'unusable')))
                        self.assertFalse(broker.prepare_maintenance_stderr(descriptor))
                    self.assertTrue(stat.S_ISCHR(os.fstat(descriptor).st_mode))
                    os.write(descriptor, b'discarded')
                    clone = self.clone()
                    self.marker(stage='workflow')
                    def prepare():
                        return False
                    with patch.dict(os.environ, {}, clear=True), patch.object(broker, 'prepare_maintenance_stderr', side_effect=prepare), patch.object(broker, 'load_config', return_value=self.config), patch.object(broker, 'process_start', return_value=None), patch.object(broker, 'daemon_relock_qualified', return_value=True):
                        (self.root / 'maintenance.json').unlink(missing_ok=True)
                        self.assertEqual(broker.main(['local-maintenance']), 0)
                    self.assertFalse(clone.exists())
                    self.assertEqual((self.root / 'maintenance-reason').read_text().strip(), 'diagnostics-unavailable')
                    self.assertEqual(json.loads((self.root / 'maintenance.json').read_text())['failures'], 0)
                finally:
                    os.close(descriptor)


if __name__ == '__main__':
    unittest.main()
