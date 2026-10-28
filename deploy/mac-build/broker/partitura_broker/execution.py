"""Native build broker: execution."""
from __future__ import annotations


import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import tempfile
import time


import partitura_broker as api

def run_v2(config, request):
    if config.get('profile') != 'registry-only':
        return api.refuse(config, request, 'legacy-profile', persist=False)
    with api.run_lock(config, 5) as acquired:
        if not acquired:
            return api.refuse(config, request, 'host-busy', persist=False)
        # Epoch/cancellation/expiry/replay precede recovery that rotates epoch.
        if request[7] != api.initialize_epoch(config):
            return api.refuse(config, request, 'stale-epoch', persist=False)
        root = Path(config['root'])
        if api.read_state(root / (request[1] + '.cancel')) is not None:
            return api.refuse(config, request, 'cancelled', persist=False)
        if not time.time() < request[9] <= time.time() + 150:
            return api.refuse(config, request, 'submission-expired')
        if os.path.lexists(root / request[1]):
            return api.refuse(config, request, 'duplicate-job', persist=False)
        if api.read_state(root / ('attempt-' + request[8])) is not None:
            return api.refuse(config, request, 'duplicate-attempt')
        if api.read_state(root / 'maintenance-blocked') is not None:
            return api.refuse(config, request, 'cleanup-required')
        jobs, _ = api.obligations(config)
        # Run and the boot daemon can race for the lock. Whichever wins must
        # account for missing-marker legacy debris before admitting any input.
        boot = api.boot_id()
        previous, inventory = api.maintenance_state(root, boot)
        inventory |= api.read_state(root / 'inventory-required') is not None
        if inventory and previous and previous['nextAt'] > time.time():
            # Retry known safety obligations from this SSH context without
            # repeating inventory before its recorded retry time.
            result, _ = api.reconcile_locked(config, jobs) if jobs else ('host-maintenance', [])
            return api.refuse(config, request, 'host-reconciled' if result == 'reconciled' else result)
        if inventory:
            api.durable_write(root / 'inventory-required', 'inventory-pending\n')
            if len(jobs) > 6:
                result, _ = api.reconcile_locked(config, jobs)
                api.record_maintenance(root, boot, inventory_complete=False)
                return api.refuse(config, request, 'host-maintenance' if result == 'reconciled' else result)
            try:
                jobs |= api.inventory_obligations(config)
            except api.InventoryPending as pending:
                result, _ = api.reconcile_locked(config, jobs | pending.jobs) if jobs or pending.jobs else ('host-maintenance', [])
                api.record_maintenance(root, boot, min(16, (previous or {}).get('failures', 0) + 1), inventory_complete=False)
                return api.refuse(config, request, 'host-maintenance' if result == 'reconciled' else result)
            except ValueError:
                api.durable_write(root / 'maintenance-blocked', 'inventory-invalid\n')
                return api.refuse(config, request, 'cleanup-required')
            except OSError:
                api.record_maintenance(root, boot, min(16, (previous or {}).get('failures', 0) + 1), inventory_complete=False)
                return api.refuse(config, request, 'host-maintenance')
            api.durable_remove(root / 'inventory-required')
        if jobs:
            result, _ = api.reconcile_locked(config, jobs)
            api.record_maintenance(root, boot, 0 if result == 'reconciled' else min(16, (previous or {}).get('failures', 0) + 1))
            return api.refuse(config, request, 'host-reconciled' if result == 'reconciled' else result)
        if inventory:
            api.record_maintenance(root, boot)
            api.durable_remove(root / 'inventory-required')
        legacy = ('run', *request[1:6], request[6])
        return api.run_job(config, legacy, lock_held=True, attempt=request[8], expiry=request[9])


def cancel_job(config, job):
    api.tombstone(config, job)
    if config.get('profile') == 'registry-only':
        return
    # Legacy recovery requires exit zero once the durable tombstone exists.
    # Cleanup acknowledgement isn't cleanup success; failures keep their fences.
    try:
        with api.run_lock(config, 0) as acquired:
            if not acquired:
                return
            jobs, _ = api.obligations(config)
            if job in jobs:
                api.reconcile_locked(config, jobs)
    except Exception:
        return


