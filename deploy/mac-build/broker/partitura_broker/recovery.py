"""Native build broker: recovery."""
from __future__ import annotations


import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid


import partitura_broker as api

def tombstone(config, job):
    api.durable_write(Path(config['root']) / (job + '.cancel'), job + '\n')


def verify_owned_clone(config, job):
    directory = Path(config['tartHome']) / 'vms' / ('partitura-job-' + job)
    if not os.path.lexists(directory):
        return False
    api.private_directory(directory.parent)
    api.private_directory(directory)
    for index, child in enumerate(directory.iterdir()):
        if index >= 64:
            raise ValueError('oversized clone inventory')
        info = child.lstat()
        # Pinned Tart 2.41.1 Sources/tart/VMDirectory.swift. Stacked images are
        # not qualified bases, but their local metadata remains owned debris.
        if child.name not in ('config.json', 'disk.img', 'nvram.bin', 'state.vzvmsave', 'manifest.json', 'overlay.asif', '.explicitly-pulled', 'control.sock') or info.st_uid != os.getuid() or stat.S_ISLNK(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink != 1):
            raise ValueError('unsafe owned clone')
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISSOCK(info.st_mode)):
            raise ValueError('unexpected owned clone object')
    return True


def macos_build():
    result = subprocess.run(['/usr/bin/sw_vers', '-buildVersion'], check=True, capture_output=True, timeout=5)
    value = result.stdout.decode('ascii').strip()
    if not re.fullmatch(r'[A-Za-z0-9]{1,32}', value):
        raise ValueError('invalid macOS build')
    return value


def daemon_relock_qualified(config):
    if not config.get('daemonRelockQualified', False):
        return False
    try:
        return config['daemonRelockMacOSBuild'] == api.macos_build()
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def keychain_relock_entry(config):
    keychain = api.LoginKeychain(config)
    try:
        keychain.lock()
        if keychain.state() != 'locked':
            raise api.KeychainError('relock-state')
    finally:
        keychain.close()
    return 0


def relock_keychain(config, deadline):
    """Exec a sealed helper with no SSH stdio or inherited run-lock descriptor."""
    seconds = deadline - time.monotonic() - 20
    if seconds <= 0:
        raise TimeoutError('relock deadline')
    script = api.sealed(Path(api.BROKER_FILE).resolve())
    api.owned([sys.executable, '-I', str(script), 'local-relock'], api.environment_for(config), seconds,
          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)


def remove_partial_input(directory):
    path = directory / 'source.bundle'
    if os.path.lexists(path):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError('unsafe partial input')
        api.durable_remove(path)


def inspect_job_directory(directory):
    """An absent receipt doesn't make other private state trustworthy or safe."""
    if not os.path.lexists(directory):
        return [], False
    api.private_directory(directory)
    limits = {'receipt.json': api.MAX_STATE, 'keychain.json': api.MAX_STATE, 'source.bundle': api.MAX_BUNDLE, 'artifacts.tar': api.MAX_ARTIFACT, 'boot.log': api.MAX_BOOT_LOG, 'runner.log': api.MAX_BOOT_LOG, 'build.log': api.MAX_WORKFLOW_LOG}
    files = []
    relock = False
    for index, path in enumerate(directory.iterdir()):
        if index >= 64:
            raise ValueError('oversized job directory')
        name = path.name
        # Interrupted atomic receipt/keychain publication can leave a private
        # temporary inode. It is never an execution receipt or a success proof.
        if name in ('receipt.json.new', 'keychain.json.new') or re.fullmatch(r'\.(?:receipt|keychain)\.json\.[a-z0-9_]{8}', name):
            limit = api.MAX_STATE
        else:
            limit = limits.get(name)
        info = path.lstat()
        if limit is None or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > limit:
            raise ValueError('unsafe job directory object')
        files.append(path)
        if name not in ('source.bundle', 'receipt.json', 'receipt.json.new') and not name.startswith('.receipt.json.'):
            relock = True
    return files, relock


def job_execution_evidence(config, job, kind, receipt):
    """Shared daemon/reconcile predicate; validate even terminal job debris."""
    _, unlock = api.inspect_job_directory(Path(config['root']) / job)
    clone = api.verify_owned_clone(config, job)
    return unlock or (kind == 'known' and receipt['state'] == 'running') or clone


