#!/usr/bin/env python3
"""Preflight and stage Partitura's generic macOS native-build host.

Run this module directly from a pinned Partitura checkout. It validates source,
account, Tart, qualified-base, sshd and runtime prerequisites before staging host
files for the separate root installer. It has no Toolbox runtime dependency.
"""
from __future__ import annotations

import argparse
import ast
import base64
import hashlib
import json
import os
import pwd
from pathlib import Path
import re
import stat
import subprocess
import sys
import types

WRITER_PATH = "deploy/mac-build/credential-writer.py"
GUEST_RUNNER_PATH = "deploy/mac-build/guest-run.sh"
NATIVE_HOST_PATH = "deploy/mac-build/native_host.py"
INSTALL_HOST_PATH = "deploy/mac-build/install-host.sh"
HOST_SETUP_PATH = "deploy/mac-build/host_setup.py"
BROKER_CONFIG_KEYS = {
    "tart",
    "tartSha256",
    "base",
    "root",
    "tartHome",
    "guestRunnerSha256",
    "qualifierSha256",
    "guestUser",
    "guestHome",
    "keychainPath",
    "keychainCredentialPath",
}
HASH = re.compile(r"[a-f0-9]{64}\Z")
COMMIT = re.compile(r"[a-f0-9]{40}\Z")
PUBLIC_KEY = re.compile(
    r"(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?\Z"
)
FORCED_COMMAND = "/usr/bin/python3 /Library/Partitura/NativeBuild/broker.py"
ROOT_CONFIG = Path("/Library/Partitura/NativeBuild/config.json")
ROOT_MANIFEST = Path("/Library/Partitura/NativeBuild/managed-files.json")
ROOT_WRITER = Path("/Library/Partitura/NativeBuild/credential-writer.py")
ROOT_BROKER = Path("/Library/Partitura/NativeBuild/broker.py")
ROOT_AUTHORIZED_KEYS = Path("/Library/Partitura/NativeBuild/authorized_keys")
ROOT_SSHD_CONFIG = Path("/private/etc/ssh/sshd_config")
ROOT_SSHD_DROPIN = Path("/private/etc/ssh/sshd_config.d/90-partitura-native-build.conf")
ROOT_TART_APP = Path("/Library/Partitura/NativeBuild/tart.app")
ROOT_PLIST = Path("/Library/LaunchDaemons/net.partitura.native-build-maintenance.plist")
ROOT_IDENTITY = Path("/Library/Partitura/NativeBuild/installation.json")
MAINTENANCE_LABEL = "net.partitura.native-build-maintenance"
MINIMUM_FREE_BYTES = 50 * 1024**3
BROKER_POLICY_KEYS = {"host_id", "protocol", "profile", "minimum_free_bytes", "daemon_relock_qualified", "daemon_relock_macos_build"}


# Pinned host_setup.py bytes pin its helpers transitively: each helper is hashed
# before it runs, so a drifted working tree can't execute unpinned code.
CAPACITY_SHA256 = "8917a05cc6a57ada3d9427dbfa4c50e7fa2c106054f734303af52881a530e734"
HOST_SETUP_VALIDATION_SHA256 = "a1a7d417d746549a4afc4e22f38e1d0370bcb0ca0da04239ebdd64b5bb5c2efa"
MAINTENANCE_SSH_SHA256 = "8ef7c42ed494fd008e99da853be4a82ca4e69c7b98cb12ba6c527d5e596c8874"
BROKER_ARCHIVE_SHA256 = "747dbb6a612e5bb4c304784753e6e1bcb55f90f02d2e424d4551fbae0a3244af"


def _load_pinned_helper(name: str, filename: str, expected: str) -> types.ModuleType:
    path = Path(__file__).with_name(filename)
    payload = path.read_bytes()
    if hashlib.sha256(payload).hexdigest() != expected:
        raise ValueError(f"{filename} differs from the copy pinned by host_setup.py")
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(payload, str(path), "exec"), module.__dict__)
    return module


