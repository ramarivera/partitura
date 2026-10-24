#!/usr/bin/env python3
"""Installed SSH forced command. Caller code executes only inside a disposable VM."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import threading
import time

CONFIG = Path('/Library/Partitura/NativeBuild/config.json')
MAX_BUNDLE = 1024 * 1024 * 1024
MAX_ARTIFACT = 2 * MAX_BUNDLE
JOB = r'[a-f0-9]{32}'
COMMIT = r'[a-f0-9]{40}'
RUN = re.compile(rf'run ({JOB}) ({COMMIT}) ([1-9][0-9]{{0,7}}) (archive|native-smoke) ([1-9][0-9]{{0,9}})')
READ = re.compile(rf'(status|artifact|cancel) ({JOB})')


def parse_command(command):
    match = RUN.fullmatch(command)
    if match:
        job, commit, pr, action, length = match.groups()
        if int(length) > MAX_BUNDLE:
            raise ValueError('bundle exceeds limit')
        return ('run', job, commit, pr, action, int(length))
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
    if set(config) != {'tart', 'tartSha256', 'base', 'root', 'tartHome', 'guestRunnerSha256', 'qualifierSha256'}:
        raise ValueError('invalid installed configuration')
    tart = sealed(config['tart'])
    if hashlib.sha256(tart.read_bytes()).hexdigest() != config['tartSha256']:
        raise ValueError('installed Tart digest differs')
    for key in ('guestRunnerSha256', 'qualifierSha256', 'tartSha256'):
        if not re.fullmatch('[a-f0-9]{64}', config[key]):
            raise ValueError('invalid installed digest')
    if not re.fullmatch('[a-z0-9][a-z0-9-]{1,80}', config['base']):
        raise ValueError('invalid sealed base name')
    for key in ('root', 'tartHome'):
        path = Path(config[key])
        info = path.lstat()
        if not path.is_absolute() or path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('unsafe private runtime directory')
    return config


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


def owned(arguments, environment, timeout, **kwargs):
    child = subprocess.Popen(arguments, env=environment, start_new_session=True, **kwargs)
    try:
        code = child.wait(timeout=timeout)
        if code:
            raise subprocess.CalledProcessError(code, arguments)
    finally:
        stop(child)


def bounded_output(arguments, environment, destination, timeout):
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
                if size > MAX_ARTIFACT:
                    raise ValueError('artifact exceeds limit')
                output.write(chunk)
        if child.wait(timeout=max(1, deadline - time.monotonic())):
            raise ValueError('artifact transfer failed')
    finally:
        stop(child)
        child.stdout.close()
    return size


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


def environment_for(config):
    return {'HOME': str(Path.home()), 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'TART_HOME': config['tartHome']}


def destroy_vm(config, job):
    vm = 'partitura-job-' + job
    environment = environment_for(config)
    try:
        owned([config['tart'], 'stop', vm], environment, 45, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass  # An already stopped VM still needs deletion and its readback.
    owned([config['tart'], 'delete', vm], environment, 45, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
            destroy_vm(config, job)
            active.unlink()
            (root / 'cleanup-required').unlink(missing_ok=True)
            directory = root / job
            if (directory / 'receipt.json').exists():
                receipt = json.loads((directory / 'receipt.json').read_text())
                receipt.update(state='cancelled')
                record(directory, **receipt)


def run_job(config, request):
    _, job, commit, pr, action, length = request
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
        directory.mkdir(mode=0o700)
        record(directory, job=job, commit=commit, action=action, state='receiving')
        bundle = directory / 'source.bundle'
        with bundle.open('xb') as output:
            receive(sys.stdin.buffer, output, length)
        if cancelled.exists():
            bundle.unlink()
            record(directory, job=job, commit=commit, action=action, state='cancelled')
            raise ValueError('native job was cancelled while receiving')
        environment = environment_for(config)
        tart = config['tart']
        vm = 'partitura-job-' + job
        boot = None
        clone_attempted = False
        failure = None
        cleanup_failed = False
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
            clone_attempted = True
            owned([tart, 'clone', config['base'], vm], environment, 180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            boot = subprocess.Popen([tart, 'run', vm, '--no-graphics', '--no-audio', '--no-usb-accessories', '--no-clipboard'], env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
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
            record(directory, job=job, commit=commit, action=action, state='running')
            # The fixed installed guest runner verifies its own sealed qualifier,
            # receives a Git bundle, and never uses host mounts or credentials.
            with bundle.open('rb') as source:
                owned([tart, 'exec', '-i', vm, '/usr/bin/sudo', '-n', '-u', 'previewrunner', '/usr/bin/env', '-i', 'HOME=/Users/previewrunner', 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', '/bin/bash', '/Library/Partitura/NativeBuild/run.sh', job, commit, pr, action, config['guestRunnerSha256'], config['qualifierSha256']], environment, 2700, stdin=source, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            size = bounded_output([tart, 'exec', vm, '/usr/bin/sudo', '-n', '-u', 'previewrunner', '/usr/bin/tar', '-C', '/Users/previewrunner/dev/agentic-scratchpads/partitura/' + job, '-cf', '-', 'artifacts'], environment, directory / 'artifacts.tar', 180)
            digest = hashlib.sha256()
            with (directory / 'artifacts.tar').open('rb') as artifact:
                for block in iter(lambda: artifact.read(65536), b''):
                    digest.update(block)
            receipt = dict(job=job, commit=commit, action=action, state='succeeded', artifactBytes=size, artifactSha256=digest.hexdigest())
        except BaseException as error:
            failure = error
            receipt = dict(job=job, commit=commit, action=action, state='failed', cause=type(error).__name__)
        finally:
            ignore_shutdown_signals()
            finished.set()
            watcher.join(timeout=2)
            stop(boot)
            if clone_attempted:
                try:
                    destroy_vm(config, job)
                    active.unlink(missing_ok=True)
                except Exception:
                    cleanup_failed = True
            if cleanup_failed:
                (root / 'cleanup-required').write_text(vm + '\n')
                receipt.update(state='failed', cause='cleanup-required')
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
        print(json.dumps(receipt))
    else:
        if receipt['state'] != 'succeeded':
            raise ValueError('no successful artifact')
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
