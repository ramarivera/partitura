"""Native build broker: state."""
from __future__ import annotations


import fcntl
import contextlib
import json
import math
import os
import pwd
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid


import partitura_broker as api

def durable_write(path, text):
    descriptor, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    pending = Path(name)
    try:
        with os.fdopen(descriptor, 'w') as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        pending.replace(path)
        api.sync_directory(path.parent)
    finally:
        pending.unlink(missing_ok=True)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def durable_remove(path):
    path.unlink(missing_ok=True)
    api.sync_directory(path.parent)


def record(directory, **receipt):
    api.durable_write(directory / 'receipt.json', json.dumps(receipt) + '\n')


def housekeeping_counts(root):
    # Diagnostics are advisory. Corrupt/missing diagnostics never block recovery.
    try:
        value = api.json_state(root / 'housekeeping.json')
        if value is not None and set(value) == {'artifacts', 'history'} and all(type(count) is int and 0 <= count <= 2**63 - 1 for count in value.values()):
            return value
    except (OSError, ValueError):
        pass
    return dict(artifacts=0, history=0)


def record_housekeeping(root, category, skipped):
    counts = api.housekeeping_counts(root)
    counts[category] = skipped
    api.durable_write(root / 'housekeeping.json', json.dumps(counts) + '\n')
    if skipped:
        print(f'housekeeping-{category}-skipped: {skipped}', file=sys.stderr)


def prune_artifacts(root, now=None, protected_jobs=()):
    """Caller holds runner.lock. Keep receipts and reserve space for the next job."""
    cutoff = (time.time() if now is None else now) - api.ARTIFACT_RETENTION_SECONDS
    candidates = []
    skipped = 0
    deadline = time.monotonic() + api.HISTORY_PASS_SECONDS
    for directory in root.iterdir():
        if time.monotonic() >= deadline:
            break  # Retain unvisited entries; disk checks still apply.
        if directory.name in protected_jobs or not re.fullmatch(api.JOB, directory.name) or directory.is_symlink() or not directory.is_dir():
            continue
        try:
            api.private_directory(directory)
            receipt_path = directory / 'receipt.json'
            artifact = directory / 'artifacts.tar'
            if not os.path.lexists(receipt_path) or not os.path.lexists(artifact):
                continue
            receipt = api.json_state(receipt_path)
            if receipt.get('state') not in api.TERMINAL:
                continue
            info = artifact.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                raise ValueError('unsafe retained artifact')
        except ValueError:
            skipped += 1
            continue  # Keep unsafe retained output; it isn't a live obligation.
        candidates.append((info.st_mtime, artifact, info.st_size, receipt))
    retained = 0
    for modified, artifact, size, receipt in sorted(candidates, key=lambda item: item[0], reverse=True):
        if modified < cutoff or not api.delivers_artifact(receipt) or retained + size > api.ARTIFACT_STORAGE_LIMIT - api.MAX_ARTIFACT:
            artifact.unlink()
            receipt['artifactExpired'] = True
            api.record(artifact.parent, **receipt)
        else:
            retained += size
    api.record_housekeeping(root, 'artifacts', skipped)


def environment_for(config):
    return {'HOME': pwd.getpwuid(os.getuid()).pw_dir, 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'TART_HOME': config['tartHome'], 'TART_NO_AUTO_PRUNE': '1'}


