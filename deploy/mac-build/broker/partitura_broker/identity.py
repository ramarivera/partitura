"""Native build broker: identity."""
from __future__ import annotations


import ctypes as C
import hashlib
import json
import os
import pwd
from pathlib import Path
import re
import stat


import partitura_broker as api

def parse_command(command):
    if not isinstance(command, str) or len(command) > 512:
        raise ValueError('unsupported native build command')
    if command == 'health':
        return ('health',)
    match = api.RUN_V2.fullmatch(command)
    if match:
        job, commit, pr, action, length, secret_length, epoch, attempt, expiry = match.groups()
        if int(length) > api.MAX_BUNDLE or int(secret_length) > 65536:
            raise ValueError('input exceeds limit')
        return ('run-v2', job, commit, pr, action, int(length), int(secret_length), epoch, attempt, int(expiry))
    match = re.fullmatch(rf'reconcile ({api.JOB})', command)
    if match:
        return ('reconcile', match[1])
    match = api.RUN.fullmatch(command)
    if match:
        job, commit, pr, action, length, secret_length = match.groups()
        if int(length) > api.MAX_BUNDLE:
            raise ValueError('bundle exceeds limit')
        if secret_length is not None and int(secret_length) > 65536:
            raise ValueError('job secret input exceeds limit')
        request = ('run', job, commit, pr, action, int(length))
        return request if secret_length is None else (*request, int(secret_length))
    match = api.READ.fullmatch(command)
    if match:
        return match.groups()
    raise ValueError('unsupported native build command')


def sealed(path):
    """Reject caller-writable installed source and symlinked ancestors."""
    path = Path(path)
    if not path.is_absolute():
        raise ValueError('installed path must be absolute')
    for item in (path, *path.parents):
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('unsafe installed source')
    return path


