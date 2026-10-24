#!/bin/bash
# Digests are from jdx/mise v2026.10.15 GitHub release asset metadata.
set -euo pipefail
umask 077

if [ "$#" -ne 2 ]; then
  printf '%s\n' 'Usage: fetch-mise.sh linux-x64|linux-arm64|macos-arm64 /absolute/output/path' >&2
  exit 64
fi
platform=$1 destination=$2
case "$platform" in
  linux-x64) digest=e3b186d4c70627f27037be615becaf4acfb30e41fb6a1819486717dc94e4e2a9 ;;
  linux-arm64) digest=3abbaac305a465ef038eb4ea07b961c037a8b639108005e43f8e2c00a8f67c11 ;;
  macos-arm64) digest=826c4833fa7437a63f6027b86bc10c8b61b1163dc793c03ecde92f68ad167890 ;;
  *) printf '%s\n' 'Unsupported Mise platform' >&2; exit 64 ;;
esac
[[ "$destination" = /* && "$destination" != */ && "$destination" != *'/../'* && "$destination" != */.. && "$destination" != *'/./'* && "$destination" != *'//'* ]] || {
  printf '%s\n' 'Mise output path must be absolute and normalized' >&2
  exit 64
}
ancestor=$destination
while [ "$ancestor" != / ]; do
  [ ! -L "$ancestor" ] || { printf '%s\n' 'Mise output has a symlinked path' >&2; exit 1; }
  ancestor=${ancestor%/*}; [ -n "$ancestor" ] || ancestor=/
done
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
if [ -e "$destination" ]; then
  [ -f "$destination" ] && [ "$(hash_file "$destination")" = "$digest" ] || {
    printf '%s\n' 'Existing Mise output differs from the pinned asset; refusing overwrite' >&2
    exit 1
  }
  printf 'Verified Mise 2026.10.15 %s sha256=%s\n' "$platform" "$digest"
  exit 0
fi
[ -d "${destination%/*}" ] || { printf '%s\n' 'Create the owned output directory first' >&2; exit 1; }
partial=$(mktemp "$destination.partial.XXXXXX")
trap 'rm -f "$partial"' EXIT
curl --fail --location --proto '=https' --retry 3 \
  "https://github.com/jdx/mise/releases/download/v2026.10.15/mise-v2026.10.15-$platform" \
  --output "$partial"
[ "$(hash_file "$partial")" = "$digest" ] || { printf '%s\n' 'Mise asset checksum differs' >&2; exit 1; }
chmod 0755 "$partial"
mv -n "$partial" "$destination"
[ -f "$destination" ] && [ ! -L "$destination" ] && [ "$(hash_file "$destination")" = "$digest" ] || {
  printf '%s\n' 'Mise output changed during download' >&2
  exit 1
}
printf 'Downloaded Mise 2026.10.15 %s sha256=%s\n' "$platform" "$digest"
