"""Build the single-file broker deterministically from pinned source bytes."""
import io
from pathlib import Path
import subprocess
import zipfile

BROKER_FILES = (
    '__main__.py',
    'partitura_broker/__init__.py',
    'partitura_broker/execution.py',
    'partitura_broker/identity.py',
    'partitura_broker/recovery.py',
    'partitura_broker/state.py',
    'partitura_broker/vm.py',
)
BROKER_SOURCE = 'deploy/mac-build/broker/'


def build_broker_archive(entries):
    if set(entries) != set(BROKER_FILES):
        raise ValueError('unexpected broker package entries')
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(entries):
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100644 << 16)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, entries[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return output.getvalue()


def broker_from_directory(directory):
    root = Path(directory)
    return build_broker_archive({name: (root / name).read_bytes() for name in BROKER_FILES})


def broker_from_commit(repository, commit, environment):
    entries = {}
    for name in BROKER_FILES:
        result = subprocess.run(
            ['/usr/bin/git', '-C', str(repository), 'show', f'{commit}:{BROKER_SOURCE}{name}'],
            check=True, capture_output=True, env=environment,
        )
        entries[name] = result.stdout
    return build_broker_archive(entries)
