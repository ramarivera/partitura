"""The installed broker remains a reproducible, self-contained zipapp."""
import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1] / "deploy/session-sandbox"
spec = importlib.util.spec_from_file_location("build_broker", ROOT / "build-broker.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BrokerPackageTests(unittest.TestCase):
    def test_reproducible_archive_and_adjacent_firecracker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second = root / "broker.py", root / "other.py"
            builder.build(first)
            builder.build(second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with zipfile.ZipFile(first) as archive:
                names = archive.namelist()
                self.assertEqual(names, sorted(names))
                self.assertTrue(all(not name.endswith(".pyc") and "__pycache__" not in name for name in names))
                self.assertTrue(all(entry.date_time == (1980, 1, 1, 0, 0, 0) and entry.external_attr >> 16 == 0o100644 for entry in archive.infolist()))
            shutil.copyfile(ROOT / "firecracker.py", root / "firecracker.py")
            result = subprocess.run([sys.executable, "-I", str(first), "--help"], capture_output=True, text=True, cwd=root)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stderr.strip(), "unsupported broker arguments")
            probe = subprocess.run([sys.executable, "-I", "-c", "import sys; sys.path.insert(0, sys.argv[1]); from sandbox_broker import core; print(core.vm.__file__)", str(first)], capture_output=True, text=True, cwd=root, check=True)
            self.assertEqual(Path(probe.stdout.strip()), root / "firecracker.py")


if __name__ == "__main__":
    unittest.main()