_validation = _load_pinned_helper("partitura_host_validation", "host_setup_validation.py", HOST_SETUP_VALIDATION_SHA256)
NativeHostError = _validation.NativeHostError
sha256_bytes = _validation.sha256_bytes
sha256_file = _validation.sha256_file
reject_symlink_ancestors = _validation.reject_symlink_ancestors
tree_sha256 = _validation.tree_sha256
TREE_HASH_AS_ACCOUNT = _validation.TREE_HASH_AS_ACCOUNT
trusted_root_path = _validation.trusted_root_path
verify_root_interpreter = _validation.verify_root_interpreter
safe_read = _validation.safe_read
git_environment = _validation.git_environment
required_mapping = _validation.required_mapping
validate_settings = _validation.validate_settings
validate_authorized_keys = _validation.validate_authorized_keys
validate_public_key = _validation.validate_public_key
_archive = _load_pinned_helper("partitura_broker_archive", "broker_archive.py", BROKER_ARCHIVE_SHA256)
broker_from_commit = _archive.broker_from_commit
broker_from_directory = _archive.broker_from_directory
BROKER_FILES = _archive.BROKER_FILES
BROKER_SOURCE = _archive.BROKER_SOURCE


_maintenance = _load_pinned_helper("partitura_maintenance_ssh", "maintenance_ssh.py", MAINTENANCE_SSH_SHA256)
maintenance_plist = _maintenance.maintenance_plist
ROOT_MAINTENANCE = Path("/Library/Partitura/NativeBuild/maintenance_ssh.py")
ROOT_REMOTE_LOGIN = Path("/Library/Partitura/NativeBuild/remote_login.py")

def account_python(account: str) -> list[str]:
    """Run the same qualified interpreter selection as a dedicated account.

    sudo resets the environment, so a process-scoped DEVELOPER_DIR selection
    is passed explicitly; otherwise /usr/bin/python3 falls back to xcode-select.
    """
    command = ["/usr/bin/sudo", "--non-interactive", "-H", "-u", account]
    developer = os.environ.get("DEVELOPER_DIR")
    if developer is not None:
        trusted_root_path(Path(developer), "selected developer directory")
        command += ["/usr/bin/env", f"DEVELOPER_DIR={developer}"]
    return [*command, "/usr/bin/python3", "-I"]


def tree_sha256_as_account(root: Path, account: str, run=subprocess.run) -> str:
    result = run(
        [*account_python(account), "-c", TREE_HASH_AS_ACCOUNT, str(root)],
        capture_output=True,
        text=True,
        check=True,
        timeout=300,
        cwd="/",
    )
    digest = result.stdout.strip()
    if not HASH.fullmatch(digest):
        raise NativeHostError("dedicated account returned an invalid Tart base hash")
    return digest



def make_broker_config(config: dict) -> dict:
    """Render exactly the broker config contract from deploy/mac-build/README.md."""
    tart = config["tart"]
    source = config["source"]
    result = {
        "tart": str(ROOT_TART_APP / tart["executable_relative_path"]),
        "tartSha256": tart["sha256"],
        "base": config["base"]["name"],
        "root": config["runtime"]["root"],
        "tartHome": config["runtime"]["tart_home"],
        "guestRunnerSha256": source["guest_runner_sha256"],
        "qualifierSha256": source["qualifier_sha256"],
        "guestUser": config["guest_user"],
        "guestHome": f"/Users/{config['guest_user']}",
        "keychainPath": f"/Users/{config['account']}/Library/Keychains/login.keychain-db",
        "keychainCredentialPath": f"/Users/{config['account']}/.partitura-native-login.password",
    }
    policy = config.get("broker")
    if policy and policy["host_id"]:
        result.update(hostId=policy["host_id"], profile=policy["profile"], minimumFreeBytes=policy["minimum_free_bytes"], daemonRelockQualified=policy["daemon_relock_qualified"], daemonRelockMacOSBuild=policy["daemon_relock_macos_build"])
        result['keychainPolicy'] = policy.get('keychain_policy')
    return result


def authorized_key_line(public_key: str) -> str:
    validate_public_key(public_key)
    options = (
        'restrict,command="/usr/bin/python3 /Library/Partitura/NativeBuild/broker.py",'
        "no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc"
    )
    return f"{options} {public_key}\n"


def sshd_dropin(account: str) -> str:
    # sshd refuses non-Match keywords here (PermitUserEnvironment is global-only);
    # its effective "no" default is verified separately through sshd -T.
    return "\n".join(
        [
            f"Match User {account}",
            "    AuthorizedKeysFile /Library/Partitura/NativeBuild/authorized_keys /Library/Partitura/NativeBuild/maintenance-ssh/authorized_keys",
            "    ExposeAuthInfo yes",
            "    PasswordAuthentication no",
            "    KbdInteractiveAuthentication no",
            "    AuthenticationMethods publickey",
            f"    ForceCommand {FORCED_COMMAND}",
            "    AllowTcpForwarding no",
            "    AllowAgentForwarding no",
            "    X11Forwarding no",
            "    PermitTTY no",
            "    ClientAliveInterval 15",
            "    ClientAliveCountMax 3",
            "",
        ]
    )


