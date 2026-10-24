"""Validate a pinned archive of portable Node/Python installs before guest transfer."""
import argparse
import hashlib
from pathlib import Path, PurePosixPath
import posixpath
import re
import tarfile

LIMIT = 2 * 1024 * 1024 * 1024


def validate_archive(path: Path, expected_sha: str, node_version: str, python_version: str) -> None:
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha) or not all(
        re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version)
        for version in (node_version, python_version)
    ):
        raise ValueError("runtime cache requires exact SHA-256 and version pins")
    if path.is_symlink() or not path.is_file() or path.stat().st_size > LIMIT:
        raise ValueError("runtime cache must be a regular archive at most 2 GiB")
    with path.open("rb") as source:
        digest = hashlib.sha256()
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
        if digest.hexdigest() != expected_sha:
            raise ValueError("runtime cache SHA-256 differs from its pin")
    roots = (f"installs/node/{node_version}", f"installs/python/{python_version}")
    ancestors = {"installs", "installs/node", "installs/python", *roots}
    with tarfile.open(path, "r:") as archive:
        members = archive.getmembers()
        if len(members) > 100_000 or sum(member.size for member in members) > LIMIT:
            raise ValueError("runtime cache exceeds its entry or payload limit")
        names = set()
        links = set()
        for member in members:
            name = member.name.rstrip("/")
            if not name or name.startswith("/") or posixpath.normpath(name) != name or name in names:
                raise ValueError("runtime cache has duplicate or unsafe paths")
            names.add(name)
            root = next((root for root in roots if name == root or name.startswith(root + "/")), None)
            if name not in ancestors and root is None:
                raise ValueError("runtime cache contains files outside its pinned runtimes")
            if name in ancestors and not member.isdir():
                raise ValueError("runtime cache ancestor must be a directory")
            if member.issym():
                target = posixpath.normpath(str(PurePosixPath(name).parent / member.linkname))
                if member.linkname.startswith("/") or root is None or not target.startswith(root + "/"):
                    raise ValueError("runtime cache symlink escapes its pinned runtime")
                links.add(name)
            elif not member.isfile() and not member.isdir():
                raise ValueError("runtime cache contains a hardlink or special file")
        if any(str(parent) in links for name in names for parent in PurePosixPath(name).parents):
            raise ValueError("runtime cache contains a child beneath a symlink")
        if not {roots[0] + "/bin/node", roots[1] + "/bin/python3"}.issubset(names):
            raise ValueError("runtime cache is missing a required executable")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("sha256")
    parser.add_argument("node_version")
    parser.add_argument("python_version")
    args = parser.parse_args()
    validate_archive(args.archive, args.sha256, args.node_version, args.python_version)
