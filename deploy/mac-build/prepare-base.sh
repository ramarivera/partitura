#!/bin/bash
# Clone and seal a user-selected pinned Tart VM as a generic Partitura base.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

usage() {
  cat <<'EOF'
Usage: prepare-base.sh --source NAME --source-sha256 HASH --base NAME
  --tart PATH --tart-home PATH --runner PATH --qualifier PATH
  --guest-user NAME --mise-binary PATH --mise-version VERSION
  --mise-sha256 HASH --node-version VERSION --python-version VERSION
  [--runtime-cache PATH --runtime-cache-sha256 HASH]
  [--dedicated-tart-home PATH --dedicated-account NAME]
  [--receipt PATH] [--apply]

The default is a read-only preflight. --apply clones and changes a VM, then
stops it and writes a root-owned qualification receipt. When a dedicated Tart
home is supplied, it copies the qualified base there, seals ownership and
rehashes the destination before writing a receipt bound to that path. It never
changes the source VM. Run on an Apple silicon Mac with Tart and an already
prepared, user-selected clean macOS VM. No host directories are shared.
EOF
}

fail() { printf 'base preparation failed: %s\n' "$1" >&2; exit 1; }
check_path() {
  local path=$1 current
  [[ "$path" = /* && "$path" != */ && "$path" != *'/../'* && "$path" != */.. && "$path" != *'/./'* && "$path" != */. && "$path" != *'//'* ]] || fail "expected a normalized absolute path: $path"
  current=$path
  while [ "$current" != / ]; do
    [ ! -L "$current" ] || fail "refusing symlink path: $current"
    current=${current%/*}; [ -n "$current" ] || current=/
  done
}
source_name= source_sha= base_name= tart= tart_home= runner= qualifier= guest_user= mise_binary= mise_version= mise_sha= node_version= python_version= dedicated_tart_home= dedicated_account= receipt=/Library/Partitura/NativeBuild/qualification/partitura-native-base.json runtime_cache= runtime_cache_sha= apply=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) source_name=${2-}; shift 2 ;;
    --source-sha256) source_sha=${2-}; shift 2 ;;
    --base) base_name=${2-}; shift 2 ;;
    --tart) tart=${2-}; shift 2 ;;
    --tart-home) tart_home=${2-}; shift 2 ;;
    --runner) runner=${2-}; shift 2 ;;
    --qualifier) qualifier=${2-}; shift 2 ;;
    --guest-user) guest_user=${2-}; shift 2 ;;
    --mise-binary) mise_binary=${2-}; shift 2 ;;
    --mise-version) mise_version=${2-}; shift 2 ;;
    --mise-sha256) mise_sha=${2-}; shift 2 ;;
    --node-version) node_version=${2-}; shift 2 ;;
    --python-version) python_version=${2-}; shift 2 ;;
    --runtime-cache) runtime_cache=${2-}; shift 2 ;;
    --runtime-cache-sha256) runtime_cache_sha=${2-}; shift 2 ;;
    --dedicated-tart-home) dedicated_tart_home=${2-}; shift 2 ;;
    --dedicated-account) dedicated_account=${2-}; shift 2 ;;
    --receipt) receipt=${2-}; shift 2 ;;
    --apply) apply=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done

[[ "$source_name" =~ ^[a-z0-9][a-z0-9-]{0,79}$ ]] || fail 'invalid source VM name'
[[ "$base_name" =~ ^[a-z0-9][a-z0-9-]{0,79}$ && "$base_name" != "$source_name" ]] || fail 'invalid or identical destination VM name'
[[ "$source_sha" =~ ^[a-f0-9]{64}$ ]] || fail 'source base needs a pinned SHA-256'
[[ "$guest_user" =~ ^[a-z][a-z0-9_-]{0,30}$ && "$guest_user" != root ]] || fail 'invalid guest user'
[[ "$mise_version" =~ ^[0-9]{4}\.[0-9]+\.[0-9]+$ ]] || fail 'Mise version must be an exact release version'
[[ "$mise_sha" =~ ^[a-f0-9]{64}$ ]] || fail 'Mise binary needs a pinned SHA-256'
[[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Node version must be an exact version'
[[ "$python_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'Python version must be an exact version'
for path in "$tart" "$tart_home" "$runner" "$qualifier" "$mise_binary" "$receipt"; do check_path "$path"; done
if [ -n "$dedicated_tart_home" ] || [ -n "$dedicated_account" ]; then
  [ -n "$dedicated_tart_home" ] && [ -n "$dedicated_account" ] || fail 'dedicated Tart promotion needs both --dedicated-tart-home and --dedicated-account'
  [[ "$dedicated_account" =~ ^[a-z][a-z0-9_-]{0,30}$ && "$dedicated_account" != root ]] || fail 'invalid dedicated Tart account'
  check_path "$dedicated_tart_home"
fi
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || fail 'host must be an Apple silicon Mac'
[ -x "$tart" ] || fail 'Tart executable is unavailable'
[ -f "$runner" ] && [ ! -L "$runner" ] || fail 'runner source is unavailable or a symlink'
[ -f "$qualifier" ] && [ ! -L "$qualifier" ] || fail 'qualifier source is unavailable or a symlink'
[ -f "$mise_binary" ] && [ ! -L "$mise_binary" ] || fail 'pinned Mise binary is unavailable or a symlink'
actual_mise_sha=$(/usr/bin/shasum -a 256 "$mise_binary" | awk '{print $1}')
[ "$actual_mise_sha" = "$mise_sha" ] || fail 'Mise binary differs from its pinned SHA-256'
mise_arch=$(/usr/bin/file -b "$mise_binary")
case "$mise_arch" in *'Mach-O 64-bit executable arm64'*) ;; *) fail 'Mise input must be an Apple silicon macOS executable' ;; esac

cache_validator="$(cd "$(dirname "$0")" && pwd)/runtime_cache.py"
if [ -n "$runtime_cache" ] || [ -n "$runtime_cache_sha" ]; then
  check_path "$runtime_cache"
  /usr/bin/python3 "$cache_validator" "$runtime_cache" "$runtime_cache_sha" "$node_version" "$python_version"
fi

source_vm="$tart_home/vms/$source_name"
base_vm="$tart_home/vms/$base_name"
dedicated_vm=
receipt_base_path=$base_vm
if [ -n "$dedicated_tart_home" ]; then
  [ "$dedicated_tart_home" != "$tart_home" ] || fail 'dedicated Tart home must differ from the source/working Tart home'
  dedicated_vm="$dedicated_tart_home/vms/$base_name"
  receipt_base_path=$dedicated_vm
fi
check_path "$source_vm"
check_path "$base_vm"
[ -d "$source_vm" ] && [ ! -L "$source_vm" ] || fail 'selected source VM is unavailable or a symlink'
[ ! -e "$base_vm" ] && [ ! -L "$base_vm" ] || fail 'destination VM already exists; refusing to overwrite it'
[ -z "$dedicated_vm" ] || [ ! -e "$dedicated_vm" ] && [ ! -L "$dedicated_vm" ] || fail 'dedicated destination VM already exists; refusing to overwrite it'
[ ! -e "$receipt" ] && [ ! -L "$receipt" ] || fail 'qualification receipt already exists; refusing to overwrite it'
source_actual_sha=$(/usr/bin/python3 - "$source_vm" <<'PY'
import hashlib, os, stat, sys
from pathlib import Path
root = Path(sys.argv[1])
digest = hashlib.sha256()
for current, directories, files in os.walk(root, followlinks=False):
    directories.sort()
    files.sort()
    for name in sorted([*directories, *files]):
        path = Path(current) / name
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise SystemExit(f"source VM contains a symlink: {path}")
        relative = path.relative_to(root).as_posix().encode()
        digest.update(len(relative).to_bytes(4, "big")); digest.update(relative)
        digest.update(stat.S_IMODE(info.st_mode).to_bytes(2, "big"))
        if stat.S_ISREG(info.st_mode):
            digest.update(info.st_size.to_bytes(8, "big"))
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        elif not stat.S_ISDIR(info.st_mode):
            raise SystemExit(f"source VM contains an unsupported file: {path}")
print(digest.hexdigest())
PY
)
[ "$source_actual_sha" = "$source_sha" ] || fail 'selected source VM does not match its pinned SHA-256'
runner_sha=$(/usr/bin/shasum -a 256 "$runner" | awk '{print $1}')
qualifier_sha=$(/usr/bin/shasum -a 256 "$qualifier" | awk '{print $1}')
printf 'Preflight passed. Source=%s sha256=%s; destination=%s; guest=%s; runner=%s; qualifier=%s; Mise=%s sha256=%s; Node=%s; Python=%s\n' \
  "$source_name" "$source_actual_sha" "$base_name" "$guest_user" "$runner_sha" "$qualifier_sha" "$mise_version" "$mise_sha" "$node_version" "$python_version"
if [ -n "$dedicated_vm" ]; then
  dedicated_uid=$(id -u "$dedicated_account") || fail 'dedicated Tart account does not exist'
  [ "$(id -Gn "$dedicated_account" | tr ' ' '\n' | grep -x admin || true)" = '' ] || fail 'dedicated Tart account must not be an administrator'
  sudo -n /usr/bin/python3 - "$dedicated_tart_home" "$dedicated_vm" "$dedicated_uid" <<'PY'
import os, stat, sys
from pathlib import Path
home, destination, uid = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
for path in (home, home / "vms"):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o700:
        raise SystemExit(f"dedicated Tart directory has unsafe owner or mode: {path}")
if destination.exists() or destination.is_symlink():
    raise SystemExit(f"dedicated destination VM already exists: {destination}")
PY
  printf 'Dedicated target=%s account=%s uid=%s\n' "$dedicated_tart_home" "$dedicated_account" "$dedicated_uid"
fi
[ "$apply" -eq 1 ] || { printf '%s\n' 'Read-only preflight only. Review inputs, then rerun with --apply.'; exit 0; }

if [ "$(id -u)" -eq 0 ]; then fail 'run as an administrator account, not root'; fi
export TART_HOME="$tart_home"
export TART_NO_AUTO_PRUNE=1
scratch_root="$HOME/dev/agentic-scratchpads/partitura/native-base-preparation"
mkdir -p -m 0700 "$scratch_root"
check_path "$scratch_root"
[ "$(stat -f '%u:%Lp' "$scratch_root")" = "$(id -u):700" ] || fail 'scratch directory must be owned by the current user mode 0700'
running=0
completed=0
receipt_write_started=0
promotion_started=0
archive_dir=
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$running" -eq 1 ]; then "$tart" stop "$base_name" >/dev/null 2>&1 || true; fi
  if [ "$completed" -eq 0 ] && [ -d "$base_vm" ]; then
    quarantine="$tart_home/vms/$base_name.failed-$(date +%Y%m%d%H%M%S)"
    if [ ! -e "$quarantine" ]; then mv "$base_vm" "$quarantine" || printf 'warning: could not quarantine failed clone at %s\n' "$base_vm" >&2; fi
  fi
  if [ "$completed" -eq 0 ] && [ "$promotion_started" -eq 1 ] && sudo -n /usr/bin/python3 - "$dedicated_vm" <<'PY'
import os, stat, sys
from pathlib import Path
path = Path(sys.argv[1])
for ancestor in (path, *path.parents):
    try:
        info = ancestor.lstat()
    except FileNotFoundError:
        continue
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit(1)
if path.exists() and stat.S_ISDIR(path.lstat().st_mode):
    raise SystemExit(0)
raise SystemExit(1)
PY
  then
    quarantine="$dedicated_tart_home/vms/$base_name.failed-$(date +%Y%m%d%H%M%S)"
    if sudo -n /usr/bin/python3 - "$quarantine" <<'PY'
import sys
from pathlib import Path
raise SystemExit(1 if Path(sys.argv[1]).exists() else 0)
PY
    then
      sudo -n /bin/mv "$dedicated_vm" "$quarantine" || printf 'warning: could not quarantine failed promoted base at %s\n' "$dedicated_vm" >&2
    else
      printf 'warning: could not quarantine failed promoted base at %s\n' "$dedicated_vm" >&2
    fi
  fi
  if [ "$completed" -eq 0 ] && [ "$receipt_write_started" -eq 1 ]; then
    sudo /bin/rm -f "$receipt" || printf 'warning: could not remove incomplete receipt at %s\n' "$receipt" >&2
  fi
  [ -z "$archive_dir" ] || rm -rf "$archive_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM
"$tart" clone "$source_name" "$base_name"
# Tart keeps the source file modes on the disposable clone. Make only the
# guest's writable VM files owner-writable, after rejecting links and hardlinks.
/usr/bin/python3 - "$base_vm" <<'PY'
import os, stat, sys
from pathlib import Path
directory = Path(sys.argv[1])
if directory.resolve() != directory:
    raise SystemExit("cloned VM path contains a symlink")
info = directory.lstat()
if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
    raise SystemExit("cloned VM directory has an unsafe owner or type")
for name in ("config.json", "disk.img", "nvram.bin"):
    descriptor = os.open(directory / name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise SystemExit(f"unsafe cloned VM file: {name}")
        os.fchmod(descriptor, stat.S_IMODE(info.st_mode) | stat.S_IWUSR)
    finally:
        os.close(descriptor)
PY
boot_log=$(mktemp "$scratch_root/tart-boot.XXXXXX")
"$tart" run "$base_name" --no-graphics --no-audio --no-usb-accessories --no-clipboard >"$boot_log" 2>&1 &
tart_run_pid=$!
running=1
ready=0
for _ in $(seq 1 120); do
  kill -0 "$tart_run_pid" 2>/dev/null || { cat "$boot_log" >&2; fail 'Tart exited before the guest agent became ready'; }
  if "$tart" exec "$base_name" /usr/bin/true >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" -eq 1 ] || fail 'guest agent did not become ready'

# Install files through Tart's stdin transport. The guest is never given a host
# directory mount, even during preparation.
archive_dir=$(mktemp -d "$scratch_root/partitura-native-base.XXXXXX")
chmod 0700 "$archive_dir"
install -m 0600 "$runner" "$archive_dir/run.sh"
install -m 0600 "$qualifier" "$archive_dir/qualify.sh"
install -m 0600 "$mise_binary" "$archive_dir/mise"
cat > "$archive_dir/toolchain.env" <<EOF
miseSha256=$mise_sha
miseVersion=$mise_version
nodeVersion=$node_version
pythonVersion=$python_version
EOF
chmod 0600 "$archive_dir/toolchain.env"
cat <<'GUEST_SETUP' | "$tart" exec -i "$base_name" /usr/bin/sudo -n /bin/bash -s -- "$guest_user" "$mise_version" "$node_version" "$python_version"
set -euo pipefail
user=$1 mise_version=$2 node_version=$3 python_version=$4
[[ "$user" =~ ^[a-z][a-z0-9_-]{0,30}$ && "$user" != root ]]
if /usr/bin/dscl . -read "/Users/$user" UniqueID >/dev/null 2>&1; then
  groups=$(/usr/bin/id -Gn "$user")
  case " $groups " in *' admin '*) echo 'configured guest user is an administrator' >&2; exit 1;; esac
else
  uid=501
  while /usr/bin/dscl . -search /Users UniqueID "$uid" | /usr/bin/grep -q .; do
    uid=$((uid + 1)); [ "$uid" -lt 6000 ] || { echo 'no guest uid available' >&2; exit 1; }
  done
  /usr/bin/dscl . -create "/Users/$user"
  /usr/bin/dscl . -create "/Users/$user" UniqueID "$uid"
  /usr/bin/dscl . -create "/Users/$user" PrimaryGroupID 20
  /usr/bin/dscl . -create "/Users/$user" UserShell /bin/bash
  /usr/bin/dscl . -create "/Users/$user" NFSHomeDirectory "/Users/$user"
  /usr/bin/dscl . -create "/Users/$user" RealName 'Partitura build guest'
fi
/bin/mkdir -p "/Users/$user" /Library/Partitura/NativeBuild
/usr/sbin/chown "$user":staff "/Users/$user"
/bin/chmod 0700 "/Users/$user"
/usr/sbin/chown -R root:wheel /Library/Partitura/NativeBuild
/bin/chmod 0755 /Library/Partitura/NativeBuild
GUEST_SETUP
tar -cf - -C "$archive_dir" run.sh qualify.sh mise toolchain.env | \
  "$tart" exec -i "$base_name" /usr/bin/sudo -n /usr/bin/tar -xpf - -C /Library/Partitura/NativeBuild
cat <<'GUEST_MISE_SETUP' | "$tart" exec -i "$base_name" /usr/bin/sudo -n /bin/bash -s -- "$guest_user" "$mise_version" "$node_version" "$python_version"
set -euo pipefail
user=$1 mise_version=$2 node_version=$3 python_version=$4
/usr/sbin/chown root:wheel /Library/Partitura/NativeBuild/run.sh /Library/Partitura/NativeBuild/qualify.sh /Library/Partitura/NativeBuild/mise
/bin/chmod 0555 /Library/Partitura/NativeBuild/run.sh /Library/Partitura/NativeBuild/qualify.sh /Library/Partitura/NativeBuild/mise
/usr/sbin/chown root:wheel /Library/Partitura/NativeBuild/toolchain.env
/bin/chmod 0444 /Library/Partitura/NativeBuild/toolchain.env
if [ -L /usr/local ] || [ -L /usr/local/bin ]; then echo 'refusing symlink in /usr/local/bin' >&2; exit 1; fi
/bin/mkdir -p /usr/local/bin
if [ -e /usr/local/bin/mise ]; then
  [ -f /usr/local/bin/mise ] && [ ! -L /usr/local/bin/mise ] && /usr/bin/cmp -s /usr/local/bin/mise /Library/Partitura/NativeBuild/mise || { echo 'existing /usr/local/bin/mise differs from the pinned binary' >&2; exit 1; }
  [ "$(/usr/bin/stat -f '%u:%Lp' /usr/local/bin/mise)" = '0:555' ] || { echo 'existing Mise binary must be root-owned mode 0555' >&2; exit 1; }
else
  /usr/bin/install -o root -g wheel -m 0555 /Library/Partitura/NativeBuild/mise /usr/local/bin/mise
fi
/bin/mkdir -p "/Users/$user/.config/mise" "/Users/$user/.local/share/mise"
/usr/sbin/chown -R "$user":staff "/Users/$user/.config" "/Users/$user/.local"
/bin/chmod 0700 "/Users/$user/.config/mise" "/Users/$user/.local" "/Users/$user/.local/share" "/Users/$user/.local/share/mise"
config_scratch="/Users/$user/dev/agentic-scratchpads/partitura/native-base-preparation"
for path in "/Users/$user/dev" "/Users/$user/dev/agentic-scratchpads" "/Users/$user/dev/agentic-scratchpads/partitura" "$config_scratch"; do
  [ ! -L "$path" ] || { echo "refusing symlink in guest scratch path: $path" >&2; exit 1; }
  if [ -e "$path" ]; then
    [ -d "$path" ] && [ "$(/usr/bin/stat -f '%Su:%Sg' "$path")" = "$user:staff" ] || { echo "guest scratch parent must be a guest-owned directory: $path" >&2; exit 1; }
  else
    /bin/mkdir -m 0700 "$path"
    /usr/sbin/chown "$user":staff "$path"
  fi
done
[ "$(/usr/bin/stat -f '%Su:%Sg:%Lp' "$config_scratch")" = "$user:staff:700" ] || { echo 'guest configuration scratch must be private and guest-owned' >&2; exit 1; }
config_tmp=$(/usr/bin/mktemp "$config_scratch/mise-config.XXXXXX")
cat > "$config_tmp" <<EOF
[tools]
node = "$node_version"
python = "$python_version"
EOF
config_path="/Users/$user/.config/mise/config.toml"
if [ -e "$config_path" ]; then
  /usr/bin/cmp -s "$config_tmp" "$config_path" || { /bin/rm -f "$config_tmp"; echo 'existing Mise global config differs from the pinned base defaults' >&2; exit 1; }
else
  /usr/bin/install -o "$user" -g staff -m 0644 "$config_tmp" "$config_path"
fi
/bin/rm -f "$config_tmp"
GUEST_MISE_SETUP
if [ -n "$runtime_cache" ]; then
  install -m 0600 "$runtime_cache" "$archive_dir/runtimes.tar"
  /usr/bin/python3 "$cache_validator" "$archive_dir/runtimes.tar" "$runtime_cache_sha" "$node_version" "$python_version"
  cat "$archive_dir/runtimes.tar" | "$tart" exec -i "$base_name" /usr/bin/sudo -n -u "$guest_user" /usr/bin/tar -xpf - -C "/Users/$guest_user/.local/share/mise"
else
  "$tart" exec "$base_name" /usr/bin/sudo -n -u "$guest_user" /usr/bin/env -i "HOME=/Users/$guest_user" "PATH=/usr/bin:/bin:/usr/sbin:/sbin" MISE_YES=1 MISE_JOBS=2 /usr/local/bin/mise install --yes --jobs 2 "node@$node_version" "python@$python_version"
fi
printf '%s\n' 'set -euo pipefail; /bin/chmod 0555 /Library/Partitura/NativeBuild' | \
  "$tart" exec -i "$base_name" /usr/bin/sudo -n /bin/bash -s
printf '%s\n' 'set -euo pipefail; /usr/sbin/chown root:wheel /Library/Partitura/NativeBuild/run.sh /Library/Partitura/NativeBuild/qualify.sh /Library/Partitura/NativeBuild/mise; /bin/chmod 0555 /Library/Partitura/NativeBuild/run.sh /Library/Partitura/NativeBuild/qualify.sh /Library/Partitura/NativeBuild/mise; /usr/sbin/chown root:wheel /Library/Partitura/NativeBuild/toolchain.env; /bin/chmod 0444 /Library/Partitura/NativeBuild/toolchain.env' | \
  "$tart" exec -i "$base_name" /usr/bin/sudo -n /bin/bash -s
qualification_output=$("$tart" exec "$base_name" /usr/bin/sudo -n -u "$guest_user" /usr/bin/env -i \
  "HOME=/Users/$guest_user" "PATH=/usr/bin:/bin:/usr/sbin:/sbin" \
  /bin/bash /Library/Partitura/NativeBuild/qualify.sh "$runner_sha" "$qualifier_sha" "$guest_user")
case "$qualification_output" in PARTITURA_NATIVE_BASE_QUALIFIED*) ;; *) fail 'generic guest qualification did not return its receipt marker' ;; esac
"$tart" stop "$base_name"
running=0
wait "$tart_run_pid" 2>/dev/null || true
# Tart 2.41 may leave its Unix control socket after the VMM has exited.
# Remove only that owned socket before sealing the stopped VM, never arbitrary
# unexpected files or a symlink. Persistent base hashing still rejects those.
/usr/bin/python3 - "$base_vm/control.sock" <<'PY'
import errno, os, socket, stat, sys
from pathlib import Path
path = Path(sys.argv[1])
try:
    info = path.lstat()
except FileNotFoundError:
    pass
else:
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
        raise SystemExit("unexpected Tart control socket type or owner")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        if probe.connect_ex(str(path)) != errno.ECONNREFUSED:
            raise SystemExit("Tart control socket is still active or cannot be verified stale")
    path.unlink()
PY
base_sha=$(/usr/bin/python3 - "$base_vm" <<'PY'
import hashlib, os, stat, sys
from pathlib import Path
root = Path(sys.argv[1])
digest = hashlib.sha256()
for current, directories, files in os.walk(root, followlinks=False):
    directories.sort()
    files.sort()
    for name in sorted([*directories, *files]):
        path = Path(current) / name
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode): raise SystemExit(f"prepared base contains a symlink: {path}")
        relative = path.relative_to(root).as_posix().encode()
        digest.update(len(relative).to_bytes(4, "big")); digest.update(relative)
        digest.update(stat.S_IMODE(info.st_mode).to_bytes(2, "big"))
        if stat.S_ISREG(info.st_mode):
            digest.update(info.st_size.to_bytes(8, "big"))
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        elif not stat.S_ISDIR(info.st_mode): raise SystemExit(f"unsupported prepared base file: {path}")
print(digest.hexdigest())
PY
)
if [ -n "$dedicated_vm" ]; then
  promotion_started=1
  sudo -n /usr/bin/ditto --rsrc "$base_vm" "$dedicated_vm"
  sudo -n /usr/sbin/chown -R "$dedicated_account":staff "$dedicated_vm"
  qualified_sha=$base_sha
  base_sha=$(sudo -n -u "$dedicated_account" /usr/bin/python3 - "$dedicated_vm" <<'PY'
import hashlib, os, stat, sys
from pathlib import Path
root = Path(sys.argv[1])
uid = os.getuid()
root_info = root.lstat()
if not stat.S_ISDIR(root_info.st_mode) or root_info.st_uid != uid or root_info.st_mode & 0o022:
    raise SystemExit(f"promoted base root has unsafe ownership or mode: {root}")
digest = hashlib.sha256()
for current, directories, files in os.walk(root, followlinks=False):
    directories.sort(); files.sort()
    for name in sorted([*directories, *files]):
        path = Path(current) / name
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode): raise SystemExit(f"promoted base contains a symlink: {path}")
        if info.st_uid != uid or info.st_mode & 0o022: raise SystemExit(f"promoted base ownership or mode is unsafe: {path}")
        relative = path.relative_to(root).as_posix().encode()
        digest.update(len(relative).to_bytes(4, "big")); digest.update(relative)
        digest.update(stat.S_IMODE(info.st_mode).to_bytes(2, "big"))
        if stat.S_ISREG(info.st_mode):
            digest.update(info.st_size.to_bytes(8, "big"))
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        elif not stat.S_ISDIR(info.st_mode): raise SystemExit(f"unsupported promoted base file: {path}")
print(digest.hexdigest())
PY
  )
  [ "$base_sha" = "$qualified_sha" ] || fail 'promoted base differs from the qualified clone'
fi
receipt_tmp="$archive_dir/qualification.json"
/usr/bin/python3 - "$receipt_tmp" "$source_name" "$source_sha" "$base_name" "$receipt_base_path" "$base_sha" "$runner_sha" "$qualifier_sha" "$mise_sha" "$mise_version" "$node_version" "$python_version" "$qualification_output" <<'PY'
import json, sys
path, source_name, source_sha, name, base_path, base_sha, runner_sha, qualifier_sha, mise_sha, mise_version, node_version, python_version, output = sys.argv[1:]
receipt = {
    "schema": 1,
    "sourceName": source_name,
    "sourceSha256": source_sha,
    "base": name,
    "basePath": base_path,
    "baseSha256": base_sha,
    "guestRunnerSha256": runner_sha,
    "qualifierSha256": qualifier_sha,
    "miseSha256": mise_sha,
    "miseVersion": mise_version,
    "nodeVersion": node_version,
    "pythonVersion": python_version,
    "qualificationOutput": output,
}
with open(path, "w") as handle:
    json.dump(receipt, handle, sort_keys=True, indent=2)
    handle.write("\n")
PY
sudo /usr/bin/install -d -o root -g wheel -m 0755 "${receipt%/*}"
receipt_write_started=1
sudo /usr/bin/install -o root -g wheel -m 0444 "$receipt_tmp" "$receipt"
completed=1
printf 'Prepared and sealed base %s sha256=%s\n' "$base_name" "$base_sha"
if [ -n "$dedicated_vm" ]; then printf 'Promoted base to %s owned by %s.\n' "$dedicated_vm" "$dedicated_account"; fi
printf 'Receipt installed at %s\n' "$receipt"
