#!/usr/bin/env python3
"""Installed SSH forced command. Caller code executes only inside a disposable VM."""
from __future__ import annotations

import fcntl
import ctypes as C
import hashlib
import io
import json
import os
import pwd
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import tarfile
import threading
import tempfile
import time

CONFIG = Path('/Library/Partitura/NativeBuild/config.json')
MAX_BUNDLE = 1024 * 1024 * 1024
MAX_ARTIFACT = 2 * MAX_BUNDLE
MAX_BOOT_LOG = 65536
MAX_WORKFLOW_LOG = 1024 * 1024
ARTIFACT_RETENTION_SECONDS = 7 * 24 * 60 * 60
ARTIFACT_STORAGE_LIMIT = 8 * MAX_BUNDLE
JOB = r'[a-f0-9]{32}'
COMMIT = r'[a-f0-9]{40}'
RUN = re.compile(rf'run ({JOB}) ({COMMIT}) ([1-9][0-9]{{0,7}}) ([a-z][a-z0-9-]{{0,63}}) ([1-9][0-9]{{0,9}})(?: ([1-9][0-9]{{0,4}}))?')
READ = re.compile(rf'(status|artifact|cancel) ({JOB})')


def parse_command(command):
    match = RUN.fullmatch(command)
    if match:
        job, commit, pr, action, length, secret_length = match.groups()
        if int(length) > MAX_BUNDLE:
            raise ValueError('bundle exceeds limit')
        if secret_length is not None and int(secret_length) > 65536:
            raise ValueError('job secret input exceeds limit')
        request = ('run', job, commit, pr, action, int(length))
        return request if secret_length is None else (*request, int(secret_length))
    match = READ.fullmatch(command)
    if match:
        return match.groups()
    raise ValueError('unsupported native build command')


def sealed(path):
    """Reject caller-writable installed source and symlinked ancestors."""
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('installed path must be absolute')
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unsafe installed source')
    return path


def load_config():
    config = json.loads(sealed(CONFIG).read_text())
    if set(config) != {'tart', 'tartSha256', 'base', 'root', 'tartHome', 'guestRunnerSha256', 'qualifierSha256', 'guestUser', 'guestHome', 'keychainPath', 'keychainCredentialPath'}:
        raise ValueError('invalid installed configuration')
    validate_keychain_paths(config)
    tart = sealed(config['tart'])
    if hashlib.sha256(tart.read_bytes()).hexdigest() != config['tartSha256']:
        raise ValueError('installed Tart digest differs')
    for key in ('guestRunnerSha256', 'qualifierSha256', 'tartSha256'):
        if not re.fullmatch('[a-f0-9]{64}', config[key]):
            raise ValueError('invalid installed digest')
    if not re.fullmatch('[a-z0-9][a-z0-9-]{1,80}', config['base']):
        raise ValueError('invalid sealed base name')
    if not re.fullmatch('[a-z][a-z0-9_-]{0,30}', config['guestUser']) or config['guestUser'] == 'root':
        raise ValueError('invalid guest user')
    if config['guestHome'] != '/Users/' + config['guestUser']:
        raise ValueError('invalid guest home')
    for key in ('root', 'tartHome'):
        path = Path(config[key])
        info = path.lstat()
        if not path.is_absolute() or path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('unsafe private runtime directory')
    return config


def validate_keychain_paths(config):
    account = pwd.getpwuid(os.getuid())
    home = Path(account.pw_dir)
    if account.pw_name == 'root' or home != Path('/Users') / account.pw_name:
        raise ValueError('keychain requires the dedicated host account')
    info = home.lstat()
    if home.resolve() != home or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('unsafe dedicated account home')
    if config['keychainPath'] != str(home / 'Library/Keychains/login.keychain-db') or config['keychainCredentialPath'] != str(home / '.partitura-native-login.password'):
        raise ValueError('keychain paths differ from the dedicated account')


class KeychainError(Exception):
    """Contains fixed API stages and numeric status only, never credentials."""