class RunnerMarker:
    def __init__(self, config, job, commit, action, attempt):
        self.root = Path(config['root'])
        self.value = dict(job=job, attempt=attempt or '0'*32, commit=commit, action=action, stage='receiving', heartbeat=time.time())
        self.mutex = threading.Lock()
        self.finished = threading.Event()
        self.failed = threading.Event()
        self.thread = threading.Thread(target=self.heartbeat, daemon=True)

    def publish(self, stage=None):
        with self.mutex:
            if stage is not None:
                self.value['stage'] = stage
            self.value['heartbeat'] = time.time()
            api.durable_write(self.root / 'runner.json', json.dumps(self.value) + '\n')

    def start(self):
        start = api.process_start(os.getpid())
        if start is None:
            raise ValueError('own process birth time unavailable')
        self.value['owner'] = dict(pid=os.getpid(), start=start, boot=api.boot_id())
        self.publish()
        self.thread.start()

    def heartbeat(self):
        while not self.finished.wait(10):
            try:
                self.publish()
            except Exception:
                self.failed.set()
                return

    def check(self):
        if self.failed.is_set():
            raise OSError('runner heartbeat unavailable')
        if os.path.lexists(self.root / (self.value['job'] + '.cancel')):
            raise InterruptedError('native job cancelled')

    def stop(self):
        self.finished.set()
        if self.thread.ident is not None:
            # Never release runner.lock while an old publisher could overwrite
            # another runner's marker. Kernel-stalled IO keeps admission closed.
            self.thread.join()


