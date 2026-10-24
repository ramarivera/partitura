#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: seed-mise-installs.sh DATA_DIR SHARED_INSTALLS" >&2
  exit 64
fi
mise_data=$1
shared_installs=$2
case "$mise_data:$shared_installs" in
  /*:/*) ;;
  *) echo "Mise install paths must be absolute" >&2; exit 64 ;;
esac

ensure_real_directory() {
  path=$1
  if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then
    echo "unsafe Mise install path: $path" >&2
    exit 1
  fi
  if [ ! -d "$path" ]; then
    mkdir -m 0700 "$path"
  fi
}

ensure_real_directory "$mise_data"
ensure_real_directory "$mise_data/installs"
for tool in node python; do
  source_directory="$shared_installs/$tool"
  if [ -L "$source_directory" ] || [ ! -d "$source_directory" ]; then
    echo "missing shared Mise runtime directory: $source_directory" >&2
    exit 1
  fi
  ensure_real_directory "$mise_data/installs/$tool"
  for source_version in "$source_directory"/*; do
    [ -d "$source_version" ] || continue
    [ ! -L "$source_version" ] || continue
    version=${source_version##*/}
    destination="$mise_data/installs/$tool/$version"
    if [ -L "$destination" ]; then
      [ "$(readlink "$destination")" = "$source_version" ] || {
        echo "unexpected Mise runtime link: $destination" >&2
        exit 1
      }
    elif [ ! -e "$destination" ]; then
      ln -s "$source_version" "$destination"
    fi
  done
done