def destroy_vm(config, job, deadline=None):
    vm = 'partitura-job-' + job
    environment = api.environment_for(config)
    def remaining():
        # owned() reserves up to twenty seconds to terminate/reap its process
        # group after a timeout. Never borrow those seconds past the pass bound.
        seconds = 45 if deadline is None else min(30, deadline - time.monotonic() - 20)
        if seconds <= 0:
            raise TimeoutError('cleanup deadline')
        return seconds
    stop_error = None
    try:
        budget = remaining()
        # Tart 2.41.1 Stop.swift sends SIGKILL after its graceful timeout,
        # including timeout=0. Leave ten seconds inside owned() for that kill
        # and Tart's exit; owned()'s own group reap has a separate reserve.
        grace = max(0, min(30, int(budget - 10)))
        api.owned([config['tart'], 'stop', vm, '--timeout', str(grace)], environment, budget, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as error:
        # An already stopped VM still needs deletion and its readback.
        stop_error = error
    try:
        api.owned([config['tart'], 'delete', vm], environment, remaining(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        # Tart reports an error for an already absent VM, including a clone
        # that failed before creating it. The filesystem readback is decisive.
        if os.path.lexists(Path(config['tartHome']) / 'vms' / vm):
            if stop_error is not None:
                api.maintenance_error(stop_error, job)
            raise
    if os.path.lexists(Path(config['tartHome']) / 'vms' / vm):
        if stop_error is not None:
            api.maintenance_error(stop_error, job)
        raise ValueError('VM still exists after deletion')


def ignore_shutdown_signals():
    # The first signal enters the cleanup path. Further signals must not
    # interrupt the VM stop/delete and durable receipt writes.
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, signal.SIG_IGN)


def private_directory(path):
    info = path.lstat()
    if path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('unsafe runtime directory')


def read_state(path, limit=api.MAX_STATE):
    """Bounded, nonblocking, no-follow reads of broker-private state."""
    api.private_directory(path.parent)
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, 'rb') as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > limit:
            raise ValueError('unsafe runtime state')
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError('oversized runtime state')
    return data.decode('utf-8')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate state key')
        result[key] = value
    return result


def json_state(path):
    text = api.read_state(path)
    if text is None:
        return None
    value = json.loads(text, object_pairs_hook=api.unique_object)
    if not isinstance(value, dict):
        raise ValueError('invalid runtime state')
    return value


def fence_job(path):
    text = api.read_state(path)
    if text is None:
        return None
    match = re.fullmatch(rf'(?:partitura-job-)?({api.JOB})\n?', text)
    if not match:
        raise ValueError('invalid safety fence')
    return match[1]


def admission_epoch(config):
    path = Path(config['root']) / 'admission-epoch'
    value = api.read_state(path)
    if value is None or not re.fullmatch(api.JOB + '\n', value):
        raise ValueError('missing or invalid admission epoch')
    return value.strip()


def initialize_epoch(config):
    """Local migration only. Hard-link publication never overwrites a rotation."""
    root = Path(config['root'])
    if api.read_state(root / 'admission-epoch') is None:
        descriptor, name = tempfile.mkstemp(prefix='.epoch.', dir=root)
        pending = Path(name)
        try:
            with os.fdopen(descriptor, 'w') as output:
                output.write(uuid.uuid4().hex + '\n')
                output.flush()
                os.fsync(output.fileno())
            try:
                os.link(pending, root / 'admission-epoch', follow_symlinks=False)
            except FileExistsError:
                pass
        finally:
            pending.unlink()
            api.sync_directory(root)
    return api.admission_epoch(config)


def emit(config, kind, **fields):
    envelope = dict(protocolVersion=api.PROTOCOL_VERSION, hostId=config['hostId'], kind=kind, **fields)
    line = json.dumps(envelope, separators=(',', ':'), allow_nan=False) + '\n'
    if len(line.encode()) > api.MAX_STATE:
        raise ValueError('oversized protocol envelope')
    sys.stdout.write(line)


def runner_state(root):
    value = api.json_state(root / 'runner.json')
    if value is None:
        return None
    keys = {'job', 'attempt', 'commit', 'action', 'stage', 'heartbeat'}
    if set(value) not in (keys, keys | {'owner'}) or not re.fullmatch(api.JOB, value.get('job', '')) or not re.fullmatch(api.JOB, value.get('attempt', '')) or not re.fullmatch(api.COMMIT, value.get('commit', '')) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', value.get('action', '')) or value['stage'] not in ('receiving', 'capacity', 'unlock', 'keychain-policy', 'clone', 'boot', 'workflow', 'artifact', 'cleanup') or type(value['heartbeat']) not in (int, float) or not math.isfinite(value['heartbeat']) or value['heartbeat'] <= 0:
        raise ValueError('invalid runner marker')
    return value


def process_start(pid):
    """macOS ps birth time, never kill(pid, 0) or PID-only ownership.

    lstart has second resolution. Reuse within that second looks live and
    therefore blocks cleanup, which is the safe direction of that ambiguity.
    """
    result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, timeout=5, env={'LC_ALL': 'C', 'TZ': 'UTC', 'PATH': '/usr/bin:/bin'})
    if result.returncode == 1 and not result.stdout and not result.stderr:
        return None
    if result.returncode or result.stderr or len(result.stdout) > 128:
        raise ValueError('process birth time unavailable')
    value = ' '.join(result.stdout.decode('ascii').split())
    if not re.fullmatch(r'[A-Z][a-z]{2} [A-Z][a-z]{2} [0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}', value):
        raise ValueError('invalid process birth time')
    return value


def owner_block_reason(runner, boot):
    """Caller holds runner.lock. An ambiguous owner never authorizes cleanup."""
    if runner is None:
        return None  # Inventory decides whether markerless jobs need cleanup.
    owner = runner.get('owner')
    if owner is None:
        return 'runner-owner-missing'
    if not isinstance(owner, dict) or set(owner) != {'pid', 'start', 'boot'} or type(owner['pid']) is not int or not 1 <= owner['pid'] <= 2**31 - 1 or not isinstance(owner['start'], str) or not re.fullmatch(r'[A-Z][a-z]{2} [A-Z][a-z]{2} [0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}', owner['start']) or not isinstance(owner['boot'], str):
        return 'runner-owner-unavailable'
    if owner['boot'] != boot:
        if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', owner['boot']):
            return 'runner-owner-unavailable'
        return None  # No process from a previous boot can still own this job.
    try:
        current = api.process_start(owner['pid'])
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        return 'runner-owner-unavailable'
    if current == owner['start']:
        return 'runner-owner-alive'
    return None  # Absent PID or different birth time proves the old owner died.