def run_job(config, request, lock_held=False, attempt=None, expiry=None):
    _, job, commit, pr, action, length = request[:6]
    secret_length = request[6] if len(request) == 7 else 0
    if config.get('profile') == 'registry-only' and not lock_held:
        raise ValueError('legacy run disabled by installed profile')
    root = Path(config['root'])
    directory = root / job
    # A dedicated account's one forced-command key cannot start parallel VMs.
    with (contextlib.nullcontext(True) if lock_held else api.run_lock(config, 0)) as acquired, contextlib.ExitStack() as resources:
        if not acquired:
            raise BlockingIOError('native host busy')
        # Legacy callers have no reconcile handshake. A post-install inventory
        # or daemon-only relock can be completed in this SSH session before any
        # input. Actual failed cleanup and installer fences remain refusals.
        if not lock_held and config.get('profile', 'legacy') == 'legacy' and api.read_state(root / 'maintenance-blocked') is None and (api.read_state(root / 'inventory-required') is not None or api.read_state(root / 'keychain-relock-pending') is not None) and api.read_state(root / 'cleanup-required') is None:
            jobs, _ = api.obligations(config)
            jobs |= api.inventory_obligations(config)
            if jobs:
                result, _ = api.reconcile_locked(config, jobs)
                if result != 'reconciled':
                    raise ValueError('previous VM cleanup requires operator reconciliation')
            api.record_maintenance(root, api.boot_id())
            api.durable_remove(root / 'inventory-required')
        if (root / 'cleanup-required').exists():
            raise ValueError('previous VM cleanup requires operator reconciliation')
        active = root / 'active-vm'
        if active.exists():
            raise ValueError('previous VM requires crash recovery')
        if any(os.path.lexists(root / name) for name in ('runner.json', 'unlock-attempt', 'keychain-relock-pending', 'recovery.json', 'maintenance-blocked', 'inventory-required')):
            raise ValueError('previous runner requires crash recovery')
        cancelled = root / (job + '.cancel')
        if cancelled.exists():
            raise ValueError('native job was cancelled before submission')
        identity = dict(job=job, commit=commit, action=action)
        if attempt is not None:
            identity['attempt'] = attempt
        if os.path.lexists(directory):
            raise ValueError('native job already exists')
        try:
            if attempt is not None:
                api.durable_write(root / ('attempt-' + attempt), job + '\n')
            api.prune_artifacts(root)
            api.require_disk(config, length + secret_length)
            directory.mkdir(mode=0o700)
        except (api.DiskUnavailable, OSError):
            receipt = dict(**identity, state='failed', stage='disk-preflight', failureCode='host-disk-space-unavailable')
            try:
                directory.mkdir(mode=0o700, exist_ok=True)
                api.record(directory, **receipt)
            except OSError:
                pass
            if attempt is not None:
                api.emit(config, 'known', **receipt)
            else:
                print(json.dumps(receipt))
            return 1
        if expiry is not None and time.time() >= expiry:
            api.record(directory, **identity, state='failed')
            api.emit(config, 'refused', **identity, accepted=False, code='submission-expired')
            return 1
        bundle = directory / 'source.bundle'
        secret_input = io.BytesIO()
        marker = api.RunnerMarker(config, job, commit, action, attempt)
        resources.callback(secret_input.close)
        resources.callback(marker.stop)
        try:
            marker.start()  # The receiver observes cancellation before its first read.
            api.record(directory, **identity, state='receiving')
            if secret_length:
                api.receive(sys.stdin.buffer, secret_input, secret_length, seconds=30, check=marker.check)
                files = json.loads(secret_input.getvalue())
                if not isinstance(files, dict) or not 1 <= len(files) <= 16 or any(
                    not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', name) or not isinstance(value, str)
                    for name, value in files.items()
                ):
                    raise ValueError('invalid job secret files')
            with bundle.open('xb') as output:
                api.receive(sys.stdin.buffer, output, length, check=marker.check)
            marker.check()
        except BaseException as error:
            try:
                if marker.thread.ident is not None:
                    marker.stop()
                bundle.unlink(missing_ok=True)
                receipt = dict(**identity, state='cancelled' if cancelled.exists() else 'failed', cause=type(error).__name__, stage='receiving', failureCode='receive-interrupted')
                api.record(directory, **receipt)
                api.durable_remove(root / 'runner.json')
                if attempt is not None:
                    api.emit(config, 'known', **{key: value for key, value in receipt.items() if key != 'cause'})
                    return 1
            finally:
                secret_input.close()
            raise
        environment = api.environment_for(config)
        tart = config['tart']
        vm = 'partitura-job-' + job
        boot = None
        boot_logger = None
        stage = 'receiving'
        clone_attempted = False
        workflow_logs = None
        failure = None
        cleanup_failed = False
        keychain = None
        keychain_attempted = False
        keychain_state = None
        keychain_policy = None
        pre_relock_state = None
        finished = threading.Event()
        def watch_cancellation():
            while not finished.wait(1):
                if cancelled.exists() or marker.failed.is_set():
                    os.kill(os.getpid(), signal.SIGTERM)
                    return
        watcher = threading.Thread(target=watch_cancellation, daemon=True)
        watcher.start()
        try:
            try:
                api.require_disk(config)
            except api.DiskUnavailable:
                stage = 'disk-post-transfer'
                raise
            stage = 'capacity'
            marker.publish(stage)
            api.verify_vm_capacity()
            stage = 'unlock'
            marker.check()
            api.record(directory, **identity, state='running', stage='unlock')
            # Both durable fences precede *every* keychain API, including open.
            api.durable_write(root / 'unlock-attempt', job + '\n')
            api.durable_write(active, job + '\n')
            marker.publish(stage)
            keychain_attempted = True
            keychain = api.LoginKeychain(config)
            keychain_state = keychain.state()
            # Private host evidence only, never projected through the gateway.
            api.durable_write(directory / 'keychain.json', json.dumps({'preUnlockState': keychain_state}) + '\n')
            keychain.unlock()
            if config.get('keychainPolicy') is not None:
                stage = 'keychain-policy'
                marker.publish(stage)
                keychain_policy = keychain.apply_policy(config['keychainPolicy'], root / 'keychain-policy.json')
            stage = 'clone'
            marker.publish(stage)
            clone_attempted = True
            api.owned([tart, 'clone', config['base'], vm], environment, 180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            api.prepare_clone(config, vm)
            stage = 'boot'
            marker.publish(stage)
            # Boot has no repository code or secrets; retain its private stderr
            # only on failure so SSH-only startup failures can be diagnosed.
            boot = subprocess.Popen([tart, 'run', vm, '--no-graphics', '--no-audio', '--no-usb-accessories', '--no-clipboard'], env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
            boot_logger = threading.Thread(target=api.capture_boot_log, args=(boot.stderr, directory / 'boot.log'), daemon=True)
            boot_logger.start()
            ready = False
            for _ in range(60):
                if boot.poll() is not None:
                    raise ValueError('guest exited before readiness')
                try:
                    api.owned([tart, 'exec', vm, 'true'], environment, 5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    ready = True
                    break
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    time.sleep(2)
            if not ready:
                raise TimeoutError('guest boot timed out')
            stage = 'workflow'
            marker.publish(stage)
            api.record(directory, **identity, state='running')
            # The fixed installed guest runner verifies its own sealed qualifier,
            # receives a Git bundle, and never uses host mounts or credentials.
            with bundle.open('rb') as source, tempfile.TemporaryFile(dir=directory) as transport:
                # Unlinked transport storage cannot survive a host-process crash.
                # The source bundle and durable job record contain no secrets.
                transport.write(secret_input.getvalue())
                for block in iter(lambda: source.read(65536), b''):
                    transport.write(block)
                transport.seek(0)
                arguments = [tart, 'exec', '-i', vm, '/usr/bin/sudo', '-n', '-u', config['guestUser'], '/usr/bin/env', '-i', 'HOME=' + config['guestHome'], 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', '/bin/bash', '/Library/Partitura/NativeBuild/run.sh', job, commit, pr, action, config['guestRunnerSha256'], config['qualifierSha256']]
                if secret_length:
                    arguments.append(str(secret_length))
                try:
                    api.owned(arguments, environment, 2700, stderr_log=directory / 'runner.log', stdin=transport, stdout=subprocess.DEVNULL)
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    # Collect while the guest still exists; never mask the failure.
                    try:
                        workflow_logs = api.package_workflow_logs(config, environment, vm, job, directory)
                    except Exception:
                        (directory / 'artifacts.tar').unlink(missing_ok=True)
                    raise
            stage = 'artifact'
            marker.publish(stage)
            size = api.bounded_output([tart, 'exec', vm, '/usr/bin/sudo', '-n', '-u', config['guestUser'], '/usr/bin/tar', '-C', config['guestHome'] + '/dev/agentic-scratchpads/partitura/' + job, '-cf', '-', 'artifacts'], environment, directory / 'artifacts.tar', 180)
            digest = hashlib.sha256()
            with (directory / 'artifacts.tar').open('rb') as artifact:
                for block in iter(lambda: artifact.read(65536), b''):
                    digest.update(block)
            receipt = dict(**identity, state='succeeded', artifactBytes=size, artifactSha256=digest.hexdigest())
        except BaseException as error:
            failure = error
            receipt = dict(**identity, state='cancelled' if isinstance(error, InterruptedError) and cancelled.exists() else 'failed', cause=type(error).__name__, stage=stage)
            if isinstance(error, api.DiskUnavailable):
                receipt['failureCode'] = 'host-disk-space-unavailable'
            if stage in ('unlock', 'capacity'):
                receipt['failureCode'] = 'unlock-failed' if stage == 'unlock' else 'host-capacity-unavailable'
            if stage == 'keychain-policy':
                # Existing gateways have a closed legacy stage/code decoder.
                # Keep policy failure within its unlock boundary on that wire.
                receipt.update(stage='keychain-policy' if attempt is not None else 'unlock', failureCode='keychain-policy-unavailable' if attempt is not None else 'unlock-failed')
            if stage == 'boot' and boot is not None and boot.poll() is not None:
                receipt['bootExitCode'] = boot.returncode
            if stage == 'workflow' and isinstance(error, (subprocess.CalledProcessError, subprocess.TimeoutExpired)):
                receipt['failureCode'] = 'workflow-failed'
                if isinstance(error, subprocess.CalledProcessError):
                    receipt['workflowExitCode'] = max(-255, min(255, error.returncode))
                if workflow_logs is not None:
                    receipt.update(workflow_logs)
        finally:
            api.ignore_shutdown_signals()
            finished.set()
            watcher.join(timeout=2)
            try:
                marker.publish('cleanup')
            except OSError:
                marker.failed.set()  # The existing marker still fences failure.
            try:
                api.stop(boot)
            except Exception:
                cleanup_failed = True
            if boot_logger is not None:
                boot_logger.join(timeout=2)
            if clone_attempted:
                try:
                    api.destroy_vm(config, job)
                except Exception:
                    cleanup_failed = True
            if keychain_attempted:
                try:
                    if keychain is None:
                        keychain = api.LoginKeychain(config)
                    with contextlib.suppress(Exception):
                        pre_relock_state = keychain.state()
                    keychain.lock()
                except Exception:
                    cleanup_failed = True
                finally:
                    if keychain is not None:
                        keychain.close()
            if not cleanup_failed:
                api.durable_remove(active)
                api.durable_remove(root / 'unlock-attempt')
            if cleanup_failed:
                api.durable_write(root / 'cleanup-required', vm + '\n')
                receipt.update(state='failed', cause='cleanup-required')
                for field in ('failureCode', 'workflowExitCode', 'artifactBytes', 'artifactSha256'):
                    receipt.pop(field, None)
            if not api.delivers_artifact(receipt):
                (directory / 'artifacts.tar').unlink(missing_ok=True)
            if receipt['state'] == 'succeeded':
                (directory / 'boot.log').unlink(missing_ok=True)
            (directory / 'runner.log').unlink(missing_ok=True)
            receipt = api.diagnostic_receipt(directory, receipt)
            if keychain_policy is not None:
                receipt['keychainPolicy'] = keychain_policy
            if pre_relock_state in ('locked', 'unlocked'):
                receipt['preRelockState'] = pre_relock_state
            api.record(directory, **receipt)
            bundle.unlink(missing_ok=True)
            secret_input.close()
            marker.stop()
            if not cleanup_failed:
                api.durable_remove(root / 'runner.json')
        if attempt is not None:
            api.emit(config, 'known', **{key: value for key, value in receipt.items() if key != 'cause'})
        else:
            print(json.dumps(receipt))
        return 1 if failure or cleanup_failed else 0


def main(argv=()):
    os.umask(0o077)
    # sshd's ForceCommand supplies no argv. A remote string cannot select a
    # local-only mode, even if it spells the installed maintenance entry point.
    if argv:
        if list(argv) not in (['local-maintenance'], ['local-relock']) or 'SSH_ORIGINAL_COMMAND' in os.environ or 'SSH_CONNECTION' in os.environ:
            raise ValueError('unsupported local invocation')
        diagnostics_ready = argv[0] != 'local-maintenance' or api.prepare_maintenance_stderr()
        config = api.load_config()
        if argv[0] == 'local-relock':
            return api.keychain_relock_entry(config)
        result = api.local_maintenance(config)
        reason = Path(config['root']) / 'maintenance-reason'
        if not diagnostics_ready and api.read_state(reason) is None:
            api.durable_write(reason, 'diagnostics-unavailable\n')
        return result
    request = api.parse_command(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    config = api.load_config()
    if request[0] in ('health', 'run-v2', 'reconcile') or config.get('profile') == 'registry-only':
        if 'hostId' not in config:
            print(json.dumps({'protocolVersion': api.PROTOCOL_VERSION, 'kind': 'error', 'code': 'identity-not-installed'}))
            return 1
        try:
            if request[0] == 'health':
                return api.health(config)
            if request[0] == 'run-v2':
                return api.run_v2(config, request)
            if request[0] == 'reconcile':
                return api.reconcile(config, request[1])
            if request[0] == 'run':
                api.emit(config, 'error', code='legacy-run-disabled')
                return 1
            if request[0] == 'status':
                kind, fields = api.registry_status(config, request[1])
                api.emit(config, kind, **fields)
                return 0
            if request[0] == 'cancel':
                api.cancel_job(config, request[1])
                api.emit(config, 'cancellation-requested', job=request[1])
                return 0
        except Exception:
            # Malformed state/IO is never an authenticated unknown-job result.
            api.emit(config, 'error', code='broker-state-unavailable')
            return 1
    if request[0] == 'run':
        return api.run_job(config, request)
    directory = Path(config['root']) / request[1]
    if request[0] == 'cancel':
        # A durable tombstone also fences a submission still creating its bundle.
        api.cancel_job(config, request[1])
        print(json.dumps({'job': request[1], 'state': 'cancellation-requested'}))
        return 0
    api.private_directory(directory)
    receipt = api.json_state(directory / 'receipt.json')
    if receipt is None:
        raise ValueError('missing job receipt')
    if request[0] == 'status':
        print(json.dumps(api.diagnostic_receipt(directory, receipt)))
    else:
        if not api.delivers_artifact(receipt):
            raise ValueError('no deliverable artifact')
        # Opaque archive bytes only. No caller path and no host extraction.
        descriptor = os.open(directory / 'artifacts.tar', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as artifact:
            info = os.fstat(artifact.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > api.MAX_ARTIFACT:
                raise ValueError('unsafe job artifact')
            for block in iter(lambda: artifact.read(65536), b''):
                sys.stdout.buffer.write(block)
    return 0


def cli(argv=()):
    try:
        return api.main(argv)
    except Exception:
        command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
        if command.split(' ', 1)[0] in ('health', 'run-v2', 'reconcile'):
            print(json.dumps(dict(protocolVersion=api.PROTOCOL_VERSION, kind='error', code='broker-request-refused')))
        else:
            print(json.dumps({'state': 'refused', 'cause': 'broker-request-refused'}))
        return 1
