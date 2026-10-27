"""Focused checks for the opt-in macOS native-build host setup."""
import base64
import importlib.util
import json
import hashlib
import os
import plistlib
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "partitura_native_host", ROOT / "deploy/mac-build/host_setup.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
ED25519_BLOB = (11).to_bytes(4, "big") + b"ssh-ed25519" + b"x" * 32
VALID_KEY = "ssh-ed25519 " + base64.b64encode(ED25519_BLOB).decode() + " test-key"
SCRATCH = Path(os.environ.get("TMPDIR", str(Path.home() / "dev/agentic-scratchpads/partitura/native-host-setup-tests")))
SCRATCH.mkdir(parents=True, mode=0o700, exist_ok=True)
scratch_metadata = SCRATCH.lstat()
if not stat.S_ISDIR(scratch_metadata.st_mode) or scratch_metadata.st_uid != os.getuid() or stat.S_IMODE(scratch_metadata.st_mode) != 0o700:
    raise RuntimeError(f"test scratch must be caller-owned mode 0700: {SCRATCH}")


class PartituraNativeHostTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.settings = {
            "enabled": False,
            "predecessor_manifest_sha256": "",
            "host": "generic-mac-host",
            "account": "partitura-build",
            "guest_user": "partitura",
            "authorized_key": "",
            "source": {
                "partitura_repository": "/opt/partitura",
                "broker_commit": "a" * 40,
                "broker_sha256": "b" * 64,
                "credential_writer_sha256": "f" * 64,
                "guest_runner_sha256": "c" * 64,
                "native_host_sha256": "",
                "install_host_sha256": "",
                "qualifier_source": "/opt/partitura/deploy/mac-build/qualify-base.sh",
                "qualifier_sha256": "d" * 64,
            },
            "tart": {
                "source_app": "/opt/tart.app",
                "installed_app": "/Library/Partitura/NativeBuild/tart.app",
                "executable_relative_path": "Contents/MacOS/tart",
                "sha256": "e" * 64,
            },
            "base": {
                "name": "partitura-base",
                "source_name": "macos-base",
                "source_path": "/opt/macos-base",
                "source_sha256": "",
                "dedicated_path": "/opt/partitura-native/tart/vms/partitura-base",
                "sha256": "",
                "qualification_receipt": "/Library/Partitura/NativeBuild/qualification/base.json",
                "mise_binary": "/opt/mise",
                "mise_version": "2026.10.15",
                "mise_sha256": "",
                "node_version": "24.22.1",
                "python_version": "3.13.17",
            },
            "runtime": {
                "root": "/Users/partitura-build/dev/partitura",
                "tart_home": "/opt/partitura-native/tart",
            },
        }

    def enabled_settings(self):
        config = json.loads(json.dumps(self.settings))
        config.update(enabled=True, authorized_key=VALID_KEY)
        for field in ('sha256', 'source_sha256', 'mise_sha256'):
            config['base'][field] = 'a' * 64
        for field in ('native_host_sha256', 'install_host_sha256'):
            config['source'][field] = 'b' * 64
        return config

    def test_one_or_two_keys_normalize_without_comment_identity(self):
        config = self.enabled_settings()
        self.assertEqual(MODULE.validate_settings(config)['authorized_keys'], [VALID_KEY])
        second = 'ssh-ed25519 ' + base64.b64encode(ED25519_BLOB[:-1] + b'y').decode()
        config.pop('authorized_key')
        config['authorized_keys'] = [VALID_KEY, second]
        normalized = MODULE.validate_settings(config)
        lines = MODULE.expected_host_files(normalized, (b'1',) * 6)[MODULE.ROOT_AUTHORIZED_KEYS][0].decode().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0].split(' ssh-ed25519 ')[0], lines[1].split(' ssh-ed25519 ')[0])
        for keys, error in (([], 'one or two'), ([VALID_KEY] * 3, 'one or two'), ([VALID_KEY, VALID_KEY.rsplit(' ', 1)[0] + ' another-comment'], 'duplicate')):
            config['authorized_keys'] = keys
            with self.assertRaisesRegex(MODULE.NativeHostError, error):
                MODULE.validate_settings(config)
        config['authorized_keys'] = [VALID_KEY]
        config['authorized_key'] = VALID_KEY
        with self.assertRaisesRegex(MODULE.NativeHostError, 'exactly one'):
            MODULE.validate_settings(config)

    def test_legacy_settings_preserve_installed_identity_profile_and_floor(self):
        config = MODULE.validate_settings(self.enabled_settings())
        installed = dict(MODULE.make_broker_config(config), hostId='12345678-1234-1234-1234-123456789abc', profile='registry-only', minimumFreeBytes=60 * 1024**3, daemonRelockQualified=True, daemonRelockMacOSBuild='27A123')
        def read(path):
            return installed if path == MODULE.ROOT_CONFIG else None
        with patch.object(MODULE, 'read_root_json', side_effect=read):
            resolved = MODULE.resolve_broker_policy(config)
            self.assertEqual(MODULE.make_broker_config(resolved), installed)
            self.assertEqual(resolved['broker']['protocol'], 2)
            changed = dict(resolved, broker=dict(resolved['broker'], host_id='aaaaaaaa-1234-1234-1234-123456789abc'))
            with self.assertRaisesRegex(MODULE.NativeHostError, 'conflicting'):
                MODULE.resolve_broker_policy(changed)
        with patch.object(MODULE, 'read_root_json', return_value=None):
            with self.assertRaisesRegex(MODULE.NativeHostError, 'stable host identity'):
                MODULE.resolve_broker_policy(config)
        # Existing eleven-field configs still validate and upgrade to legacy.
        installed = MODULE.make_broker_config(config)
        with patch.object(MODULE, 'read_root_json', side_effect=lambda path: installed if path == MODULE.ROOT_CONFIG else dict(schema=1, account=config['account'], hostId='12345678-1234-1234-1234-123456789abc')):
            resolved = MODULE.resolve_broker_policy(config)
            self.assertEqual(resolved['broker']['profile'], 'legacy')
            self.assertFalse(resolved['broker']['daemon_relock_qualified'])

    def test_launchdaemon_is_fixed_dedicated_account_and_ssh_policy_is_scoped(self):
        plist = plistlib.loads(MODULE.maintenance_plist('builder'))
        self.assertEqual(plist['UserName'], 'builder')
        self.assertEqual(plist['StartInterval'], 60)
        self.assertTrue(plist['RunAtLoad'])
        self.assertEqual(plist['ProgramArguments'][-3:], ['-I', str(MODULE.ROOT_BROKER), 'local-maintenance'])
        self.assertIn('-i', plist['ProgramArguments'])
        ssh = MODULE.sshd_dropin('builder')
        self.assertTrue(ssh.startswith('Match User builder\n'))
        self.assertIn('    ClientAliveInterval 15\n', ssh)
        self.assertIn('    ClientAliveCountMax 3\n', ssh)
        self.assertNotIn('Match all', ssh)

    def test_capacity_checks_actual_roots_without_summing_free_space(self):
        config = dict(account='builder', broker=dict(minimum_free_bytes=50), runtime=dict(root='/actual/jobs', tart_home='/actual/tart'))
        calls = []
        def run(argv, **kwargs):
            calls.append(argv)
            script = argv[argv.index('-c') + 1]
            with patch('sys.argv', ['capacity', '50', '/actual/jobs', '/actual/tart']), patch('os.statvfs', side_effect=lambda path: SimpleNamespace(f_bavail=40 if path.endswith('jobs') else 100, f_frsize=1)):
                with self.assertRaisesRegex(SystemExit, 'below sealed'):
                    exec(script, {})
            return subprocess.CompletedProcess(argv, 0, stdout="")
        with patch.object(MODULE, 'account_python', return_value=['python']):
            MODULE.verify_runtime_capacity(config, run)
        self.assertEqual(calls[0][-3:], ['50', '/actual/jobs', '/actual/tart'])

    def test_validation_accepts_a_second_generic_host_and_rejects_invalid_keys(self):
        config = json.loads(json.dumps(self.settings))
        config["host"] = "second-mac-host"
        config["account"] = "partitura-build-2"
        config["base"]["name"] = "partitura-base-2"
        validated = MODULE.validate_settings(config)
        broker_config = MODULE.make_broker_config(validated)
        self.assertEqual(broker_config["guestUser"], "partitura")
        self.assertEqual(broker_config["guestHome"], "/Users/partitura")
        self.assertEqual(set(broker_config), MODULE.BROKER_CONFIG_KEYS)

        config["host"] = "invalid/host"
        with self.assertRaisesRegex(MODULE.NativeHostError, "valid macOS hostname"):
            MODULE.validate_settings(config)

        config = json.loads(json.dumps(self.settings))
        config["authorized_key"] = VALID_KEY
        with self.assertRaisesRegex(MODULE.NativeHostError, "keep authorized_key empty"):
            MODULE.validate_settings(config)

    def test_enabled_requires_a_single_public_key_and_qualified_base_hash(self):
        config = json.loads(json.dumps(self.settings))
        config["enabled"] = True
        config["authorized_key"] = VALID_KEY
        config["source"]["native_host_sha256"] = "d" * 64
        config["source"]["install_host_sha256"] = "e" * 64
        with self.assertRaisesRegex(MODULE.NativeHostError, "qualified base SHA-256"):
            MODULE.validate_settings(config)

        config["base"]["sha256"] = "a" * 64
        config["base"]["source_sha256"] = "b" * 64
        config["base"]["mise_sha256"] = "c" * 64
        config["source"]["native_host_sha256"] = "d" * 64
        config["source"]["install_host_sha256"] = "e" * 64
        self.assertTrue(MODULE.validate_settings(config)["enabled"])

        config["authorized_key"] = "ssh-ed25519 YWJj test-key"
        with self.assertRaisesRegex(MODULE.NativeHostError, "blob is truncated"):
            MODULE.validate_settings(config)

    def test_disabled_check_has_no_host_side_effects(self):
        with patch.object(MODULE.subprocess, "run", side_effect=AssertionError("host command ran")):
            self.assertEqual(MODULE.check(self.settings, system="Linux"), 0)

    def test_enabled_check_refuses_non_macos_before_source_access(self):
        config = json.loads(json.dumps(self.settings))
        config["enabled"] = True
        config["authorized_key"] = VALID_KEY
        config["base"]["sha256"] = "a" * 64
        config["base"]["source_sha256"] = "b" * 64
        config["base"]["mise_sha256"] = "c" * 64
        config["source"]["native_host_sha256"] = "d" * 64
        config["source"]["install_host_sha256"] = "e" * 64
        config["base"]["source_sha256"] = "b" * 64
        config["base"]["mise_sha256"] = "c" * 64
        with patch.object(MODULE, "checked_source_blobs", side_effect=AssertionError("source read")):
            with self.assertRaisesRegex(MODULE.NativeHostError, "requires macOS"):
                MODULE.check(config, system="Linux")

    def test_qualified_base_hash_rejects_symlinks(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory) / "base"
            root.mkdir()
            (root / "disk.img").write_bytes(b"disk")
            first = MODULE.tree_sha256(root)
            self.assertEqual(first, MODULE.tree_sha256(root))
            (root / "link").symlink_to(root / "disk.img")
            with self.assertRaisesRegex(MODULE.NativeHostError, "contains a symlink"):
                MODULE.tree_sha256(root)

    def test_broker_config_and_qualification_receipt_are_readable_by_the_staging_account(self):
        config = json.loads(json.dumps(self.settings))
        config["enabled"] = True
        config["authorized_key"] = VALID_KEY
        config["base"]["sha256"] = "a" * 64
        config["base"]["source_sha256"] = "b" * 64
        config["base"]["mise_sha256"] = "c" * 64
        files = MODULE.expected_host_files(config, (b"broker", b"runner", b"qualifier", b"launcher", b"installer", b"writer"))
        self.assertEqual(files[MODULE.ROOT_CONFIG][1], 0o444)

        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            base = root / "base"
            base.mkdir()
            (base / "disk.img").write_bytes(b"sealed disk")
            dedicated = root / "dedicated"
            dedicated.mkdir()
            (dedicated / "disk.img").write_bytes(b"sealed disk")
            expected = {
                "schema": 1,
                "sourceName": config["base"]["source_name"],
                "sourceSha256": config["base"]["source_sha256"],
                "base": config["base"]["name"],
                "basePath": str(dedicated),
                "baseSha256": MODULE.tree_sha256(dedicated),
                "guestRunnerSha256": config["source"]["guest_runner_sha256"],
                "qualifierSha256": config["source"]["qualifier_sha256"],
                "miseSha256": config["base"]["mise_sha256"],
                "miseVersion": config["base"]["mise_version"],
                "nodeVersion": config["base"]["node_version"],
                "pythonVersion": config["base"]["python_version"],
                "qualificationOutput": (
                    "PARTITURA_NATIVE_BASE_QUALIFIED os=Darwin arch=arm64 "
                    f"guestUser={config['guest_user']} "
                    "developerTools=verified "
                    f"runnerSha256={config['source']['guest_runner_sha256']} "
                    f"qualifierSha256={config['source']['qualifier_sha256']} "
                    f"miseSha256={config['base']['mise_sha256']} miseVersion={config['base']['mise_version']} "
                    f"nodeVersion={config['base']['node_version']} pythonVersion={config['base']['python_version']}"
                ),
            }
            receipt = root / "receipt.json"
            receipt.write_text(json.dumps(expected))
            receipt.chmod(0o444)
            config["base"].update(
                dedicated_path=str(dedicated),
                qualification_receipt=str(receipt),
                sha256=expected["baseSha256"],
            )
            metadata = SimpleNamespace(st_mode=stat.S_IFREG | 0o444, st_uid=0)
            parent_metadata = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
            parents = set(receipt.parents)
            original_lstat = Path.lstat
            def fake_lstat(path):
                if path == receipt:
                    return metadata
                if path in parents:
                    return parent_metadata
                return original_lstat(path)

            calls = []

            def fake_run(command, **kwargs):
                calls.append((command, kwargs))
                return SimpleNamespace(stdout=f"{expected['baseSha256']}\n")

            environment = {key: value for key, value in os.environ.items() if key != "DEVELOPER_DIR"}
            with patch.dict(os.environ, environment, clear=True), patch.object(Path, "lstat", autospec=True, side_effect=fake_lstat), patch.object(MODULE.os, "access", return_value=True):
                MODULE.verify_qualified_base(config, run=fake_run)

            command, kwargs = calls[0]
            self.assertEqual(
                command[:7],
                ["/usr/bin/sudo", "--non-interactive", "-H", "-u", config["account"], "/usr/bin/python3", "-I"],
            )
            self.assertEqual(command[7], "-c")
            self.assertEqual(kwargs["cwd"], "/")
            self.assertEqual(command[9], str(dedicated))
            self.assertEqual(kwargs["timeout"], 300)

            unsafe_parent = SimpleNamespace(st_mode=stat.S_IFDIR | 0o777, st_uid=0)
            with patch.object(
                Path,
                "lstat",
                autospec=True,
                side_effect=lambda path: unsafe_parent if path == receipt.parent else fake_lstat(path),
            ), patch.object(MODULE.os, "access", return_value=True):
                with self.assertRaisesRegex(MODULE.NativeHostError, "not group/other writable"):
                    MODULE.verify_qualified_base(config)

    def test_qualifier_checks_selected_apple_tools_before_git(self):
        qualifier = (ROOT / "deploy/mac-build/qualify-base.sh").read_text()
        self.assertLess(qualifier.index("/usr/bin/xcode-select -p"), qualifier.index("/usr/bin/git --version"))
        self.assertIn("/usr/bin/xcrun --find clang", qualifier)
        self.assertIn("/usr/bin/xcrun --find make", qualifier)
        self.assertIn("developerTools=verified", qualifier)

    def test_staging_sources_and_setup_module_are_bound_to_the_exact_commit(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            repository = Path(directory) / "source"
            paths = (
                MODULE.BROKER_PATH,
                MODULE.GUEST_RUNNER_PATH,
                MODULE.NATIVE_HOST_PATH,
                MODULE.INSTALL_HOST_PATH,
                MODULE.HOST_SETUP_PATH,
                MODULE.WRITER_PATH,
            )
            for relative in paths:
                target = repository / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, target)
            qualifier = repository / "qualify-base.sh"
            shutil.copyfile(ROOT / "deploy/mac-build/qualify-base.sh", qualifier)
            subprocess.run(["/usr/bin/git", "init", str(repository)], check=True, capture_output=True)
            subprocess.run(["/usr/bin/git", "-C", str(repository), "config", "user.name", "Partitura Test"], check=True)
            subprocess.run(["/usr/bin/git", "-C", str(repository), "config", "user.email", "partitura-test@example.invalid"], check=True)
            subprocess.run(["/usr/bin/git", "-C", str(repository), "add", "."], check=True)
            subprocess.run(["/usr/bin/git", "-C", str(repository), "commit", "-m", "pin setup sources"], check=True, capture_output=True)
            commit = subprocess.check_output(
                ["/usr/bin/git", "-C", str(repository), "rev-parse", "HEAD"], text=True
            ).strip()
            config = json.loads(json.dumps(self.settings))
            config["source"].update(
                partitura_repository=str(repository),
                broker_commit=commit,
                broker_sha256=MODULE.sha256_file(repository / MODULE.BROKER_PATH),
                credential_writer_sha256=MODULE.sha256_file(repository / MODULE.WRITER_PATH),
                guest_runner_sha256=MODULE.sha256_file(repository / MODULE.GUEST_RUNNER_PATH),
                native_host_sha256=MODULE.sha256_file(repository / MODULE.NATIVE_HOST_PATH),
                install_host_sha256=MODULE.sha256_file(repository / MODULE.INSTALL_HOST_PATH),
                qualifier_source=str(qualifier),
                qualifier_sha256=MODULE.sha256_file(qualifier),
            )
            with patch.object(MODULE, "__file__", str(repository / MODULE.HOST_SETUP_PATH)):
                blobs = MODULE.checked_source_blobs(config)
                self.assertEqual(
                    blobs,
                    (
                        (repository / MODULE.BROKER_PATH).read_bytes(),
                        (repository / MODULE.GUEST_RUNNER_PATH).read_bytes(),
                        qualifier.read_bytes(),
                        (repository / MODULE.NATIVE_HOST_PATH).read_bytes(),
                        (repository / MODULE.INSTALL_HOST_PATH).read_bytes(),
                        (repository / MODULE.WRITER_PATH).read_bytes(),
                    ),
                )
                config["source"]["install_host_sha256"] = "f" * 64
                with self.assertRaisesRegex(MODULE.NativeHostError, "pinned source hash differs"):
                    MODULE.checked_source_blobs(config)

    def test_sshd_validation_uses_bounded_noninteractive_sudo(self):
        config = {"account": "partitura-build"}
        calls = []
        output = "\n".join(
            [
                f"authorizedkeysfile {MODULE.ROOT_AUTHORIZED_KEYS}",
                "passwordauthentication no",
                "kbdinteractiveauthentication no",
                "authenticationmethods publickey",
                f"forcecommand {MODULE.FORCED_COMMAND}",
                "allowtcpforwarding no",
                "allowagentforwarding no",
                "x11forwarding no",
                "permittty no",
                "permituserenvironment no",
                "clientaliveinterval 15",
                "clientalivecountmax 3",
            ]
        )

        def run(args, **kwargs):
            calls.append(args)
            self.assertEqual(kwargs.get("timeout"), 15)
            return subprocess.CompletedProcess(args, 0, stdout=output if "-T" in args else "", stderr="")

        with patch.object(Path, "read_text", return_value="Include /etc/ssh/sshd_config.d/*"):
            effective = MODULE.sshd_effective(config, run)
        MODULE.verify_effective_sshd(config, effective)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call[:3] == ["/usr/bin/sudo", "--non-interactive", "/usr/sbin/sshd"] for call in calls))

    def test_managed_updates_require_a_matching_manifest_and_unknown_files_are_preserved(self):
        config = json.loads(json.dumps(self.settings))
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            source_app = root / "source.app"
            source_exec = source_app / "Contents/MacOS/tart"
            source_exec.parent.mkdir(parents=True)
            source_exec.write_bytes(b"new signed Tart")
            installed_app = root / "installed.app"
            installed_exec = installed_app / "Contents/MacOS/tart"
            installed_exec.parent.mkdir(parents=True)
            installed_exec.write_bytes(b"old signed Tart")
            config["tart"].update(source_app=str(source_app), installed_app=str(installed_app))
            target = root / "broker.py"
            target.write_bytes(b"old reviewed broker")
            target.chmod(0o444)
            manifest_path = root / "manifest.json"
            mode = 0o444
            old_hash = hashlib.sha256(b"old reviewed broker").hexdigest()
            tart_hash = hashlib.sha256(b"old signed Tart").hexdigest()
            old_manifest = {
                "schema": 1,
                "files": {
                    str(target): {"sha256": old_hash, "mode": mode},
                    str(installed_exec): {"sha256": tart_hash, "mode": mode},
                },
            }
            manifest_path.write_text(json.dumps(old_manifest))
            manifest_path.chmod(0o444)
            files = {target: (b"new reviewed broker", mode)}
            original_lstat = Path.lstat

            def fake_lstat(path):
                if path == target:
                    return SimpleNamespace(st_mode=stat.S_IFREG | mode, st_uid=0)
                return original_lstat(path)

            with patch.object(MODULE, "read_managed_manifest", return_value=old_manifest), patch.object(
                Path, "lstat", autospec=True, side_effect=lambda path: fake_lstat(path)
            ):
                stale = MODULE.check_existing_files(
                    files,
                    config,
                    manifest_path=manifest_path,
                    tart_inspector=lambda _: (tart_hash, mode),
                )
            self.assertTrue(stale)

            with patch.object(MODULE, "read_managed_manifest", return_value=None), patch.object(
                Path, "lstat", autospec=True, side_effect=lambda path: fake_lstat(path)
            ):
                with self.assertRaisesRegex(MODULE.NativeHostError, "without a matching root-owned manifest"):
                    MODULE.check_existing_files(
                        files,
                        config,
                        manifest_path=manifest_path,
                        tart_inspector=lambda _: (hashlib.sha256(source_exec.read_bytes()).hexdigest(), mode),
                    )

    def test_writer_migration_requires_exact_frozen_manifest_and_unchanged_payloads(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            broker, writer = root / 'broker.py', root / 'credential-writer.py'
            executable = root / 'tart.app/Contents/MacOS/tart'
            executable.parent.mkdir(parents=True)
            broker.write_bytes(b'old-broker')
            broker.chmod(0o555)
            executable.write_bytes(b'old-tart')
            executable.chmod(0o755)
            manifest = {'schema': 1, 'files': {
                str(broker): {'sha256': MODULE.sha256_file(broker), 'mode': 0o555},
                str(executable): {'sha256': MODULE.sha256_file(executable), 'mode': 0o755},
            }}
            manifest_path = root / 'managed-files.json'
            manifest_path.write_text(json.dumps(manifest))
            config = json.loads(json.dumps(self.settings))
            config['predecessor_manifest_sha256'] = MODULE.sha256_file(manifest_path)
            config['tart'].update(source_app=str(executable.parents[2]), installed_app=str(executable.parents[2]), sha256=MODULE.sha256_file(executable))
            files = {broker: (b'new-broker', 0o555), writer: (b'new-writer', 0o555)}
            original_lstat = Path.lstat
            def root_owned(path):
                metadata = original_lstat(path)
                return SimpleNamespace(st_mode=metadata.st_mode, st_uid=0)
            with patch.object(MODULE, 'read_managed_manifest', return_value=manifest), patch.object(MODULE, 'ROOT_WRITER', writer), patch.object(Path, 'lstat', autospec=True, side_effect=root_owned):
                inspector = lambda _: (MODULE.sha256_file(executable), 0o755)
                self.assertTrue(MODULE.check_existing_files(files, config, manifest_path=manifest_path, tart_inspector=inspector))
                config['predecessor_manifest_sha256'] = 'f' * 64
                with self.assertRaisesRegex(MODULE.NativeHostError, 'frozen predecessor'):
                    MODULE.check_existing_files(files, config, manifest_path=manifest_path, tart_inspector=inspector)
                config['predecessor_manifest_sha256'] = MODULE.sha256_file(manifest_path)
                broker.chmod(0o755)
                broker.write_bytes(b'changed-since-review')
                broker.chmod(0o555)
                with self.assertRaisesRegex(MODULE.NativeHostError, 'predecessor payload'):
                    MODULE.check_existing_files(files, config, manifest_path=manifest_path, tart_inspector=inspector)

    def test_plist_migration_accepts_only_exact_historical_target_sets(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            broker, writer, plist, unknown = [root / name for name in ('broker', 'writer', 'plist', 'unknown')]
            executable = root / 'tart.app/Contents/MacOS/tart'
            executable.parent.mkdir(parents=True)
            for path in (broker, writer, executable):
                path.write_bytes(path.name.encode())
                path.chmod(0o555)
            config = json.loads(json.dumps(self.settings))
            config['tart'].update(source_app=str(executable.parents[2]), installed_app=str(executable.parents[2]), sha256=MODULE.sha256_file(executable))
            files = {broker: (b'new-broker', 0o555), writer: (b'writer', 0o555), plist: (b'plist', 0o644)}
            manifest_path = root / 'manifest'
            actual_lstat = Path.lstat
            def root_owned(path):
                metadata = actual_lstat(path)
                return SimpleNamespace(st_mode=metadata.st_mode, st_uid=0)
            for prior_set, accepted in (({broker, writer, executable}, True), ({broker, executable}, True), ({broker, plist, executable}, False), ({broker, writer, executable, unknown}, False)):
                with self.subTest(prior=prior_set):
                    if writer.exists(): writer.unlink()
                    if writer in prior_set:
                        writer.write_bytes(b'writer')
                        writer.chmod(0o555)
                    manifest = dict(schema=1, files={str(path): dict(sha256=MODULE.sha256_file(path) if path.exists() else 'a' * 64, mode=0o555) for path in prior_set})
                    manifest_path.write_text(json.dumps(manifest))
                    config['predecessor_manifest_sha256'] = MODULE.sha256_file(manifest_path)
                    with patch.object(MODULE, 'ROOT_WRITER', writer), patch.object(MODULE, 'ROOT_PLIST', plist), patch.object(MODULE, 'ROOT_TART_APP', executable.parents[2]), patch.object(MODULE, 'read_managed_manifest', return_value=manifest), patch.object(Path, 'lstat', autospec=True, side_effect=root_owned):
                        if accepted:
                            self.assertTrue(MODULE.check_existing_files(files, config, manifest_path=manifest_path, tart_inspector=lambda _: (MODULE.sha256_file(executable), 0o555)))
                        else:
                            with self.assertRaisesRegex(MODULE.NativeHostError, 'frozen predecessor target set'):
                                MODULE.check_existing_files(files, config, manifest_path=manifest_path)

    def test_failed_update_restores_all_managed_files_and_retry_passes_preflight(self):
        for failure in ('sshd', 'policy', 'bootstrap', 'readback'):
            for was_loaded in (False, True):
                with self.subTest(failure=failure, was_loaded=was_loaded):
                    self.exercise_install_rollback(failure, was_loaded)

    def exercise_install_rollback(self, failure, was_loaded):
        installer = (ROOT / "deploy/mac-build/install-host.sh").read_text()

        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            host = Path(directory) / "host"
            native_root = host / "Library/Partitura/NativeBuild"
            ssh_root = host / "private/etc/ssh"
            dropin = ssh_root / "sshd_config.d/90-partitura-native-build.conf"
            source_app = Path(directory) / "source-tart.app"
            source_executable = source_app / "Contents/MacOS/tart"
            installed_app = native_root / "tart.app"
            installed_executable = installed_app / "Contents/MacOS/tart"
            stage = Path(directory) / "stage"
            shims = Path(directory) / "shims"
            (host / "Library/LaunchDaemons").mkdir(parents=True)
            native_root.mkdir(parents=True)
            dropin.parent.mkdir(parents=True)
            source_executable.parent.mkdir(parents=True)
            stage.mkdir()
            shims.mkdir()
            (ssh_root / "sshd_config").write_text("Include /etc/ssh/sshd_config.d/*\n")

            old_tart = b"old signed Tart"
            new_tart = b"new signed Tart"
            source_executable.write_bytes(new_tart)
            source_executable.chmod(0o755)
            installed_executable.parent.mkdir(parents=True)
            installed_executable.write_bytes(old_tart)
            installed_executable.chmod(0o755)
            tart_sha256 = hashlib.sha256(new_tart).hexdigest()

            config = json.loads(json.dumps(self.settings))
            config["enabled"] = True
            config["authorized_key"] = VALID_KEY
            config["base"]["sha256"] = "a" * 64
            config["base"]["source_sha256"] = "b" * 64
            config["base"]["mise_sha256"] = "c" * 64
            config["source"]["native_host_sha256"] = "d" * 64
            config["source"]["install_host_sha256"] = "e" * 64
            config["tart"].update(
                source_app=str(source_app),
                installed_app=str(installed_app),
                sha256=tart_sha256,
            )
            broker_blob, runner_blob, qualifier_blob = b"new broker", b"new runner", b"new qualifier"
            with patch.object(MODULE, "ROOT_TART_APP", installed_app), patch.object(
                MODULE, "ROOT_BROKER", native_root / "broker.py"
            ), patch.object(MODULE, "ROOT_WRITER", native_root / "credential-writer.py"), patch.object(MODULE, "ROOT_CONFIG", native_root / "config.json"), patch.object(
                MODULE, "ROOT_AUTHORIZED_KEYS", native_root / "authorized_keys"
            ), patch.object(MODULE, "ROOT_SSHD_DROPIN", dropin), patch.object(MODULE, "ROOT_PLIST", host / "Library/LaunchDaemons/net.partitura.native-build-maintenance.plist"):
                files = MODULE.expected_host_files(config, (broker_blob, runner_blob, qualifier_blob, b"launcher", b"installer", b"writer"))
                expected_manifest = MODULE.expected_managed_manifest(files, config)

            for target, (payload, mode) in files.items():
                staged = stage / target.name
                staged.write_bytes(payload)
                staged.chmod(mode)
            (stage / "maintenance.plist").write_bytes(files[host / "Library/LaunchDaemons/net.partitura.native-build-maintenance.plist"][0])
            (stage / "provision.py").write_bytes((ROOT / "deploy/mac-build/provision.py").read_bytes())
            (stage / "sshd_config").write_bytes(files[dropin][0])
            (stage / "sshd_config").chmod(0o600)
            (stage / "managed-files.json").write_bytes(expected_manifest)
            (stage / "managed-files.json").chmod(0o444)
            shutil.copytree(source_app, stage / "tart.app")

            old_contents = {
                target: (f"old {target.name}".encode(), mode)
                for target, (_, mode) in files.items()
            }
            # The existing sshd policy is already current, so the post-update
            # preflight reaches the old Tart/new manifest mismatch specifically.
            old_contents[dropin] = (files[dropin][0], files[dropin][1])
            old_entries = {
                str(target): {"sha256": hashlib.sha256(payload).hexdigest(), "mode": mode}
                for target, (payload, mode) in old_contents.items()
            }
            old_entries[str(installed_executable)] = {
                "sha256": hashlib.sha256(old_tart).hexdigest(),
                "mode": 0o755,
            }
            old_manifest = json.dumps(
                {"schema": 1, "files": old_entries}, sort_keys=True, indent=2
            ).encode() + b"\n"
            for target, (payload, mode) in old_contents.items():
                target.write_bytes(payload)
                target.chmod(mode)
            manifest_path = native_root / "managed-files.json"
            manifest_path.write_bytes(old_manifest)
            manifest_path.chmod(0o444)

            daemon_state = Path(directory) / "daemon-state"
            if was_loaded:
                daemon_state.write_text('loaded')
            policy_state = Path(directory) / "policy-state"
            policy_state.write_text('old')
            fixture_state = Path(directory) / "sshd-state"
            fail_once = Path(directory) / "fail-live-sshd-once"
            fail_once.touch()
            shim_source = f'''#!/usr/bin/env python3
import hashlib
import os
from pathlib import Path
import shutil
import sys

name = Path(sys.argv[0]).name
args = sys.argv[1:]
if name == "install":
    mode = "755"
    is_directory = "-d" in args
    operands = []
    index = 0
    while index < len(args):
        if args[index] in ("-o", "-g", "-m"):
            if args[index] == "-m":
                mode = args[index + 1]
            index += 2
        elif args[index] == "-d":
            index += 1
        else:
            operands.append(args[index])
            index += 1
    if is_directory:
        for operand in operands:
            Path(operand).mkdir(parents=True, exist_ok=True)
            Path(operand).chmod(int(mode, 8))
    else:
        source, target = operands[-2:]
        shutil.copyfile(source, target)
        Path(target).chmod(int(mode, 8))
elif name == "ditto":
    operands = [argument for argument in args if argument != "--rsrc"]
    shutil.copytree(operands[0], operands[1])
elif name == "shasum":
    path = Path(args[-1])
    print(hashlib.sha256(path.read_bytes()).hexdigest(), path)
elif name == "stat":
    metadata = Path(args[-1]).stat()
    values = {{
        "%u": str(metadata.st_uid),
        "%g": str(metadata.st_gid),
        "%Lp": format(metadata.st_mode & 0o777, "o"),
    }}
    print(values[args[1]])
elif name == "sshd":
    if "-t" in args:
        count = int(Path({str(fixture_state)!r}).read_text()) if Path({str(fixture_state)!r}).exists() else 0
        count += 1
        Path({str(fixture_state)!r}).write_text(str(count))
        if count == 2 and {failure!r} == "sshd" and Path({str(fail_once)!r}).exists():
            Path({str(fail_once)!r}).unlink()
            sys.exit(1)
    elif "-T" in args:
        print("\\n".join([
            "authorizedkeysfile {native_root / "authorized_keys"}",
            "passwordauthentication no",
            "kbdinteractiveauthentication no",
            "authenticationmethods publickey",
            "forcecommand /usr/bin/python3 {native_root / "broker.py"}",
            "allowtcpforwarding no",
            "allowagentforwarding no",
            "x11forwarding no",
            "permittty no",
            "permituserenvironment no",
            "clientaliveinterval 15",
            "clientalivecountmax 3",
        ]))
elif name == "launchctl":
    state = Path({str(daemon_state)!r})
    if args[0] == 'list':
        if state.exists(): print('123 0 net.partitura.native-build-maintenance')
    elif args[0] == 'print':
        if {failure!r} == 'readback' and Path({str(policy_state)!r}).read_text() == 'new' and Path({str(fail_once)!r}).exists():
            Path({str(fail_once)!r}).unlink()
            sys.exit(1)
        sys.exit(0 if state.exists() else 113)
    elif args[0] == 'bootout':
        state.unlink()
    elif args[0] == 'bootstrap':
        if state.exists(): raise SystemExit('two daemon instances')
        state.write_text('loaded')
        if {failure!r} == 'bootstrap' and Path({str(fail_once)!r}).exists():
            Path({str(fail_once)!r}).unlink()
            sys.exit(1)
elif name == "sudo":
    state = Path({str(policy_state)!r})
    mode = args[-1]
    if mode == 'snapshot': print(state.read_text())
    elif mode == 'apply':
        state.write_text('new')
        if {failure!r} == 'policy' and Path({str(fail_once)!r}).exists():
            Path({str(fail_once)!r}).unlink()
            sys.exit(1)
    elif args[-2] == 'restore': state.write_text(args[-1])
    else: raise SystemExit('unexpected policy mode')
elif name not in ("codesign", "chown", "plutil"):
    raise SystemExit(f"unexpected fixture command: {{name}} {{args}}")
'''
            shim = shims / "fixture-command"
            shim.write_text(shim_source)
            shim.chmod(0o755)
            for command in ("install", "ditto", "shasum", "stat", "sshd", "codesign", "chown", "plutil", "launchctl", "sudo"):
                (shims / command).symlink_to(shim)

            for old_path, new_path in (
                ("/Library", str(host / "Library")),
                ("/private", str(host / "private")),
                ("/usr/bin/install", str(shims / "install")),
                ("/usr/bin/ditto", str(shims / "ditto")),
                ("/usr/bin/codesign", str(shims / "codesign")),
                ("/usr/bin/shasum", str(shims / "shasum")),
                ("/usr/bin/stat", str(shims / "stat")),
                ("/usr/sbin/sshd", str(shims / "sshd")),
                ("/usr/sbin/chown", str(shims / "chown")),
                ("/usr/bin/plutil", str(shims / "plutil")),
                ("/bin/launchctl", str(shims / "launchctl")),
                ("/usr/bin/sudo", str(shims / "sudo")),
            ):
                installer = installer.replace(old_path, new_path)

            def run_installer():
                return subprocess.run(
                    ["/bin/bash", "-euo", "pipefail", "-c", installer, "--", str(stage), tart_sha256, config["account"]],
                    capture_output=True,
                    text=True,
                    check=False,
                )

            failed_update = run_installer()
            self.assertNotEqual(failed_update.returncode, 0, failed_update.stdout + failed_update.stderr)
            self.assertEqual(installed_executable.read_bytes(), old_tart)
            self.assertEqual(daemon_state.exists(), was_loaded)
            self.assertEqual(policy_state.read_text(), "old")

            managed_paths = set(files) | {manifest_path, installed_executable}
            original_lstat = Path.lstat

            def root_owned_lstat(path):
                metadata = original_lstat(path)
                if path in managed_paths:
                    return SimpleNamespace(st_mode=metadata.st_mode, st_uid=0)
                return metadata

            def retry_preflight():
                tart_inspector = lambda _: (
                    hashlib.sha256(installed_executable.read_bytes()).hexdigest(),
                    stat.S_IMODE(installed_executable.stat().st_mode),
                )
                with patch.object(Path, "lstat", autospec=True, side_effect=root_owned_lstat), patch.object(
                    MODULE, "ROOT_TART_APP", installed_app
                ):
                    return MODULE.check_existing_files(
                        files,
                        config,
                        manifest_path=manifest_path,
                        tart_inspector=tart_inspector,
                    )

            self.assertTrue(retry_preflight(), "restored prior state should allow a normal update retry")
            for target, (payload, _) in old_contents.items():
                self.assertEqual(target.read_bytes(), payload)
            self.assertEqual(json.loads(manifest_path.read_text()), json.loads(old_manifest))

            retry = run_installer()
            self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)
            self.assertEqual(installed_executable.read_bytes(), new_tart)
            self.assertTrue(daemon_state.exists())
            self.assertEqual(policy_state.read_text(), "new")
            self.assertFalse(retry_preflight(), "successful retry should match the new manifest")

    def test_installer_validates_live_sshd_and_restores_the_dropin_on_failure(self):
        installer = (ROOT / "deploy/mac-build/install-host.sh").read_text()
        swap = installer.index('/bin/mv -f "$dropin.new" "$dropin"')
        live_check = installer.index('/usr/sbin/sshd -t', swap)
        completion = installer.index("completed=1", live_check)
        self.assertLess(swap, live_check)
        self.assertLess(live_check, completion)
        manifest_backup = installer.index(
            "backup_managed_file manifest /Library/Partitura/NativeBuild/managed-files.json"
        )
        manifest_install = installer.index('atomic_install "$stage/managed-files.json"')
        self.assertLess(manifest_backup, manifest_install)
        self.assertIn(
            "restore_managed_file manifest /Library/Partitura/NativeBuild/managed-files.json",
            installer,
        )


if __name__ == "__main__":
    unittest.main()