def obligations(config):
    root = Path(config['root'])
    jobs = {job for name in api.FENCES if (job := api.fence_job(root / name)) is not None}
    runner = api.runner_state(root)
    if runner:
        jobs.add(runner['job'])
    recovery = api.json_state(root / 'recovery.json')
    if recovery is not None:
        if set(recovery) != {'jobs', 'relock'} or type(recovery['relock']) is not bool or not isinstance(recovery['jobs'], list) or not 1 <= len(recovery['jobs']) <= 64 or any(not isinstance(job, str) or not re.fullmatch(api.JOB, job) for job in recovery['jobs']):
            raise ValueError('invalid recovery marker')
        jobs.update(recovery['jobs'])
    return jobs, runner


@contextlib.contextmanager
def run_lock(config, seconds):
    path = Path(config['root']) / 'runner.lock'
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(descriptor, 'r+') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o022:
            raise ValueError('unsafe runner lock')
        deadline = time.monotonic() + seconds
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    yield False
                    return
                time.sleep(min(0.05, remaining))
        yield True


def disk_space(config, incoming=0):
    floor = config.get('minimumFreeBytes', api.DISK_FLOOR)
    roots = [Path(config[key]) for key in ('root', 'tartHome')]
    free = []
    for path in roots:
        info = os.statvfs(path)
        free.append(info.f_bavail * info.f_frsize)
    # APFS sibling volumes may share a pool. Never add their reported free bytes.
    if roots[0].stat().st_dev == roots[1].stat().st_dev:
        sufficient = min(free) >= floor + incoming
    else:
        sufficient = free[0] >= floor + incoming and free[1] >= floor
    return dict(jobRootFreeBytes=free[0], tartRootFreeBytes=free[1], hostFloorBytes=floor), sufficient


def require_disk(config, incoming=0):
    try:
        if not api.disk_space(config, incoming)[1]:
            raise OSError('insufficient disk')
    except OSError:
        raise api.DiskUnavailable() from None


class DiskUnavailable(Exception):
    pass


def registry_status(config, job):
    root = Path(config['root'])
    directory = root / job
    if not os.path.lexists(directory):
        return 'unknown-job', dict(job=job, tombstonePresent=api.read_state(root / (job + '.cancel')) is not None, inconsistentDirectory=False)
    api.private_directory(directory)
    receipt = api.json_state(directory / 'receipt.json')
    if receipt is None:
        return 'unknown-job', dict(job=job, tombstonePresent=api.read_state(root / (job + '.cancel')) is not None, inconsistentDirectory=True)
    if receipt.get('job') != job or receipt.get('state') not in ('receiving', 'running', *api.TERMINAL):
        raise ValueError('invalid job receipt')
    # Old receipt causes/host diagnostics and arbitrary future fields stay private.
    fields = {key: value for key, value in api.diagnostic_receipt(directory, receipt).items() if key in (
        'job', 'commit', 'action', 'attempt', 'state', 'stage', 'failureCode', 'artifactExpired', 'artifactBytes', 'artifactSha256', 'bootExitCode', 'workflowExitCode', 'keychainPolicy', 'preRelockState',
    )}
    if 'commit' in fields and not re.fullmatch(api.COMMIT, fields['commit']):
        raise ValueError('invalid receipt commit')
    if 'action' in fields and not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', fields['action']):
        raise ValueError('invalid receipt action')
    if 'attempt' in fields and not re.fullmatch(api.JOB, fields['attempt']):
        raise ValueError('invalid receipt attempt')
    if fields.get('stage') not in (None, 'receiving', 'disk-preflight', 'disk-post-transfer', 'capacity', 'unlock', 'keychain-policy', 'clone', 'boot', 'workflow', 'artifact', 'cleanup'):
        raise ValueError('invalid receipt stage')
    if fields.get('failureCode') not in (None, 'host-disk-space-unavailable', 'host-capacity-unavailable', 'unlock-failed', 'keychain-policy-unavailable', 'host-key-unavailable', 'workflow-failed', 'cleanup-required', 'receive-interrupted', 'execution-interrupted'):
        raise ValueError('invalid receipt failure code')
    if 'keychainPolicy' in fields:
        evidence = fields['keychainPolicy']
        if not isinstance(evidence, dict) or set(evidence) != {'before', 'requested', 'actual'}:
            raise ValueError('invalid keychain evidence')
        for value in evidence.values():
            api.validate_keychain_policy(value)
    if fields.get('preRelockState') not in (None, 'locked', 'unlocked'):
        raise ValueError('invalid pre-relock state')
    for name in ('artifactBytes', 'bootExitCode', 'workflowExitCode'):
        if name in fields and (type(fields[name]) is not int or not ((0 if name == 'artifactBytes' else -255) <= fields[name] <= (api.MAX_ARTIFACT if name == 'artifactBytes' else 255))):
            raise ValueError('invalid receipt number')
    if 'artifactSha256' in fields and not re.fullmatch('[a-f0-9]{64}', fields['artifactSha256']):
        raise ValueError('invalid artifact digest')
    if 'artifactExpired' in fields and type(fields['artifactExpired']) is not bool:
        raise ValueError('invalid artifact expiry')
    if fields.get('failureCode') == 'host-disk-space-unavailable' and (fields['state'] != 'failed' or fields.get('stage') not in ('disk-preflight', 'disk-post-transfer')):
        raise ValueError('invalid disk receipt')
    if fields.get('stage') in ('disk-preflight', 'disk-post-transfer') and fields.get('failureCode') != 'host-disk-space-unavailable':
        raise ValueError('invalid disk receipt')
    return 'known', fields