def read_root_json(path: Path) -> dict | None:
    reject_symlink_ancestors(path)
    if not os.path.lexists(path):
        return None
    trusted_root_path(path, "installed state")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0 or info.st_mode & 0o022 or info.st_size > 65536:
            raise NativeHostError("unsafe installed state")
        pairs = lambda values: unique_settings(values)
        value = json.loads(stream.read(65537), object_pairs_hook=pairs)
    if not isinstance(value, dict):
        raise NativeHostError("invalid installed state")
    return value


def unique_settings(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise NativeHostError("duplicate settings key")
        result[key] = value
    return result


def resolve_broker_policy(config: dict) -> dict:
    """A check never mints an identity or silently downgrades an installed profile."""
    installed = read_root_json(ROOT_CONFIG)
    identity = read_root_json(ROOT_IDENTITY)
    account = config['account']
    if installed:
        extension = {"hostId", "profile", "minimumFreeBytes", "daemonRelockQualified", "daemonRelockMacOSBuild"}
        shapes = (BROKER_CONFIG_KEYS, BROKER_CONFIG_KEYS | extension, BROKER_CONFIG_KEYS | (extension - {"minimumFreeBytes"}), BROKER_CONFIG_KEYS | extension | {'keychainPolicy'}, BROKER_CONFIG_KEYS | (extension - {'minimumFreeBytes'}) | {'keychainPolicy'})
        if set(installed) not in shapes or installed.get('keychainPath') != f'/Users/{account}/Library/Keychains/login.keychain-db':
            raise NativeHostError("installed broker state/account differs")
        if installed['root'] != config['runtime']['root'] or installed['tartHome'] != config['runtime']['tart_home']:
            raise NativeHostError("runtime root migration requires separate drained host repair")
    if identity and (set(identity) != {'schema', 'hostId', 'account'} or identity['schema'] != 1 or identity['account'] != account):
        raise NativeHostError("installation identity journal differs")
    identifiers = {value for value in ((installed or {}).get('hostId'), (identity or {}).get('hostId'), config.get('broker', {}).get('host_id')) if value}
    if len(identifiers) > 1:
        raise NativeHostError("conflicting installed host identity")
    if not identifiers:
        raise NativeHostError("initialize a stable host identity through the approved one-shot installer before staging")
    policy = config.get('broker', dict(host_id='', protocol=2, profile=(installed or {}).get('profile', 'legacy'), minimum_free_bytes=(installed or {}).get('minimumFreeBytes', MINIMUM_FREE_BYTES), daemon_relock_qualified=(installed or {}).get('daemonRelockQualified', False), daemon_relock_macos_build=(installed or {}).get('daemonRelockMacOSBuild', ''), keychain_policy=(installed or {}).get('keychainPolicy')))
    result = dict(config, broker=dict(policy, host_id=identifiers.pop()))
    return validate_settings(result)


def checked_provision_blob(config: dict) -> bytes:
    source = config['source']
    return subprocess.run(["/usr/bin/git", "-C", source['partitura_repository'], "show", f"{source['broker_commit']}:deploy/mac-build/provision.py"], check=True, capture_output=True, env=git_environment()).stdout


def provision_constant(blob: bytes, name: str) -> str:
    for node in ast.parse(blob).body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            value = ast.literal_eval(node.value)
            if isinstance(value, str):
                return value
    raise NativeHostError("pinned provision helper lacks the fixed entry point")


def verify_runtime_capacity(config: dict, run=subprocess.run) -> None:
    helper = Path(__file__).parent / 'broker/partitura_broker/capacity.py'
    script = safe_read(helper)
    if sha256_bytes(script) != CAPACITY_SHA256:
        raise NativeHostError('capacity.py differs from the pinned helper')
    result = run([*account_python(config['account']), '-c', script.decode(), str(config['broker']['minimum_free_bytes']), config['runtime']['root'], config['runtime']['tart_home']], check=False, capture_output=True, text=True, timeout=15, cwd='/')
    # Print the measured values before refusing, so a below-floor install shows why.
    print(result.stdout, end='')
    if result.returncode != 0:
        detail = (result.stderr.strip().splitlines() or [''])[-1]
        raise NativeHostError('runtime job/Tart root below sealed free-space floor' + (f' ({detail})' if detail else ''))


def verify_host_policy(config: dict, run=subprocess.run) -> bool:
    # Never call a keychain API from sudo. Only the broker's unlocked SSH
    # session can qualify the optional sealed keychain policy.
    result = run(['/bin/launchctl', 'print', 'system/' + MAINTENANCE_LABEL], check=False, capture_output=True, text=True, timeout=15)
    if result.returncode:
        if 'Could not find service' in result.stderr:
            return False
        raise NativeHostError('cannot read system maintenance daemon state')
    return True


def installation_pending(config: dict, run=subprocess.run) -> bool:
    script = r'''
import os, stat, sys
from pathlib import Path
path = Path(sys.argv[1]) / 'maintenance-blocked'
try:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except FileNotFoundError:
    print('clear')
else:
    with os.fdopen(fd, 'r') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > 128:
            raise SystemExit('unsafe installation fence')
        print('incomplete' if stream.read(129).startswith('installation-incomplete') else 'clear')
'''
    result = run([*account_python(config['account']), '-c', script, config['runtime']['root']], check=True, capture_output=True, text=True, timeout=15, cwd='/')
    if result.stdout.strip() not in ('clear', 'incomplete'):
        raise NativeHostError('invalid installation fence readback')
    return result.stdout.strip() == 'incomplete'


def checked_source_blobs(config: dict) -> tuple[bytes, ...]:
    source = config["source"]
    repository = Path(source["partitura_repository"])
    reject_symlink_ancestors(repository)
    if not repository.is_dir():
        raise NativeHostError(f"Partitura source repository is unavailable: {repository}")
    commit = source["broker_commit"]
    resolved = subprocess.run(
        ["/usr/bin/git", "-C", str(repository), "rev-parse", "--verify", f"{commit}^{{commit}}"],
        check=True,
        capture_output=True,
        text=True,
        env=git_environment(),
    ).stdout.strip()
    if resolved != commit:
        raise NativeHostError("Partitura broker source commit did not resolve exactly")
    setup = subprocess.run(
        ["/usr/bin/git", "-C", str(repository), "show", f"{commit}:{HOST_SETUP_PATH}"],
        check=True,
        capture_output=True,
        env=git_environment(),
    ).stdout
    if sha256_bytes(setup) != sha256_file(Path(__file__)):
        raise NativeHostError("running host setup module differs from the pinned Partitura commit")
    for relative in ("deploy/mac-build/host_setup_validation.py", "deploy/mac-build/broker_archive.py", "deploy/mac-build/maintenance_ssh.py", "deploy/mac-build/broker/partitura_broker/capacity.py"):
        result = subprocess.run(["/usr/bin/git", "-C", str(repository), "show", f"{commit}:{relative}"], check=True, capture_output=True, env=git_environment())
        if sha256_bytes(result.stdout) != sha256_file(Path(__file__).parent / Path(relative).relative_to("deploy/mac-build")):
            raise NativeHostError("running host setup module differs from the pinned Partitura commit")
    broker = broker_from_commit(repository, commit, git_environment())
    if sha256_bytes(broker) != source["broker_sha256"]:
        raise NativeHostError("pinned source hash differs: broker archive")
    blobs: list[bytes] = [broker]
    for relative, expected in (
        (GUEST_RUNNER_PATH, source["guest_runner_sha256"]),
        (NATIVE_HOST_PATH, source["native_host_sha256"]),
        (INSTALL_HOST_PATH, source["install_host_sha256"]),
        (WRITER_PATH, source["credential_writer_sha256"]),
    ):
        result = subprocess.run(
            ["/usr/bin/git", "-C", str(repository), "show", f"{commit}:{relative}"],
            check=True,
            capture_output=True,
            env=git_environment(),
        )
        blob = result.stdout
        if sha256_bytes(blob) != expected:
            raise NativeHostError(f"pinned source hash differs: {relative}")
        blobs.append(blob)
    qualifier = safe_read(Path(source["qualifier_source"]))
    if sha256_bytes(qualifier) != source["qualifier_sha256"]:
        raise NativeHostError("pinned Partitura qualifier hash differs")
    extra = [subprocess.run(["/usr/bin/git", "-C", str(repository), "show", f"{commit}:deploy/mac-build/{name}"], check=True, capture_output=True, env=git_environment()).stdout for name in ("maintenance_ssh.py", "remote_login.py")]
    if sha256_bytes(extra[1]) != _maintenance.REMOTE_LOGIN_SHA256:
        raise NativeHostError("remote_login.py differs from the copy pinned by maintenance_ssh.py")
    return blobs[0], blobs[1], qualifier, blobs[2], blobs[3], blobs[4], *extra


def verify_tart_source(config: dict) -> Path:
    tart = config["tart"]
    app = Path(tart["source_app"])
    reject_symlink_ancestors(app)
    if not app.is_dir():
        raise NativeHostError(f"signed Tart app is unavailable: {app}")
    binary = app / tart["executable_relative_path"]
    reject_symlink_ancestors(binary)
    if sha256_file(binary) != tart["sha256"]:
        raise NativeHostError("Tart executable hash differs from the reviewed pin")
    subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)],
        check=True,
        capture_output=True,
        text=True,
    )
    return app


