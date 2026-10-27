"""The pinned broker source builds the same runnable, single-file artifact."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('broker_archive_test', ROOT / 'deploy/mac-build/broker_archive.py')
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)


class BrokerArchiveTests(unittest.TestCase):
    def test_repeated_builds_are_identical_and_have_fixed_metadata(self):
        source = ROOT / 'deploy/mac-build/broker'
        first = archive.broker_from_directory(source)
        second = archive.broker_from_directory(source)
        self.assertEqual(first, second)
        self.assertEqual(hashlib.sha256(first).hexdigest(), hashlib.sha256(second).hexdigest())
        with zipfile.ZipFile(io.BytesIO(first)) as result:
            self.assertEqual(result.namelist(), sorted(archive.BROKER_FILES))
            for entry in result.infolist():
                self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(entry.external_attr >> 16, 0o100644)

    def test_artifact_runs_as_python_script_without_a_host(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            artifact = Path(directory) / 'broker.py'
            artifact.write_bytes(archive.broker_from_directory(ROOT / 'deploy/mac-build/broker'))
            env = dict(os.environ, SSH_ORIGINAL_COMMAND='unsupported')
            result = subprocess.run([sys.executable, '-I', str(artifact)], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout), {'state': 'refused', 'cause': 'broker-request-refused'})
            self.assertEqual(result.stderr, '')


if __name__ == '__main__':
    unittest.main()
