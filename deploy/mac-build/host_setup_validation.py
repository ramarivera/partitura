"""Validation and filesystem hashing for native host setup."""
from __future__ import annotations
import base64
import hashlib
import os
import pwd
from pathlib import Path
import re
import stat
import subprocess
import sys

HASH = re.compile(r"[a-f0-9]{64}\Z")
COMMIT = re.compile(r"[a-f0-9]{40}\Z")
PUBLIC_KEY = re.compile(r"(?:ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?\Z")
ROOT_TART_APP = Path("/Library/Partitura/NativeBuild/tart.app")
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
    policy = dict(host_id="", protocol=2, profile="legacy", minimum_free_bytes=MINIMUM_FREE_BYTES, daemon_relock_qualified=False, daemon_relock_macos_build="", keychain_policy=None)
    if "broker" in config:
        raw = config['broker']
        if not isinstance(raw, dict) or set(raw) - BROKER_POLICY_KEYS - {'keychain_policy'} or BROKER_POLICY_KEYS - set(raw):
            raise NativeHostError('invalid broker policy fields')
        policy.update(raw)
    value = policy['keychain_policy']
    if value is not None and (not isinstance(value, dict) or set(value) != {'lockOnSleep', 'lockInterval'} or type(value['lockOnSleep']) is not bool or type(value['lockInterval']) is not int or not 0 <= value['lockInterval'] <= 2**31 - 1):
        raise NativeHostError('invalid broker keychain_policy')
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