def health(config):
    root = Path(config['root'])
    fields = dict(brokerRevision=api.BROKER_REVISION, capabilities=['health', 'status', 'reconcile', 'run-v2'], profile=config['profile'], epoch=api.initialize_epoch(config), status='blocked', accepting=False, capacity=0, reasons=[], jobRootFreeBytes=None, tartRootFreeBytes=None, hostFloorBytes=config.get('minimumFreeBytes', api.DISK_FLOOR))
    fields['housekeepingSkippedEntries'] = api.housekeeping_counts(root)
    fields['keychainPolicy'] = dict(requested=config.get('keychainPolicy'), lastReadback=api.policy_evidence(root))
    jobs, runner = api.obligations(config)
    fresh = runner is not None and 0 <= time.time() - runner['heartbeat'] <= 60
    # Only a matching active-vm/unlock fence is normal for a current live runner.
    unsafe = any(api.fence_job(root / name) is not None for name in ('cleanup-required', 'keychain-relock-pending'))
    unrelated = bool(jobs - ({runner['job']} if runner else set()))
    if api.read_state(root / 'maintenance-blocked') is not None or api.json_state(root / 'recovery.json') is not None or unsafe or unrelated or (jobs and not fresh):
        if api.read_state(root / 'maintenance-blocked') is not None:
            reason = 'maintenance-blocked'
        elif api.fence_job(root / 'cleanup-required') is not None:
            reason = 'cleanup-required'
        elif api.fence_job(root / 'keychain-relock-pending') is not None:
            reason = 'keychain-relock-pending'
        elif runner is not None and not fresh:
            reason = 'runner-stale'
        else:
            reason = 'recovery-incomplete'
        fields['reasons'] = [reason]
        if jobs:
            fields['maintenanceJobId'] = sorted(jobs)[0]
    elif fresh:
        fields.update(status='busy', reasons=['runner-active'], runner={key: runner[key] for key in ('job', 'attempt', 'stage', 'heartbeat')})
    else:
        try:
            _, inventory = api.maintenance_state(root, api.boot_id())
            if inventory or api.read_state(root / 'inventory-required') is not None:
                fields['reasons'] = ['inventory-pending']
                reason = api.read_state(root / 'maintenance-reason')
                if reason is not None and reason.strip() in api.MAINTENANCE_REASONS:
                    fields['reasons'] = [reason.strip()]
                api.emit(config, 'health', **fields)
                return 0
            api.private_directory(root)
            api.private_directory(Path(config['tartHome']))
            base = Path(config['tartHome']) / 'vms' / config['base']
            if base.is_symlink() or not base.is_dir() or not os.access(root, os.W_OK):
                raise ValueError('installed input unavailable')
            values, sufficient = api.disk_space(config)
            fields.update(values)
            if not sufficient:
                fields['reasons'] = ['host-disk-space-unavailable']
            else:
                api.verify_vm_capacity()
                fields.update(status='ready', accepting=True, capacity=1)
        except OSError:
            fields['reasons'] = ['host-disk-space-unavailable']
        except (ValueError, subprocess.SubprocessError):
            fields['reasons'] = ['host-capacity-unavailable']
    reason = api.read_state(root / 'maintenance-reason')
    if reason is not None and reason.strip() in api.MAINTENANCE_REASONS and reason.strip() not in fields['reasons']:
        fields['reasons'].append(reason.strip())
        fields.update(status='blocked', accepting=False, capacity=0)
    if config['profile'] != 'registry-only':
        fields.update(status='blocked', accepting=False, capacity=0, reasons=[*fields['reasons'], 'legacy-profile'])
    api.emit(config, 'health', **fields)
    return 0
