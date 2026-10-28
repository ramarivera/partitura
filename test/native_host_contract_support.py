"""Focused checks for the opt-in macOS native-build host setup."""
import base64
import contextlib
import io
import importlib.util
import json
import hashlib
import os
import plistlib
from pathlib import Path
import shutil
import stat
import subprocess
import sys
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
SCRATCH = Path((os.environ.get("TMPDIR") or str(Path.home() / "dev/agentic-scratchpads/partitura/builder-registry-impl/python-tests")))
SCRATCH.mkdir(parents=True, mode=0o700, exist_ok=True)
scratch_metadata = SCRATCH.lstat()
if not stat.S_ISDIR(scratch_metadata.st_mode) or scratch_metadata.st_uid != os.getuid() or stat.S_IMODE(scratch_metadata.st_mode) != 0o700:
    raise RuntimeError(f"test scratch must be caller-owned mode 0700: {SCRATCH}")


class NativeHostFixture:
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


    def exercise_install_rollback(self, failure, was_loaded, corrupt_restored=False):
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
        "%l:%Su:%Lp": str(metadata.st_nlink) + ":" + {self.settings["account"]!r} + ":" + format(metadata.st_mode & 0o777, "o"),
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
        pass # Login domain is empty even if the system daemon is loaded.
    elif args[0] == 'print':
        assert args[1] == 'system/net.partitura.native-build-maintenance'
        if {failure!r} == 'readback' and Path({str(daemon_state)!r}).exists() and Path({str(fixture_state)!r}).exists() and int(Path({str(fixture_state)!r}).read_text()) >= 2 and Path({str(fail_once)!r}).exists():
            Path({str(fail_once)!r}).unlink()
            sys.exit(1)
        if not state.exists():
            print('Could not find service', file=sys.stderr)
            sys.exit(113)
    elif args[0] == 'bootout':
        state.unlink()
    elif args[0] == 'bootstrap':
        if state.exists(): raise SystemExit('two daemon instances')
        state.write_text('loaded')
        if {failure!r} == 'bootstrap' and Path({str(fail_once)!r}).exists():
            Path({str(fail_once)!r}).unlink()
            sys.exit(1)
elif name == "sudo":
    raise SystemExit('securityd denies keychain access in sudo context')
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
                # Drive the actual root wrapper's exit-75 branch, including its
                # real predecessor verifier, guard protocol and fence release.
                loader = importlib.util.spec_from_file_location('rollback_launcher', ROOT / 'deploy/mac-build/native_host.py')
                launcher = importlib.util.module_from_spec(loader)
                loader.loader.exec_module(launcher)
                runtime, tart = Path(directory) / 'runtime', Path(directory) / 'runtime-tart'
                runtime.mkdir(mode=0o700, exist_ok=True)
                (tart / 'vms').mkdir(parents=True, exist_ok=True)
                guard_config = dict(root=str(runtime), tartHome=str(tart), hostId='12345678-1234-1234-1234-123456789abc', profile='legacy')
                payloads = {'config.json': json.dumps(guard_config).encode(), 'provision.py': (ROOT / 'deploy/mac-build/provision.py').read_bytes(), 'broker.py': MODULE.broker_from_directory(ROOT / 'deploy/mac-build/broker')}
                stage.chmod(0o700)
                script = stage / 'install-host.sh'
                if script.exists(): script.chmod(0o600)
                script.write_text(installer)
                script.chmod(0o500)
                popen, run = subprocess.Popen, subprocess.run
                result = None
                def fake_sudo(args, **kwargs):
                    if args[0] == '/usr/bin/sudo':
                        start = args.index('-c')
                        return popen([sys.executable, '-I', *args[start:]], **kwargs)
                    return popen(args, **kwargs)
                def transaction(args, **kwargs):
                    nonlocal result
                    if args[0] == '/usr/bin/ditto':
                        shutil.copytree(args[-2], args[-1])
                        return subprocess.CompletedProcess(args, 0)
                    self.assertEqual(args[0], '/bin/bash')
                    # Run the actual transaction against the fixture payloads;
                    # its platform commands are the shims above.
                    result = run(['/bin/bash', '-euo', 'pipefail', '-c', installer, '--', str(stage), tart_sha256, config['account']], capture_output=True, text=True, pass_fds=kwargs['pass_fds'])
                    if result.returncode == 75 and corrupt_restored:
                        target = next(iter(old_contents))
                        target.write_bytes(b'rollback payload drift')
                    return result
                actual_lstat, actual_fstat = Path.lstat, os.fstat
                def root_metadata(info):
                    values = list(info)
                    values[4] = 0
                    return os.stat_result(values)
                targets = {str(path): path.name for path in old_contents}
                argv = ['--stage', str(stage), '--account', config['account'], '--tart-sha256', tart_sha256, '--manifest-sha256', 'a'*64, '--apply']
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(launcher.subprocess, 'Popen', side_effect=fake_sudo))
                    stack.enter_context(patch.object(launcher.subprocess, 'run', side_effect=transaction))
                    stack.enter_context(patch.object(launcher.os, 'uname', return_value=SimpleNamespace(sysname='Darwin')))
                    stack.enter_context(patch.object(launcher.os, 'geteuid', return_value=0))
                    stack.enter_context(patch.object(Path, 'lstat', lambda path: root_metadata(actual_lstat(path))))
                    stack.enter_context(patch.object(launcher.os, 'fstat', lambda fd: root_metadata(actual_fstat(fd))))
                    stack.enter_context(patch.object(launcher, 'untrusted_root_interpreter', return_value=None))
                    stack.enter_context(patch.object(launcher, 'root_scratch_directory', return_value=Path(directory)))
                    stack.enter_context(patch.object(launcher, 'verified_payloads', return_value=payloads))
                    stack.enter_context(patch.object(launcher, 'ensure_identity'))
                    stack.enter_context(patch.object(launcher, 'INSTALL_HOST_SHA256', hashlib.sha256(script.read_bytes()).hexdigest()))
                    stack.enter_context(patch.object(launcher, 'MANIFEST_PATH', manifest_path))
                    stack.enter_context(patch.object(launcher, 'STAGED_FILES', targets))
                    stack.enter_context(patch.object(launcher, 'TART_TARGET', str(installed_executable)))
                    stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
                    code = launcher.main(argv)
                self.assertIsNotNone(result)
                self.assertEqual(code, 0 if result.returncode == 0 else 1)
                self.assertEqual((runtime / 'cleanup-required').exists(), corrupt_restored)
                self.assertEqual((runtime / 'maintenance-blocked').exists(), corrupt_restored)
                return result

            failed_update = run_installer()
            self.assertEqual(failed_update.returncode, 75, failed_update.stdout + failed_update.stderr)
            if corrupt_restored:
                return # The real verifier rejected drift and retained both fences.
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
            self.assertEqual(policy_state.read_text(), "old")
            self.assertFalse(retry_preflight(), "successful retry should match the new manifest")
