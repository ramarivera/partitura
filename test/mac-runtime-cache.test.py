"""Safety boundary for transferring host-prepared runtimes into a generic guest."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'runtime_cache', Path(__file__).parents[1] / 'deploy/mac-build/runtime_cache.py'
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
NODE = 'installs/node/24.22.1'
PYTHON = 'installs/python/3.13.17'


class RuntimeCacheTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.archive = Path(self.directory.name) / 'cache.tar'

    def write_archive(self, extra=(), omit_python=False):
        with tarfile.open(self.archive, 'w') as archive:
            for name in [NODE + '/bin/node'] + ([] if omit_python else [PYTHON + '/bin/python3']):
                entry = tarfile.TarInfo(name)
                entry.mode = 0o755
                entry.size = 3
                archive.addfile(entry, io.BytesIO(b'bin'))
            for entry in extra:
                archive.addfile(entry, io.BytesIO(b'x' * entry.size) if entry.isfile() else None)
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def validate(self, digest):
        module.validate_archive(self.archive, digest, '24.22.1', '3.13.17')

    def test_accepts_only_pinned_runtimes_with_internal_symlinks(self):
        link = tarfile.TarInfo(PYTHON + '/bin/python')
        link.type = tarfile.SYMTYPE
        link.linkname = 'python3'
        self.validate(self.write_archive([link]))

    def test_rejects_operator_metadata_traversal_and_duplicate_paths(self):
        for name in ['fnox.toml', 'installs/node/latest', '../outside', '/etc/passwd', NODE + '/bin/node']:
            with self.subTest(name=name):
                with self.assertRaises(ValueError):
                    self.validate(self.write_archive([tarfile.TarInfo(name)]))

    def test_rejects_escaping_symlinks_hardlinks_and_special_files(self):
        for kind, target in [(tarfile.SYMTYPE, '../../../../etc/passwd'), (tarfile.SYMTYPE, '/etc/passwd'), (tarfile.LNKTYPE, NODE + '/bin/node'), (tarfile.FIFOTYPE, '')]:
            with self.subTest(kind=kind, target=target):
                entry = tarfile.TarInfo(NODE + '/bin/other')
                entry.type, entry.linkname = kind, target
                with self.assertRaises(ValueError):
                    self.validate(self.write_archive([entry]))

    def test_rejects_descendants_of_symlinks_regardless_of_archive_order(self):
        link = tarfile.TarInfo(NODE + '/share')
        link.type, link.linkname = tarfile.SYMTYPE, 'lib'
        child = tarfile.TarInfo(NODE + '/share/file')
        for entries in [[link, child], [child, link]]:
            with self.assertRaisesRegex(ValueError, 'child beneath a symlink'):
                self.validate(self.write_archive(entries))

    def test_rejects_missing_runtime_mismatched_hash_and_symlink_archive(self):
        digest = self.write_archive(omit_python=True)
        with self.assertRaisesRegex(ValueError, 'missing a required executable'):
            self.validate(digest)
        with self.assertRaisesRegex(ValueError, 'differs from its pin'):
            self.validate('0' * 64)
        link = self.archive.with_name('link.tar')
        link.symlink_to(self.archive)
        with self.assertRaisesRegex(ValueError, 'regular archive'):
            module.validate_archive(link, digest, '24.22.1', '3.13.17')


if __name__ == '__main__':
    unittest.main()
