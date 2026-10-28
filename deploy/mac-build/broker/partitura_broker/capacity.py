"""Per-volume capacity for requested builds, including macOS reclaimable space.

No reservation or purge is performed. Unsupported/invalid CF queries retain the
statvfs floor. APFS volume values must never be added together.
"""
import ctypes
import json
import os
import sys


def _important_key(cf):
    return ctypes.c_void_p.in_dll(cf, 'kCFURLVolumeAvailableCapacityForImportantUsageKey')


def important_usage_capacity(path):
    if sys.platform != 'darwin':
        return None
    cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    pointer = ctypes.c_void_p
    cf.CFURLCreateFromFileSystemRepresentation.argtypes = [pointer, ctypes.c_char_p, ctypes.c_long, ctypes.c_ubyte]
    cf.CFURLCreateFromFileSystemRepresentation.restype = pointer
    cf.CFURLCopyResourcePropertyForKey.argtypes = [pointer, pointer, ctypes.POINTER(pointer), ctypes.POINTER(pointer)]
    cf.CFURLCopyResourcePropertyForKey.restype = ctypes.c_ubyte
    cf.CFGetTypeID.argtypes = [pointer]
    cf.CFGetTypeID.restype = ctypes.c_ulong
    cf.CFNumberGetTypeID.restype = ctypes.c_ulong
    cf.CFNumberIsFloatType.argtypes = [pointer]
    cf.CFNumberIsFloatType.restype = ctypes.c_ubyte
    cf.CFNumberGetValue.argtypes = [pointer, ctypes.c_int, pointer]
    cf.CFNumberGetValue.restype = ctypes.c_ubyte
    cf.CFRelease.argtypes = [pointer]
    cf.CFRelease.restype = None
    key = _important_key(cf)
    encoded = os.fsencode(os.path.abspath(path))
    url = cf.CFURLCreateFromFileSystemRepresentation(None, encoded, len(encoded), True)
    if not url:
        return None
    value, error = pointer(), pointer()
    try:
        if not cf.CFURLCopyResourcePropertyForKey(url, key, ctypes.byref(value), ctypes.byref(error)) or not value:
            return None
        if cf.CFGetTypeID(value) != cf.CFNumberGetTypeID() or cf.CFNumberIsFloatType(value):
            return None
        result = ctypes.c_int64()
        # kCFNumberSInt64Type = 4. Reject failed/overflowing conversions.
        if not cf.CFNumberGetValue(value, 4, ctypes.byref(result)):
            return None
        return result.value
    finally:
        for item in (value, error, url):
            if item:
                cf.CFRelease(item)


def volume_capacity(path):
    info = os.statvfs(path)  # Required baseline: errors still fail closed.
    baseline = info.f_bavail * info.f_frsize
    try:
        important = important_usage_capacity(path)
    except (OSError, AttributeError, ValueError, TypeError, OverflowError):
        important = None
    if type(important) is not int or not 0 <= important <= min(info.f_blocks * info.f_frsize, 2**63 - 1):
        important = None
    return dict(statvfsBytes=baseline, importantUsageBytes=important,
                availableBytes=max(baseline, important or 0))


def main():
    floor = int(sys.argv[1])
    values = [volume_capacity(path) for path in sys.argv[2:]]
    if not values or floor < 0:
        raise ValueError('invalid capacity check')
    print('runtime capacity: ' + json.dumps(values, separators=(',', ':')))
    # Each actual root must satisfy the floor, including siblings in one pool.
    return 0 if min(value['availableBytes'] for value in values) >= floor else 1


if __name__ == '__main__':
    sys.exit(main())