def verify_qualified_base(config: dict, run=subprocess.run) -> None:
    base = config["base"]
    dedicated = Path(base["dedicated_path"])
    receipt_path = Path(base["qualification_receipt"])
    reject_symlink_ancestors(receipt_path)
    for ancestor in receipt_path.parents:
        parent_metadata = ancestor.lstat()
        if not stat.S_ISDIR(parent_metadata.st_mode) or parent_metadata.st_uid != 0 or parent_metadata.st_mode & 0o022:
            raise NativeHostError(f"qualification receipt ancestor must be root-owned and not group/other writable: {ancestor}")
        if not os.access(ancestor, os.X_OK):
            raise NativeHostError(f"qualification receipt ancestor is not searchable by this account: {ancestor}")
    metadata = receipt_path.lstat()
    # The unprivileged staging helper must read this hashes-only receipt.
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o444:
        raise NativeHostError("base qualification receipt must be root-owned mode 0444")
    receipt = json.loads(receipt_path.read_text())
    expected = {
        "schema": 1,
        "sourceName": base["source_name"],
        "sourceSha256": base["source_sha256"],
        "base": base["name"],
        "basePath": str(dedicated),
        "baseSha256": base["sha256"],
        "guestRunnerSha256": config["source"]["guest_runner_sha256"],
        "qualifierSha256": config["source"]["qualifier_sha256"],
        "miseSha256": base["mise_sha256"],
        "miseVersion": base["mise_version"],
        "nodeVersion": base["node_version"],
        "pythonVersion": base["python_version"],
        "qualificationOutput": (
            "PARTITURA_NATIVE_BASE_QUALIFIED os=Darwin arch=arm64 "
            f"guestUser={config['guest_user']} "
            "developerTools=verified "
            f"runnerSha256={config['source']['guest_runner_sha256']} "
            f"qualifierSha256={config['source']['qualifier_sha256']} "
            f"miseSha256={base['mise_sha256']} miseVersion={base['mise_version']} "
            f"nodeVersion={base['node_version']} pythonVersion={base['python_version']}"
        ),
    }
    if receipt != expected:
        raise NativeHostError("base qualification receipt does not match the pinned inputs")
    if tree_sha256_as_account(dedicated, config["account"], run) != base["sha256"]:
        raise NativeHostError("dedicated Tart base changed after qualification")


