"""Bounded, private maintenance stderr without credential/path disclosure."""
import os
import stat
import subprocess
import sys

# Broker-authored messages only. Never stringify command argv, filesystem paths,
# arbitrary JSON contents or foreign exception text into the daemon log.
SAFE_MESSAGES = frozenset((
    'VM inventory is too large',
    'VM still exists after deletion',
    'artifact exceeds limit',
    'artifact transfer failed',
    'artifact transfer timed out',
    'bundle exceeds limit',
    'bundle input timed out',
    'cleanup deadline',
    'duplicate state key',
    'guest boot timed out',
    'guest exited before readiness',
    'host VM capacity is unavailable',
    'input exceeds limit',
    'installed Tart digest differs',
    'installed input unavailable',
    'installed path must be absolute',
    'invalid artifact digest',
    'invalid artifact expiry',
    'invalid boot identity',
    'invalid daemon qualification',
    'invalid disk receipt',
    'invalid expired identity marker',
    'invalid guest home',
    'invalid guest user',
    'invalid history GC state',
    'invalid installed configuration',
    'invalid installed digest',
    'invalid installed disk floor',
    'invalid installed identity/profile',
    'invalid job receipt',
    'invalid job secret files',
    'invalid keychain evidence',
    'invalid keychain policy',
    'invalid macOS build',
    'invalid maintenance state',
    'invalid pre-relock state',
    'invalid process birth time',
    'invalid receipt action',
    'invalid receipt attempt',
    'invalid receipt commit',
    'invalid receipt failure code',
    'invalid receipt number',
    'invalid receipt stage',
    'invalid reconciliation set',
    'invalid recovery marker',
    'invalid runner marker',
    'invalid runtime state',
    'invalid safety fence',
    'invalid sealed base name',
    'job secret input exceeds limit',
    'keychain paths differ from the dedicated account',
    'keychain requires the dedicated host account',
    'legacy run disabled by installed profile',
    'maintenance deadline',
    'malformed owned VM name',
    'missing daemon qualification build',
    'missing job receipt',
    'missing or invalid admission epoch',
    'native job already exists',
    'native job was cancelled before submission',
    'no deliverable artifact',
    'oversized clone inventory',
    'oversized installed configuration',
    'oversized job directory',
    'oversized protocol envelope',
    'oversized runtime state',
    'own process birth time unavailable',
    'owned clone remains',
    'previous VM cleanup requires operator reconciliation',
    'previous VM requires crash recovery',
    'previous runner requires crash recovery',
    'process birth time unavailable',
    'relock deadline',
    'truncated bundle',
    'unexpected owned clone object',
    'unqualified host VM inventory',
    'unsafe dedicated account home',
    'unsafe disposable VM directory',
    'unsafe disposable VM file',
    'unsafe disposable VM owner',
    'unsafe installed source',
    'unsafe job artifact',
    'unsafe job directory object',
    'unsafe owned clone',
    'unsafe partial input',
    'unsafe private runtime directory',
    'unsafe retained artifact',
    'unsafe runner lock',
    'unsafe runtime directory',
    'unsafe runtime state',
    'unsupported local invocation',
    'unsupported native build command',
))


def maintenance_error(error, job=None):
    try:
        if isinstance(error, OSError) and type(error.errno) is int:
            message = os.strerror(error.errno)
        elif isinstance(error, subprocess.TimeoutExpired):
            message = 'command timed out'
        elif isinstance(error, subprocess.CalledProcessError):
            message = 'command failed'
            if type(error.returncode) is int:
                message += ' with exit ' + str(error.returncode)
        else:
            message = str(error) if str(error) in SAFE_MESSAGES else 'redacted exception message'
        identity = ' job=' + job if job is not None else ''
        print('maintenance-error' + identity + ' ' + type(error).__name__ + ': ' + message, file=sys.stderr, flush=True)
    except Exception:
        # Includes OSError/BrokenPipeError and ValueError from write or flush.
        # Formatting a foreign exception must not interrupt cleanup either.
        pass


def prepare_maintenance_stderr(descriptor=2):
    """Launchd holds this pre-created private inode; never open a pathname here.

    Reset at half the plist's 1 MiB RLIMIT_FSIZE before each short-lived pass.
    The kernel cap also bounds unexpected stderr output within a single pass.
    Pipes/terminals in hermetic tests and foreground diagnostics stay untouched.
    """
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            return True
        if info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('unsafe maintenance stderr')
        if info.st_size >= 524288:
            os.ftruncate(descriptor, 0)
        os.lseek(descriptor, 0, os.SEEK_END)
        return True
    except (OSError, ValueError):
        # Never write to or truncate an unsafe inode. Losing diagnostics must
        # not disable orphan cleanup; main records the degraded log separately.
        null = os.open(os.devnull, os.O_WRONLY)
        try:
            if null != descriptor:
                os.dup2(null, descriptor)
        finally:
            if null != descriptor:
                os.close(null)
        return False
