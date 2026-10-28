"""Fixed maintenance verbs behind the existing SSH forced-command dispatcher."""
import errno
import json
import math
import os
from pathlib import Path
import re
import resource
import stat
import sys
import time

import partitura_broker as api

MAINTENANCE_PUBLIC = Path('/Library/Partitura/NativeBuild/maintenance-ssh/id_ed25519.pub')
MAINTENANCE_LOG = Path('/Library/Partitura/NativeBuild/maintenance.stderr.log')
MAINTENANCE_VERBS = ('partitura-local-maintenance', 'partitura-maintenance-check')
STORAGE_ACCESS_HINT = 'Enable Remote Login > Allow full disk access for remote users. This macOS setting cannot be set by a script.'
# Every admitted pass beats, including backoff/busy passes. Allow a 120s cleanup
# plus two 60s launch intervals, well below the 900s work-retry ceiling.
MAINTENANCE_STALE_SECONDS = 240


class StorageProbeError(OSError):
    """Only explicit Tart directory reads can attribute EPERM to TCC."""
    def __init__(self, config, error):
        super().__init__(error.errno, 'storage probe failed', error.filename)
        self.config = config
        self.reason = 'storage-access-denied' if error.errno == errno.EPERM else 'storage-permission-denied' if error.errno == errno.EACCES else 'inventory-unavailable'


def maintenance_identity():
    """ExposeAuthInfo is sshd-authored; accepted env cannot supply SSH_* names."""
    connection = os.environ.get('SSH_CONNECTION', '').split()
    if len(connection) != 4 or connection[0] not in ('127.0.0.1', '::1') or connection[2] not in ('127.0.0.1', '::1'):
        return False
    if not os.path.lexists(MAINTENANCE_PUBLIC):
        if os.path.lexists(MAINTENANCE_PUBLIC.parent):
            raise ValueError('unsupported local invocation')
        return False
    name = os.environ.get('SSH_USER_AUTH', '')
    if not re.fullmatch(r'/tmp/sshauth\.[A-Za-z0-9]{15}', name):
        raise ValueError('unsupported local invocation')
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'r') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4096:
                raise ValueError('unsupported local invocation')
            authenticated = source.read(4097)
        key = api.sealed(MAINTENANCE_PUBLIC).read_text().strip()
        lines = authenticated.splitlines()
        if len(lines) != 1 or not lines[0].startswith('publickey '):
            raise ValueError('unsupported local invocation')
        return lines == ['publickey ' + key]
    except (OSError, ValueError, UnicodeError):
        raise ValueError('unsupported local invocation') from None


def storage_access_denied(config, error):
    return isinstance(error, StorageProbeError) and error.reason == 'storage-access-denied'


def tart_path(config, path):
    home = os.path.abspath(config['tartHome'])
    target = os.path.abspath(path)
    return target == home or target.startswith(home + os.sep)


def record_storage_denial(config):
    # Separate probe evidence cannot overwrite the locked recovery reason.
    api.durable_write(Path(config['root']) / 'maintenance-storage-reason', 'storage-access-denied\n')


def check_maintenance_storage(config):
    """No writes, locks, log truncation or VM/job mutation, even on failure."""
    try:
        for path in (Path(config['tartHome']), Path(config['tartHome']) / 'vms'):
            with os.scandir(path) as entries:
                next(entries, None)
    except OSError as error:
        raise StorageProbeError(config, error) from None


def maintenance_heartbeat(config):
    value = dict(boot=api.boot_id(), admittedAt=time.time())
    api.durable_write(Path(config['root']) / 'maintenance-heartbeat', json.dumps(value) + '\n')


def maintenance_stale(config):
    if not os.path.lexists(MAINTENANCE_PUBLIC.parent):
        return False  # Legacy installations have no loopback job yet.
    try:
        value = api.json_state(Path(config['root']) / 'maintenance-heartbeat')
        return not (value and set(value) == {'boot', 'admittedAt'} and value['boot'] == api.boot_id() and type(value['admittedAt']) in (int, float) and math.isfinite(value['admittedAt']) and 0 <= time.time() - value['admittedAt'] <= MAINTENANCE_STALE_SECONDS)
    except (OSError, ValueError, TypeError):
        return True


def maintenance_stderr():
    """Replace the SSH pipe with the validated inode, or /dev/null on refusal."""
    try:
        descriptor = os.open(MAINTENANCE_LOG, os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        descriptor = os.open(os.devnull, os.O_WRONLY)
        ready = False
    else:
        ready = api.prepare_maintenance_stderr(descriptor)
    try:
        os.dup2(descriptor, 2)
        # sshd does not inherit launchd's client limits. Bound this session's
        # log independently, preserving any stricter inherited soft limit.
        soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
        resource.setrlimit(resource.RLIMIT_FSIZE, (1048576 if soft == resource.RLIM_INFINITY else min(soft, 1048576), hard))
    finally:
        if descriptor != 2:
            os.close(descriptor)
    return ready


def storage_result(error):
    reason = error.reason
    try:
        print('PARTITURA_MAINTENANCE_STORAGE_ERROR=' + reason, flush=True)
    except (OSError, ValueError):
        pass
    try:
        print(reason + (': ' + STORAGE_ACCESS_HINT if reason == 'storage-access-denied' else ''), file=sys.stderr, flush=True)
    except (OSError, ValueError):
        pass


def loopback_maintenance(config, check=False):
    # sshd creates a separate session: launchd's ExitTimeOut bounds the client,
    # NOT this remote process. The 120s cleanup deadline and durable fences cover
    # an orphan, SIGKILL or reboot. A lost pipe cannot interrupt atomic writes.
    api.ignore_shutdown_signals()
    if not check:
        ready = api.maintenance_stderr()
        api.maintenance_heartbeat(config)
    try:
        api.check_maintenance_storage(config)  # Explicit even when nothing is due/lock busy.
    except StorageProbeError as error:
        if not check:
            api.durable_write(Path(config['root']) / 'maintenance-storage-reason', error.reason + '\n')
        api.storage_result(error)
        return 1
    if not check:
        api.durable_remove(Path(config['root']) / 'maintenance-storage-reason')
    try:
        print('PARTITURA_MAINTENANCE_STORAGE_OK', flush=True)
    except (OSError, ValueError):
        pass
    if check:
        return 0
    result = api.local_maintenance(config)
    if not ready and api.read_state(Path(config['root']) / 'maintenance-reason') is None:
        api.durable_write(Path(config['root']) / 'maintenance-reason', 'diagnostics-unavailable\n')
    return result


def health_maintenance_reasons(config, fields):
    reason = api.read_state(Path(config['root']) / 'maintenance-storage-reason')
    reasons = [reason.strip()] if reason and reason.strip() in ('storage-access-denied', 'storage-permission-denied', 'inventory-unavailable') else []
    if api.maintenance_stale(config):
        reasons.append('maintenance-stale')
    for reason in reasons:
        if reason not in fields['reasons']:
            fields['reasons'].append(reason)
        fields.update(status='blocked', accepting=False, capacity=0)
