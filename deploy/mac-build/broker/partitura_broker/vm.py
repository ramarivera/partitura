"""Native build broker: vm."""
from __future__ import annotations


import hashlib
import os
from pathlib import Path
import select
import signal
import stat
import subprocess
import tarfile
import threading
import time


import partitura_broker as api

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
    remaining = api.MAX_BOOT_LOG
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
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > api.MAX_BOOT_LOG:
                return result
            diagnostic = source.read(api.MAX_BOOT_LOG + 1)
        if len(diagnostic) <= api.MAX_BOOT_LOG and all(marker in diagnostic for marker in (
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
        drain = threading.Thread(target=api.capture_boot_log, args=(child.stderr, stderr_log), daemon=True)
        drain.start()
    try:
        code = child.wait(timeout=timeout)
        if code:
            raise subprocess.CalledProcessError(code, arguments)
    finally:
        api.stop(child)
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


def bounded_output(arguments, environment, destination, timeout, limit=api.MAX_ARTIFACT):
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
        api.stop(child)
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
        api.bounded_output([config['tart'], 'exec', vm, '/usr/bin/sudo', '-n', '-u', config['guestUser'], '/usr/bin/tail', '-c', str(api.MAX_WORKFLOW_LOG), guest_log], environment, build, 60, api.MAX_WORKFLOW_LOG)
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