def verify_account(account: str, run=subprocess.run) -> None:
    result = run(
        ["/usr/bin/dscl", ".", "-read", f"/Users/{account}", "UniqueID", "PrimaryGroupID", "UserShell"],
        capture_output=True,
        text=True,
        check=True,
    )
    values = {}
    for line in result.stdout.splitlines():
        key, _, value = line.partition(":")
        values[key] = value.strip()
    if values.get("UserShell") not in {"/bin/bash", "/bin/zsh"}:
        raise NativeHostError(f"{account} must have an executable login shell for its forced command")
    if values.get("PrimaryGroupID") != "20":
        raise NativeHostError(f"{account} must use the non-admin staff primary group")
    membership = run(
        ["/usr/bin/id", "-Gn", account], capture_output=True, text=True, check=True
    ).stdout.split()
    if "admin" in membership or "wheel" in membership:
        raise NativeHostError(f"{account} must not belong to admin or wheel")


def sshd_effective(settings: dict, run=subprocess.run) -> dict[str, str]:
    include = ROOT_SSHD_CONFIG
    reject_symlink_ancestors(include)
    text = include.read_text()
    if not re.search(r"(?mi)^\s*Include\s+/etc/ssh/sshd_config\.d/\*\s*(?:#.*)?$", text):
        raise NativeHostError("system sshd_config lacks the managed sshd_config.d include")
    sudo = ["/usr/bin/sudo", "--non-interactive", "/usr/sbin/sshd"]
    run([*sudo, "-t"], capture_output=True, text=True, check=True, timeout=15)
    result = run(
        [
            *sudo,
            "-T",
            "-C",
            f"user={settings['account']},host=localhost,addr=127.0.0.1",
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
    )
    _maintenance.verify_environment(result.stdout)
    return {
        key.lower(): value
        for line in result.stdout.splitlines()
        if len(parts := line.split(None, 1)) == 2
        for key, value in [parts]
    }


def expected_host_files(config: dict, blobs: tuple[bytes, ...]) -> dict[Path, tuple[bytes, int]]:
    broker, runner, qualifier = blobs[:3]
    # The guest files are staged for a later approved base-qualification path.
    # This host installer does not run them or copy a VM image.
    return {
        ROOT_BROKER: (broker, 0o555),
        ROOT_WRITER: (blobs[5], 0o555),
        # The forced-command broker runs as the dedicated host account.
        ROOT_CONFIG: (json.dumps(make_broker_config(config), sort_keys=True, indent=2).encode() + b"\n", 0o444),
        ROOT_AUTHORIZED_KEYS: (''.join(authorized_key_line(key) for key in config.get("authorized_keys", [config["authorized_key"]] if config.get("authorized_key") else [])).encode(), 0o444),
        ROOT_SSHD_DROPIN: (sshd_dropin(config["account"]).encode(), 0o644),
        ROOT_PLIST: (maintenance_plist(config["account"]), 0o644),
        ROOT_MAINTENANCE: (blobs[6], 0o555),
        ROOT_REMOTE_LOGIN: (blobs[7], 0o555),
    }


def expected_managed_manifest(files: dict[Path, tuple[bytes, int]], config: dict) -> bytes:
    entries = {
        str(path): {"sha256": sha256_bytes(contents), "mode": mode}
        for path, (contents, mode) in files.items()
    }
    tart = config["tart"]
    executable = Path(tart["source_app"]) / tart["executable_relative_path"]
    entries[str(ROOT_TART_APP / tart["executable_relative_path"])] = {
        "sha256": tart["sha256"],
        "mode": stat.S_IMODE(executable.stat().st_mode),
    }
    return json.dumps({"schema": 1, "files": entries}, sort_keys=True, indent=2).encode() + b"\n"


def read_managed_manifest(path: Path = ROOT_MANIFEST) -> dict | None:
    reject_symlink_ancestors(path)
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o444:
        raise NativeHostError("managed-files manifest must be root-owned mode 0444")
    try:
        manifest = json.loads(path.read_text())
    except json.JSONDecodeError as error:
        raise NativeHostError("managed-files manifest is invalid JSON") from error
    if not isinstance(manifest, dict) or set(manifest) != {"schema", "files"} or manifest["schema"] != 1 or not isinstance(manifest["files"], dict):
        raise NativeHostError("managed-files manifest has an unsupported schema")
    for name, entry in manifest["files"].items():
        if not isinstance(name, str) or not isinstance(entry, dict) or set(entry) != {"sha256", "mode"}:
            raise NativeHostError("managed-files manifest contains an invalid entry")
        if not isinstance(entry["sha256"], str) or not HASH.fullmatch(entry["sha256"]):
            raise NativeHostError("managed-files manifest contains an invalid hash")
        if not isinstance(entry["mode"], int) or entry["mode"] < 0 or entry["mode"] > 0o777:
            raise NativeHostError("managed-files manifest contains an invalid mode")
    return manifest


def check_existing_files(
    files: dict[Path, tuple[bytes, int]],
    config: dict,
    *,
    manifest_path: Path = ROOT_MANIFEST,
    tart_inspector=None,
) -> bool:
    manifest = read_managed_manifest(manifest_path)
    previous = manifest["files"] if manifest else {}
    stale = manifest is None
    target_names = {str(path) for path in files}
    target_names.add(str(Path(config["tart"]["installed_app"]) / config["tart"]["executable_relative_path"]))
    migrating = manifest and set(previous) != target_names
    if migrating:
        predecessor = config["predecessor_manifest_sha256"]
        prior = target_names - {str(ROOT_MAINTENANCE), str(ROOT_REMOTE_LOGIN)}
        predecessors = (prior, prior - {str(ROOT_PLIST)}, prior - {str(ROOT_PLIST), str(ROOT_WRITER)})
        if set(previous) not in predecessors or not predecessor or sha256_file(manifest_path) != predecessor:
            raise NativeHostError("managed-files manifest does not match the frozen predecessor target set")
        # Every predecessor entry must still match. The pin alone does not
        # authorize arbitrary intervening changes or a partial prior install.
        for name, entry in previous.items():
            path = Path(name)
            reject_symlink_ancestors(path)
            metadata = path.lstat()
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != entry["mode"] or sha256_file(path) != entry["sha256"]:
                raise NativeHostError("frozen predecessor payload differs")
        for added in target_names - set(previous):
            if os.path.lexists(added):
                raise NativeHostError("unexpected new managed target before migration")
        stale = True

    def known_or_desired(path: Path, expected_hash: str, expected_mode: int, actual_hash: str, actual_mode: int) -> None:
        nonlocal stale
        if actual_hash == expected_hash and actual_mode == expected_mode:
            return
        prior = previous.get(str(path))
        if prior == {"sha256": actual_hash, "mode": actual_mode}:
            stale = True
            return
        raise NativeHostError(f"managed target differs without a matching root-owned manifest: {path}")

    for target, (desired, mode) in files.items():
        reject_symlink_ancestors(target)
        try:
            metadata = target.lstat()
        except FileNotFoundError:
            stale = True
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise NativeHostError(f"managed target is not a regular file: {target}")
        if metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise NativeHostError(f"managed target ownership/mode is unsafe: {target}")
        known_or_desired(
            target,
            sha256_bytes(desired),
            mode,
            sha256_file(target),
            stat.S_IMODE(metadata.st_mode),
        )

    tart = config["tart"]
    tart_app = Path(tart["installed_app"])
    tart_executable = tart_app / tart["executable_relative_path"]
    reject_symlink_ancestors(tart_executable)
    if not tart_app.exists():
        stale = True
    elif not tart_executable.exists():
        raise NativeHostError("installed Tart bundle is incomplete; refusing to replace an unknown bundle")
    else:
        inspector = tart_inspector or verify_installed_tart
        actual_hash, actual_mode = inspector(config)
        source_executable = Path(tart["source_app"]) / tart["executable_relative_path"]
        known_or_desired(
            tart_executable,
            tart["sha256"],
            stat.S_IMODE(source_executable.stat().st_mode),
            actual_hash,
            actual_mode,
        )

    expected_manifest = expected_managed_manifest(files, config)
    if manifest is None or manifest_path.read_bytes() != expected_manifest:
        stale = True
    return stale


def verify_effective_sshd(settings: dict, effective: dict[str, str]) -> None:
    try:
        _maintenance.verify_effective_sshd(settings['account'], effective)
    except ValueError as error:
        raise NativeHostError(str(error)) from None


def check(settings: object, *, system: str | None = None, run=subprocess.run) -> int:
    config = validate_settings(settings)
    if not config["enabled"]:
        print("partitura native host: disabled; no host reads or changes")
        return 0
    if (system or os.uname().sysname) != "Darwin":
        raise NativeHostError("enabled native host provisioning requires macOS")
    config = resolve_broker_policy(config)
    blobs = checked_source_blobs(config)
    verify_tart_source(config)
    verify_qualified_base(config, run)
    verify_account(config["account"], run)
    verify_private_runtime(config, run)
    verify_runtime_capacity(config, run)
    effective = sshd_effective(config, run)
    files = expected_host_files(config, blobs)
    stale = check_existing_files(files, config)
    if stale or installation_pending(config, run):
        print("partitura native host: prerequisites verified; managed files need installation")
        return 2
    verify_effective_sshd(config, effective)
    if not verify_host_policy(config, run):
        print("partitura native host: managed files current; maintenance daemon needs installation")
        return 2
    _maintenance.self_test(config["account"], check=True, run=run)
    print("partitura native host: pinned sources, account, Tart, base, sshd and files verified")
    return 0


def verify_installed_tart(config: dict) -> tuple[str, int]:
    app = Path(config["tart"]["installed_app"])
    reject_symlink_ancestors(app)
    binary = app / config["tart"]["executable_relative_path"]
    reject_symlink_ancestors(binary)
    subprocess.run(
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)],
        check=True,
        capture_output=True,
        text=True,
    )
    for path in (app, *app.rglob("*")):
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise NativeHostError(f"installed Tart bundle ownership/mode is unsafe: {path}")
    metadata = binary.stat()
    return sha256_file(binary), stat.S_IMODE(metadata.st_mode)


