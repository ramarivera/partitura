"""Bounded ONYXIO simulator artifact admission, before acquiring a device lease.

The binding comes from the authenticated build receipt and install capability,
never from the archive itself. This module doesn't run or install the app.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import mmap
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import struct
import subprocess
import tarfile
import tempfile
import time
import unicodedata

MAX_ARCHIVE = 2 * 1024 ** 3
MAX_EXPANDED = 4 * 1024 ** 3
MAX_MEMBERS = 50000
MAX_BINARIES = 512
MAX_METADATA = 65536
ARM64 = 0x0100000C
SIMULATOR = 7
MACH_MAGICS = (b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xce\xfa\xed\xfe', b'\xfe\xed\xfa\xce', b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf', b'\xbe\xba\xfe\xca', b'\xbf\xba\xfe\xca')
BINDING_KEYS = {'organizationId', 'runId', 'repository', 'commit', 'bundleId'}


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{1,3}(?:\.[0-9]{1,3}){0,2}', value):
        raise ValueError('invalid simulator OS version')
    parts = tuple(int(item) for item in value.split('.'))
    return parts + (0,) * (3 - len(parts))


def validate_binding(binding):
    if set(binding) != BINDING_KEYS or any(not isinstance(item, str) or not item for item in binding.values()):
        raise ValueError('invalid authenticated artifact binding')
    if not re.fullmatch(r'[a-f0-9]{40}', binding['commit']):
        raise ValueError('invalid source commit')
    if not re.fullmatch(r'[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+', binding['repository']):
        raise ValueError('invalid source repository')
    if not re.fullmatch(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', binding['bundleId']):
        raise ValueError('invalid bundle identity')


def member_path(name):
    # Reject aliases even on case-insensitive, Unicode-normalizing APFS volumes.
    if not name or '\\' in name or any(unicodedata.category(c).startswith('C') for c in name):
        raise ValueError('invalid archive member name')
    name = name.rstrip('/')
    parts = name.split('/')
    if any(part in ('', '.', '..') or ':' in part or part.startswith('._') for part in parts):
        raise ValueError('unsafe archive member path')
    if parts[0] != 'artifacts' or len(parts) > 64 or len(name) > 1024:
        raise ValueError('invalid artifact archive layout')
    return PurePosixPath(name)


def link_path(path, target):
    if not target or '\\' in target or target.startswith('/') or any(unicodedata.category(c).startswith('C') for c in target):
        raise ValueError('unsafe artifact symlink')
    parts = list(path.parent.parts)
    child_seen = False
    for part in target.split('/'):
        if part in ('', '.'):
            continue
        if part == '..':
            # A '..' after a symlink component has filesystem semantics that
            # differ from lexical normalization. Only leading parents are safe.
            if child_seen or len(parts) <= 2:
                raise ValueError('artifact symlink escapes app')
            parts.pop()
        elif ':' in part:
            raise ValueError('unsafe artifact symlink')
        else:
            child_seen = True
            parts.append(part)
    destination = PurePosixPath(*parts)
    if len(destination.parts) < 2 or destination.parts[:2] != path.parts[:2]:
        raise ValueError('artifact symlink escapes app')
    return destination


def archive_plan(archive):
    entries = {}
    aliases = set()
    expanded = 0
    for member in archive:
        if len(entries) >= MAX_MEMBERS:
            raise ValueError('artifact has too many entries')
        path = member_path(member.name)
        alias = unicodedata.normalize('NFD', str(path)).casefold()
        if alias in aliases:
            raise ValueError('duplicate artifact member')
        aliases.add(alias)
        if member.pax_headers.keys() - {'path', 'linkpath', 'mtime', 'atime', 'ctime'}:
            raise ValueError('artifact extended metadata is unsupported')
        if not (member.isdir() or member.isreg() or member.issym()) or member.issparse():
            raise ValueError('unsupported artifact entry type')
        if member.mode & 0o7000 or member.size < 0 or (not member.isreg() and member.size):
            raise ValueError('unsafe artifact entry metadata')
        expanded += member.size
        if expanded > MAX_EXPANDED:
            raise ValueError('expanded artifact exceeds limit')
        entries[path] = member
    apps = {path.parts[1] for path in entries if len(path.parts) > 1 and path.parts[1].endswith('.app')}
    if len(apps) != 1:
        raise ValueError('artifact must contain exactly one app')
    app = apps.pop()
    directories = set()
    for path, member in entries.items():
        directories.update(path.parents)
        if member.isdir():
            directories.add(path)
        if len(directories) > MAX_MEMBERS:
            raise ValueError('artifact has too many directories')
    spellings = {}
    for path in entries.keys() | directories:
        alias = unicodedata.normalize('NFD', str(path)).casefold()
        if alias in spellings and spellings[alias] != path:
            raise ValueError('artifact path aliases another member')
        spellings[alias] = path
    for path, member in entries.items():
        if path == PurePosixPath('artifacts') and member.isdir():
            continue
        if path in (PurePosixPath('artifacts/partitura-simulator.json'), PurePosixPath('artifacts/result.json')) and member.isreg() and member.size <= MAX_METADATA:
            continue
        if len(path.parts) < 2 or path.parts[1] != app:
            raise ValueError('unexpected artifact member')
        for parent in path.parents:
            if parent in entries and not entries[parent].isdir():
                raise ValueError('artifact member has a non-directory ancestor')
        if member.issym():
            destination = link_path(path, member.linkname)
            seen = {path}
            while True:
                if destination in seen or len(seen) > 64:
                    raise ValueError('cyclic artifact symlink')
                seen.add(destination)
                changed = False
                for parent in reversed(destination.parents):
                    ancestor = entries.get(parent)
                    if ancestor is None or ancestor.isdir():
                        continue
                    if not ancestor.issym():
                        raise ValueError('artifact link traverses a non-directory')
                    resolved = link_path(parent, ancestor.linkname)
                    destination = resolved / destination.relative_to(parent)
                    changed = True
                    break
                if changed:
                    continue
                target = entries.get(destination)
                if target is None:
                    # tar may omit directory records, but the target must exist.
                    if destination not in directories:
                        raise ValueError('dangling artifact symlink')
                    break
                if not target.issym():
                    break
                destination = link_path(destination, target.linkname)
    return entries, app


def bounded_tar_headers(source):
    # tarfile reads PAX/GNU extension payloads while advancing to the next
    # member, before archive_plan can bound their declared size.
    headers, extended_bytes = 0, 0
    while True:
        block = source.read(512)
        if len(block) != 512:
            raise ValueError('truncated tar header')
        if block == b'\0' * 512:
            if source.read(512) != b'\0' * 512:
                raise ValueError('invalid tar terminator')
            while True:
                tail = source.read(65536)
                if not tail:
                    break
                if tail.strip(b'\0'):
                    raise ValueError('unexpected data after tar terminator')
            source.seek(0)
            return
        member = tarfile.TarInfo.frombuf(block, 'utf-8', 'surrogateescape')
        headers += 1
        if headers > MAX_MEMBERS * 2 or member.size < 0 or member.size > MAX_EXPANDED:
            raise ValueError('tar header exceeds artifact limits')
        if member.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK):
            extended_bytes += member.size
            if member.size > MAX_METADATA or extended_bytes > 8 * 1024 ** 2:
                raise ValueError('tar extended header exceeds limit')
        source.seek(((member.size + 511) // 512) * 512, os.SEEK_CUR)


def simulator_macho(data, runtime):
    """Check load commands, including the arm64 slice of universal binaries."""
    slices = [(0, len(data), None)]
    if data[:4] in (b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf'):
        wide = data[:4] == b'\xca\xfe\xba\xbf'
        if len(data) < 8:
            raise ValueError('truncated universal binary')
        count = struct.unpack_from('>I', data, 4)[0]
        stride = 32 if wide else 20
        header_end = 8 + count * stride
        if not 1 <= count <= 16 or header_end > len(data):
            raise ValueError('invalid universal binary slices')
        slices = []
        for index in range(count):
            start = 8 + index * stride
            cpu = struct.unpack_from('>I', data, start)[0]
            offset, length = struct.unpack_from('>QQ' if wide else '>II', data, start + 8)
            if offset < header_end or length < 32 or offset + length > len(data) or any(offset < old + size and old < offset + length for old, size, _ in slices):
                raise ValueError('invalid universal binary range')
            slices.append((offset, length, cpu))
    arm64 = False
    filetypes = set()
    for offset, length, declared_cpu in slices:
        magic = data[offset:offset + 4]
        if magic not in (b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf') or length < 32:
            raise ValueError('unsupported Mach-O slice')
        order = '<' if magic == b'\xcf\xfa\xed\xfe' else '>'
        cpu, _, filetype, commands, size = struct.unpack_from(order + 'IIIII', data, offset + 4)
        filetypes.add(filetype)
        if declared_cpu is not None and declared_cpu != cpu:
            raise ValueError('inconsistent Mach-O architecture')
        arm64 = arm64 or cpu == ARM64
        if not 1 <= commands <= 4096 or size > 1024 ** 2 or 32 + size > length:
            raise ValueError('invalid Mach-O commands')
        cursor, end, platform_found = offset + 32, offset + 32 + size, False
        for _ in range(commands):
            if cursor + 8 > end:
                raise ValueError('truncated Mach-O command')
            command, command_size = struct.unpack_from(order + 'II', data, cursor)
            if command_size < 8 or command_size % 4 or cursor + command_size > end:
                raise ValueError('invalid Mach-O command length')
            if command == 0x32:
                if platform_found or command_size < 24:
                    raise ValueError('invalid Mach-O build version')
                platform, minimum, _, tools = struct.unpack_from(order + 'IIII', data, cursor + 8)
                minimum = (minimum >> 16, (minimum >> 8) & 255, minimum & 255)
                if platform != SIMULATOR or minimum > runtime or minimum == (0, 0, 0) or 24 + tools * 8 != command_size:
                    raise ValueError('Mach-O is incompatible with simulator runtime')
                platform_found = True
            cursor += command_size
        if cursor != end or not platform_found:
            raise ValueError('Mach-O simulator platform is missing')
    if not arm64 or len(filetypes) != 1:
        raise ValueError('artifact requires an arm64 simulator slice')
    return filetype


def verify_signatures(app, binaries):
    deadline = time.monotonic() + 60
    verify = subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], capture_output=True, timeout=30)
    if verify.returncode:
        raise ValueError('simulator app signature verification failed')
    for binary in binaries:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('simulator signature verification deadline exceeded')
        display = subprocess.run(['/usr/bin/codesign', '--display', '--verbose=4', str(binary)], capture_output=True, timeout=min(10, remaining))
        if display.returncode or not re.search(rb'^Signature=adhoc\r?$', display.stderr, re.M) or re.search(rb'^TeamIdentifier=(?!not set\r?$)', display.stderr, re.M):
            raise ValueError('simulator app requires ad-hoc signatures only')


def validate_app(root, app_name, binding, runtime, verify=verify_signatures):
    manifest = root / 'artifacts/partitura-simulator.json'
    if not manifest.is_file() or manifest.is_symlink() or manifest.stat().st_size > MAX_METADATA:
        raise ValueError('artifact binding manifest is missing')
    record = json.loads(manifest.read_bytes())
    if record != {'format': 1, 'app': app_name, **binding}:
        raise ValueError('artifact differs from authenticated build binding')
    app = root / 'artifacts' / app_name
    plist = app / 'Info.plist'
    if not plist.is_file() or plist.is_symlink() or plist.stat().st_size > MAX_METADATA:
        raise ValueError('app Info.plist is missing or oversized')
    info = plistlib.loads(plist.read_bytes())
    executable = info.get('CFBundleExecutable')
    if info.get('CFBundleIdentifier') != binding['bundleId'] or info.get('CFBundlePackageType') != 'APPL' or info.get('CFBundleSupportedPlatforms') != ['iPhoneSimulator']:
        raise ValueError('app identity or simulator platform differs')
    if not isinstance(executable, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+', executable) or executable in ('.', '..'):
        raise ValueError('unsafe app executable name')
    if version(info.get('MinimumOSVersion')) > runtime:
        raise ValueError('app minimum OS exceeds simulator runtime')
    bundle = app / 'main.jsbundle'
    if not bundle.is_file() or bundle.is_symlink() or bundle.stat().st_size == 0:
        raise ValueError('ONYXIO requires an embedded JS bundle')
    binaries = []
    main_found = False
    for path in app.rglob('*'):
        if path.is_symlink() or not path.is_file():
            continue
        with path.open('rb') as source:
            if source.read(4) not in MACH_MAGICS:
                continue
            with mmap.mmap(source.fileno(), 0, access=mmap.ACCESS_READ) as data:
                filetype = simulator_macho(data, runtime)
            if path == app / executable:
                if filetype != 2 or not path.stat().st_mode & 0o111:
                    raise ValueError('invalid app executable')
                main_found = True
            binaries.append(path)
            if len(binaries) > MAX_BINARIES:
                raise ValueError('artifact has too many executable images')
    if not main_found:
        raise ValueError('app executable is not a simulator Mach-O')
    verify(app, binaries)
    return app


@contextmanager
def admitted_app(archive_path, scratch, sha256, byte_count, binding, runtime_version, verify=verify_signatures):
    """Yield a privately extracted app only after all admission checks pass.

    No xattrs are restored. The private staging tree lives through the caller's
    leased install and is removed on every normal exit, including rejection.
    """
    validate_binding(binding)
    runtime = version(runtime_version)
    if not re.fullmatch(r'[a-f0-9]{64}', sha256) or type(byte_count) is not int or not 0 < byte_count <= MAX_ARCHIVE:
        raise ValueError('invalid artifact transfer receipt')
    scratch = Path(scratch)
    metadata = scratch.lstat()
    if scratch.resolve() != scratch or not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise ValueError('artifact staging requires a private owned directory')
    fd = os.open(archive_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != byte_count:
            raise ValueError('artifact transfer length differs')
        with tempfile.TemporaryDirectory(prefix='simulator-', dir=scratch) as staging:
            root = Path(staging)
            # Parse a private snapshot of the bytes that were actually hashed.
            # The gateway-owned input may otherwise change between hash and tar.
            snapshot = root / 'artifact.tar'
            digest, received = hashlib.sha256(), 0
            with snapshot.open('xb') as output:
                while True:
                    block = source.read(min(65536, byte_count - received + 1))
                    if not block:
                        break
                    received += len(block)
                    if received > byte_count:
                        raise ValueError('artifact transfer length differs')
                    digest.update(block)
                    output.write(block)
            if received != byte_count or digest.hexdigest() != sha256:
                raise ValueError('artifact transfer digest differs')
            with snapshot.open('rb') as raw:
                bounded_tar_headers(raw)
            with tarfile.open(snapshot, mode='r:') as archive:
                entries, app_name = archive_plan(archive)
                for path, member in entries.items():
                    if member.issym():
                        continue
                    destination = root.joinpath(*path.parts)
                    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    if member.isdir():
                        destination.mkdir(mode=0o700, exist_ok=True)
                    else:
                        with archive.extractfile(member) as content, destination.open('xb') as output:
                            remaining = member.size
                            while remaining:
                                block = content.read(min(65536, remaining))
                                if not block:
                                    raise ValueError('truncated artifact member')
                                output.write(block)
                                remaining -= len(block)
                        destination.chmod(0o700 if member.mode & 0o111 else 0o600)
                for path, member in entries.items():
                    if member.issym():
                        destination = root.joinpath(*path.parts)
                        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                        destination.symlink_to(member.linkname)
            yield validate_app(root, app_name, binding, runtime, verify)
