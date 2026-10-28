"""Hermetic important-usage capacity and shared APFS pool admission contracts."""
import importlib
import math
import ctypes
from unittest.mock import Mock
from types import SimpleNamespace
from mac_build_broker_support import *

capacity = importlib.import_module('partitura_broker.capacity')


class CapacityTests(RegistryFixture, unittest.TestCase):
    def measure(self, important):
        info = SimpleNamespace(f_bavail=30, f_frsize=1, f_blocks=200)
        with patch.object(capacity.os, 'statvfs', return_value=info), patch.object(capacity, 'important_usage_capacity', return_value=important):
            return capacity.volume_capacity(self.root)

    def test_important_usage_includes_reclaimable_capacity_without_adding_it(self):
        self.assertEqual(self.measure(70), dict(statvfsBytes=30, importantUsageBytes=70, availableBytes=70))
        self.assertEqual(self.measure(20)['availableBytes'], 30)
        self.assertEqual(self.measure(0)['availableBytes'], 30)

    def test_nonsense_cf_results_keep_the_old_floor(self):
        for value in (None, True, -1, 201, 2**64, 70.0, math.nan, '70'):
            with self.subTest(value=value):
                self.assertEqual(self.measure(value), dict(statvfsBytes=30, importantUsageBytes=None, availableBytes=30))

    def test_cf_failure_or_unavailable_symbol_falls_back_but_statvfs_error_does_not(self):
        for error in (OSError('CF failed'), AttributeError('missing key'), ValueError('bad conversion')):
            with patch.object(capacity, 'important_usage_capacity', side_effect=error):
                result = capacity.volume_capacity(self.root)
                self.assertIsNone(result['importantUsageBytes'])
                self.assertEqual(result['availableBytes'], result['statvfsBytes'])
        with patch.object(capacity.os, 'statvfs', side_effect=OSError('unreadable volume')):
            with self.assertRaises(OSError):
                capacity.volume_capacity(self.root)

    def test_broker_uses_effective_capacity_and_never_adds_shared_pool_values(self):
        floor = broker.DISK_FLOOR
        info = SimpleNamespace(f_bavail=30*1024**3, f_frsize=1, f_blocks=200*1024**3)
        with patch.object(capacity.os, 'statvfs', return_value=info), patch.object(capacity, 'important_usage_capacity', return_value=60*1024**3):
            values, allowed = broker.disk_space(self.config)
            self.assertTrue(allowed)
            self.assertEqual(values['jobRootFreeBytes'], 60*1024**3)
            with patch.object(capacity, 'important_usage_capacity', return_value=floor-1):
                self.assertFalse(broker.disk_space(self.config)[1])
            with patch.object(capacity, 'important_usage_capacity', return_value=floor):
                self.assertFalse(broker.disk_space(self.config, incoming=1)[1])

    def test_cf_query_uses_integer_resource_and_releases_all_copy_owned_objects(self):
        cf = Mock()
        cf.CFURLCreateFromFileSystemRepresentation.return_value = 12
        cf.CFGetTypeID.return_value = 7
        cf.CFNumberGetTypeID.return_value = 7
        cf.CFNumberIsFloatType.return_value = False
        def copy(url, key, value, error):
            ctypes.cast(value, ctypes.POINTER(ctypes.c_void_p))[0] = 31
            ctypes.cast(error, ctypes.POINTER(ctypes.c_void_p))[0] = 32
            return True
        cf.CFURLCopyResourcePropertyForKey.side_effect = copy
        def number(value, kind, output):
            self.assertEqual(kind, 4)
            ctypes.cast(output, ctypes.POINTER(ctypes.c_int64))[0] = 70
            return True
        cf.CFNumberGetValue.side_effect = number
        with patch.object(capacity.sys, 'platform', 'darwin'), patch.object(capacity.ctypes, 'CDLL', return_value=cf), patch.object(capacity, '_important_key', return_value=ctypes.c_void_p(25)):
            self.assertEqual(capacity.important_usage_capacity(self.root), 70)
            self.assertEqual([getattr(call.args[0], 'value', call.args[0]) for call in cf.CFRelease.call_args_list], [31, 32, 12])
            cf.CFRelease.reset_mock()
            cf.CFURLCopyResourcePropertyForKey.side_effect = lambda *args: False
            self.assertIsNone(capacity.important_usage_capacity(self.root))
            cf.CFRelease.assert_called_once_with(12)

    def test_non_macos_never_loads_core_foundation(self):
        with patch.object(capacity.sys, 'platform', 'linux'), patch.object(capacity.ctypes, 'CDLL', side_effect=AssertionError('no CF on Linux')):
            self.assertIsNone(capacity.important_usage_capacity(self.root))


if __name__ == '__main__':
    unittest.main()
