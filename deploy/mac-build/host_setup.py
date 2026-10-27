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
import plistlib
import subprocess
import sys

WRITER_PATH = "deploy/mac-build/credential-writer.py"
BROKER_PATH = "deploy/mac-build/broker.py"
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


class NativeHostError(ValueError):
    """A source, host, or managed-file invariant failed."""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def reject_symlink_ancestors(path: Path) -> None:
    """Reject existing symlinks from a path through its filesystem root."""
    if not path.is_absolute():
        raise NativeHostError(f"path must be absolute: {path}")
    for item in reversed((path, *path.parents)):
        try:
            metadata = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise NativeHostError(f"refusing symlink in managed path: {item}")


def tree_sha256(root: Path) -> str:
    """Hash a qualified Tart VM tree without following links or changing it."""
    reject_symlink_ancestors(root)
    metadata = root.lstat()
    if not stat.S_ISDIR(metadata.st_mode):
        raise NativeHostError(f"qualified Tart base is not a directory: {root}")
    digest = hashlib.sha256()
    for current, directories, files in os.walk(root, followlinks=False):
        directories.sort()
        files.sort()
        current_path = Path(current)
        entries = sorted([*directories, *files])
        for name in entries:
            path = current_path / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                raise NativeHostError(f"qualified Tart base contains a symlink: {path}")
            relative = path.relative_to(root).as_posix().encode()
            digest.update(len(relative).to_bytes(4, "big"))
            digest.update(relative)
            digest.update(stat.S_IMODE(info.st_mode).to_bytes(2, "big"))
            if stat.S_ISREG(info.st_mode):
                digest.update(info.st_size.to_bytes(8, "big"))
                with path.open("rb") as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        digest.update(chunk)
            elif not stat.S_ISDIR(info.st_mode):
                raise NativeHostError(f"unsupported file in qualified Tart base: {path}")
    return digest.hexdigest()


TREE_HASH_AS_ACCOUNT = r'''
import hashlib
import os
import pwd
from pathlib import Path
import stat
import sys

root = Path(sys.argv[1])
if not root.is_absolute():
    raise SystemExit("base path must be absolute")
for item in reversed((root, *root.parents)):
    try:
        if stat.S_ISLNK(item.lstat().st_mode):
            raise SystemExit(f"base path contains a symlink: {item}")
    except FileNotFoundError:
        pass
if not stat.S_ISDIR(root.lstat().st_mode):
    raise SystemExit(f"qualified Tart base is not a directory: {root}")
digest = hashlib.sha256()
for current, directories, files in os.walk(root, followlinks=False):
    directories.sort()
    files.sort()
    current_path = Path(current)
    for name in sorted([*directories, *files]):
        path = current_path / name
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise SystemExit(f"qualified Tart base contains a symlink: {path}")
        relative = path.relative_to(root).as_posix().encode()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(stat.S_IMODE(info.st_mode).to_bytes(2, "big"))
        if stat.S_ISREG(info.st_mode):
            digest.update(info.st_size.to_bytes(8, "big"))
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
        elif not stat.S_ISDIR(info.st_mode):
            raise SystemExit(f"unsupported file in qualified Tart base: {path}")
print(digest.hexdigest())
'''


def trusted_root_path(path: Path, what: str) -> None:
    """Require a real path whose every component is root-owned and unwritable."""
    if not path.is_absolute() or Path(os.path.realpath(path)) != path:
        raise NativeHostError(f"{what} must be an absolute path without symlinks: {path}")
    for item in (path, *path.parents):
        metadata = os.lstat(item)
        if metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise NativeHostError(f"{what} is not root-owned and protected: {item}")


def verify_root_interpreter() -> None:
    """Refuse root execution from an interpreter outside root-owned directories.

    The protected runbook qualifies the interpreter before starting Python; this
    repeats the check so a wrong selection stops before any host reads.
    """
    if os.geteuid() != 0:
        return
    trusted_root_path(Path(os.path.realpath(sys.executable)), "root Python interpreter")
    trusted_root_path(Path(os.path.realpath(sys.prefix)), "root Python prefix")


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


def required_mapping(value: object, keys: set[str], label: str) -> dict:
    if not isinstance(value, dict) or set(value) != keys:
        raise NativeHostError(f"{label} must contain exactly: {', '.join(sorted(keys))}")
    return value


