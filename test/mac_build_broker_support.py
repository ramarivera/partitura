"""Host broker contract tests. Run with TMPDIR in owned scratch storage."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import shutil
import threading
import tarfile
import time
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('broker_archive', ROOT / 'deploy/mac-build/broker_archive.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)
SOURCE = Path(os.environ['TMPDIR']) / 'broker-test.py'
SOURCE.write_bytes(archive.broker_from_directory(ROOT / 'deploy/mac-build/broker'))
import sys
sys.path.insert(0, str(SOURCE))
import partitura_broker as broker

real_verify_vm_capacity = broker.verify_vm_capacity
real_relock_keychain = broker.relock_keychain
real_boot_id = broker.boot_id
RealLoginKeychain = broker.LoginKeychain

FAKE_TART = '''#!/usr/bin/python3
import json, pathlib, shutil, sys, time
root = pathlib.Path(__file__).parent
args = sys.argv[1:]
with (root/'trace').open('a') as out: out.write(json.dumps(args)+'\\n')
scenario = (root/'scenario').read_text()
if args[0]=='clone' and scenario=='clone-failure': sys.exit(1)
if args[0]=='clone': shutil.copytree(root/'vms'/args[1], root/'vms'/args[2])
if args[0]=='run' and scenario in ('boot-failure', 'host-key-failure'):
    print('VZErrorDomain Code=-9: Failed to get current host key; Failed to create new HostKey; private fixture detail' if scenario=='host-key-failure' else 'fixture virtualization startup refusal', file=sys.stderr)
    sys.exit(42)
if args[0]=='run':
    if any(not (root/'vms'/args[1]/name).stat().st_mode & 0o200 for name in ['config.json','disk.img','nvram.bin']): sys.exit(1)
    time.sleep(120)
# Model a guest that ignores graceful shutdown. With Tart's default 30-second
# wait, owned()'s 30-second deadline kills stop before its forced-stop phase.
# An explicit shorter grace reaches that phase and makes deletion possible.
if scenario=='force-stop-required':
    if args[0]=='stop':
        grace=int(args[args.index('--timeout')+1]) if '--timeout' in args else 30
        if grace>=30: sys.exit(1)
        (root/'forced-stop').write_text(str(grace))
    if args[0]=='delete' and not (root/'forced-stop').exists(): sys.exit(1)
if args[0]=='delete' and scenario in ('cleanup-failure', 'build-cleanup-failure'): sys.exit(1)
if args[0]=='delete':
    target=root/'vms'/args[1]
    if not target.exists(): sys.exit(1)
    shutil.rmtree(target)
if args[0]=='exec' and scenario in ('boot-failure', 'host-key-failure'):  sys.exit(1)
if args[0]=='exec' and '-i' in args:
    data=sys.stdin.buffer.read()
    (root/'received').write_bytes(data)
    if scenario.startswith('build-'):
        print('fixture guest runner refusal', file=sys.stderr)
        sys.exit(3)
if args[0]=='exec' and '/usr/bin/tail' in args:
    if scenario=='build-no-log': sys.exit(1)
    sys.stdout.buffer.write(b'fixture repository build log')
if args[0]=='exec' and '/usr/bin/tar' in args: sys.stdout.buffer.write(b'opaque-guest-artifact')
'''


@contextlib.contextmanager
def preserved_shutdown_signals():
    # Each real broker handles one request, then exits. Tests reuse this process;
    # cleanup's SIG_IGN must not leak into the next fixture Tart subprocess.
    previous = {number: signal.getsignal(number) for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    try:
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


class BrokerFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mac-broker-', dir=os.environ['TMPDIR'])
        self.root = Path(self.temp.name)
        self.tart = self.root / 'tart'
        self.tart.write_text(FAKE_TART)
        self.tart.chmod(0o700)
        (self.root / 'scenario').write_text('success')
        self.config = dict(root=str(self.root), tart=str(self.tart), tartHome=str(self.root), base='sealed-native-base', guestUser='partitura', guestHome='/Users/partitura', guestRunnerSha256='b'*64, qualifierSha256='c'*64)
        base = self.root / 'vms' / self.config['base']
        base.mkdir(parents=True)
        for name in ('config.json', 'disk.img', 'nvram.bin'):
            (base / name).write_bytes(b'sealed input')
            (base / name).chmod(0o444)
        self.keychain_patch = patch.object(broker, 'LoginKeychain')
        self.keychain = self.keychain_patch.start().return_value
        self.keychain.state.return_value = 'locked'
        self.addCleanup(self.keychain_patch.stop)
        def fake_relock(_config, _deadline):
            try:
                self.keychain.lock()
                if self.keychain.state() != 'locked':
                    raise broker.KeychainError('relock-state')
            finally:
                self.keychain.close()
        self.relock_patch = patch.object(broker, 'relock_keychain', side_effect=fake_relock)
        self.relock_patch.start()
        self.addCleanup(self.relock_patch.stop)
        self.capacity_patch = patch.object(broker, 'verify_vm_capacity')
        self.capacity_patch.start()
        self.addCleanup(self.capacity_patch.stop)
        self.process_patch = patch.object(broker, 'process_start', return_value='Mon Oct 26 12:00:00 2026')
        self.process_patch.start()
        self.addCleanup(self.process_patch.stop)
        self.boot_patch = patch.object(broker, 'boot_id', return_value='fixture-boot')
        self.boot_patch.start()
        self.addCleanup(self.boot_patch.stop)
        self.disk_patch = patch.object(broker.os, 'statvfs', return_value=type('Space', (), {'f_bavail': 100 * 1024**3, 'f_frsize': 1})())
        self.disk_patch.start()
        self.addCleanup(self.disk_patch.stop)
        self.job = 'a'*32
        self.request = ('run', self.job, 'd'*40, '12', 'archive', 6)


    def tearDown(self):
        self.temp.cleanup()


    def invoke(self, prefix=b'', request=None):
        reader, writer = os.pipe()
        os.write(writer, prefix + b'bundle')
        os.close(writer)
        output = io.StringIO()
        with preserved_shutdown_signals(), os.fdopen(reader, 'rb', buffering=0) as source, patch.object(broker.sys, 'stdin', type('Input', (), {'buffer': source})()), contextlib.redirect_stdout(output):
            code = broker.run_job(self.config, request or self.request)
        return code, json.loads(output.getvalue())


    def trace(self):
        return [json.loads(line) for line in (self.root / 'trace').read_text().splitlines()]


    def old_history(self, count=2200, aged=False):
        modified = time.time() - 30 * 24 * 60 * 60 - 10
        for index in range(1, count + 1):
            job = f'{index:032x}'
            directory = self.root / job
            directory.mkdir(mode=0o700)
            receipt = directory / 'receipt.json'
            receipt.write_text(json.dumps(dict(job=job, commit='d'*40, action='archive', state='failed', cause='TimeoutError')))
            cancel = self.root / (job + '.cancel')
            cancel.touch(mode=0o600)  # Slice-1 tombstones were empty files.
            attempt = self.root / ('attempt-' + f'{index + count:032x}')
            attempt.write_text(job + '\n')
            if aged:
                for path in (receipt, cancel, attempt):
                    os.utime(path, (modified, modified))


    def archive_members(self):
        with tarfile.open(self.root / self.job / 'artifacts.tar') as archive:
            return {member.name: archive.extractfile(member).read() for member in archive.getmembers()}


    def retained_artifact(self, job, state, size, modified):
        directory = self.root / job
        directory.mkdir()
        broker.record(directory, job=job, state=state)
        artifact = directory / 'artifacts.tar'
        with artifact.open('wb') as handle:
            handle.truncate(size)
        os.utime(artifact, (modified, modified))
        return artifact



class RegistryFixture(BrokerFixture):
    def setUp(self):
        BrokerFixture.setUp(self)
        self.config.update(hostId='20faf704-1af9-4791-b023-a07843b00547', profile='registry-only', daemonRelockQualified=False, daemonRelockMacOSBuild='')
        self.epoch = broker.initialize_epoch(self.config)
        self.attempt = 'e'*32
        self.request = ('run-v2', self.job, 'd'*40, '12', 'archive', 6, 0, self.epoch, self.attempt, int(time.time()) + 100)


    def invoke(self, request=None, prefix=b''):
        reader, writer = os.pipe()
        os.write(writer, prefix + b'bundle')
        os.close(writer)
        output = io.StringIO()
        with preserved_shutdown_signals(), os.fdopen(reader, 'rb', buffering=0) as source, patch.object(broker.sys, 'stdin', type('Input', (), {'buffer': source})()), contextlib.redirect_stdout(output):
            code = broker.run_v2(self.config, request or self.request)
        value = json.loads(output.getvalue())
        self.assertEqual(value['protocolVersion'], 2)
        self.assertEqual(value['hostId'], self.config['hostId'])
        self.assertLessEqual(len(output.getvalue().encode()), 4096)
        return code, value


    def wire(self, command):
        output = io.StringIO()
        with patch.object(broker, 'load_config', return_value=self.config), patch.dict(os.environ, SSH_ORIGINAL_COMMAND=command), contextlib.redirect_stdout(output):
            code = broker.main()
        return code, json.loads(output.getvalue())


    def reconcile(self, job=None):
        return self.wire('reconcile ' + (job or self.job))


    def marker(self, job=None, age=0, stage='receiving'):
        value = dict(job=job or self.job, attempt=self.attempt, commit='d'*40, action='archive', stage=stage, heartbeat=time.time() - age)
        value['owner'] = dict(pid=12345, start='Mon Oct 26 11:00:00 2026', boot='fixture-boot')
        broker.durable_write(self.root / 'runner.json', json.dumps(value) + '\n')
        return value


    def clone(self, job=None):
        target = self.root / 'vms' / ('partitura-job-' + (job or self.job))
        shutil.copytree(self.root / 'vms' / self.config['base'], target)
        return target


    def maintenance(self, boot='fixture-boot'):
        with patch.object(broker, 'boot_id', return_value=boot):
            return broker.local_maintenance(self.config)