def reconcile_locked(config, requested, daemon=False, deadline=None, allow_blocked=False, clear_blocked=True):
    """The caller owns runner.lock. No PID or marker timestamp grants authority."""
    root = Path(config['root'])
    deadline = time.monotonic() + 120 if deadline is None else deadline
    jobs, runner = api.obligations(config)
    jobs |= set(requested)
    if not jobs or len(jobs) > 64:
        raise ValueError('invalid reconciliation set')
    blocked = api.read_state(root / 'maintenance-blocked')
    if blocked is not None and (not allow_blocked or blocked.startswith('installation-incomplete')):
        return 'cleanup-required', sorted(jobs)
    previous_recovery = api.json_state(root / 'recovery.json')
    previous_cleanup = api.fence_job(root / 'cleanup-required')
    api.durable_write(root / 'recovery.json', json.dumps(dict(jobs=sorted(jobs), relock=True if previous_recovery is None else previous_recovery['relock'])) + '\n')
    # Publish a fence even for an unknown/inconsistent directory before touching it.
    api.durable_write(root / 'cleanup-required', sorted(jobs)[0] + '\n')
    try:
        # Execution evidence must stay in sync with resource_jobs() below.
        # Validate all evidence first. Do not partly clean an untrusted state set.
        states = {}
        unlock = api.fence_job(root / 'unlock-attempt')
        active = api.fence_job(root / 'active-vm')
        pending = api.fence_job(root / 'keychain-relock-pending')
        relock = any((unlock, active, pending, previous_cleanup)) or bool(previous_recovery and previous_recovery['relock']) or bool(runner and runner['stage'] not in ('receiving', 'capacity'))
        for job in sorted(jobs):
            kind, receipt = api.registry_status(config, job)
            states[job] = kind, receipt
            relock |= job_execution_evidence(config, job, kind, receipt)
        api.durable_write(root / 'recovery.json', json.dumps(dict(jobs=sorted(jobs), relock=relock)) + '\n')
        for job in sorted(jobs):
            if time.monotonic() >= deadline:
                raise TimeoutError('maintenance deadline')
            directory = root / job
            if directory.exists():
                api.remove_partial_input(directory)
                kind, receipt = states[job]
                if kind == 'known' and receipt['state'] not in api.TERMINAL:
                    receiving = receipt['state'] == 'receiving' and not relock
                    receipt.update(state='failed', stage='receiving' if receiving else 'cleanup', failureCode='receive-interrupted' if receiving else 'execution-interrupted')
                    api.record(directory, **receipt)
            if api.verify_owned_clone(config, job):
                api.destroy_vm(config, job, deadline=deadline)
            if os.path.lexists(Path(config['tartHome']) / 'vms' / ('partitura-job-' + job)):
                raise ValueError('owned clone remains')
        if relock:
            if daemon and not api.daemon_relock_qualified(config):
                api.durable_write(root / 'keychain-relock-pending', (unlock or active or pending or sorted(jobs)[0]) + '\n')
                if previous_cleanup is None:
                    api.durable_remove(root / 'cleanup-required')
                return 'keychain-relock-pending', sorted(jobs)
            api.relock_keychain(config, deadline)
        for job in sorted(jobs):
            directory = root / job
            if states[job][0] == 'unknown-job' and directory.exists():
                files, _ = api.inspect_job_directory(directory)
                for path in files:
                    api.durable_remove(path)
                directory.rmdir()
                api.sync_directory(root)
        # Rotation precedes every safety-fence removal. Failed writes keep the gate.
        api.durable_write(root / 'admission-epoch', uuid.uuid4().hex + '\n')
        for name in (*api.FENCES, 'runner.json', 'recovery.json'):
            api.durable_remove(root / name)
        api.durable_remove(root / 'maintenance-reason')
        if allow_blocked and clear_blocked:
            api.durable_remove(root / 'maintenance-blocked')
        return 'reconciled', sorted(jobs)
    except Exception as error:
        api.maintenance_error(error, sorted(jobs)[0])
        api.durable_write(root / 'cleanup-required', sorted(jobs)[0] + '\n')
        return 'cleanup-required', sorted(jobs)


