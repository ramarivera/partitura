#!/bin/bash
# Prepare portable generic runtimes without reading the operator's Mise config.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
[ "$#" -eq 5 ] || { echo 'Usage: prepare-runtime-cache.sh MISE_BINARY MISE_SHA256 NODE_VERSION PYTHON_VERSION NEW_OUTPUT_DIRECTORY' >&2; exit 64; }
mise_binary=$1 mise_sha=$2 node_version=$3 python_version=$4 output=$5
[ "$(uname -s):$(uname -m)" = Darwin:arm64 ] || { echo 'runtime cache requires an Apple silicon Mac' >&2; exit 1; }
[[ "$mise_sha" =~ ^[a-f0-9]{64}$ && "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$python_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'runtime cache needs exact tool pins' >&2; exit 1; }
[ -f "$mise_binary" ] && [ ! -L "$mise_binary" ] && [ -x "$mise_binary" ] || { echo 'Mise binary must be a regular executable' >&2; exit 1; }
[ "$(shasum -a256 "$mise_binary" | awk '{print $1}')" = "$mise_sha" ] || { echo 'Mise binary does not match its pin' >&2; exit 1; }
case "$output" in "$HOME"/dev/agentic-scratchpads/*) ;; *) echo 'output must be under your dev/agentic-scratchpads directory' >&2; exit 1;; esac
/usr/bin/python3 - "$output" <<'PY'
from pathlib import Path
import os, sys
p = Path(sys.argv[1])
if str(p) != os.path.normpath(str(p)) or p.exists() or p.is_symlink():
    raise SystemExit('output must be a new normalized directory')
if p.parent.resolve(strict=True) != p.parent:
    raise SystemExit('output parent must not contain symlinks')
PY
mkdir -m 0700 "$output"
mkdir "$output/home" "$output/config" "$output/data" "$output/cache" "$output/state"
# An empty HOME alone isn't enough. Mise also discovers project config from cwd.
cd /
isolated_mise() {
  /usr/bin/env -i HOME="$output/home" PATH="$PATH" MISE_DATA_DIR="$output/data" \
    MISE_CONFIG_DIR="$output/config" MISE_CACHE_DIR="$output/cache" MISE_STATE_DIR="$output/state" \
    MISE_YES=1 MISE_JOBS=2 "$mise_binary" "$@"
}
isolated_mise config ls --json > "$output/config-sources.json"
/usr/bin/python3 - "$output/config-sources.json" <<'PY'
import json, sys
if json.load(open(sys.argv[1])):
    raise SystemExit('isolated Mise unexpectedly discovered operator configuration')
PY
isolated_mise install --yes --jobs 2 "node@$node_version" "python@$python_version"
[ "$("$output/data/installs/node/$node_version/bin/node" --version)" = "v$node_version" ]
[ "$("$output/data/installs/python/$python_version/bin/python3" --version)" = "Python $python_version" ]
COPYFILE_DISABLE=1 tar -C "$output/data" -cf "$output/runtimes.tar" "installs/node/$node_version" "installs/python/$python_version"
shasum -a256 "$output/runtimes.tar"
