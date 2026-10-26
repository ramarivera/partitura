"""Admission of untrusted ONYXIO simulator artifacts before leased install."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('simulator_artifact', ROOT / 'deploy/mac-build/simulator_artifact.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
SCRATCH = Path.home() / 'dev/agentic-scratchpads/partitura/simulator-artifact-tests'
SCRATCH.mkdir(mode=0o700, parents=True, exist_ok=True)
BINDING = dict(organizationId='org-a', runId='run-a', repository='ramarivera/onyxio', commit='a' * 40, bundleId='com.onyxio.app')


def macho(platform=7, minimum=26 << 16, cpu=MODULE.ARM64):
    return struct.pack('<IIIIIIII', 0xfeedfacf, cpu, 0, 2, 1, 24, 0, 0) + struct.pack('<IIIIII', 0x32, 24, platform, minimum, 30 << 16, 0)


def fixture():
    return [
        ('artifacts/partitura-simulator.json', json.dumps(dict(format=1, app='ONYXIO.app', **BINDING)).encode(), None),
        ('artifacts/ONYXIO.app/Info.plist', plistlib.dumps(dict(CFBundleIdentifier=BINDING['bundleId'], CFBundleExecutable='ONYXIO', CFBundlePackageType='APPL', CFBundleSupportedPlatforms=['iPhoneSimulator'], MinimumOSVersion='26.0')), None),
        ('artifacts/ONYXIO.app/ONYXIO', macho(), None),
        ('artifacts/ONYXIO.app/main.jsbundle', b'embedded release code', None),
        ('artifacts/result.json', ('{"job":"' + 'b' * 32 + '","commit":"' + BINDING['commit'] + '","action":"simulator","taskExit":0}\n').encode(), None),
    ]


class SimulatorArtifactTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=SCRATCH)
        self.addCleanup(self.temp.cleanup)
        self.scratch = Path(self.temp.name)
        self.archive = self.scratch / 'input.tar'
        self.verified = []

    def write(self, files=None, extra=None):
        with tarfile.open(self.archive, 'w') as archive:
            for name, data, link in files if files is not None else fixture():
                info = tarfile.TarInfo(name)
                info.mode = 0o755 if name.endswith('/ONYXIO') else 0o644
                if link:
                    info.type = tarfile.SYMTYPE
                    info.linkname = link
                else:
                    info.size = len(data)
                if extra:
                    extra(info)
                archive.addfile(info, None if link else io.BytesIO(data))
        return hashlib.sha256(self.archive.read_bytes()).hexdigest(), self.archive.stat().st_size

    def admit(self, receipt, **kwargs):
        return MODULE.admitted_app(self.archive, self.scratch, *receipt, kwargs.pop('binding', BINDING), kwargs.pop('runtime', '26.4'), verify=lambda app, binaries: self.verified.append((app, binaries)), **kwargs)

    def assert_rejected(self, receipt, **kwargs):
        with self.assertRaises((ValueError, tarfile.TarError)):
            with self.admit(receipt, **kwargs):
                self.fail('unsafe artifact was admitted')
        self.assertEqual(list(self.scratch.glob('simulator-*')), [])
        self.assertEqual(self.verified, [])

    def test_exact_binding_runtime_and_cleanup(self):
        with self.admit(self.write()) as app:
            self.assertTrue((app / 'main.jsbundle').is_file())
            self.assertEqual(len(self.verified), 1)
            self.assertEqual(self.verified[0][1], [app / 'ONYXIO'])
            self.assertEqual((app / 'ONYXIO').stat().st_mode & 0o777, 0o700)
            self.assertEqual(json.loads((app.parent / 'result.json').read_bytes())['commit'], BINDING['commit'])
        self.assertFalse(app.exists())
        self.assertTrue(self.archive.exists())

    def test_native_guest_receipt_must_be_bounded_regular_file(self):
        files = [entry for entry in fixture() if entry[0] != 'artifacts/result.json']
        for data, link in [(b'x' * (MODULE.MAX_METADATA + 1), None), (b'', 'ONYXIO.app/Info.plist')]:
            with self.subTest(link=link, size=len(data)):
                self.assert_rejected(self.write(files + [('artifacts/result.json', data, link)]))
        for kind in (tarfile.DIRTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            def extra(info):
                if info.name == 'artifacts/result.json':
                    info.type, info.size = kind, 0
                    info.linkname = 'artifacts/ONYXIO.app/Info.plist'
            with self.subTest(kind=kind):
                self.assert_rejected(self.write(extra=extra))

    def test_caller_failure_cleans_staging(self):
        with self.assertRaisesRegex(RuntimeError, 'install failed'):
            with self.admit(self.write()) as app:
                raise RuntimeError('install failed')
        self.assertFalse(app.exists())

    def test_digest_size_and_foreign_binding_rejected(self):
        digest, length = self.write()
        for receipt, binding in [
            (('0' * 64, length), BINDING),
            ((digest, length - 1), BINDING),
            ((digest, length + 1), BINDING),
            ((digest, length), {**BINDING, 'runId': 'foreign'}),
            ((digest, length), {**BINDING, 'commit': 'b' * 40}),
            ((digest, length), {**BINDING, 'repository': 'foreign/onyxio'}),
        ]:
            with self.subTest(receipt=receipt, binding=binding):
                self.assert_rejected(receipt, binding=binding)

    def test_traversal_aliases_and_extra_apps_rejected(self):
        for name in ['../escape', '/absolute', 'artifacts/../escape', 'artifacts/ONYXIO.app/../escape', 'artifacts//ONYXIO.app/file', 'artifacts/ONYXIO.app/a:b', 'artifacts/ONYXIO.app/._Info.plist', 'artifacts/ONYXIO.app/a\x7f', 'artifacts/OTHER.app/a', 'artifacts/onyxio.app/info.plist', 'artifacts/ONYXIO.app/Info.plist']:
            with self.subTest(name=name):
                self.assert_rejected(self.write(fixture() + [(name, b'extra', None)]))
        self.assert_rejected(self.write(fixture() + [('artifacts/ONYXIO.app/caf\u00e9', b'a', None), ('artifacts/ONYXIO.app/cafe\u0301', b'b', None)]))

    def test_unicode_resources_are_preserved(self):
        with self.admit(self.write(fixture() + [('artifacts/ONYXIO.app/caf\u00e9', b'resource', None)])) as app:
            self.assertEqual((app / 'caf\u00e9').read_bytes(), b'resource')

    def test_hardlink_device_fifo_sparse_and_extended_metadata_rejected(self):
        for kind in [tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE, tarfile.GNUTYPE_SPARSE]:
            def extra(info):
                info.type = kind
                info.linkname = 'artifacts/ONYXIO.app/Info.plist'
            with self.subTest(kind=kind):
                self.assert_rejected(self.write(extra=extra))
        for key in ['SCHILY.xattr.com.apple.quarantine', 'SCHILY.acl.access', 'GNU.sparse.map']:
            with self.subTest(key=key):
                self.assert_rejected(self.write(extra=lambda info: info.pax_headers.update({key: 'value'})))
        self.assert_rejected(self.write(extra=lambda info: setattr(info, 'mode', 0o4755)))

    def test_app_internal_links_supported_and_escaping_links_rejected(self):
        files = fixture() + [
            ('artifacts/ONYXIO.app/Frameworks/A.framework/Versions/A/A', macho(), None),
            ('artifacts/ONYXIO.app/Frameworks/A.framework/Versions/Current', b'', 'A'),
            ('artifacts/ONYXIO.app/Frameworks/A.framework/A', b'', 'Versions/Current/A'),
        ]
        with self.admit(self.write(files)) as app:
            self.assertEqual((app / 'Frameworks/A.framework/A').read_bytes(), macho())
        self.verified.clear()
        for target in ['/etc/passwd', '../../../escape', '../../partitura-simulator.json', 'missing', 'link', 'internal/../../escape']:
            with self.subTest(target=target):
                self.assert_rejected(self.write(fixture() + [('artifacts/ONYXIO.app/link', b'', target)]))

    def test_symlink_parent_write_and_non_app_targets_rejected(self):
        for files in [
            [('artifacts/ONYXIO.app/link', b'', 'real'), ('artifacts/ONYXIO.app/link/file', b'write', None)],
            [('artifacts/ONYXIO.app/link', b'', '../partitura-simulator.json')],
            [('artifacts/ONYXIO.app/real', b'file', None), ('artifacts/ONYXIO.app/link', b'', 'real/nested')],
        ]:
            with self.subTest(files=files):
                self.assert_rejected(self.write(fixture() + files))

    def test_symlinked_transfer_and_public_staging_rejected(self):
        receipt = self.write()
        target = self.scratch / 'original'
        self.archive.rename(target)
        self.archive.symlink_to(target)
        with self.assertRaises(OSError):
            with self.admit(receipt):
                self.fail('symlink accepted')
        self.archive.unlink()
        target.rename(self.archive)
        self.scratch.chmod(0o755)
        self.assert_rejected(receipt)

    def test_expansion_entry_count_and_extension_header_limits(self):
        receipt = self.write()
        for key, limit in [('MAX_EXPANDED', 10), ('MAX_MEMBERS', 2)]:
            with self.subTest(key=key), patch.object(MODULE, key, limit):
                self.assert_rejected(receipt)
        header = tarfile.TarInfo('pax')
        header.type = tarfile.XHDTYPE
        header.size = MODULE.MAX_METADATA + 1
        self.archive.write_bytes(header.tobuf() + b'\0' * 1024)
        receipt = hashlib.sha256(self.archive.read_bytes()).hexdigest(), self.archive.stat().st_size
        self.assert_rejected(receipt)

    def test_embedded_bundle_and_info_platform_required(self):
        for path in ['main.jsbundle', 'Info.plist', 'ONYXIO']:
            with self.subTest(path=path):
                self.assert_rejected(self.write([entry for entry in fixture() if entry[0] != 'artifacts/ONYXIO.app/' + path]))
        files = fixture()
        name, data, link = files[1]
        info = plistlib.loads(data)
        info['CFBundleSupportedPlatforms'] = ['iPhoneOS']
        files[1] = name, plistlib.dumps(info), link
        self.assert_rejected(self.write(files))

    def test_all_macho_code_must_be_arm64_simulator_compatible(self):
        for data in [macho(platform=2), macho(minimum=27 << 16), macho(cpu=0x01000007), macho()[:40]]:
            with self.subTest(data=data):
                files = fixture() + [('artifacts/ONYXIO.app/Frameworks/dependency.dylib', data, None)]
                self.assert_rejected(self.write(files))
        # An SDK newer than the runtime is fine; only the minimum OS is gated.
        with self.admit(self.write()) as app:
            self.assertTrue(app.exists())

    def test_fat_binary_arm64_and_device_slices(self):
        a, b = macho(cpu=0x01000007), macho()
        header = struct.pack('>II', 0xcafebabe, 2)
        header += struct.pack('>IIIII', 0x01000007, 0, 48, len(a), 0)
        header += struct.pack('>IIIII', MODULE.ARM64, 0, 48 + len(a), len(b), 0)
        self.assertEqual(MODULE.simulator_macho(header + a + b, (26, 4, 0)), 2)
        with self.assertRaises(ValueError):
            MODULE.simulator_macho(header + a + macho(platform=2), (26, 4, 0))

    def test_signature_gate_executes_without_application_code(self):
        from types import SimpleNamespace
        app = self.scratch / 'ONYXIO.app'
        for output in [b'Signature=adhoc\nTeamIdentifier=not set\n', b'Signature=adhoc\n']:
            with patch.object(MODULE.subprocess, 'run', side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(returncode=0, stderr=output)]) as run:
                MODULE.verify_signatures(app, [app / 'ONYXIO'])
                self.assertEqual(run.call_args_list[0].args[0][:4], ['/usr/bin/codesign', '--verify', '--deep', '--strict'])
        for output in [b'Signature size=123\nTeamIdentifier=TEAM\n', b'Signature=adhoc\nTeamIdentifier=TEAM\n']:
            with patch.object(MODULE.subprocess, 'run', side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(returncode=0, stderr=output)]):
                with self.assertRaises(ValueError):
                    MODULE.verify_signatures(app, [app / 'ONYXIO'])

    @unittest.skipUnless(sys.platform == 'darwin', 'requires macOS signing tools and iOS simulator SDK')
    def test_real_ad_hoc_simulator_app_is_admitted_without_launch(self):
        app = self.scratch / 'ONYXIO.app'
        app.mkdir()
        for name, data, _ in fixture():
            if name.startswith('artifacts/ONYXIO.app/'):
                (app / Path(name).name).write_bytes(data)
        source = self.scratch / 'main.c'
        source.write_text('int main(void) { return 0; }\n')
        # Python may use CLT for interpreter isolation; the simulator SDK belongs
        # to the globally selected Xcode and is only used by this user build.
        compiler_env = {key: value for key, value in os.environ.items() if key != 'DEVELOPER_DIR'}
        subprocess.run(['/usr/bin/xcrun', '--sdk', 'iphonesimulator', 'clang', '-target', 'arm64-apple-ios26.0-simulator', str(source), '-o', str(app / 'ONYXIO')], check=True, capture_output=True, timeout=60, env=compiler_env)
        subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', str(app)], check=True, capture_output=True, timeout=30)
        with tarfile.open(self.archive, 'w') as archive:
            for name, data, _ in fixture():
                if not name.startswith('artifacts/ONYXIO.app/'):
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
            archive.add(app, arcname='artifacts/ONYXIO.app')
        receipt = hashlib.sha256(self.archive.read_bytes()).hexdigest(), self.archive.stat().st_size
        with MODULE.admitted_app(self.archive, self.scratch, *receipt, BINDING, '26.4') as admitted:
            self.assertTrue((admitted / '_CodeSignature/CodeResources').is_file())


if __name__ == '__main__':
    unittest.main()
