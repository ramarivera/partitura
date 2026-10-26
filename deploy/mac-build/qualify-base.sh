#!/bin/bash
# Project-neutral checks run inside a guest before it becomes a reusable base.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export MISE_OFFLINE=true MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false

fail() { printf 'base qualification failed: %s\n' "$1" >&2; exit 1; }
[ "$#" -eq 3 ] || fail 'expected runner hash, qualifier hash, and guest user'
runner_sha=$1
qualifier_sha=$2
guest_user=$3
[[ "$runner_sha" =~ ^[a-f0-9]{64}$ && "$qualifier_sha" =~ ^[a-f0-9]{64}$ ]] || fail 'invalid source hash'
[[ "$guest_user" =~ ^[a-z][a-z0-9_-]{0,30}$ && "$guest_user" != root ]] || fail 'invalid guest user'
[ "$(uname -s)" = Darwin ] || fail 'guest must run macOS'
[ "$(uname -m)" = arm64 ] || fail 'guest must run on Apple silicon'
[ "$(id -un)" = "$guest_user" ] || fail 'qualification must run as the configured guest user'
[ "$(id -u)" -ne 0 ] || fail 'qualification must not run as root'
# git on macOS is an Xcode/Command Line Tools shim. Check the selected tools
# first so qualification fails without triggering Apple's interactive setup.
developer_dir=$(/usr/bin/xcode-select -p 2>/dev/null) || fail 'select Xcode or install its Command Line Tools before qualifying this base'
[ -d "$developer_dir" ] || fail 'selected Xcode or Command Line Tools directory is unavailable'
git_version=$(/usr/bin/git --version 2>/dev/null) || fail 'Apple git is unavailable; install Xcode or its Command Line Tools'
clang_path=$(/usr/bin/xcrun --find clang 2>/dev/null) || fail 'Apple clang is unavailable; install Xcode or its Command Line Tools'
make_path=$(/usr/bin/xcrun --find make 2>/dev/null) || fail 'Apple make is unavailable; install Xcode or its Command Line Tools'
[ -x "$clang_path" ] && [ -x "$make_path" ] || fail 'selected Apple developer tools are incomplete'
guest_home="/Users/$guest_user"
[ "$HOME" = "$guest_home" ] || fail 'guest HOME does not match the account home'
[ "$(stat -f '%u:%Lp' "$guest_home")" = "$(id -u):700" ] || fail 'guest home must be private and owned by the guest user'

root=/Library/Partitura/NativeBuild
runner=$root/run.sh
qualifier=$root/qualify.sh
mise=/usr/local/bin/mise
toolchain=$root/toolchain.env
for path in /Library /Library/Partitura "$root" "$runner" "$qualifier" "$toolchain"; do
  [ ! -L "$path" ] || fail "sealed path contains a symlink: $path"
done
for path in "$root" "$runner" "$qualifier"; do
  [ "$(stat -f '%u:%Lp' "$path")" = '0:555' ] || fail "sealed path must be root-owned mode 0555: $path"
done
[ "$(shasum -a 256 "$runner" | awk '{print $1}')" = "$runner_sha" ] || fail 'runner hash differs from the pinned source'
[ "$(shasum -a 256 "$qualifier" | awk '{print $1}')" = "$qualifier_sha" ] || fail 'qualifier hash differs from the pinned source'
[ "$(stat -f '%u:%Lp' "$toolchain")" = '0:444' ] || fail 'toolchain metadata must be root-owned mode 0444'
mise_sha= mise_version= node_version= python_version=
seen_mise_sha=0 seen_mise_version=0 seen_node=0 seen_python=0 metadata_count=0
while IFS='=' read -r key value; do
  metadata_count=$((metadata_count + 1))
  case "$key" in
    miseSha256) [ "$seen_mise_sha" -eq 0 ] || fail 'toolchain metadata has a duplicate key'; mise_sha=$value; seen_mise_sha=1 ;;
    miseVersion) [ "$seen_mise_version" -eq 0 ] || fail 'toolchain metadata has a duplicate key'; mise_version=$value; seen_mise_version=1 ;;
    nodeVersion) [ "$seen_node" -eq 0 ] || fail 'toolchain metadata has a duplicate key'; node_version=$value; seen_node=1 ;;
    pythonVersion) [ "$seen_python" -eq 0 ] || fail 'toolchain metadata has a duplicate key'; python_version=$value; seen_python=1 ;;
    *) fail 'toolchain metadata has an unknown key' ;;
  esac
done < "$toolchain"
[ "$metadata_count" -eq 4 ] || fail 'toolchain metadata is incomplete'
[[ "$mise_sha" =~ ^[a-f0-9]{64}$ && "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$python_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$mise_version" =~ ^[0-9]{4}\.[0-9]+\.[0-9]+$ ]] || fail 'toolchain metadata contains an invalid pin'
[ ! -L /usr/local ] && [ ! -L /usr/local/bin ] && [ ! -L "$mise" ] || fail 'Mise installation path contains a symlink'
[ "$(stat -f '%u:%Lp' "$mise")" = '0:555' ] || fail 'Mise binary must be root-owned mode 0555'
[ "$(shasum -a 256 "$mise" | awk '{print $1}')" = "$mise_sha" ] || fail 'Mise binary hash differs from its pin'
[[ "$($mise --version | awk 'NR == 1 {print $1}')" = "$mise_version" ]] || fail 'Mise version differs from its pin'
config="$guest_home/.config/mise/config.toml"
[ ! -L "$guest_home/.config" ] && [ ! -L "$guest_home/.config/mise" ] && [ ! -L "$config" ] || fail 'Mise config path contains a symlink'
[ "$(stat -f '%u:%Lp' "$config")" = "$(id -u):644" ] || fail 'Mise config must be guest-owned mode 0644'
grep -Fx "node = \"$node_version\"" "$config" >/dev/null || fail 'global Node pin differs from the prepared version'
grep -Fx "python = \"$python_version\"" "$config" >/dev/null || fail 'global Python pin differs from the prepared version'
node_output=$(MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false "$mise" exec --deny-net --no-deps "node@$node_version" "python@$python_version" -- node --version)
python_output=$(MISE_AUTO_INSTALL=false MISE_EXEC_AUTO_INSTALL=false "$mise" exec --deny-net --no-deps "node@$node_version" "python@$python_version" -- python --version)
[ "$node_output" = "v$node_version" ] || fail 'offline Mise Node runtime check failed'
[[ "$python_output" = "Python $python_version"* ]] || fail 'offline Mise Python runtime check failed'

# Tart directory shares appear as mounts under /Volumes. The launcher also
# starts jobs without any --dir/share options; this check catches a base that
# was prepared with a host directory still attached.
mount_check=$(mount | awk 'index($3, "/Volumes/") == 1 { found=1 } tolower($0) ~ /virtiofs|9pfs|smbfs/ { found=1 } END { print found ? "host-share" : "none" }')
[ "$mount_check" = none ] || fail 'guest has a mounted host share'

printf 'PARTITURA_NATIVE_BASE_QUALIFIED os=Darwin arch=arm64 guestUser=%s developerTools=verified runnerSha256=%s qualifierSha256=%s miseSha256=%s miseVersion=%s nodeVersion=%s pythonVersion=%s\n' \
  "$guest_user" "$runner_sha" "$qualifier_sha" "$mise_sha" "$mise_version" "$node_version" "$python_version"