def validate_settings(settings: object) -> dict:
    top_keys = {
        "enabled",
        "host",
        "account",
        "guest_user",
        "source",
        "predecessor_manifest_sha256",
        "tart",
        "base",
        "runtime",
    }
    if not isinstance(settings, dict) or set(settings) - top_keys - {"authorized_key", "authorized_keys", "broker"} or top_keys - set(settings) or ("authorized_key" in settings) == ("authorized_keys" in settings):
        raise NativeHostError("settings require exactly one of authorized_key or authorized_keys and known settings fields")
    config = dict(settings)
    keys = config.get("authorized_keys", [config.get("authorized_key")] if config.get("authorized_key") else [])
    validate_authorized_keys(keys, config['enabled'])
    config.pop("authorized_key", None)
    config["authorized_keys"] = keys
    policy = dict(host_id="", protocol=2, profile="legacy", minimum_free_bytes=MINIMUM_FREE_BYTES, daemon_relock_qualified=False, daemon_relock_macos_build="")
    if "broker" in config:
        policy = dict(required_mapping(config["broker"], BROKER_POLICY_KEYS, "broker"))
    if not isinstance(policy["host_id"], str) or policy["host_id"] and not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", policy["host_id"]):
        raise NativeHostError("broker.host_id must be a canonical UUID")
    if type(policy["protocol"]) is not int or policy["protocol"] != 2 or policy["profile"] not in ("legacy", "registry-only"):
        raise NativeHostError("invalid broker protocol/profile")
    if type(policy["minimum_free_bytes"]) is not int or not MINIMUM_FREE_BYTES <= policy["minimum_free_bytes"] <= 2**63 - 1:
        raise NativeHostError("invalid broker minimum_free_bytes")
    if type(policy["daemon_relock_qualified"]) is not bool or not isinstance(policy["daemon_relock_macos_build"], str) or not re.fullmatch(r"[A-Za-z0-9]{0,32}", policy["daemon_relock_macos_build"]) or policy["daemon_relock_qualified"] and not policy["daemon_relock_macos_build"]:
        raise NativeHostError("invalid broker daemon relock qualification")
    if "broker" in settings:
        config["broker"] = policy
    if not isinstance(config["enabled"], bool):
        raise NativeHostError("enabled must be a boolean")
    if not isinstance(config["host"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,62}", config["host"]):
        raise NativeHostError("host must be a valid macOS hostname")
    if not isinstance(config["account"], str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,30}", config["account"]):
        raise NativeHostError("account must be a valid macOS short name")
    if not isinstance(config["guest_user"], str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,30}", config["guest_user"]) or config["guest_user"] == "root":
        raise NativeHostError("guest_user must be a non-root macOS short name")
    predecessor = config["predecessor_manifest_sha256"]
    if not isinstance(predecessor, str) or (predecessor and not HASH.fullmatch(predecessor)):
        raise NativeHostError("predecessor manifest must be empty or a frozen SHA-256")
    source = required_mapping(
        config["source"],
        {
            "partitura_repository",
            "broker_commit",
            "broker_sha256",
            "credential_writer_sha256",
            "guest_runner_sha256",
            "native_host_sha256",
            "install_host_sha256",
            "qualifier_source",
            "qualifier_sha256",
        },
        "source",
    )
    tart = required_mapping(
        config["tart"],
        {"source_app", "installed_app", "executable_relative_path", "sha256"},
        "tart",
    )
    base = required_mapping(
        config["base"],
        {
            "name", "source_name", "source_path", "source_sha256", "dedicated_path", "sha256",
            "qualification_receipt", "mise_binary", "mise_version", "mise_sha256", "node_version", "python_version",
        },
        "base",
    )
    runtime = required_mapping(config["runtime"], {"root", "tart_home"}, "runtime")
    for key in ("broker_sha256", "credential_writer_sha256", "guest_runner_sha256", "qualifier_sha256"):
        if not isinstance(source[key], str) or not HASH.fullmatch(source[key]):
            raise NativeHostError(f"source.{key} must be a lowercase SHA-256")
    for key in ("native_host_sha256", "install_host_sha256"):
        if not isinstance(source[key], str) or (source[key] and not HASH.fullmatch(source[key])):
            raise NativeHostError(f"source.{key} must be empty until its source commit or a lowercase SHA-256")
    if config["enabled"] and (not source["native_host_sha256"] or not source["install_host_sha256"]):
        raise NativeHostError("enabled provisioning requires pinned Partitura host installer sources")
    if not isinstance(source["broker_commit"], str) or not COMMIT.fullmatch(source["broker_commit"]):
        raise NativeHostError("source.broker_commit must be a full lowercase Git commit")
    if not isinstance(tart["sha256"], str) or not HASH.fullmatch(tart["sha256"]):
        raise NativeHostError("tart.sha256 must be a lowercase SHA-256")
    for section, path_keys in ((source, ("partitura_repository", "qualifier_source")),
                          (tart, ("source_app", "installed_app")),
                          (base, ("source_path", "mise_binary", "dedicated_path", "qualification_receipt")),
                          (runtime, ("root", "tart_home"))):
        for key in path_keys:
            if not isinstance(section[key], str) or not Path(section[key]).is_absolute():
                raise NativeHostError(f"configured path must be absolute: {key}")
    if not isinstance(base["name"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", base["name"]):
        raise NativeHostError("base.name must be a valid Tart VM name")
    if not isinstance(base["source_name"], str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", base["source_name"]):
        raise NativeHostError("base.source_name must be a valid Tart VM name")
    if not isinstance(base["source_sha256"], str) or (base["source_sha256"] and not HASH.fullmatch(base["source_sha256"])):
        raise NativeHostError("base.source_sha256 must be empty until selected or a lowercase SHA-256")
    if not isinstance(base["mise_sha256"], str) or (base["mise_sha256"] and not HASH.fullmatch(base["mise_sha256"])):
        raise NativeHostError("base.mise_sha256 must be empty until selected or a lowercase SHA-256")
    for key in ("node_version", "python_version"):
        if not isinstance(base[key], str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", base[key]):
            raise NativeHostError(f"base.{key} must be an exact runtime version")
    if not isinstance(base["mise_version"], str) or not re.fullmatch(r"[0-9]{4}\.[0-9]+\.[0-9]+", base["mise_version"]):
        raise NativeHostError("base.mise_version must be an exact Mise release version")
    if not isinstance(base["sha256"], str) or (base["sha256"] and not HASH.fullmatch(base["sha256"])):
        raise NativeHostError("base.sha256 must be empty until qualification or a lowercase SHA-256")
    if tart["executable_relative_path"] != "Contents/MacOS/tart":
        raise NativeHostError("unexpected Tart executable path")
    if tart["installed_app"] != str(ROOT_TART_APP):
        raise NativeHostError(f"tart.installed_app must be {ROOT_TART_APP}")
    if config["enabled"]:
        if not keys:
            raise NativeHostError("enabled provisioning requires one or two authorized_keys")
        if not base["sha256"]:
            raise NativeHostError("enabled provisioning requires a qualified base SHA-256")
    elif keys:
        raise NativeHostError("keep authorized_key empty while provisioning is disabled")
    if config["enabled"] and (not base["source_sha256"] or not base["mise_sha256"]):
        raise NativeHostError("enabled provisioning requires pinned source VM and Mise SHA-256 values")
    return config


def validate_authorized_keys(keys: list, enabled: bool) -> None:
    if not isinstance(keys, list) or len(keys) > 2 or any(not isinstance(key, str) for key in keys) or enabled and not keys:
        raise NativeHostError("authorized_keys must contain one or two public keys when enabled")
    if not enabled and keys:
        raise NativeHostError("keep authorized_key empty while provisioning is disabled")
    identities = set()
    for key in keys:
        validate_public_key(key)
        identity = base64.b64decode(key.split()[1], validate=True)
        if identity in identities:
            raise NativeHostError("duplicate authorized public key")
        identities.add(identity)


def validate_public_key(public_key: str) -> None:
    if len(public_key) > 16384 or any(ord(char) < 32 or ord(char) == 127 for char in public_key) or not PUBLIC_KEY.fullmatch(public_key):
        raise NativeHostError("authorized_key must be one supported OpenSSH public key")
    algorithm, encoded, *_ = public_key.split(" ", 2)
    try:
        blob = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise NativeHostError("authorized_key contains invalid base64") from error
    if len(blob) < 4:
        raise NativeHostError("authorized_key blob is truncated")
    algorithm_length = int.from_bytes(blob[:4], "big")
    embedded_algorithm = blob[4 : 4 + algorithm_length].decode("ascii", errors="replace")
    if embedded_algorithm != algorithm or len(blob) < 4 + algorithm_length:
        raise NativeHostError("authorized_key algorithm does not match its key blob")


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
    return result


def authorized_key_line(public_key: str) -> str:
    validate_public_key(public_key)
    options = (
        'restrict,command="/usr/bin/python3 /Library/Partitura/NativeBuild/broker.py",'
        "no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc"
    )
    return f"{options} {public_key}\n"


def sshd_dropin(account: str) -> str:
    return "\n".join(
        [
            f"Match User {account}",
            "    AuthorizedKeysFile /Library/Partitura/NativeBuild/authorized_keys",
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


def maintenance_plist(account: str) -> bytes:
    return plistlib.dumps({
        "Label": MAINTENANCE_LABEL, "UserName": account, "GroupName": "staff",
        "ProgramArguments": ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", f"HOME=/Users/{account}", "DEVELOPER_DIR=/Library/Developer/CommandLineTools", "/usr/bin/python3", "-I", str(ROOT_BROKER), "local-maintenance"],
        "RunAtLoad": True, "StartInterval": 60, "ProcessType": "Background", "WorkingDirectory": "/",
        "Umask": 0o077, "ExitTimeOut": 150, "ThrottleInterval": 60,
        "HardResourceLimits": {"Core": 0}, "SoftResourceLimits": {"Core": 0},
    }, sort_keys=True)


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
        if set(installed) not in (BROKER_CONFIG_KEYS, BROKER_CONFIG_KEYS | extension, BROKER_CONFIG_KEYS | (extension - {"minimumFreeBytes"})) or installed.get('keychainPath') != f'/Users/{account}/Library/Keychains/login.keychain-db':
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
    policy = config.get('broker', dict(host_id='', protocol=2, profile=(installed or {}).get('profile', 'legacy'), minimum_free_bytes=(installed or {}).get('minimumFreeBytes', MINIMUM_FREE_BYTES), daemon_relock_qualified=(installed or {}).get('daemonRelockQualified', False), daemon_relock_macos_build=(installed or {}).get('daemonRelockMacOSBuild', '')))
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
    script = r'''
import os, sys
floor = int(sys.argv[1])
free = []
for path in sys.argv[2:]:
    info = os.statvfs(path)
    free.append(info.f_bavail * info.f_frsize)
if min(free) < floor:
    raise SystemExit('runtime job/Tart root below sealed free-space floor')
print('runtime capacity verified: jobRootFreeBytes=%d tartRootFreeBytes=%d minimumFreeBytes=%d' % (*free, floor))
'''
    result = run([*account_python(config['account']), '-c', script, str(config['broker']['minimum_free_bytes']), config['runtime']['root'], config['runtime']['tart_home']], check=True, capture_output=True, text=True, timeout=15, cwd='/')
    print(result.stdout, end='')


def verify_host_policy(config: dict, run=subprocess.run) -> None:
    script = provision_constant(checked_provision_blob(config), 'KEYCHAIN_POLICY_SCRIPT')
    run([*account_python(config['account']), '-c', script, 'check'], check=True, capture_output=True, text=True, timeout=15, cwd='/')
    run(['/bin/launchctl', 'print', 'system/' + MAINTENANCE_LABEL], check=True, capture_output=True, text=True, timeout=15)


def safe_read(path: Path) -> bytes:
    reject_symlink_ancestors(path)
    return path.read_bytes()


def git_environment() -> dict[str, str]:
    """Run /usr/bin/git without user config and with the qualified toolchain.

    /usr/bin/git is an xcode-select shim. Keep a process-scoped DEVELOPER_DIR
    selection, or root would fall back to the globally selected toolchain.
    """
    environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": pwd.getpwuid(os.getuid()).pw_dir, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
    developer = os.environ.get("DEVELOPER_DIR")
    if developer is not None:
        trusted_root_path(Path(developer), "selected developer directory")
        environment["DEVELOPER_DIR"] = developer
    return environment


def checked_source_blobs(config: dict) -> tuple[bytes, bytes, bytes, bytes, bytes, bytes]:
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
    blobs: list[bytes] = []
    for relative, expected in (
        (BROKER_PATH, source["broker_sha256"]),
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
    return blobs[0], blobs[1], qualifier, blobs[2], blobs[3], blobs[4]


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
    return {
        key.lower(): value
        for line in result.stdout.splitlines()
        if len(parts := line.split(None, 1)) == 2
        for key, value in [parts]
    }


def expected_host_files(config: dict, blobs: tuple[bytes, bytes, bytes, bytes, bytes, bytes]) -> dict[Path, tuple[bytes, int]]:
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
        predecessors = (target_names - {str(ROOT_PLIST)}, target_names - {str(ROOT_PLIST), str(ROOT_WRITER)})
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
    expected = {
        "authorizedkeysfile": str(ROOT_AUTHORIZED_KEYS),
        "passwordauthentication": "no",
        "kbdinteractiveauthentication": "no",
        "authenticationmethods": "publickey",
        "forcecommand": FORCED_COMMAND,
        "allowtcpforwarding": "no",
        "allowagentforwarding": "no",
        "x11forwarding": "no",
        "permittty": "no",
        "permituserenvironment": "no",
        "clientaliveinterval": "15",
        "clientalivecountmax": "3",
    }
    mismatch = [key for key, value in expected.items() if effective.get(key) != value]
    if mismatch:
        raise NativeHostError("effective sshd policy differs: " + ", ".join(mismatch))


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
    if stale:
        print("partitura native host: prerequisites verified; managed files need installation")
        return 2
    verify_effective_sshd(config, effective)
    try:
        verify_host_policy(config, run)
    except subprocess.CalledProcessError:
        print("partitura native host: managed files current; daemon/keychain policy needs installation or initialization")
        return 2
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
    for name in ("broker.py", "guest-run.sh", "qualify.sh", "native_host.py", "install-host.sh", "credential-writer.py"):
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
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError, NativeHostError) as error:
        print(f"partitura native host: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