def reconcile(config, job):
    api.tombstone(config, job)
    with api.run_lock(config, 2) as acquired:
        if not acquired:
            runner = api.runner_state(Path(config['root']))
            evidence = {key: runner[key] for key in ('job', 'attempt', 'stage', 'heartbeat')} if runner else None
            api.emit(config, 'busy', job=job, runner=evidence)
            return 0
        root = Path(config['root'])
        if (api.read_state(root / 'maintenance-blocked') or '').startswith('installation-incomplete'):
            api.emit(config, 'cleanup-required', job=job)
            return 1
        api.durable_remove(root / 'maintenance-reason')
        api.initialize_epoch(config)
        jobs = {job}
        try:
            boot = api.boot_id()
            _, inventory = api.maintenance_state(root, boot)
            blocked = api.read_state(root / 'maintenance-blocked') is not None
            existing, _ = api.obligations(config)
            if len(existing) > 6 and (inventory or api.read_state(root / 'inventory-required') is not None):
                # Finish an earlier bounded batch before discovering more jobs.
                # Keep inventory/administrator fences until a full scan passes.
                result, _ = api.reconcile_locked(config, existing, allow_blocked=blocked, clear_blocked=False)
                api.record_maintenance(root, boot, inventory_complete=False)
                api.emit(config, 'cleanup-required', job=job)
                return 1
            if inventory or blocked or api.read_state(root / 'inventory-required') is not None:
                jobs |= api.inventory_obligations(config)
            result, jobs = api.reconcile_locked(config, jobs, allow_blocked=blocked)
            if result == 'reconciled':
                api.record_maintenance(root, boot)
                api.durable_remove(root / 'inventory-required')
        except api.InventoryPending as pending:
            api.durable_write(root / 'inventory-required', 'inventory-pending\n')
            # A batch may make progress but cannot claim whole-host cleanup.
            if pending.jobs:
                api.reconcile_locked(config, pending.jobs, allow_blocked=blocked, clear_blocked=False)
            result = 'cleanup-required'
        except (OSError, ValueError, subprocess.SubprocessError):
            result = 'cleanup-required'
        if result == 'reconciled':
            kind, _ = api.registry_status(config, job)
            api.emit(config, 'reconciled-terminal' if kind == 'known' else 'reconciled-unknown', job=job, epoch=api.admission_epoch(config), nonce=uuid.uuid4().hex, reconciledJobs=jobs)
            return 0
        api.emit(config, result, job=job)
        return 1


class InventoryPending(Exception):
    def __init__(self, jobs):
        self.jobs = set(jobs)


def inventory_obligations(config):
    jobs = set()
    root = Path(config['root'])
    deadline = time.monotonic() + api.HISTORY_PASS_SECONDS
    def budget():
        if len(jobs) >= 58 or time.monotonic() >= deadline:
            raise api.InventoryPending(jobs)
    for directory in root.iterdir():
        budget()
        if re.fullmatch(api.JOB, directory.name):
            kind, receipt = api.registry_status(config, directory.name)
            if kind != 'known' or receipt['state'] not in api.TERMINAL or os.path.lexists(directory / 'source.bundle'):
                jobs.add(directory.name)
    vms = Path(config['tartHome']) / 'vms'
    api.private_directory(vms)
    for directory in vms.iterdir():
        budget()
        if directory.name.startswith('partitura-job-'):
            match = re.fullmatch('partitura-job-(' + api.JOB + ')', directory.name)
            if not match:
                raise ValueError('malformed owned VM name')
            api.verify_owned_clone(config, match[1])
            jobs.add(match[1])
    return jobs


def boot_id():
    result = subprocess.run(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], check=True, capture_output=True, timeout=5)
    value = result.stdout.decode('ascii').strip().lower()
    if len(result.stdout) > 64 or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value):
        raise ValueError('invalid boot identity')
    return value


def maintenance_state(root, boot):
    previous = api.json_state(root / 'maintenance.json')
    if previous is not None and (set(previous) not in ({'boot', 'revision', 'failures', 'nextAt'}, {'boot', 'revision', 'failures', 'nextAt', 'inventoryComplete'}) or not isinstance(previous['boot'], str) or not isinstance(previous['revision'], str) or type(previous['failures']) is not int or not 0 <= previous['failures'] <= 16 or type(previous['nextAt']) not in (int, float) or not math.isfinite(previous['nextAt']) or previous['nextAt'] < 0 or type(previous.get('inventoryComplete', True)) is not bool):
        raise ValueError('invalid maintenance state')
    if previous and previous['nextAt'] > time.time() + 900:
        previous['nextAt'] = 0  # A backwards clock step makes maintenance due.
    if previous and (previous['boot'] != boot or previous['revision'] != api.BROKER_REVISION):
        previous = dict(previous, nextAt=0, failures=0)
    inventory = previous is None or previous['boot'] != boot or previous['revision'] != api.BROKER_REVISION or not previous.get('inventoryComplete', previous['failures'] == 0)
    return previous, inventory


def record_maintenance(root, boot, failures=0, inventory_complete=True):
    api.durable_write(root / 'maintenance.json', json.dumps(dict(boot=boot, revision=api.BROKER_REVISION, failures=failures, nextAt=time.time() + min(900, 60 * 2**max(0, failures - 1)) if failures else 0, inventoryComplete=inventory_complete)) + '\n')
    if not failures and inventory_complete:
        api.durable_remove(root / 'maintenance-reason')


