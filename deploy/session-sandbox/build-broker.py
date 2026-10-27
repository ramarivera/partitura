#!/usr/bin/env python3
"""Build the single-file broker with reproducible zip metadata."""
from pathlib import Path
import sys
import zipfile


def build(destination: Path) -> None:
    root = Path(__file__).resolve().parent
    package = root / "sandbox_broker"
    entries = {"__main__.py": b"from sandbox_broker import __main__\n"}
    entries.update({f"sandbox_broker/{path.name}": path.read_bytes()
                    for path in package.glob("*.py") if path.is_file()})
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, contents in sorted(entries.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, contents)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} OUTPUT")
    build(Path(sys.argv[1]))
