#!/bin/bash
# Provision only the generic unprivileged account and its private host paths.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

usage() {
  cat <<'EOF'
Usage: bootstrap-host.sh --runtime-root PATH --tart-home PATH [--account NAME] [--apply]

Read-only preflight is the default. --apply creates the dedicated unprivileged
account and private directories. Partitura's standalone host_setup.py stages
the pinned broker, public key and restricted SSH policy for install-host.sh.
EOF
}
fail() { printf 'host bootstrap failed: %s\n' "$1" >&2; exit 1; }
check_path() {
  local path=$1 current
  [[ "$path" = /* && "$path" != */ && "$path" != *'/../'* && "$path" != */.. && "$path" != *'/./'* && "$path" != */. && "$path" != *'//'* ]] || fail "expected a normalized absolute path: $path"
  current=$path
  while [ "$current" != / ]; do
    [ ! -L "$current" ] || fail "refusing symlink path: $current"
    current=${current%/*}; [ -n "$current" ] || current=/
  done
  [ ! -L / ] || fail 'refusing symlink root'
}
account=partitura-build runtime_root= tart_home= apply=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --account) account=${2-}; shift 2 ;;
    --runtime-root) runtime_root=${2-}; shift 2 ;;
    --tart-home) tart_home=${2-}; shift 2 ;;
    --apply) apply=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
done
[[ "$account" =~ ^[a-z][a-z0-9_-]{0,30}$ ]] || fail 'invalid account name'
for path in "$runtime_root" "$tart_home" "/Users/$account"; do check_path "$path"; done
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || fail 'host must be an Apple silicon Mac'

if id -u "$account" >/dev/null 2>&1; then
  groups=$(id -Gn "$account")
  case " $groups " in *' admin '*|*' wheel '*) fail 'build account must not belong to admin or wheel' ;; esac
  printf 'Existing account %s is non-admin.\n' "$account"
else
  printf 'Account %s will be created with staff as its primary group.\n' "$account"
fi
for path in "/Users/$account" "$runtime_root" "$tart_home"; do
  check_path "$path"
  if [ -e "$path" ]; then
    [ -d "$path" ] && [ ! -L "$path" ] || fail "configured path is not a real directory: $path"
    printf 'Existing path will be checked for private ownership: %s\n' "$path"
  else
    printf 'Directory will be created mode 0700: %s\n' "$path"
  fi
done
printf '%s\n' 'SSH authorization remains public-key-only and is installed by the managed host installer.'
[ "$apply" -eq 1 ] || { printf '%s\n' 'Read-only preflight only. Review this plan, then rerun with --apply.'; exit 0; }
[ "$(id -u)" -ne 0 ] || fail 'run as an administrator account, not root'

/usr/bin/sudo /bin/bash -s -- "$account" "$runtime_root" "$tart_home" <<'ROOT_SETUP'
set -euo pipefail
account=$1 runtime_root=$2 tart_home=$3
home="/Users/$account"
if /usr/bin/id -u "$account" >/dev/null 2>&1; then
  details=$(/usr/bin/dscl . -read "/Users/$account" PrimaryGroupID UserShell NFSHomeDirectory)
  printf '%s\n' "$details" | /usr/bin/grep -Fx 'PrimaryGroupID: 20' >/dev/null || { echo 'existing account must use staff as primary group' >&2; exit 1; }
  printf '%s\n' "$details" | /usr/bin/grep -Fx 'NFSHomeDirectory: /Users/'"$account" >/dev/null || { echo 'existing account home must be its standard home path' >&2; exit 1; }
  printf '%s\n' "$details" | /usr/bin/grep -E '^UserShell: /(bin/bash|bin/zsh)$' >/dev/null || { echo 'existing account must use a supported shell' >&2; exit 1; }
  case "$(/usr/bin/id -Gn "$account")" in *admin*|*wheel*) echo 'existing account is privileged' >&2; exit 1 ;; esac
  created_account=0
else
  uid=501
  while /usr/bin/dscl . -search /Users UniqueID "$uid" | /usr/bin/grep -q .; do
    uid=$((uid + 1)); [ "$uid" -lt 6000 ] || { echo 'no account uid available' >&2; exit 1; }
  done
  /usr/bin/dscl . -create "/Users/$account"
  /usr/bin/dscl . -create "/Users/$account" UniqueID "$uid"
  /usr/bin/dscl . -create "/Users/$account" PrimaryGroupID 20
  /usr/bin/dscl . -create "/Users/$account" UserShell /bin/bash
  /usr/bin/dscl . -create "/Users/$account" NFSHomeDirectory "$home"
  /usr/bin/dscl . -create "/Users/$account" RealName 'Partitura native build'
  created_account=1
fi
if [ -e "$home" ]; then
  [ -d "$home" ] && [ ! -L "$home" ] && [ "$(/usr/bin/stat -f '%Su:%Lp' "$home")" = "$account:700" ] || { echo "existing home must already be owned by $account mode 0700" >&2; exit 1; }
elif [ "$created_account" -eq 1 ]; then
  /bin/mkdir -m 0700 "$home"
  /usr/sbin/chown "$account":staff "$home"
else
  echo 'existing account home is missing; refusing to create or change it' >&2
  exit 1
fi
for path in "$runtime_root" "$tart_home"; do
  current=$path
  while [ "$current" != / ]; do
    [ ! -L "$current" ] || { echo "refusing symlink path: $current" >&2; exit 1; }
    current=${current%/*}; [ -n "$current" ] || current=/
  done
  if [ -e "$path" ]; then
    [ -d "$path" ] && [ "$(/usr/bin/stat -f '%Su:%Sg:%Lp' "$path")" = "$account:staff:700" ] || { echo "existing path must already be owned by $account:staff mode 0700: $path" >&2; exit 1; }
  else
    /bin/mkdir -p "$path"
    /usr/sbin/chown "$account":staff "$path"
    /bin/chmod 0700 "$path"
  fi
done
vms="$tart_home/vms"
if [ -e "$vms" ]; then
  [ -d "$vms" ] && [ ! -L "$vms" ] && [ "$(/usr/bin/stat -f '%Su:%Sg:%Lp' "$vms")" = "$account:staff:700" ] || { echo "Tart vms directory must be owned by $account:staff mode 0700: $vms" >&2; exit 1; }
else
  /bin/mkdir -m 0700 "$vms"
  /usr/sbin/chown "$account":staff "$vms"
fi
ROOT_SETUP
printf 'Provisioned %s and its private host directories.\n' "$account"