def history_gc_due(root):
    value = api.json_state(root / 'history-gc.json')
    if value is None:
        return True
    if set(value) != {'nextAt'} or type(value['nextAt']) not in (int, float) or not math.isfinite(value['nextAt']):
        raise ValueError('invalid history GC state')
    now = time.time()
    return value['nextAt'] <= now or value['nextAt'] > now + 86400


def prune_history(config, protected_jobs=()):
    """Bounded registry history GC. Expiry fences delayed submission commands.

    Legacy commands have no epoch or expiry: their anti-replay receipts and
    tombstones remain until the approved registry-only cutover.
    """
    root = Path(config['root'])
    expired = []
    skipped = 0
    if config.get('profile') == 'registry-only':
        protected, _ = api.obligations(config)
        protected |= set(protected_jobs)
        cutoff = time.time() - api.HISTORY_RETENTION_SECONDS
        deadline = time.monotonic() + api.HISTORY_PASS_SECONDS
        for path in root.iterdir():
            if len(expired) >= 64 or time.monotonic() >= deadline:
                break
            name = path.name
            try:
                if re.fullmatch(api.JOB, name):
                    if name in protected or os.path.lexists(Path(config['tartHome']) / 'vms' / ('partitura-job-' + name)):
                        continue
                    api.private_directory(path)
                    receipt = path / 'receipt.json'
                    if not os.path.lexists(receipt) or receipt.lstat().st_mtime >= cutoff or os.path.lexists(path / 'artifacts.tar') or os.path.lexists(path / 'source.bundle'):
                        continue
                    kind, value = api.registry_status(config, name)
                    if kind == 'known' and value['state'] in api.TERMINAL:
                        files, _ = api.inspect_job_directory(path)
                        expired.append((path, files))
                elif re.fullmatch(rf'(?:{api.JOB}\.cancel|attempt-{api.JOB})', name):
                    text = api.read_state(path)
                    if path.lstat().st_mtime >= cutoff:
                        continue
                    job = name[:32] if name.endswith('.cancel') else text.strip()
                    if not re.fullmatch(api.JOB, job):
                        raise ValueError('invalid expired identity marker')
                    if job not in protected:
                        expired.append((path, None))
            except ValueError:
                skipped += 1
                continue  # Preserve invalid history for host-admin inspection.
        if expired:
            for path, files in expired:
                if files is None:
                    api.durable_remove(path)
                else:
                    for child in files:
                        api.durable_remove(child)
                    path.rmdir()
                    api.sync_directory(root)
    api.record_housekeeping(root, 'history', skipped)
    api.durable_write(root / 'history-gc.json', json.dumps(dict(nextAt=time.time() + (60 if len(expired) == 64 else 86400))) + '\n')


def resource_jobs(config, jobs, runner):
    """Under runner.lock, distinguish inert input debris from execution resources."""
    root = Path(config['root'])
    # Keep execution evidence in sync with reconcile_locked(): fences, recovery
    # relock, post-capacity runner stages, private unlock state, running receipt
    # and owned clones. The daemon also protects relock=False recovery jobs.
    live = {job for name in api.FENCES if (job := api.fence_job(root / name))}
    recovery = api.json_state(root / 'recovery.json')
    if recovery:
        live.update(recovery['jobs'])  # obligations() already validated this record.
    if runner and runner['stage'] not in ('receiving', 'capacity'):
        live.add(runner['job'])
    for job in jobs:
        kind, receipt = api.registry_status(config, job)
        if job_execution_evidence(config, job, kind, receipt):
            live.add(job)
    return live


