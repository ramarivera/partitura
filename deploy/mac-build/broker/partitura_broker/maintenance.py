"""Fixed maintenance verbs behind the existing SSH forced-command dispatcher."""
import errno
import os
from pathlib import Path
import signal
import stat
import sys

import partitura_broker as api

MAINTENANCE_PUBLIC = Path('/Library/Partitura/NativeBuild/maintenance-ssh/id_ed25519.pub')
MAINTENANCE_LOG = Path('/Library/Partitura/NativeBuild/maintenance.stderr.log')
MAINTENANCE_VERBS = ('partitura-local-maintenance', 'partitura-maintenance-check')
STORAGE_ACCESS_HINT = 'Verify Remote Login > Allow full disk access for remote users is enabled on this host.'


def maintenance_identity():
    """ExposeAuthInfo is sshd-authored, never a client-supplied key claim."""
    connection = os.environ.get('SSH_CONNECTION', '').split()
    if len(connection) != 4 or connection[0] not in ('127.0.0.1', '::1') or connection[2] not in ('127.0.0.1', '::1'):
        return False
    if not os.path.lexists(MAINTENANCE_PUBLIC):
        if os.path.lexists(MAINTENANCE_PUBLIC.parent):
            raise ValueError('unsupported local invocation')
        return False  # Pre-upgrade installs have no loopback identity.
    name = os.environ.get('SSH_USER_AUTH')
    if not name:
        raise ValueError('unsupported local invocation')
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'r') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4096:
                raise ValueError('unsupported local invocation')
            authenticated = source.read(4097)
        # The root-owned public half binds the generated private identity. A
        # gateway key remains a gateway key even when connecting from loopback.
        key = api.sealed(MAINTENANCE_PUBLIC).read_text().strip()
        return authenticated.splitlines() == ['publickey ' + key]
    except (OSError, ValueError, UnicodeError):
        # Missing/unreadable proof must not turn the maintenance key into a
        # gateway key that can request run/status/artifact.
        raise ValueError('unsupported local invocation') from None


def storage_access_denied(config, error):
    if not isinstance(error, OSError) or error.errno not in (errno.EPERM, errno.EACCES) or not error.filename:
        return False
    home = os.path.abspath(config['tartHome'])
    target = os.path.abspath(error.filename)
    return target == home or target.startswith(home + os.sep)


def record_storage_denial(config):
    api.durable_write(Path(config['root']) / 'maintenance-reason', 'storage-access-denied\n')
    try:
        print('storage-access-denied: ' + STORAGE_ACCESS_HINT, file=sys.stderr, flush=True)
    except (OSError, ValueError):
        pass


def check_maintenance_storage(config):
    try:
        api.private_directory(Path(config['tartHome']))
        # Actually enumerate, not just lstat/access: TCC may deny directory reads.
        with os.scandir(Path(config['tartHome']) / 'vms') as entries:
            next(entries, None)
    except OSError as error:
        if api.storage_access_denied(config, error):
            api.record_storage_denial(config)
        raise


def loopback_maintenance(config, check=False):
    # An SSH disconnect can send HUP/TERM. Finish the bounded, fenced pass rather
    # than interrupt atomic publication or VM cleanup. SIGKILL remains crash-safe
    # through the existing fsync/rename protocol and durable recovery fences.
    api.ignore_shutdown_signals()
    try:
        descriptor = os.open(MAINTENANCE_LOG, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        diagnostics_ready = False
    else:
        try:
            diagnostics_ready = api.prepare_maintenance_stderr(descriptor)
        finally:
            os.close(descriptor)
    api.check_maintenance_storage(config)
    try:
        print('PARTITURA_MAINTENANCE_STORAGE_OK', flush=True)
    except (OSError, ValueError):
        pass  # A dead client cannot cancel a cleanup pass already admitted.
    if check:
        return 0
    result = api.local_maintenance(config)
    if not diagnostics_ready and api.read_state(Path(config['root']) / 'maintenance-reason') is None:
        api.durable_write(Path(config['root']) / 'maintenance-reason', 'diagnostics-unavailable\n')
    return result
