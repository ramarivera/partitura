"""Host installation ownership, idempotence and transactional update tests."""
import importlib.util
import hashlib
import io
import os
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "deploy/session-sandbox/install-host.py"
spec = importlib.util.spec_from_file_location("session_sandbox_host", SOURCE)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class HostTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "root"
        (self.root / "run").mkdir(parents=True)
        self.kernel = self.base / "vmlinux"
        self.kernel.write_bytes(b"ELF guest kernel")
        self.rootfs = self.base / "rootfs.ext4"
        self.rootfs.write_bytes(b"guest disk")
        self.archive = self.base / "release.tgz"
        with tarfile.open(self.archive, "w:gz") as archive:
            for name in ("firecracker", "jailer"):
                entry = tarfile.TarInfo(f"release-v{host.VERSION}-x86_64/{name}-v{host.VERSION}-x86_64")
                blob = name.encode()
                entry.size = len(blob)
                archive.addfile(entry, io.BytesIO(blob))
        self.server = self.base / "sftp-server"
        self.server.write_bytes(b"sftp")
        self.uid = os.getuid()

    def install(self):
        binary_pins = {name: hashlib.sha256(name.encode()).hexdigest() for name in ("firecracker", "jailer")}
        with patch.object(host, "BINARY_HASHES", binary_pins), patch.object(host, "RELEASE_SHA256", host.digest(self.archive)), patch.object(host, "sftp_files", return_value={host.SFTP_ROOT / "usr/lib/ssh/sftp-server": self.server}):
            return host.install(self.archive, self.kernel, host.digest(self.kernel), self.rootfs,
                                host.digest(self.rootfs), self.server, root=self.root, uid=self.uid)

    def test_installs_then_repeats_without_replacing_files(self):
        self.assertTrue(self.install())
        kernel = self.root / "opt/partitura-sandbox/vmlinux"
        inode = kernel.stat().st_ino
        self.assertFalse(self.install())
        self.assertEqual(kernel.stat().st_ino, inode)
        self.assertEqual((self.root / "var/lib/partitura-vms").stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / "opt/partitura-sandbox/rootfs.ext4").stat().st_mode & 0o777, 0o444)
        host.load_manifest(self.root, uid=self.uid)
        self.assertFalse((self.root / "usr/lib/partitura-sandbox/managed-files.json").exists())
        binary_pins = {name: hashlib.sha256(name.encode()).hexdigest() for name in ("firecracker", "jailer")}
        with patch.object(host, "BINARY_HASHES", binary_pins), patch.object(host, "sftp_files", return_value={host.SFTP_ROOT / "usr/lib/ssh/sftp-server": self.server}):
            self.assertTrue(host.check_host(host.digest(self.kernel), host.digest(self.rootfs), self.server, root=self.root, uid=self.uid))
            self.assertFalse(host.check_host("a" * 64, host.digest(self.rootfs), self.server, root=self.root, uid=self.uid))

    def test_refuses_unmanaged_file_and_symlink_parent_before_writes(self):
        (self.root / "usr/local/bin").mkdir(parents=True)
        (self.root / "usr/local/bin/firecracker").write_bytes(b"operator binary")
        with self.assertRaisesRegex(host.InstallError, "unmanaged"):
            self.install()
        self.assertFalse((self.root / "opt").exists())
        (self.root / "usr/local/bin/firecracker").unlink()
        (self.root / "opt").symlink_to(self.base)
        with self.assertRaisesRegex(host.InstallError, "directory"):
            self.install()
        self.assertFalse((self.base / "partitura-sandbox").exists())

    def test_rejects_tampered_installed_file_before_update(self):
        self.install()
        kernel = self.root / "opt/partitura-sandbox/vmlinux"
        kernel.chmod(0o644)
        kernel.write_bytes(b"modified")
        kernel.chmod(0o444)
        self.rootfs.write_bytes(b"new disk")
        with self.assertRaisesRegex(host.InstallError, "differs from manifest"):
            self.install()
        self.assertEqual((self.root / "opt/partitura-sandbox/rootfs.ext4").read_bytes(), b"guest disk")

    def test_update_preserves_previous_install_when_replace_fails(self):
        self.install()
        manifest = self.root / host.MANIFEST.relative_to("/")
        old_manifest = manifest.read_bytes()
        self.kernel.write_bytes(b"new kernel")
        self.rootfs.write_bytes(b"new disk")
        replace = os.replace
        counter = 0
        def fail_once(source, target):
            nonlocal counter
            if str(source).split("/")[-1].startswith(".partitura-install-"):
                counter += 1
                if counter == 2:
                    raise OSError("injected write failure")
            return replace(source, target)
        with patch.object(host.os, "replace", side_effect=fail_once):
            with self.assertRaisesRegex(OSError, "injected"):
                self.install()
        self.assertEqual(manifest.read_bytes(), old_manifest)
        self.assertEqual((self.root / "opt/partitura-sandbox/vmlinux").read_bytes(), b"ELF guest kernel")
        host.load_manifest(self.root, uid=self.uid)

    def test_rejects_hash_mismatch_before_any_writes(self):
        with self.assertRaisesRegex(host.InstallError, "SHA-256"):
            host.release_binaries(self.archive)
        self.assertFalse((self.root / "opt").exists())

    def test_ldd_dependencies_are_copied_to_original_jail_paths(self):
        output = f"libtest.so => {self.server} (0x01)\n"
        fake_run = lambda *args, **kwargs: SimpleNamespace(stdout=output)
        files = host.sftp_files(self.server, uid=self.uid, run=fake_run)
        self.assertEqual(files[host.SFTP_ROOT / str(self.server).lstrip("/")], self.server)
        with self.assertRaisesRegex(host.InstallError, "unresolved"):
            host.sftp_files(self.server, uid=self.uid, run=lambda *args, **kwargs: SimpleNamespace(stdout="libtest.so => not found"))


if __name__ == "__main__":
    unittest.main()