def verify_private_runtime(config: dict, run=subprocess.run) -> None:
    # The staging administrator cannot traverse the dedicated account's 0700
    # home. Inspect it as its owner, as with the qualified base tree hash.
    script = r'''
import os
import pwd
from pathlib import Path
import stat
import sys

for value in sys.argv[1:]:
    path = Path(value)
    if not path.is_absolute():
        raise SystemExit("private runtime path must be absolute")
    for ancestor in reversed((path, *path.parents)):
        if stat.S_ISLNK(ancestor.lstat().st_mode):
            raise SystemExit("private runtime path contains a symlink")
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise SystemExit("private runtime directory is not account-owned mode 0700")
'''
    run(
        [*account_python(config["account"]), "-c", script,
         config["runtime"]["root"], config["runtime"]["tart_home"]],
        capture_output=True, text=True, check=True, timeout=15, cwd="/",
    )


def stage(settings: object, destination: Path) -> None:
    config = validate_settings(settings)
    if not config["enabled"]:
        raise NativeHostError("cannot stage native host files while disabled")
    if os.uname().sysname != "Darwin":
        raise NativeHostError("native host staging requires macOS")
    config = resolve_broker_policy(config)
    blobs = checked_source_blobs(config)
    app = verify_tart_source(config)
    verify_qualified_base(config)
    verify_account(config["account"])
    verify_private_runtime(config)
    verify_runtime_capacity(config)
    sshd_effective(config)
    reject_symlink_ancestors(destination)
    if destination.exists():
        metadata = destination.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
            raise NativeHostError("stage directory must be owned by the caller with mode 0700")
    else:
        destination.mkdir(parents=True, mode=0o700)
    (destination / "broker.py").write_bytes(blobs[0])
    (destination / "guest-run.sh").write_bytes(blobs[1])
    (destination / "qualify.sh").write_bytes(blobs[2])
    (destination / "native_host.py").write_bytes(blobs[3])
    (destination / "install-host.sh").write_bytes(blobs[4])
    (destination / "credential-writer.py").write_bytes(blobs[5])
    (destination / "maintenance_ssh.py").write_bytes(blobs[6])
    (destination / "remote_login.py").write_bytes(blobs[7])
    for name in ("broker.py", "guest-run.sh", "qualify.sh", "native_host.py", "install-host.sh", "credential-writer.py", "maintenance_ssh.py", "remote_login.py"):
        os.chmod(destination / name, 0o600)
    (destination / "config.json").write_text(
        json.dumps(make_broker_config(config), sort_keys=True, indent=2) + "\n"
    )
    (destination / "authorized_keys").write_text(''.join(authorized_key_line(key) for key in config.get('authorized_keys', [config['authorized_key']] if config.get('authorized_key') else [])))
    (destination / "sshd_config").write_text(sshd_dropin(config["account"]))
    (destination / "maintenance.plist").write_bytes(maintenance_plist(config['account']))
    (destination / "provision.py").write_bytes(checked_provision_blob(config))
    for name in ("config.json", "authorized_keys", "sshd_config", "maintenance.plist", "provision.py"):
        os.chmod(destination / name, 0o600)
    managed = expected_host_files(config, blobs)
    (destination / "managed-files.json").write_bytes(expected_managed_manifest(managed, config))
    os.chmod(destination / "managed-files.json", 0o600)
    tart_copy = destination / "tart.app"
    if tart_copy.exists():
        raise NativeHostError("stage directory already contains tart.app")
    subprocess.run(
        ["/usr/bin/ditto", "--rsrc", str(app), str(tart_copy)],
        check=True,
        capture_output=True,
        text=True,
    )
    installed_binary = tart_copy / config["tart"]["executable_relative_path"]
    if sha256_file(installed_binary) != config["tart"]["sha256"]:
        raise NativeHostError("staged Tart executable hash differs")
    print(f"staged pinned host inputs unprivileged: {destination}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--stage", "--stage-host", type=Path, dest="stage")
    arguments = parser.parse_args(argv)
    try:
        verify_root_interpreter()
        settings = json.loads(arguments.config.read_text(), object_pairs_hook=unique_settings)
        if arguments.check:
            return check(settings)
        stage(settings, arguments.stage)
        return 0
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        print(f"partitura native host: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