class LoginKeychain:
    def __init__(self, config):
        validate_keychain_paths(config)
        self.config = config
        self.ref = C.c_void_p()
        self.security = C.CDLL('/System/Library/Frameworks/Security.framework/Security')
        self.core = C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        self.core.CFRelease.argtypes = [C.c_void_p]
        self.core.CFRelease.restype = None
        for name, arguments in {
            'SecKeychainSetUserInteractionAllowed': [C.c_ubyte],
            'SecKeychainOpen': [C.c_char_p, C.POINTER(C.c_void_p)],
            'SecKeychainGetStatus': [C.c_void_p, C.POINTER(C.c_uint32)],
            'SecKeychainUnlock': [C.c_void_p, C.c_uint32, C.c_void_p, C.c_ubyte],
            'SecKeychainLock': [C.c_void_p],
        }.items():
            function = getattr(self.security, name)
            function.argtypes = arguments
            function.restype = C.c_int32
        try:
            self.check(self.security.SecKeychainSetUserInteractionAllowed(0), 'interaction')
            self.check(self.security.SecKeychainOpen(os.fsencode(config['keychainPath']), C.byref(self.ref)), 'open')
        except BaseException:
            self.close()
            raise

    @staticmethod
    def check(status, stage):
        if status:
            raise KeychainError(stage + ':' + str(status))

    def state(self):
        status = C.c_uint32()
        self.check(self.security.SecKeychainGetStatus(self.ref, C.byref(status)), 'status')
        return 'unlocked' if status.value & 1 else 'locked'

    def unlock(self):
        descriptor = os.open(self.config['keychainCredentialPath'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or not 1 <= info.st_size <= 1024:
                raise KeychainError('credential-metadata')
            password = source.read(1025)
        if not 1 <= len(password) <= 1024 or b'\0' in password or b'\n' in password or b'\r' in password:
            raise KeychainError('credential-length')
        buffer = C.create_string_buffer(password)
        del password
        try:
            self.check(self.security.SecKeychainUnlock(self.ref, len(buffer) - 1, buffer, 1), 'unlock')
        finally:
            C.memset(buffer, 0, len(buffer))
        if self.state() != 'unlocked':
            raise KeychainError('unlock-state')

    def lock(self):
        self.check(self.security.SecKeychainLock(self.ref), 'lock')
        if self.state() != 'locked':
            raise KeychainError('lock-state')

    def close(self):
        if self.ref:
            self.core.CFRelease(self.ref)
            self.ref = C.c_void_p()


def verify_vm_capacity():
    # Count Tart processes across UIDs, including the operator's VM. Counting
    # non-run Tart commands too is conservative. Never stop an unrelated VM.
    result = subprocess.run(['/bin/ps', '-axo', 'comm='], check=True, capture_output=True, timeout=10)
    if len(result.stdout) > 2 * 1024 * 1024:
        raise ValueError('VM inventory is too large')
    names = [Path(os.fsdecode(line.strip())).name.lower() for line in result.stdout.splitlines()]
    # Virtualization.framework also catches guests owned by another frontend.
    # An unfamiliar hypervisor cannot establish available macOS capacity.
    if any(name.startswith(('qemu-system', 'prl_vm_app', 'vmware-vmx')) for name in names):
        raise ValueError('unqualified host VM inventory')
    running = max(names.count('tart'), names.count('com.apple.virtualization.virtualmachine'))
    if running > 1:
        raise ValueError('host VM capacity is unavailable')


def receive(source, destination, length, seconds=600):
    """Bound bytes and idle time before a guest or credential is used."""
    deadline = time.monotonic() + seconds
    remaining = length
    while remaining:
        wait = deadline - time.monotonic()
        if wait <= 0 or not select.select([source], [], [], wait)[0]:
            raise TimeoutError('bundle input timed out')
        data = os.read(source.fileno(), min(65536, remaining))
        if not data:
            raise ValueError('truncated bundle')
        destination.write(data)
        remaining -= len(data)


def stop(child):
    if child is not None and child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=10)


def capture_boot_log(source, destination):
    """Drain Tart stderr while retaining only a fixed-size private prefix."""
    remaining = MAX_BOOT_LOG
    try:
        with destination.open('xb') as output:
            for chunk in iter(lambda: source.read(65536), b''):
                if remaining:
                    kept = chunk[:remaining]
                    output.write(kept)
                    output.flush()
                    remaining -= len(kept)
    finally:
        source.close()


def diagnostic_receipt(directory, receipt):
    """Publish fixed codes only. Raw host diagnostics stay private."""
    result = dict(receipt)
    if receipt.get('state') != 'failed':
        return result
    if receipt.get('cause') == 'cleanup-required':
        result['failureCode'] = 'cleanup-required'
        return result
    if receipt.get('stage') != 'boot':
        return result
    try:
        descriptor = os.open(directory / 'boot.log', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > MAX_BOOT_LOG:
                return result
            diagnostic = source.read(MAX_BOOT_LOG + 1)
        if len(diagnostic) <= MAX_BOOT_LOG and all(marker in diagnostic for marker in (
            b'VZErrorDomain', b'Failed to get current host key', b'Failed to create new HostKey',
        )):
            result['failureCode'] = 'host-key-unavailable'
    except OSError:
        pass
    return result


def owned(arguments, environment, timeout, stderr_log=None, **kwargs):
    if stderr_log is not None:
        kwargs['stderr'] = subprocess.PIPE
    child = subprocess.Popen(arguments, env=environment, start_new_session=True, **kwargs)
    drain = None
    if stderr_log is not None:
        drain = threading.Thread(target=capture_boot_log, args=(child.stderr, stderr_log), daemon=True)
        drain.start()
    try:
        code = child.wait(timeout=timeout)
        if code:
            raise subprocess.CalledProcessError(code, arguments)
    finally:
        stop(child)
        if drain is not None:
            drain.join(timeout=2)


def prepare_clone(config, vm):
    """Tart preserves sealed file modes; only the disposable clone may change."""
    directory = Path(config['tartHome']) / 'vms' / vm
    if directory.resolve() != directory:
        raise ValueError('unsafe disposable VM directory')
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
        raise ValueError('unsafe disposable VM owner')
    for name in ('config.json', 'disk.img', 'nvram.bin'):
        descriptor = os.open(directory / name, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                raise ValueError('unsafe disposable VM file')
            os.fchmod(descriptor, stat.S_IMODE(info.st_mode) | stat.S_IWUSR)
        finally:
            os.close(descriptor)


def bounded_output(arguments, environment, destination, timeout, limit=MAX_ARTIFACT):
    child = subprocess.Popen(arguments, env=environment, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    size = 0
    deadline = time.monotonic() + timeout
    try:
        with destination.open('xb') as output:
            while True:
                wait = deadline - time.monotonic()
                if wait <= 0 or not select.select([child.stdout], [], [], wait)[0]:
                    raise TimeoutError('artifact transfer timed out')
                chunk = os.read(child.stdout.fileno(), 65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise ValueError('artifact exceeds limit')
                output.write(chunk)
        if child.wait(timeout=max(1, deadline - time.monotonic())):
            raise ValueError('artifact transfer failed')
    finally:
        stop(child)
        child.stdout.close()
    return size


def delivers_artifact(receipt):
    """Successful archives, or the repository's own logs from a failed workflow."""
    return receipt.get('state') == 'succeeded' or (
        receipt.get('state') == 'failed'
        and receipt.get('failureCode') == 'workflow-failed'
        and 'artifactSha256' in receipt
    )


def package_workflow_logs(config, environment, vm, job, directory):
    """Archive repository-controlled output from a failed workflow.

    The caller writes .partitura/native-build.sh, so its build log and the guest
    runner's stderr (relayed by tart exec) expose nothing the caller could not
    print itself. Keychain and boot diagnostics stay private.
    """
    members = []
    runner = directory / 'runner.log'
    if runner.exists() and runner.stat().st_size:
        members.append(('runner.log', runner))
    build = directory / 'build.log'
    try:
        guest_log = config['guestHome'] + '/dev/agentic-scratchpads/partitura/' + job + '/build.log'
        bounded_output([config['tart'], 'exec', vm, '/usr/bin/sudo', '-n', '-u', config['guestUser'], '/usr/bin/tail', '-c', str(MAX_WORKFLOW_LOG), guest_log], environment, build, 60, MAX_WORKFLOW_LOG)
        members.append(('build.log', build))
    except Exception:
        build.unlink(missing_ok=True)  # The runner can fail before the repository step.
    if not members:
        return None
    archive = directory / 'artifacts.tar'
    try:
        with tarfile.open(archive, 'x', format=tarfile.PAX_FORMAT) as output:
            for name, path in members:
                info = tarfile.TarInfo(name)
                info.size = path.stat().st_size
                info.mode = 0o600
                with path.open('rb') as source:
                    output.addfile(info, source)
    finally:
        runner.unlink(missing_ok=True)
        build.unlink(missing_ok=True)
    digest = hashlib.sha256()
    with archive.open('rb') as source:
        for block in iter(lambda: source.read(65536), b''):
            digest.update(block)
    return dict(artifactBytes=archive.stat().st_size, artifactSha256=digest.hexdigest())


def durable_write(path, text):
    pending = path.with_name(path.name + '.new')
    with pending.open('w') as output:
        output.write(text)
        output.flush()
        os.fsync(output.fileno())
    pending.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def record(directory, **receipt):
    durable_write(directory / 'receipt.json', json.dumps(receipt) + '\n')


def prune_artifacts(root, now=None):
    """Caller holds runner.lock. Keep receipts and reserve space for the next job."""
    cutoff = (time.time() if now is None else now) - ARTIFACT_RETENTION_SECONDS
    candidates = []
    for directory in root.iterdir():
        if not re.fullmatch(JOB, directory.name) or directory.is_symlink() or not directory.is_dir():
            continue
        receipt_path = directory / 'receipt.json'
        artifact = directory / 'artifacts.tar'
        if receipt_path.is_symlink() or not receipt_path.is_file() or not artifact.exists():
            continue
        receipt = json.loads(receipt_path.read_text())
        if receipt.get('state') not in ('succeeded', 'failed', 'cancelled'):
            continue
        info = artifact.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError('unsafe retained artifact')
        candidates.append((info.st_mtime, artifact, info.st_size, receipt))
    retained = 0
    for modified, artifact, size, receipt in sorted(candidates, key=lambda item: item[0], reverse=True):
        if modified < cutoff or not delivers_artifact(receipt) or retained + size > ARTIFACT_STORAGE_LIMIT - MAX_ARTIFACT:
            artifact.unlink()
            receipt['artifactExpired'] = True
            record(artifact.parent, **receipt)
        else:
            retained += size


def environment_for(config):
    return {'HOME': pwd.getpwuid(os.getuid()).pw_dir, 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'TART_HOME': config['tartHome'], 'TART_NO_AUTO_PRUNE': '1'}


def destroy_vm(config, job):
    vm = 'partitura-job-' + job
    environment = environment_for(config)
    try:
        owned([config['tart'], 'stop', vm], environment, 45, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass  # An already stopped VM still needs deletion and its readback.
    try:
        owned([config['tart'], 'delete', vm], environment, 45, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        # Tart reports an error for an already absent VM, including a clone
        # that failed before creating it. The filesystem readback is decisive.
        if os.path.lexists(Path(config['tartHome']) / 'vms' / vm):
            raise
    if os.path.lexists(Path(config['tartHome']) / 'vms' / vm):
        raise ValueError('VM still exists after deletion')


def ignore_shutdown_signals():
    # The first signal enters the cleanup path. Further signals must not
    # interrupt the VM stop/delete and durable receipt writes.
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, signal.SIG_IGN)


def cancel_job(config, job):
    root = Path(config['root'])
    (root / (job + '.cancel')).touch(mode=0o600, exist_ok=True)
    # If the original broker is alive it owns this lock and its watcher handles
    # cancellation. Otherwise reconcile the durable fence after crash/power loss.
    with (root / 'runner.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        active = root / 'active-vm'
        if active.exists() and active.read_text().strip() == job:
            try:
                destroy_vm(config, job)
            finally:
                keychain = LoginKeychain(config)
                try:
                    keychain.lock()
                finally:
                    keychain.close()
            active.unlink()
            (root / 'cleanup-required').unlink(missing_ok=True)
            directory = root / job
            if (directory / 'receipt.json').exists():
                receipt = json.loads((directory / 'receipt.json').read_text())
                receipt.update(state='cancelled')
                record(directory, **receipt)


def run_job(config, request):
    _, job, commit, pr, action, length = request[:6]
    secret_length = request[6] if len(request) == 7 else 0
    root = Path(config['root'])
    directory = root / job
    # A dedicated account's one forced-command key cannot start parallel VMs.
    with (root / 'runner.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (root / 'cleanup-required').exists():
            raise ValueError('previous VM cleanup requires operator reconciliation')
        active = root / 'active-vm'
        if active.exists():
            raise ValueError('previous VM requires crash recovery')
        cancelled = root / (job + '.cancel')
        if cancelled.exists():
            raise ValueError('native job was cancelled before submission')
        prune_artifacts(root)
        directory.mkdir(mode=0o700)
        record(directory, job=job, commit=commit, action=action, state='receiving')
        bundle = directory / 'source.bundle'
        secret_input = io.BytesIO()
        try:
            if secret_length:
                receive(sys.stdin.buffer, secret_input, secret_length, seconds=30)
                files = json.loads(secret_input.getvalue())
                if not isinstance(files, dict) or not 1 <= len(files) <= 16 or any(
                    not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', name) or not isinstance(value, str)
                    for name, value in files.items()
                ):
                    raise ValueError('invalid job secret files')
            with bundle.open('xb') as output:
                receive(sys.stdin.buffer, output, length)
        except BaseException as error:
            try:
                bundle.unlink(missing_ok=True)
                record(directory, job=job, commit=commit, action=action, state='failed', cause=type(error).__name__)
            finally:
                raise
        if cancelled.exists():
            bundle.unlink()
            record(directory, job=job, commit=commit, action=action, state='cancelled')
            raise ValueError('native job was cancelled while receiving')
        environment = environment_for(config)
        tart = config['tart']
        vm = 'partitura-job-' + job
        boot = None
        boot_logger = None
        stage = 'clone'
        clone_attempted = False
        workflow_logs = None
        failure = None
        cleanup_failed = False
        keychain = None
        keychain_attempted = False
        keychain_state = None
        finished = threading.Event()
        def watch_cancellation():
            while not finished.wait(1):
                if cancelled.exists():
                    os.kill(os.getpid(), signal.SIGTERM)
                    return
        watcher = threading.Thread(target=watch_cancellation, daemon=True)
        watcher.start()
        try:
            # Persist before a clone can exist. SIGKILL or power loss leaves this
            # fence, so another SSH request cannot start a second VM.
            durable_write(active, job + '\n')
            stage = 'capacity'
            verify_vm_capacity()
            stage = 'unlock'
            keychain_attempted = True
            keychain = LoginKeychain(config)
            keychain_state = keychain.state()
            # Private host evidence only, never projected through the gateway.
            durable_write(directory / 'keychain.json', json.dumps({'preUnlockState': keychain_state}) + '\n')
            keychain.unlock()
            stage = 'clone'
            clone_attempted = True
            owned([tart, 'clone', config['base'], vm], environment, 180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            prepare_clone(config, vm)
            stage = 'boot'
            # Boot has no repository code or secrets; retain its private stderr
            # only on failure so SSH-only startup failures can be diagnosed.
            boot = subprocess.Popen([tart, 'run', vm, '--no-graphics', '--no-audio', '--no-usb-accessories', '--no-clipboard'], env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True)
            boot_logger = threading.Thread(target=capture_boot_log, args=(boot.stderr, directory / 'boot.log'), daemon=True)
            boot_logger.start()
            ready = False
            for _ in range(60):
                if boot.poll() is not None:
                    raise ValueError('guest exited before readiness')
                try:
                    owned([tart, 'exec', vm, 'true'], environment, 5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    ready = True
                    break
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    time.sleep(2)
            if not ready:
                raise TimeoutError('guest boot timed out')
            stage = 'workflow'
            record(directory, job=job, commit=commit, action=action, state='running')
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
                    owned(arguments, environment, 2700, stderr_log=directory / 'runner.log', stdin=transport, stdout=subprocess.DEVNULL)
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    # Collect while the guest still exists; never mask the failure.
                    try:
                        workflow_logs = package_workflow_logs(config, environment, vm, job, directory)
                    except Exception:
                        (directory / 'artifacts.tar').unlink(missing_ok=True)
                    raise
            stage = 'artifact'
            size = bounded_output([tart, 'exec', vm, '/usr/bin/sudo', '-n', '-u', config['guestUser'], '/usr/bin/tar', '-C', config['guestHome'] + '/dev/agentic-scratchpads/partitura/' + job, '-cf', '-', 'artifacts'], environment, directory / 'artifacts.tar', 180)
            digest = hashlib.sha256()
            with (directory / 'artifacts.tar').open('rb') as artifact:
                for block in iter(lambda: artifact.read(65536), b''):
                    digest.update(block)
            receipt = dict(job=job, commit=commit, action=action, state='succeeded', artifactBytes=size, artifactSha256=digest.hexdigest())
        except BaseException as error:
            failure = error
            receipt = dict(job=job, commit=commit, action=action, state='failed', cause=type(error).__name__, stage=stage)
            if stage in ('unlock', 'capacity'):
                receipt['failureCode'] = 'unlock-failed' if stage == 'unlock' else 'host-capacity-unavailable'
            if stage == 'boot' and boot is not None and boot.poll() is not None:
                receipt['bootExitCode'] = boot.returncode
            if stage == 'workflow' and isinstance(error, (subprocess.CalledProcessError, subprocess.TimeoutExpired)):
                receipt['failureCode'] = 'workflow-failed'
                if isinstance(error, subprocess.CalledProcessError):
                    receipt['workflowExitCode'] = max(-255, min(255, error.returncode))
                if workflow_logs is not None:
                    receipt.update(workflow_logs)
        finally:
            ignore_shutdown_signals()
            finished.set()
            watcher.join(timeout=2)
            try:
                stop(boot)
            except Exception:
                cleanup_failed = True
            if boot_logger is not None:
                boot_logger.join(timeout=2)
            if clone_attempted:
                try:
                    destroy_vm(config, job)
                except Exception:
                    cleanup_failed = True
            if keychain_attempted:
                try:
                    if keychain is None:
                        keychain = LoginKeychain(config)
                    keychain.lock()
                except Exception:
                    cleanup_failed = True
                finally:
                    if keychain is not None:
                        keychain.close()
            if not cleanup_failed:
                active.unlink(missing_ok=True)
            if cleanup_failed:
                (root / 'cleanup-required').write_text(vm + '\n')
                receipt.update(state='failed', cause='cleanup-required')
                for field in ('failureCode', 'workflowExitCode', 'artifactBytes', 'artifactSha256'):
                    receipt.pop(field, None)
            if not delivers_artifact(receipt):
                (directory / 'artifacts.tar').unlink(missing_ok=True)
            if receipt['state'] == 'succeeded':
                (directory / 'boot.log').unlink(missing_ok=True)
            (directory / 'runner.log').unlink(missing_ok=True)
            receipt = diagnostic_receipt(directory, receipt)
            record(directory, **receipt)
            bundle.unlink(missing_ok=True)
        print(json.dumps(receipt))
        return 1 if failure or cleanup_failed else 0


def main():
    os.umask(0o077)
    request = parse_command(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    config = load_config()
    if request[0] == 'run':
        return run_job(config, request)
    directory = Path(config['root']) / request[1]
    if request[0] == 'cancel':
        # A durable tombstone also fences a submission still creating its bundle.
        cancel_job(config, request[1])
        print(json.dumps({'job': request[1], 'state': 'cancellation-requested'}))
        return 0
    receipt = json.loads((directory / 'receipt.json').read_text())
    if request[0] == 'status':
        print(json.dumps(diagnostic_receipt(directory, receipt)))
    else:
        if not delivers_artifact(receipt):
            raise ValueError('no deliverable artifact')
        # Opaque archive bytes only. No caller path and no host extraction.
        with (directory / 'artifacts.tar').open('rb') as artifact:
            for block in iter(lambda: artifact.read(65536), b''):
                sys.stdout.buffer.write(block)
    return 0


if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise InterruptedError('native job interrupted')
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, interrupted)
    try:
        sys.exit(main())
    except Exception as error:
        # Never echo commands, stderr, credential values or checkout output.
        print(json.dumps({'state': 'refused', 'cause': type(error).__name__}))
        sys.exit(1)