def local_maintenance(config):
    deadline = time.monotonic() + 120
    root = Path(config['root'])
    api.initialize_epoch(config)
    boot = api.boot_id()
    previous, inventory = api.maintenance_state(root, boot)
    blocked = api.read_state(root / 'maintenance-blocked') is not None
    if blocked:
        return 0  # Reported by health; repeating an operator block isn't a crash.
    jobs, _ = api.obligations(config)
    inventory |= api.read_state(root / 'inventory-required') is not None
    if previous and time.time() < previous['nextAt']:
        return 0  # A scheduled backoff wait completed normally.
    gc_due = api.history_gc_due(root)
    if not inventory and not jobs and not gc_due:
        if api.read_state(root / 'maintenance-reason') is None:
            return 0
    with api.run_lock(config, 0) as acquired:
        if not acquired:
            return 0  # A live owner is responsible for its own obligations.
        # SSH reconciliation may have completed while we were acquiring the lock.
        previous, inventory = api.maintenance_state(root, boot)
        inventory |= api.read_state(root / 'inventory-required') is not None
        if api.read_state(root / 'maintenance-blocked') is not None:
            return 0
        if api.fence_job(root / 'keychain-relock-pending') and not api.daemon_relock_qualified(config):
            api.durable_write(root / 'maintenance-reason', 'keychain-relock-pending\n')
            return 0  # Only SSH or a newly qualified daemon can finish this step.
        jobs, runner = api.obligations(config)
        complete = not inventory
        reason = None
        try:
            if inventory and len(jobs) <= 6:
                api.durable_write(root / 'inventory-required', 'inventory-pending\n')
                try:
                    jobs |= api.inventory_obligations(config)
                    complete = True
                except api.InventoryPending as pending:
                    jobs |= pending.jobs
            # Only execution resources need owner proof. A receipt-less empty
            # directory or partial input cannot be in use with runner.lock free.
            live = resource_jobs(config, jobs, runner)
            if live and runner is not None and live - {runner['job']}:
                reason = 'runner-owner-ambiguous'
            elif live and runner is None:
                reason = 'runner-owner-missing'
            elif live:
                reason = api.owner_block_reason(runner, boot)
            if reason:
                api.durable_write(root / 'inventory-required', 'inventory-pending\n')
                api.durable_write(root / 'maintenance-reason', reason + '\n')
                failures = min(16, (previous or {}).get('failures', 0) + 1)
                api.record_maintenance(root, boot, failures, inventory_complete=False)
                # Retention can proceed for unrelated terminal history. Protect
                # every discovered job. An incomplete scan cannot establish the
                # full protected set, so leave retention for a completed scan.
                if complete and gc_due and deadline - time.monotonic() >= api.HISTORY_PASS_SECONDS * 2:
                    try:
                        api.prune_artifacts(root, protected_jobs=jobs)
                        api.prune_history(config, protected_jobs=jobs)
                    except (OSError, ValueError):
                        print('housekeeping-pass-failed', file=sys.stderr)
                return 0
            result, _ = api.reconcile_locked(config, jobs, daemon=True, deadline=deadline) if jobs else ('idle', [])
            if complete:
                api.durable_remove(root / 'inventory-required')
            else:
                result = 'cleanup-required'
                reason = 'inventory-incomplete'
        except ValueError as error:
            api.maintenance_error(error)
            api.durable_write(root / 'maintenance-blocked', 'inventory-invalid\n')
            result = 'cleanup-required'
            reason = 'inventory-invalid'
            complete = False
        except (OSError, subprocess.SubprocessError) as error:
            api.maintenance_error(error)
            # IO failures are retryable. No operator-only flag is manufactured.
            result = 'cleanup-required'
            reason = 'storage-permission-denied' if isinstance(error, OSError) and error.errno in (1, 13) else 'inventory-unavailable'
            complete = False
        if reason is None and result in ('cleanup-required', 'keychain-relock-pending'):
            reason = result
        if reason:
            api.durable_write(root / 'maintenance-reason', reason + '\n')
        else:
            api.durable_remove(root / 'maintenance-reason')
        # Housekeeping cannot create an operator-required inventory flag. A
        # failed pass retries with backoff while the completed inventory stays
        # valid; unsafe individual entries are retained and counted by pruning.
        if complete and result in ('idle', 'reconciled') and gc_due and deadline - time.monotonic() >= api.HISTORY_PASS_SECONDS * 2:
            try:
                api.prune_artifacts(root)
                api.prune_history(config)
            except (OSError, ValueError):
                print('housekeeping-pass-failed', file=sys.stderr)
                result = 'host-maintenance'
        failures = min(16, (previous or {}).get('failures', 0) + 1) if result in ('cleanup-required', 'keychain-relock-pending', 'host-maintenance') else 0
        api.record_maintenance(root, boot, failures, inventory_complete=complete)
        return 1 if failures and result != 'keychain-relock-pending' else 0


def refuse(config, request, code, persist=True):
    _, job, commit, _, action, *_ = request
    fields = dict(job=job, commit=commit, action=action, attempt=request[8], accepted=False, code=code)
    if persist:
        directory = Path(config['root']) / job
        if not os.path.lexists(directory):
            try:
                directory.mkdir(mode=0o700)
                api.record(directory, job=job, commit=commit, action=action, attempt=request[8], state='failed')
            except OSError:
                pass  # Full storage must still produce the identified refusal.
    api.emit(config, 'refused', **fields)
    return 1