def load_config(allow_storage_denial=False):
    with api.sealed(api.CONFIG).open('r') as source:
        text = source.read(65537)
    if len(text) > 65536:
        raise ValueError('oversized installed configuration')
    config = json.loads(text, object_pairs_hook=api.unique_object)
    legacy = {'tart', 'tartSha256', 'base', 'root', 'tartHome', 'guestRunnerSha256', 'qualifierSha256', 'guestUser', 'guestHome', 'keychainPath', 'keychainCredentialPath'}
    registry = {'hostId', 'profile', 'daemonRelockQualified', 'daemonRelockMacOSBuild'}
    if set(config) != legacy and (not (legacy | registry) <= set(config) or set(config) - legacy - registry - {'minimumFreeBytes', 'keychainPolicy'}):
        raise ValueError('invalid installed configuration')
    if 'hostId' in config:
        if not isinstance(config['hostId'], str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', config['hostId']) or config['profile'] not in ('legacy', 'registry-only'):
            raise ValueError('invalid installed identity/profile')
        if type(config['daemonRelockQualified']) is not bool or not isinstance(config['daemonRelockMacOSBuild'], str) or not re.fullmatch(r'[A-Za-z0-9]{0,32}', config['daemonRelockMacOSBuild']):
            raise ValueError('invalid daemon qualification')
        if config['daemonRelockQualified'] and not config['daemonRelockMacOSBuild']:
            raise ValueError('missing daemon qualification build')
        floor = config.get('minimumFreeBytes', api.DISK_FLOOR)
        if type(floor) is not int or not api.DISK_FLOOR <= floor <= 2**63 - 1:
            raise ValueError('invalid installed disk floor')
        api.validate_keychain_policy(config.get('keychainPolicy'))
    api.validate_keychain_paths(config)
    tart = api.sealed(config['tart'])
    if hashlib.sha256(tart.read_bytes()).hexdigest() != config['tartSha256']:
        raise ValueError('installed Tart digest differs')
    for key in ('guestRunnerSha256', 'qualifierSha256', 'tartSha256'):
        if not re.fullmatch('[a-f0-9]{64}', config[key]):
            raise ValueError('invalid installed digest')
    if not re.fullmatch('[a-z0-9][a-z0-9-]{1,80}', config['base']):
        raise ValueError('invalid sealed base name')
    if not re.fullmatch('[a-z][a-z0-9_-]{0,30}', config['guestUser']) or config['guestUser'] == 'root':
        raise ValueError('invalid guest user')
    if config['guestHome'] != '/Users/' + config['guestUser']:
        raise ValueError('invalid guest home')
    for key in ('root', 'tartHome'):
        path = Path(config[key])
        try:
            info = path.lstat()
        except OSError as error:
            if api.tart_path(config, path):
                probe = api.StorageProbeError(config, error)
                if allow_storage_denial and key == 'tartHome':
                    continue  # Health can still inspect the accessible runtime root.
                raise probe from None
            raise
        if not path.is_absolute() or path.resolve() != path or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('unsafe private runtime directory')
    return config


def validate_keychain_paths(config):
    account = pwd.getpwuid(os.getuid())
    home = Path(account.pw_dir)
    if account.pw_name == 'root' or home != Path('/Users') / account.pw_name:
        raise ValueError('keychain requires the dedicated host account')
    info = home.lstat()
    if home.resolve() != home or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('unsafe dedicated account home')
    if config['keychainPath'] != str(home / 'Library/Keychains/login.keychain-db') or config['keychainCredentialPath'] != str(home / '.partitura-native-login.password'):
        raise ValueError('keychain paths differ from the dedicated account')


class KeychainError(Exception):
    """Contains fixed API stages and numeric status only, never credentials."""


def validate_keychain_policy(value):
    if value is not None and (not isinstance(value, dict) or set(value) != {'lockOnSleep', 'lockInterval'} or type(value['lockOnSleep']) is not bool or type(value['lockInterval']) is not int or not 0 <= value['lockInterval'] <= 2**31 - 1):
        raise ValueError('invalid keychain policy')
    return value


def policy_evidence(root):
    try:
        evidence = api.json_state(root / 'keychain-policy.json')
        if evidence is not None and set(evidence) == {'before', 'requested', 'actual'} and evidence['before'] is not None and evidence['requested'] is not None:
            for value in evidence.values():
                api.validate_keychain_policy(value)
            return evidence
    except (OSError, ValueError):
        pass
    return None


class KeychainSettings(C.Structure):
    _fields_ = [('version', C.c_uint32), ('lockOnSleep', C.c_ubyte), ('useLockInterval', C.c_ubyte), ('lockInterval', C.c_uint32)]


class LoginKeychain:
    def __init__(self, config):
        api.validate_keychain_paths(config)
        self.config = config
        self.ref = C.c_void_p()
        self.security = C.CDLL('/System/Library/Frameworks/Security.framework/Security')
        self.core = C.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
        self.core.CFRelease.argtypes = [C.c_void_p]
        self.core.CFRelease.restype = None
        for name, arguments in {
            'SecKeychainSetUserInteractionAllowed': [C.c_ubyte],
            'SecKeychainOpen': [C.c_char_p, C.POINTER(C.c_void_p)],
            'SecKeychainGetStatus': [C.c_void_p, C.POINTER(C.c_uint32)],
            'SecKeychainUnlock': [C.c_void_p, C.c_uint32, C.c_void_p, C.c_ubyte],
            'SecKeychainLock': [C.c_void_p],
            'SecKeychainCopySettings': [C.c_void_p, C.POINTER(api.KeychainSettings)],
            'SecKeychainSetSettings': [C.c_void_p, C.POINTER(api.KeychainSettings)],
        }.items():
            function = getattr(self.security, name)
            function.argtypes = arguments
            function.restype = C.c_int32
        try:
            self.check(self.security.SecKeychainSetUserInteractionAllowed(0), 'interaction')
            self.check(self.security.SecKeychainOpen(os.fsencode(config['keychainPath']), C.byref(self.ref)), 'open')
        except BaseException:
            self.close()
            raise

    @staticmethod
    def check(status, stage):
        if status:
            raise api.KeychainError(stage + ':' + str(status))

    def state(self):
        status = C.c_uint32()
        self.check(self.security.SecKeychainGetStatus(self.ref, C.byref(status)), 'status')
        return 'unlocked' if status.value & 1 else 'locked'

    def unlock(self):
        descriptor = os.open(self.config['keychainCredentialPath'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or not 1 <= info.st_size <= 1024:
                raise api.KeychainError('credential-metadata')
            password = source.read(1025)
        if not 1 <= len(password) <= 1024 or b'\0' in password or b'\n' in password or b'\r' in password:
            raise api.KeychainError('credential-length')
        buffer = C.create_string_buffer(password)
        del password
        try:
            self.check(self.security.SecKeychainUnlock(self.ref, len(buffer) - 1, buffer, 1), 'unlock')
        finally:
            C.memset(buffer, 0, len(buffer))
        if self.state() != 'unlocked':
            raise api.KeychainError('unlock-state')

    def lock(self):
        self.check(self.security.SecKeychainLock(self.ref), 'lock')
        if self.state() != 'locked':
            raise api.KeychainError('lock-state')

    def settings(self):
        current = api.KeychainSettings(1, 0, 0, 0)
        self.check(self.security.SecKeychainCopySettings(self.ref, C.byref(current)), 'policy-read')
        return api.validate_keychain_policy(dict(lockOnSleep=bool(current.lockOnSleep), lockInterval=current.lockInterval))

    def apply_policy(self, policy, evidence_path):
        api.validate_keychain_policy(policy)
        # securityd requires an unlocked keychain even for CopySettings. Only
        # run_job's SSH session may call this, immediately after unlock.
        before = self.settings()
        previous = api.policy_evidence(evidence_path.parent)
        if os.path.lexists(evidence_path) and previous is None:
            raise api.KeychainError('policy-evidence')
        if previous:
            before = previous['before']  # Keep the first snapshot across policy changes and revert.
        evidence = dict(before=before, requested=policy, actual=None)
        api.durable_write(evidence_path, json.dumps(evidence) + '\n')
        # useLockInterval is retained only for ABI layout: Set ignores it and Copy
        # leaves it untouched. INT_MAX is security(1)'s no-timeout sentinel.
        desired = api.KeychainSettings(1, policy['lockOnSleep'], 0, policy['lockInterval'])
        self.check(self.security.SecKeychainSetSettings(self.ref, C.byref(desired)), 'policy-set')
        actual = self.settings()
        if actual != policy:
            raise api.KeychainError('policy-readback')
        evidence['actual'] = actual
        api.durable_write(evidence_path, json.dumps(evidence) + '\n')
        return evidence

    def close(self):
        if self.ref:
            self.core.CFRelease(self.ref)
            self.ref = C.c_void_p()
