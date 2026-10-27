#!/usr/bin/env python3
"""Installed SSH forced command. Caller code executes only inside a disposable VM."""
from __future__ import annotations

import fcntl
import contextlib
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
import uuid

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
RUN_V2 = re.compile(rf'run-v2 ({JOB}) ({COMMIT}) ([1-9][0-9]{{0,7}}) ([a-z][a-z0-9-]{{0,63}}) ([1-9][0-9]{{0,9}}) (0|[1-9][0-9]{{0,4}}) ({JOB}) ({JOB}) ([1-9][0-9]{{0,9}})')
PROTOCOL_VERSION = 2
BROKER_REVISION = 'registry-v2'
DISK_FLOOR = 50 * 1024**3
MAX_STATE = 4096
MAX_INVENTORY = 1024
TERMINAL = ('succeeded', 'failed', 'cancelled')
FENCES = ('active-vm', 'cleanup-required', 'unlock-attempt', 'keychain-relock-pending')


def parse_command(command):
    if not isinstance(command, str) or len(command) > 512:
        raise ValueError('unsupported native build command')
    if command == 'health':
        return ('health',)
    match = RUN_V2.fullmatch(command)
    if match:
        job, commit, pr, action, length, secret_length, epoch, attempt, expiry = match.groups()
        if int(length) > MAX_BUNDLE or int(secret_length) > 65536:
            raise ValueError('input exceeds limit')
        return ('run-v2', job, commit, pr, action, int(length), int(secret_length), epoch, attempt, int(expiry))
    match = re.fullmatch(rf'reconcile ({JOB})', command)
    if match:
        return ('reconcile', match[1])
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
    with sealed(CONFIG).open('r') as source:
        text = source.read(65537)
    if len(text) > 65536:
        raise ValueError('oversized installed configuration')
    config = json.loads(text, object_pairs_hook=unique_object)
    legacy = {'tart', 'tartSha256', 'base', 'root', 'tartHome', 'guestRunnerSha256', 'qualifierSha256', 'guestUser', 'guestHome', 'keychainPath', 'keychainCredentialPath'}
    registry = {'hostId', 'profile', 'daemonRelockQualified', 'daemonRelockMacOSBuild'}
    if set(config) not in (legacy, legacy | registry):
        raise ValueError('invalid installed configuration')
    if 'hostId' in config:
        if not isinstance(config['hostId'], str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', config['hostId']) or config['profile'] not in ('legacy', 'registry-only'):
            raise ValueError('invalid installed identity/profile')
        if type(config['daemonRelockQualified']) is not bool or not isinstance(config['daemonRelockMacOSBuild'], str) or not re.fullmatch(r'[A-Za-z0-9]{0,32}', config['daemonRelockMacOSBuild']):
            raise ValueError('invalid daemon qualification')
        if config['daemonRelockQualified'] and not config['daemonRelockMacOSBuild']:
            raise ValueError('missing daemon qualification build')
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


def receive(source, destination, length, seconds=600, check=None):
    """Bound bytes and idle time before a guest or credential is used."""
    deadline = time.monotonic() + seconds
    remaining = length
    while remaining:
        if check is not None:
            check()
        wait = deadline - time.monotonic()
        if wait <= 0:
            raise TimeoutError('bundle input timed out')
        if not select.select([source], [], [], min(1, wait))[0]:
            continue
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
    descriptor, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    pending = Path(name)
    try:
        with os.fdopen(descriptor, 'w') as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        pending.replace(path)
        sync_directory(path.parent)
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
    sync_directory(path.parent)


def record(directory, **receipt):
    durable_write(directory / 'receipt.json', json.dumps(receipt) + '\n')


def prune_artifacts(root, now=None):
    """Caller holds runner.lock. Keep receipts and reserve space for the next job."""
    cutoff = (time.time() if now is None else now) - ARTIFACT_RETENTION_SECONDS
    candidates = []
    for index, directory in enumerate(root.iterdir()):
        if index >= MAX_INVENTORY:
            raise ValueError('oversized artifact inventory')
        if not re.fullmatch(JOB, directory.name) or directory.is_symlink() or not directory.is_dir():
            continue
        receipt_path = directory / 'receipt.json'
        artifact = directory / 'artifacts.tar'
        if receipt_path.is_symlink() or not receipt_path.is_file() or not artifact.exists():
            continue
        receipt = json_state(receipt_path)
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


def destroy_vm(config, job, deadline=None):
    vm = 'partitura-job-' + job
    environment = environment_for(config)
    def remaining():
        # owned() reserves up to twenty seconds to terminate/reap its process
        # group after a timeout. Never borrow those seconds past the pass bound.
        seconds = 45 if deadline is None else min(30, deadline - time.monotonic() - 20)
        if seconds <= 0:
            raise TimeoutError('cleanup deadline')
        return seconds
    try:
        owned([config['tart'], 'stop', vm], environment, remaining(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass  # An already stopped VM still needs deletion and its readback.
    try:
        owned([config['tart'], 'delete', vm], environment, remaining(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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


def private_directory(path):
    info = path.lstat()
    if path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise ValueError('unsafe runtime directory')


def read_state(path, limit=MAX_STATE):
    """Bounded, nonblocking, no-follow reads of broker-private state."""
    private_directory(path.parent)
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
    text = read_state(path)
    if text is None:
        return None
    value = json.loads(text, object_pairs_hook=unique_object)
    if not isinstance(value, dict):
        raise ValueError('invalid runtime state')
    return value


def fence_job(path):
    text = read_state(path)
    if text is None:
        return None
    match = re.fullmatch(rf'(?:partitura-job-)?({JOB})\n?', text)
    if not match:
        raise ValueError('invalid safety fence')
    return match[1]


def admission_epoch(config):
    path = Path(config['root']) / 'admission-epoch'
    value = read_state(path)
    if value is None or not re.fullmatch(JOB + '\n', value):
        raise ValueError('missing or invalid admission epoch')
    return value.strip()


def initialize_epoch(config):
    """Local migration only. Hard-link publication never overwrites a rotation."""
    root = Path(config['root'])
    if read_state(root / 'admission-epoch') is None:
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
            sync_directory(root)
    return admission_epoch(config)


def emit(config, kind, **fields):
    envelope = dict(protocolVersion=PROTOCOL_VERSION, hostId=config['hostId'], kind=kind, **fields)
    line = json.dumps(envelope, separators=(',', ':'), allow_nan=False) + '\n'
    if len(line.encode()) > MAX_STATE:
        raise ValueError('oversized protocol envelope')
    sys.stdout.write(line)


def runner_state(root):
    value = json_state(root / 'runner.json')
    if value is None:
        return None
    if set(value) != {'job', 'attempt', 'commit', 'action', 'stage', 'heartbeat'} or not re.fullmatch(JOB, value.get('job', '')) or not re.fullmatch(JOB, value.get('attempt', '')) or not re.fullmatch(COMMIT, value.get('commit', '')) or not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', value.get('action', '')) or value['stage'] not in ('receiving', 'capacity', 'unlock', 'clone', 'boot', 'workflow', 'artifact', 'cleanup') or type(value['heartbeat']) not in (int, float) or not 0 < value['heartbeat'] <= time.time() + 30:
        raise ValueError('invalid runner marker')
    return value


def obligations(config):
    root = Path(config['root'])
    jobs = {job for name in FENCES if (job := fence_job(root / name)) is not None}
    runner = runner_state(root)
    if runner:
        jobs.add(runner['job'])
    recovery = json_state(root / 'recovery.json')
    if recovery is not None:
        if set(recovery) != {'jobs', 'relock'} or type(recovery['relock']) is not bool or not isinstance(recovery['jobs'], list) or not 1 <= len(recovery['jobs']) <= 64 or any(not isinstance(job, str) or not re.fullmatch(JOB, job) for job in recovery['jobs']):
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
    roots = [Path(config[key]) for key in ('root', 'tartHome')]
    free = []
    for path in roots:
        info = os.statvfs(path)
        free.append(info.f_bavail * info.f_frsize)
    # APFS sibling volumes may share a pool. Never add their reported free bytes.
    if roots[0].stat().st_dev == roots[1].stat().st_dev:
        sufficient = min(free) >= DISK_FLOOR + incoming
    else:
        sufficient = free[0] >= DISK_FLOOR + incoming and free[1] >= DISK_FLOOR
    return dict(jobRootFreeBytes=free[0], tartRootFreeBytes=free[1], hostFloorBytes=DISK_FLOOR), sufficient


def require_disk(config, incoming=0):
    try:
        if not disk_space(config, incoming)[1]:
            raise OSError('insufficient disk')
    except OSError:
        raise DiskUnavailable() from None


class DiskUnavailable(Exception):
    pass


def registry_status(config, job):
    root = Path(config['root'])
    directory = root / job
    if not os.path.lexists(directory):
        return 'unknown-job', dict(job=job, tombstonePresent=read_state(root / (job + '.cancel')) is not None, inconsistentDirectory=False)
    private_directory(directory)
    receipt = json_state(directory / 'receipt.json')
    if receipt is None:
        return 'unknown-job', dict(job=job, tombstonePresent=read_state(root / (job + '.cancel')) is not None, inconsistentDirectory=True)
    if receipt.get('job') != job or receipt.get('state') not in ('receiving', 'running', *TERMINAL):
        raise ValueError('invalid job receipt')
    # Old receipt causes/host diagnostics and arbitrary future fields stay private.
    fields = {key: value for key, value in diagnostic_receipt(directory, receipt).items() if key in (
        'job', 'commit', 'action', 'attempt', 'state', 'stage', 'failureCode', 'artifactExpired', 'artifactBytes', 'artifactSha256', 'bootExitCode', 'workflowExitCode',
    )}
    if 'commit' in fields and not re.fullmatch(COMMIT, fields['commit']):
        raise ValueError('invalid receipt commit')
    if 'action' in fields and not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', fields['action']):
        raise ValueError('invalid receipt action')
    if 'attempt' in fields and not re.fullmatch(JOB, fields['attempt']):
        raise ValueError('invalid receipt attempt')
    if fields.get('stage') not in (None, 'receiving', 'disk-preflight', 'disk-post-transfer', 'capacity', 'unlock', 'clone', 'boot', 'workflow', 'artifact', 'cleanup'):
        raise ValueError('invalid receipt stage')
    if fields.get('failureCode') not in (None, 'host-disk-space-unavailable', 'host-capacity-unavailable', 'unlock-failed', 'host-key-unavailable', 'workflow-failed', 'cleanup-required', 'receive-interrupted', 'execution-interrupted'):
        raise ValueError('invalid receipt failure code')
    for name in ('artifactBytes', 'bootExitCode', 'workflowExitCode'):
        if name in fields and (type(fields[name]) is not int or not ((0 if name == 'artifactBytes' else -255) <= fields[name] <= (MAX_ARTIFACT if name == 'artifactBytes' else 255))):
            raise ValueError('invalid receipt number')
    if 'artifactSha256' in fields and not re.fullmatch('[a-f0-9]{64}', fields['artifactSha256']):
        raise ValueError('invalid artifact digest')
    if 'artifactExpired' in fields and type(fields['artifactExpired']) is not bool:
        raise ValueError('invalid artifact expiry')
    if fields.get('failureCode') == 'host-disk-space-unavailable' and (fields['state'] != 'failed' or fields.get('stage') not in ('disk-preflight', 'disk-post-transfer')):
        raise ValueError('invalid disk receipt')
    return 'known', fields


def health(config):
    root = Path(config['root'])
    fields = dict(brokerRevision=BROKER_REVISION, capabilities=['health', 'status', 'reconcile', 'run-v2'], profile=config['profile'], epoch=admission_epoch(config), status='blocked', accepting=False, capacity=0, reasons=[], jobRootFreeBytes=None, tartRootFreeBytes=None, hostFloorBytes=DISK_FLOOR)
    jobs, runner = obligations(config)
    fresh = runner is not None and time.time() - runner['heartbeat'] <= 60
    # Only a matching active-vm/unlock fence is normal for a current live runner.
    unsafe = any(fence_job(root / name) is not None for name in ('cleanup-required', 'keychain-relock-pending'))
    unrelated = bool(jobs - ({runner['job']} if runner else set()))
    if read_state(root / 'maintenance-blocked') is not None or json_state(root / 'recovery.json') is not None or unsafe or unrelated or (jobs and not fresh):
        fields['reasons'] = ['recovery-required']
        if jobs:
            fields['maintenanceJobId'] = sorted(jobs)[0]
    elif fresh:
        fields.update(status='busy', reasons=['runner-active'], runner={key: runner[key] for key in ('job', 'attempt', 'stage', 'heartbeat')})
    else:
        try:
            private_directory(root)
            private_directory(Path(config['tartHome']))
            base = Path(config['tartHome']) / 'vms' / config['base']
            if base.is_symlink() or not base.is_dir() or not os.access(root, os.W_OK):
                raise ValueError('installed input unavailable')
            values, sufficient = disk_space(config)
            fields.update(values)
            if not sufficient:
                fields['reasons'] = ['host-disk-space-unavailable']
            else:
                verify_vm_capacity()
                fields.update(status='ready', accepting=True, capacity=1)
        except OSError:
            fields['reasons'] = ['host-disk-space-unavailable']
        except (ValueError, subprocess.SubprocessError):
            fields['reasons'] = ['host-capacity-unavailable']
    if config['profile'] != 'registry-only':
        fields.update(status='blocked', accepting=False, capacity=0, reasons=['legacy-profile'])
    emit(config, 'health', **fields)
    return 0


def tombstone(config, job):
    durable_write(Path(config['root']) / (job + '.cancel'), job + '\n')


def verify_owned_clone(config, job):
    directory = Path(config['tartHome']) / 'vms' / ('partitura-job-' + job)
    if not os.path.lexists(directory):
        return False
    private_directory(directory.parent)
    private_directory(directory)
    for index, child in enumerate(directory.iterdir()):
        if index >= 64:
            raise ValueError('oversized clone inventory')
        info = child.lstat()
        if child.name not in ('config.json', 'disk.img', 'nvram.bin', 'state.json', 'control.sock', 'serial.log') or info.st_uid != os.getuid() or stat.S_ISLNK(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink != 1):
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
        return config['daemonRelockMacOSBuild'] == macos_build()
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def relock_keychain(config, deadline):
    """Bound Security.framework in an owned child, never an inferred lock owner."""
    if time.monotonic() >= deadline - 0.05:
        raise TimeoutError('relock deadline')
    child = os.fork()
    if child == 0:
        try:
            os.setsid()
            for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                signal.signal(number, signal.SIG_DFL)
            keychain = LoginKeychain(config)
            try:
                keychain.lock()
                if keychain.state() != 'locked':
                    raise KeychainError('relock-state')
            finally:
                keychain.close()
            os._exit(0)
        except BaseException:
            os._exit(1)
    try:
        while time.monotonic() < deadline - 0.05:
            pid, status = os.waitpid(child, os.WNOHANG)
            if pid:
                if status != 0:
                    raise KeychainError('relock-failed')
                return
            time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        raise TimeoutError('relock deadline')
    finally:
        # This is exactly our unreaped child, so PID reuse cannot target others.
        try:
            pid, _ = os.waitpid(child, os.WNOHANG)
            if not pid:
                os.kill(child, signal.SIGKILL)
                # A kernel-held child must leave the fence, not extend cleanup.
                while time.monotonic() < deadline:
                    if os.waitpid(child, os.WNOHANG)[0]:
                        break
                    time.sleep(min(0.01, max(0, deadline - time.monotonic())))
        except ChildProcessError:
            pass


def remove_partial_input(directory):
    path = directory / 'source.bundle'
    if os.path.lexists(path):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError('unsafe partial input')
        durable_remove(path)


def inspect_job_directory(directory):
    """An absent receipt doesn't make other private state trustworthy or safe."""
    if not os.path.lexists(directory):
        return [], False
    private_directory(directory)
    limits = {'receipt.json': MAX_STATE, 'keychain.json': MAX_STATE, 'source.bundle': MAX_BUNDLE, 'artifacts.tar': MAX_ARTIFACT, 'boot.log': MAX_BOOT_LOG, 'runner.log': MAX_BOOT_LOG, 'build.log': MAX_WORKFLOW_LOG}
    files = []
    relock = False
    for index, path in enumerate(directory.iterdir()):
        if index >= 64:
            raise ValueError('oversized job directory')
        name = path.name
        # Interrupted atomic receipt/keychain publication can leave a private
        # temporary inode. It is never an execution receipt or a success proof.
        if name in ('receipt.json.new', 'keychain.json.new') or re.fullmatch(r'\.(?:receipt|keychain)\.json\.[a-z0-9_]{8}', name):
            limit = MAX_STATE
        else:
            limit = limits.get(name)
        info = path.lstat()
        if limit is None or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > limit:
            raise ValueError('unsafe job directory object')
        files.append(path)
        if name not in ('source.bundle', 'receipt.json', 'receipt.json.new') and not name.startswith('.receipt.json.'):
            relock = True
    return files, relock


def reconcile_locked(config, requested, daemon=False, deadline=None):
    """The caller owns runner.lock. No PID or marker timestamp grants authority."""
    root = Path(config['root'])
    deadline = time.monotonic() + 120 if deadline is None else deadline
    jobs, runner = obligations(config)
    jobs |= set(requested)
    if not jobs or len(jobs) > 64:
        raise ValueError('invalid reconciliation set')
    if read_state(root / 'maintenance-blocked') is not None:
        return 'cleanup-required', sorted(jobs)
    previous_recovery = json_state(root / 'recovery.json')
    previous_cleanup = fence_job(root / 'cleanup-required')
    durable_write(root / 'recovery.json', json.dumps(dict(jobs=sorted(jobs), relock=True if previous_recovery is None else previous_recovery['relock'])) + '\n')
    # Publish a fence even for an unknown/inconsistent directory before touching it.
    durable_write(root / 'cleanup-required', sorted(jobs)[0] + '\n')
    try:
        # Validate all evidence first. Do not partly clean an untrusted state set.
        states = {}
        unlock = fence_job(root / 'unlock-attempt')
        active = fence_job(root / 'active-vm')
        pending = fence_job(root / 'keychain-relock-pending')
        relock = any((unlock, active, pending, previous_cleanup)) or bool(previous_recovery and previous_recovery['relock']) or bool(runner and runner['stage'] not in ('receiving', 'capacity'))
        for job in sorted(jobs):
            kind, receipt = registry_status(config, job)
            states[job] = kind, receipt
            _, private_unlock_evidence = inspect_job_directory(root / job)
            relock |= private_unlock_evidence
            if kind == 'known' and receipt['state'] == 'running':
                relock = True
            if verify_owned_clone(config, job):
                relock = True  # Missing-marker migration debris is conservative.
        durable_write(root / 'recovery.json', json.dumps(dict(jobs=sorted(jobs), relock=relock)) + '\n')
        for job in sorted(jobs):
            if time.monotonic() >= deadline:
                raise TimeoutError('maintenance deadline')
            directory = root / job
            if directory.exists():
                remove_partial_input(directory)
                kind, receipt = states[job]
                if kind == 'known' and receipt['state'] not in TERMINAL:
                    receipt.update(state='failed', stage='receiving' if receipt['state'] == 'receiving' else 'cleanup', failureCode='receive-interrupted' if receipt['state'] == 'receiving' else 'execution-interrupted')
                    record(directory, **receipt)
            if verify_owned_clone(config, job):
                destroy_vm(config, job, deadline=deadline)
            if os.path.lexists(Path(config['tartHome']) / 'vms' / ('partitura-job-' + job)):
                raise ValueError('owned clone remains')
        if relock:
            if daemon and not daemon_relock_qualified(config):
                durable_write(root / 'keychain-relock-pending', (unlock or active or pending or sorted(jobs)[0]) + '\n')
                return 'keychain-relock-pending', sorted(jobs)
            relock_keychain(config, deadline)
        for job in sorted(jobs):
            directory = root / job
            if states[job][0] == 'unknown-job' and directory.exists():
                files, _ = inspect_job_directory(directory)
                for path in files:
                    durable_remove(path)
                directory.rmdir()
                sync_directory(root)
        # Rotation precedes every safety-fence removal. Failed writes keep the gate.
        durable_write(root / 'admission-epoch', uuid.uuid4().hex + '\n')
        for name in (*FENCES, 'runner.json', 'recovery.json'):
            durable_remove(root / name)
        return 'reconciled', sorted(jobs)
    except Exception:
        durable_write(root / 'cleanup-required', sorted(jobs)[0] + '\n')
        return 'cleanup-required', sorted(jobs)


def reconcile(config, job):
    tombstone(config, job)
    with run_lock(config, 2) as acquired:
        if not acquired:
            runner = runner_state(Path(config['root']))
            evidence = {key: runner[key] for key in ('job', 'attempt', 'stage', 'heartbeat')} if runner else None
            emit(config, 'busy', job=job, runner=evidence)
            return 0
        result, jobs = reconcile_locked(config, [job])
        if result == 'reconciled':
            kind, _ = registry_status(config, job)
            emit(config, 'reconciled-terminal' if kind == 'known' else 'reconciled-unknown', job=job, epoch=admission_epoch(config), nonce=uuid.uuid4().hex, reconciledJobs=jobs)
            return 0
        emit(config, result, job=job)
        return 1


def inventory_obligations(config):
    jobs = set()
    root = Path(config['root'])
    for index, directory in enumerate(root.iterdir()):
        if index >= MAX_INVENTORY:
            raise ValueError('oversized job inventory')
        if re.fullmatch(JOB, directory.name):
            kind, receipt = registry_status(config, directory.name)
            if kind != 'known' or receipt['state'] not in TERMINAL or os.path.lexists(directory / 'source.bundle'):
                jobs.add(directory.name)
    vms = Path(config['tartHome']) / 'vms'
    private_directory(vms)
    for index, directory in enumerate(vms.iterdir()):
        if index >= MAX_INVENTORY:
            raise ValueError('oversized VM inventory')
        if directory.name.startswith('partitura-job-'):
            match = re.fullmatch('partitura-job-(' + JOB + ')', directory.name)
            if not match:
                raise ValueError('malformed owned VM name')
            verify_owned_clone(config, match[1])
            jobs.add(match[1])
    if len(jobs) > 64:
        raise ValueError('oversized maintenance set')
    return jobs


def boot_id():
    result = subprocess.run(['/usr/sbin/sysctl', '-n', 'kern.boottime'], check=True, capture_output=True, timeout=5)
    match = re.fullmatch(rb'\{ sec = ([0-9]{1,12}), usec = [0-9]{1,6} \}[^\n]*\n?', result.stdout[:256])
    if len(result.stdout) > 256 or not match:
        raise ValueError('invalid boot identity')
    return match[1].decode('ascii')


def maintenance_state(root, boot):
    previous = json_state(root / 'maintenance.json')
    if previous is not None and (set(previous) != {'boot', 'revision', 'failures', 'nextAt'} or not isinstance(previous['boot'], str) or not isinstance(previous['revision'], str) or type(previous['failures']) is not int or not 0 <= previous['failures'] <= 16 or type(previous['nextAt']) not in (int, float) or not 0 <= previous['nextAt'] <= time.time() + 900):
        raise ValueError('invalid maintenance state')
    inventory = previous is None or previous['boot'] != boot or previous['revision'] != BROKER_REVISION
    return previous, inventory


def record_maintenance(root, boot, failures=0):
    durable_write(root / 'maintenance.json', json.dumps(dict(boot=boot, revision=BROKER_REVISION, failures=failures, nextAt=time.time() + min(900, 60 * 2**max(0, failures - 1)) if failures else 0)) + '\n')


def local_maintenance(config):
    deadline = time.monotonic() + 120
    root = Path(config['root'])
    initialize_epoch(config)
    boot = boot_id()
    previous, inventory = maintenance_state(root, boot)
    jobs, _ = obligations(config)
    if not inventory and (not jobs or time.time() < previous['nextAt']):
        return 0
    with run_lock(config, 0) as acquired:
        if not acquired:
            return 0
        jobs, _ = obligations(config)
        try:
            if inventory:
                jobs |= inventory_obligations(config)
            result, _ = reconcile_locked(config, jobs, daemon=True, deadline=deadline) if jobs else ('idle', [])
        except Exception:
            # Inventory cannot nominate a malformed/unowned object for deletion.
            durable_write(root / 'maintenance-blocked', 'inventory-invalid\n')
            result = 'cleanup-required'
        failures = min(16, (previous or {}).get('failures', 0) + 1) if result in ('cleanup-required', 'keychain-relock-pending') else 0
        record_maintenance(root, boot, failures)
        return 1 if failures else 0


def refuse(config, request, code, persist=True):
    _, job, commit, _, action, *_ = request
    fields = dict(job=job, commit=commit, action=action, attempt=request[8], accepted=False, code=code)
    if persist:
        directory = Path(config['root']) / job
        if not os.path.lexists(directory):
            try:
                directory.mkdir(mode=0o700)
                record(directory, job=job, commit=commit, action=action, attempt=request[8], state='failed')
            except OSError:
                pass  # Full storage must still produce the identified refusal.
    emit(config, 'refused', **fields)
    return 1


def run_v2(config, request):
    if config.get('profile') != 'registry-only':
        return refuse(config, request, 'legacy-profile', persist=False)
    with run_lock(config, 5) as acquired:
        if not acquired:
            return refuse(config, request, 'host-busy', persist=False)
        # Epoch/expiry/replay precede any recovery that could rotate the epoch.
        if request[7] != admission_epoch(config):
            return refuse(config, request, 'stale-epoch')
        if not time.time() < request[9] <= time.time() + 120:
            return refuse(config, request, 'submission-expired')
        root = Path(config['root'])
        if read_state(root / (request[1] + '.cancel')) is not None:
            return refuse(config, request, 'cancelled')
        if os.path.lexists(root / request[1]):
            return refuse(config, request, 'duplicate-job', persist=False)
        if read_state(root / ('attempt-' + request[8])) is not None:
            return refuse(config, request, 'duplicate-attempt')
        if read_state(root / 'maintenance-blocked') is not None:
            return refuse(config, request, 'cleanup-required')
        jobs, _ = obligations(config)
        # Run and the boot daemon can race for the lock. Whichever wins must
        # account for missing-marker legacy debris before admitting any input.
        boot = boot_id()
        _, inventory = maintenance_state(root, boot)
        if inventory:
            try:
                jobs |= inventory_obligations(config)
            except Exception:
                durable_write(root / 'maintenance-blocked', 'inventory-invalid\n')
                return refuse(config, request, 'cleanup-required')
        if jobs:
            result, _ = reconcile_locked(config, jobs)
            if result == 'reconciled' and inventory:
                record_maintenance(root, boot)
            return refuse(config, request, 'host-reconciled' if result == 'reconciled' else result)
        if inventory:
            record_maintenance(root, boot)
        legacy = ('run', *request[1:6], request[6])
        return run_job(config, legacy, lock_held=True, attempt=request[8], expiry=request[9])


def cancel_job(config, job):
    root = Path(config['root'])
    tombstone(config, job)
    if config.get('profile') == 'registry-only':
        return
    # If the original broker is alive it owns this lock and its watcher handles
    # cancellation. Otherwise reconcile the durable fence after crash/power loss.
    with run_lock(config, 0) as acquired:
        if not acquired:
            return
        active = root / 'active-vm'
        if fence_job(active) == job:
            jobs, _ = obligations(config)
            if jobs - {job}:
                raise ValueError('multiple obligations require reconciliation')
            durable_write(root / 'cleanup-required', job + '\n')
            try:
                verify_owned_clone(config, job)
                destroy_vm(config, job)
            finally:
                keychain = LoginKeychain(config)
                try:
                    keychain.lock()
                finally:
                    keychain.close()
            directory = root / job
            if os.path.lexists(directory):
                private_directory(directory)
                receipt = json_state(directory / 'receipt.json')
                if receipt is not None and receipt.get('state') not in TERMINAL:
                    receipt.update(state='cancelled')
                    record(directory, **receipt)
                remove_partial_input(directory)
            if (root / 'admission-epoch').exists():
                durable_write(root / 'admission-epoch', uuid.uuid4().hex + '\n')
            durable_remove(active)
            for name in ('unlock-attempt', 'keychain-relock-pending'):
                if fence_job(root / name) == job:
                    durable_remove(root / name)
            runner = runner_state(root)
            if runner and runner['job'] == job:
                durable_remove(root / 'runner.json')
            durable_remove(root / 'cleanup-required')
            durable_remove(root / 'recovery.json')
        else:
            jobs, _ = obligations(config)
            if job in jobs:
                result, _ = reconcile_locked(config, [job])
                if result != 'reconciled':
                    raise ValueError('previous runner requires operator reconciliation')


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
            durable_write(self.root / 'runner.json', json.dumps(self.value) + '\n')

    def start(self):
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
    with (contextlib.nullcontext(True) if lock_held else run_lock(config, 0)) as acquired, contextlib.ExitStack() as resources:
        if not acquired:
            raise BlockingIOError('native host busy')
        if (root / 'cleanup-required').exists():
            raise ValueError('previous VM cleanup requires operator reconciliation')
        active = root / 'active-vm'
        if active.exists():
            raise ValueError('previous VM requires crash recovery')
        if any(os.path.lexists(root / name) for name in ('runner.json', 'unlock-attempt', 'keychain-relock-pending', 'recovery.json', 'maintenance-blocked')):
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
                durable_write(root / ('attempt-' + attempt), job + '\n')
            prune_artifacts(root)
            require_disk(config, length + secret_length)
            directory.mkdir(mode=0o700)
        except (DiskUnavailable, OSError):
            receipt = dict(**identity, state='failed', stage='disk-preflight', failureCode='host-disk-space-unavailable')
            try:
                directory.mkdir(mode=0o700, exist_ok=True)
                record(directory, **receipt)
            except OSError:
                pass
            if attempt is not None:
                emit(config, 'known', **receipt)
            else:
                print(json.dumps(receipt))
            return 1
        if expiry is not None and time.time() >= expiry:
            record(directory, **identity, state='failed')
            emit(config, 'refused', **identity, accepted=False, code='submission-expired')
            return 1
        bundle = directory / 'source.bundle'
        secret_input = io.BytesIO()
        marker = RunnerMarker(config, job, commit, action, attempt)
        resources.callback(secret_input.close)
        resources.callback(marker.stop)
        try:
            marker.start()  # The receiver observes cancellation before its first read.
            record(directory, **identity, state='receiving')
            if secret_length:
                receive(sys.stdin.buffer, secret_input, secret_length, seconds=30, check=marker.check)
                files = json.loads(secret_input.getvalue())
                if not isinstance(files, dict) or not 1 <= len(files) <= 16 or any(
                    not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', name) or not isinstance(value, str)
                    for name, value in files.items()
                ):
                    raise ValueError('invalid job secret files')
            with bundle.open('xb') as output:
                receive(sys.stdin.buffer, output, length, check=marker.check)
            marker.check()
        except BaseException as error:
            try:
                if marker.thread.ident is not None:
                    marker.stop()
                bundle.unlink(missing_ok=True)
                receipt = dict(**identity, state='cancelled' if cancelled.exists() else 'failed', cause=type(error).__name__, stage='receiving', failureCode='receive-interrupted')
                record(directory, **receipt)
                durable_remove(root / 'runner.json')
                if attempt is not None:
                    emit(config, 'known', **{key: value for key, value in receipt.items() if key != 'cause'})
                    return 1
            finally:
                secret_input.close()
            raise
        environment = environment_for(config)
        tart = config['tart']
        vm = 'partitura-job-' + job
        boot = None
        boot_logger = None
        stage = 'disk-post-transfer'
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
                if cancelled.exists() or marker.failed.is_set():
                    os.kill(os.getpid(), signal.SIGTERM)
                    return
        watcher = threading.Thread(target=watch_cancellation, daemon=True)
        watcher.start()
        try:
            require_disk(config)
            stage = 'capacity'
            marker.publish(stage)
            verify_vm_capacity()
            stage = 'unlock'
            marker.check()
            # Both durable fences precede *every* keychain API, including open.
            durable_write(root / 'unlock-attempt', job + '\n')
            durable_write(active, job + '\n')
            marker.publish(stage)
            keychain_attempted = True
            keychain = LoginKeychain(config)
            keychain_state = keychain.state()
            # Private host evidence only, never projected through the gateway.
            durable_write(directory / 'keychain.json', json.dumps({'preUnlockState': keychain_state}) + '\n')
            keychain.unlock()
            stage = 'clone'
            marker.publish(stage)
            clone_attempted = True
            owned([tart, 'clone', config['base'], vm], environment, 180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            prepare_clone(config, vm)
            stage = 'boot'
            marker.publish(stage)
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
            marker.publish(stage)
            record(directory, **identity, state='running')
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
            marker.publish(stage)
            size = bounded_output([tart, 'exec', vm, '/usr/bin/sudo', '-n', '-u', config['guestUser'], '/usr/bin/tar', '-C', config['guestHome'] + '/dev/agentic-scratchpads/partitura/' + job, '-cf', '-', 'artifacts'], environment, directory / 'artifacts.tar', 180)
            digest = hashlib.sha256()
            with (directory / 'artifacts.tar').open('rb') as artifact:
                for block in iter(lambda: artifact.read(65536), b''):
                    digest.update(block)
            receipt = dict(**identity, state='succeeded', artifactBytes=size, artifactSha256=digest.hexdigest())
        except BaseException as error:
            failure = error
            receipt = dict(**identity, state='cancelled' if isinstance(error, InterruptedError) and cancelled.exists() else 'failed', cause=type(error).__name__, stage=stage)
            if isinstance(error, DiskUnavailable):
                receipt['failureCode'] = 'host-disk-space-unavailable'
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
                marker.publish('cleanup')
            except OSError:
                marker.failed.set()  # The existing marker still fences failure.
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
                durable_remove(active)
                durable_remove(root / 'unlock-attempt')
            if cleanup_failed:
                durable_write(root / 'cleanup-required', vm + '\n')
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
            secret_input.close()
            marker.stop()
            if not cleanup_failed:
                durable_remove(root / 'runner.json')
        if attempt is not None:
            emit(config, 'known', **{key: value for key, value in receipt.items() if key != 'cause'})
        else:
            print(json.dumps(receipt))
        return 1 if failure or cleanup_failed else 0


def main(argv=()):
    os.umask(0o077)
    # sshd's ForceCommand supplies no argv. A remote string cannot select a
    # local-only mode, even if it spells the installed maintenance entry point.
    if argv:
        if list(argv) != ['local-maintenance'] or 'SSH_ORIGINAL_COMMAND' in os.environ or 'SSH_CONNECTION' in os.environ:
            raise ValueError('unsupported local invocation')
        return local_maintenance(load_config())
    request = parse_command(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    config = load_config()
    if request[0] in ('health', 'run-v2', 'reconcile') or config.get('profile') == 'registry-only':
        if 'hostId' not in config:
            print(json.dumps({'protocolVersion': PROTOCOL_VERSION, 'kind': 'error', 'code': 'identity-not-installed'}))
            return 1
        try:
            if request[0] == 'health':
                return health(config)
            if request[0] == 'run-v2':
                return run_v2(config, request)
            if request[0] == 'reconcile':
                return reconcile(config, request[1])
            if request[0] == 'run':
                emit(config, 'error', code='legacy-run-disabled')
                return 1
            if request[0] == 'status':
                kind, fields = registry_status(config, request[1])
                emit(config, kind, **fields)
                return 0
            if request[0] == 'cancel':
                cancel_job(config, request[1])
                emit(config, 'cancellation-requested', job=request[1])
                return 0
        except Exception:
            # Malformed state/IO is never an authenticated unknown-job result.
            emit(config, 'error', code='broker-state-unavailable')
            return 1
    if request[0] == 'run':
        return run_job(config, request)
    directory = Path(config['root']) / request[1]
    if request[0] == 'cancel':
        # A durable tombstone also fences a submission still creating its bundle.
        cancel_job(config, request[1])
        print(json.dumps({'job': request[1], 'state': 'cancellation-requested'}))
        return 0
    private_directory(directory)
    receipt = json_state(directory / 'receipt.json')
    if receipt is None:
        raise ValueError('missing job receipt')
    if request[0] == 'status':
        print(json.dumps(diagnostic_receipt(directory, receipt)))
    else:
        if not delivers_artifact(receipt):
            raise ValueError('no deliverable artifact')
        # Opaque archive bytes only. No caller path and no host extraction.
        descriptor = os.open(directory / 'artifacts.tar', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as artifact:
            info = os.fstat(artifact.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > MAX_ARTIFACT:
                raise ValueError('unsafe job artifact')
            for block in iter(lambda: artifact.read(65536), b''):
                sys.stdout.buffer.write(block)
    return 0


if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise InterruptedError('native job interrupted')
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(number, interrupted)
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as error:
        # Never echo commands, stderr, credential values or checkout output.
        print(json.dumps({'state': 'refused', 'cause': 'broker-request-refused'}))
        sys.exit(1)
