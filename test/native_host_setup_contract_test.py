from native_host_contract_support import *

class PartituraNativeHostTest(NativeHostFixture, unittest.TestCase):
    def test_policy_check_never_accesses_keychain_and_only_absent_system_service_needs_installation(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args, 113, stdout='', stderr='Could not find service "net.partitura.native-build-maintenance" in domain for system')
        self.assertFalse(MODULE.verify_host_policy({}, run))
        self.assertEqual(calls, [['/bin/launchctl', 'print', 'system/' + MODULE.MAINTENANCE_LABEL]])
        def denied(args, **kwargs):
            return subprocess.CompletedProcess(args, 5, stdout='', stderr='permission denied')
        with self.assertRaisesRegex(MODULE.NativeHostError, 'cannot read system'):
            MODULE.verify_host_policy({}, denied)


    def test_current_files_with_incomplete_installation_fence_never_report_success(self):
        import contextlib
        config = MODULE.validate_settings(self.enabled_settings())
        with contextlib.ExitStack() as stack:
            for name in ('checked_source_blobs', 'verify_tart_source', 'verify_qualified_base', 'verify_account', 'verify_private_runtime', 'verify_runtime_capacity', 'sshd_effective', 'expected_host_files'):
                stack.enter_context(patch.object(MODULE, name))
            stack.enter_context(patch.object(MODULE, 'resolve_broker_policy', return_value=config))
            stack.enter_context(patch.object(MODULE, 'check_existing_files', return_value=False))
            stack.enter_context(patch.object(MODULE, 'installation_pending', return_value=True))
            policy = stack.enter_context(patch.object(MODULE, 'verify_host_policy'))
            self.assertEqual(MODULE.check(config, system='Darwin'), 2)
            policy.assert_not_called()


    def test_installation_fence_readback_is_bounded_and_account_scoped(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            config = dict(account='builder', runtime=dict(root=directory))
            def run(args, **kwargs):
                start = args.index('-c')
                return subprocess.run([sys.executable, '-I', *args[start:]], **kwargs)
            self.assertFalse(MODULE.installation_pending(config, run))
            marker = Path(directory) / 'maintenance-blocked'
            marker.write_text('installation-incomplete ' + 'a'*32 + '\n')
            marker.chmod(0o600)
            self.assertTrue(MODULE.installation_pending(config, run))
            marker.write_text('x'*129)
            with self.assertRaises(subprocess.CalledProcessError):
                MODULE.installation_pending(config, run)


    def test_one_or_two_keys_normalize_without_comment_identity(self):
        config = self.enabled_settings()
        self.assertEqual(MODULE.validate_settings(config)['authorized_keys'], [VALID_KEY])
        second = 'ssh-ed25519 ' + base64.b64encode(ED25519_BLOB[:-1] + b'y').decode()
        config.pop('authorized_key')
        config['authorized_keys'] = [VALID_KEY, second]
        normalized = MODULE.validate_settings(config)
        lines = MODULE.expected_host_files(normalized, (b'1',) * 8)[MODULE.ROOT_AUTHORIZED_KEYS][0].decode().splitlines()
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


    def test_keychain_policy_accepts_only_roundtrippable_settings_before_staging(self):
        base = self.enabled_settings()
        base['broker'] = dict(host_id='12345678-1234-1234-1234-123456789abc', protocol=2, profile='legacy', minimum_free_bytes=MODULE.MINIMUM_FREE_BYTES, daemon_relock_qualified=False, daemon_relock_macos_build='')
        for value in (None, dict(lockOnSleep=True, lockInterval=300), dict(lockOnSleep=False, lockInterval=2147483647)):
            config = dict(base, broker=dict(base['broker'], keychain_policy=value))
            normalized = MODULE.validate_settings(config)
            self.assertEqual(MODULE.make_broker_config(normalized)['keychainPolicy'], value)
        for value in (dict(lockOnSleep=True, useLockInterval=False, lockInterval=300), dict(lockOnSleep=False, useLockInterval=True, lockInterval=2147483647), dict(lockOnSleep=True, lockInterval=True), dict(lockOnSleep=True, lockInterval=2147483648)):
            with self.subTest(value=value), self.assertRaisesRegex(MODULE.NativeHostError, 'invalid broker keychain_policy'):
                MODULE.validate_settings(dict(base, broker=dict(base['broker'], keychain_policy=value)))


    def test_legacy_settings_preserve_installed_identity_profile_and_floor(self):
        config = MODULE.validate_settings(self.enabled_settings())
        installed = dict(MODULE.make_broker_config(config), hostId='12345678-1234-1234-1234-123456789abc', profile='registry-only', minimumFreeBytes=60 * 1024**3, daemonRelockQualified=True, daemonRelockMacOSBuild='27A123', keychainPolicy=dict(lockOnSleep=True, lockInterval=600))
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
        self.assertEqual(plist['StandardErrorPath'], '/Library/Partitura/NativeBuild/maintenance.stderr.log')
        for key in ('SoftResourceLimits', 'HardResourceLimits'):
            self.assertEqual(plist[key]['FileSize'], 1048576)
        self.assertTrue(plist['RunAtLoad'])
        self.assertEqual(plist['ProgramArguments'], MODULE._maintenance.ssh_command('builder'))
        self.assertEqual(plist['ProgramArguments'][0], '/usr/bin/ssh')
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
                with self.assertRaises(SystemExit) as caught:
                    exec(script, {'__name__': '__main__'})
                self.assertEqual(caught.exception.code, 1)
            return subprocess.CompletedProcess(argv, 0, stdout="")
        with patch.object(MODULE, 'account_python', return_value=['python']):
            MODULE.verify_runtime_capacity(config, run)
        self.assertEqual(calls[0][-3:], ['50', '/actual/jobs', '/actual/tart'])


    def test_runtime_capacity_executes_the_same_pinned_purgeable_helper(self):
        config = dict(account='builder', broker=dict(minimum_free_bytes=50), runtime=dict(root='/jobs', tart_home='/tart'))
        def run(argv, **kwargs):
            scope = {'__name__': 'capacity_test'}
            exec(argv[argv.index('-c') + 1], scope)
            with patch('sys.argv', ['capacity', '50', '/jobs', '/tart']), patch('os.statvfs', return_value=SimpleNamespace(f_bavail=30, f_frsize=1, f_blocks=200)):
                scope['important_usage_capacity'] = lambda path: 70
                self.assertEqual(scope['main'](), 0)
                scope['important_usage_capacity'] = lambda path: None
                self.assertEqual(scope['main'](), 1)
            return subprocess.CompletedProcess(argv, 0, stdout='')
        with patch.object(MODULE, 'account_python', return_value=['python']):
            MODULE.verify_runtime_capacity(config, run)
        with patch.object(MODULE, 'CAPACITY_SHA256', '0' * 64), self.assertRaisesRegex(MODULE.NativeHostError, 'pinned helper'):
            MODULE.verify_runtime_capacity(config, run)
        provision = (ROOT / 'deploy/mac-build/provision-host.sh').read_text()
        self.assertIn('"$MB/broker/partitura_broker/capacity.py" "$((MIN_INTERNAL_KB * 1024))" /System/Volumes/Data', provision)
        self.assertNotIn('df -k /System/Volumes/Data', provision)

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
        files = MODULE.expected_host_files(config, (b"broker", b"runner", b"qualifier", b"launcher", b"installer", b"writer", b"maintenance", b"remote-login"))
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
                *(MODULE.BROKER_SOURCE + name for name in MODULE.BROKER_FILES),
                "deploy/mac-build/host_setup_validation.py",
                "deploy/mac-build/broker_archive.py",
                "deploy/mac-build/maintenance_ssh.py",
                "deploy/mac-build/remote_login.py",
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
                broker_sha256=MODULE.sha256_bytes(MODULE.broker_from_commit(repository, commit, MODULE.git_environment())),
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
                        MODULE.broker_from_commit(repository, commit, MODULE.git_environment()),
                        (repository / MODULE.GUEST_RUNNER_PATH).read_bytes(),
                        qualifier.read_bytes(),
                        (repository / MODULE.NATIVE_HOST_PATH).read_bytes(),
                        (repository / MODULE.INSTALL_HOST_PATH).read_bytes(),
                        (repository / MODULE.WRITER_PATH).read_bytes(),
                        (repository / "deploy/mac-build/maintenance_ssh.py").read_bytes(),
                        (repository / "deploy/mac-build/remote_login.py").read_bytes(),
                    ),
                )
                real_run = subprocess.run
                def damaged_remote(args, **kwargs):
                    result = real_run(args, **kwargs)
                    if args[-1].endswith(":deploy/mac-build/remote_login.py"):
                        result.stdout += b"# unpinned Remote Login change\n"
                    return result
                with patch.object(MODULE.subprocess, "run", side_effect=damaged_remote):
                    with self.assertRaisesRegex(MODULE.NativeHostError, "remote_login.py differs from the copy pinned"):
                        MODULE.checked_source_blobs(config)
                helper = repository / "deploy/mac-build/host_setup_validation.py"
                helper_bytes = helper.read_bytes()
                helper.write_bytes(helper_bytes + b"# unpinned change\n")
                with self.assertRaisesRegex(MODULE.NativeHostError, "running host setup module differs"):
                    MODULE.checked_source_blobs(config)
                helper.write_bytes(helper_bytes)
                config["source"]["broker_sha256"] = "f" * 64
                with self.assertRaisesRegex(MODULE.NativeHostError, "pinned source hash differs"):
                    MODULE.checked_source_blobs(config)
                config["source"]["broker_sha256"] = MODULE.sha256_bytes(blobs[0])
                config["source"]["install_host_sha256"] = "f" * 64
                with self.assertRaisesRegex(MODULE.NativeHostError, "pinned source hash differs"):
                    MODULE.checked_source_blobs(config)


    def test_sshd_validation_uses_bounded_noninteractive_sudo(self):
        config = {"account": "partitura-build"}
        calls = []
        output = "\n".join(
            [
                f"authorizedkeysfile {MODULE.ROOT_AUTHORIZED_KEYS} /Library/Partitura/NativeBuild/maintenance-ssh/authorized_keys",
                "exposeauthinfo yes",
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



if __name__ == '__main__':
    unittest.main()
