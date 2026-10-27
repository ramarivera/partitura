#!/bin/bash
# One-shot provisioning of a new native build Mac: one sudo prompt, one
# password paste (twice), no follow-up sessions. Run it from a clean Partitura
# checkout as an administrator. Without --apply it only runs the read-only
# preflight, which downloads and verifies the pinned Tart and Mise inputs.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

usage() {
  cat <<'EOF'
Usage: provision-host.sh --source-vm PATH --source-sha256 HASH --authorized-key KEY
  [--tart-home PATH | --create-volume CONTAINER] [--host NAME] [--base NAME]
  [--account NAME] [--inputs DIR] [--apply] [--policy-only]
  [--authorized-key SECOND_KEY] [--host-id UUID] [--profile legacy|registry-only]
  [--minimum-free-bytes BYTES] [--predecessor-manifest-sha256 HASH]
  [--daemon-relock-qualified --daemon-relock-macos-build BUILD]
  [--daemon-relock-unqualified] [--keychain-policy preserve|JSON]

  --source-vm       clean Tart VM directory, laid out as <tart home>/vms/<name>
  --source-sha256   pinned tree hash of that VM (see README)
  --authorized-key  the gateway's public key for this builder
  --create-volume   APFS container to hold a new PartituraBuilds volume
  --tart-home       existing build storage (default
                    /Volumes/PartituraBuilds/partitura-native/tart)
  --host            builder name (default: short hostname)
  --policy-only     update installed policy/keys without account/base/keychain creation
  --inputs          download cache (default
                    ~/dev/agentic-scratchpads/partitura/host-inputs)

Steps, each skipped when already done: storage, account, base VM preparation
and qualification, missing build credential/password/keychain initialization,
root install of the broker and SSH policy, SSH admission and final readback.
The first approved SSH build proves unlock. The installer never checks or
changes keychain settings; an optional sealed policy runs after SSH unlock.
EOF
}

# Reviewed pins. Tart's executable hash is the install pin; the archive hash
# only guards the download.
TART_URL=https://github.com/cirruslabs/tart/releases/download/2.41.1/tart.tar.gz
TART_TGZ_SHA=e680a734febccfce7d4e910c1f7f13fc3b00f19a181c945e2d746de3214c32c2
TART_SHA=6d3a455456979c138387d0660af8e956a054018f7516bd0e8bcd175382973823
TART_TEAM=9M2P8L4D89
MISE_VERSION=2026.10.15
MISE_URL=https://github.com/jdx/mise/releases/download/v$MISE_VERSION/mise-v$MISE_VERSION-macos-arm64
MISE_SHA=826c4833fa7437a63f6027b86bc10c8b61b1163dc793c03ecde92f68ad167890
NODE_VERSION=24.22.1
PYTHON_VERSION=3.13.17
GUEST_USER=partitura
VOLUME=PartituraBuilds
VOLUME_RESERVE=120g
MIN_STORAGE_KB=$((120 * 1024 * 1024))
MIN_INTERNAL_KB=$((50 * 1024 * 1024))
CLT=/Library/Developer/CommandLineTools
PY=(/usr/bin/env "DEVELOPER_DIR=$CLT" /usr/bin/python3 -I)
GIT=(/usr/bin/env -i PATH=/usr/bin:/bin "HOME=$HOME" "DEVELOPER_DIR=$CLT"
     GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 /usr/bin/git)
ROOT_GIT=(/usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/root "DEVELOPER_DIR=$CLT"
          GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 /usr/bin/git)
INSTALL=/Library/Partitura/NativeBuild

authorized_keys=()
policy_args=()
policy_only=0 predecessor= minimum_free_bytes= daemon_qualification= daemon_build=
source_vm= source_sha= tart_home= container= host= base= account=partitura-build
inputs="$HOME/dev/agentic-scratchpads/partitura/host-inputs" apply=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-vm) source_vm=${2-}; shift 2 ;;
    --source-sha256) source_sha=${2-}; shift 2 ;;
    --authorized-key) authorized_keys+=("${2-}"); shift 2 ;;
    --host-id)
      [[ "${2-}" =~ ^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$ ]] || { echo "invalid host UUID" >&2; exit 2; }
      policy_args+=("$1" "$2"); shift 2 ;;
    --profile)
      [[ "${2-}" = legacy || "${2-}" = registry-only ]] || { echo "invalid profile" >&2; exit 2; }
      policy_args+=("$1" "$2"); shift 2 ;;
    --daemon-relock-macos-build)
      [[ "${2-}" =~ ^[A-Za-z0-9]{1,32}$ ]] || { echo "invalid macOS build" >&2; exit 2; }
      daemon_build=$2; policy_args+=("$1" "$2"); shift 2 ;;
    --keychain-policy) policy_args+=("$1" "${2-}"); shift 2 ;;
    --minimum-free-bytes) minimum_free_bytes=${2-}; policy_args+=("$1" "${2-}"); shift 2 ;;
    --predecessor-manifest-sha256) predecessor=${2-}; shift 2 ;;
    --daemon-relock-qualified|--daemon-relock-unqualified)
      [ -z "$daemon_qualification" ] || { echo "supply only one relock qualification flag" >&2; exit 2; }
      daemon_qualification=$1; policy_args+=("$1"); shift ;;
    --policy-only) policy_only=1; shift ;;
    --tart-home) tart_home=${2-}; shift 2 ;;
    --create-volume) container=${2-}; shift 2 ;;
    --host) host=${2-}; shift 2 ;;
    --base) base=${2-}; shift 2 ;;
    --account) account=${2-}; shift 2 ;;
    --inputs) inputs=${2-}; shift 2 ;;
    --apply) apply=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

STATUS=
step() { printf '\n== %s\n' "$*"; [ -z "$STATUS" ] || printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$STATUS"; }
die() {
  printf '\nSTOPPED: %s\nNothing after this step ran. Rerunning is safe once the cause is fixed;\ncompleted steps are skipped.\n' "$*" >&2
  [ -z "$STATUS" ] || printf '%s STOPPED %s\n' "$(date -u +%FT%TZ)" "$*" >> "$STATUS"
  exit 1
}
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
root_sha() { sudo shasum -a 256 "$1" | awk '{print $1}'; }
container_of() { diskutil info "$1" 2>/dev/null | awk -F': *' '/APFS Container:/{print $2}'; }
# Build storage never shares an APFS container with macOS or a Time Machine backup.
refuse_shared_container() {
  [ "$1" != "$(container_of /)" ] || die "$1 is the system disk's container; use an external volume"
  while IFS= read -r mount; do
    [ -n "$mount" ] || continue
    [ "$(container_of "$mount")" != "$1" ] || die "$1 holds the Time Machine destination at $mount"
  done < <(tmutil destinationinfo 2>/dev/null | awk -F': *' '/^Mount Point/{print $2}')
}
socket_fits() { [ "$(printf %s "$1/vms/$base/control.sock" | wc -c)" -le 103 ]; }

step "0 preflight (read-only, no sudo)"
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "host must be an Apple silicon Mac"
[ "$(id -u)" -ne 0 ] || die "run as an administrator account, not root"
id -Gn | tr ' ' '\n' | grep -x admin >/dev/null || die "$(id -un) is not an administrator"
[ "$apply" -eq 0 ] || [ -t 0 ] || die "--apply needs a terminal (use ssh -t)"
[[ "$account" =~ ^[a-z][a-z0-9_-]{0,30}$ && "$account" != root ]] || die "invalid account name"
[ -n "$host" ] || host=$(scutil --get LocalHostName 2>/dev/null || hostname -s)
[[ "$host" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,62}$ ]] || die "invalid host name: $host"
[ -n "$base" ] || base=partitura-base-$(printf %s "$host" | tr 'A-Z' 'a-z')
[[ "$base" =~ ^[a-z0-9][a-z0-9-]{0,79}$ ]] || die "invalid base name: $base"
[ "${#authorized_keys[@]}" -ge 1 ] && [ "${#authorized_keys[@]}" -le 2 ] || die "supply one or two --authorized-key values"
for key in "${authorized_keys[@]}"; do
  [[ "$key" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa)\ [A-Za-z0-9+/]+={0,3}(\ [^[:cntrl:]]+)?$ ]] \
    || die "--authorized-key must be one OpenSSH public key line"
done
[ -z "$predecessor" ] || [[ "$predecessor" =~ ^[a-f0-9]{64}$ ]] || die "invalid predecessor SHA-256"
if [ -n "$minimum_free_bytes" ]; then
  [[ "$minimum_free_bytes" =~ ^[0-9]{1,19}$ ]] || die "invalid disk floor"
  MIN_INTERNAL_KB=$("${PY[@]}" -c 'import sys; n=int(sys.argv[1]); assert 53687091200 <= n <= 2**63-1; print((n+1023)//1024)' "$minimum_free_bytes") \
    || die "disk floor must be from 50 GiB through 2^63-1 bytes"
fi
[ "$daemon_qualification" != --daemon-relock-qualified ] || [ -n "$daemon_build" ] || die "qualification requires --daemon-relock-macos-build"
[ "$policy_only" -eq 0 ] || [ -z "$container" ] || die "--policy-only cannot create a volume"
if [ -n "$container" ] && [ -n "$tart_home" ]; then die "use --create-volume or --tart-home, not both"; fi
[ -n "$tart_home" ] || tart_home=/Volumes/$VOLUME/partitura-native/tart
case "$tart_home" in /*) ;; *) die "--tart-home must be absolute" ;; esac

checkout=$(cd "$(dirname "$0")/../.." && pwd)
MB=$checkout/deploy/mac-build
"${PY[@]}" "$MB/provision.py" validate-keys "${authorized_keys[@]}" || die "invalid/duplicate authorized public keys"
commit=$("${GIT[@]}" -C "$checkout" rev-parse HEAD) || die "cannot read the Partitura checkout"
[ -z "$("${GIT[@]}" -C "$checkout" status --porcelain)" ] || die "Partitura checkout $checkout has uncommitted changes"
mkdir -p -m 0700 "$inputs"
STATUS=$inputs/provision-$host.status
runtime_root=/Users/$account/dev/agentic-scratchpads/partitura/native-build
receipt=$INSTALL/qualification/$base.json
ROOT=/private/var/root/dev/agentic-scratchpads/partitura/native-host-inputs/${commit:0:12}
echo "Partitura $commit, builder $host, account $account, base $base"

for p in "$CLT" /Library/Developer /Library /; do
  [ "$(stat -f %u "$p" 2>/dev/null)" = 0 ] || die "$p is missing or not root-owned (install the Command Line Tools: xcode-select --install)"
done
[ -z "$(find "$CLT" ! -type l \( -perm -0020 -o -perm -0002 \) -print -quit)" ] \
  || die "Command Line Tools tree has group/other-writable entries"
"${PY[@]}" -c 'import sys; assert sys.version_info >= (3, 9)' || die "Command Line Tools Python 3.9+ is unavailable"

# Policy/key rotation uses installed inputs and never prepares a VM/account.
if [ "$policy_only" -eq 1 ]; then
  [ -f "$receipt" ] && id "$account" >/dev/null 2>&1 || die "--policy-only requires an installed account and qualified base"
  source_sha=$("${PY[@]}" -c 'import json,sys; print(json.load(open(sys.argv[1]))["sourceSha256"])' "$receipt")
  source_vm=/unused/vms/$("${PY[@]}" -c 'import json,sys; print(json.load(open(sys.argv[1]))["sourceName"])' "$receipt")
  tart_app=$INSTALL/tart.app
else
  tart_app=$inputs/tart.app
fi
[[ "$source_sha" =~ ^[a-f0-9]{64}$ ]] || die "--source-sha256 must be a lowercase SHA-256"
# Inputs: download once, verify every time.
if [ "$policy_only" -eq 0 ] && [ ! -d "$tart_app" ]; then
  curl -fsSL --proto '=https' -o "$inputs/tart.tar.gz" "$TART_URL" || die "Tart download failed"
  [ "$(sha "$inputs/tart.tar.gz")" = "$TART_TGZ_SHA" ] || die "Tart archive hash differs from the pin"
  mkdir -m 0700 "$inputs/tart-extract"
  tar -xzf "$inputs/tart.tar.gz" -C "$inputs/tart-extract" tart.app
  mv "$inputs/tart-extract/tart.app" "$tart_app"
  rm -rf "$inputs/tart-extract" "$inputs/tart.tar.gz"
fi
tart=$tart_app/Contents/MacOS/tart
[ "$(sha "$tart")" = "$TART_SHA" ] || die "Tart executable hash differs from the pin"
codesign --verify --deep --strict "$tart_app" || die "Tart signature check failed"
codesign -dv "$tart_app" 2>&1 | grep -x "TeamIdentifier=$TART_TEAM" >/dev/null || die "Tart is not signed by team $TART_TEAM"
mise_binary=$inputs/mise-v$MISE_VERSION-macos-arm64
if [ "$policy_only" -eq 0 ]; then
if [ ! -f "$mise_binary" ]; then
  curl -fsSL --proto '=https' -o "$mise_binary.part" "$MISE_URL" || die "Mise download failed"
  mv "$mise_binary.part" "$mise_binary"
fi
[ "$(sha "$mise_binary")" = "$MISE_SHA" ] || die "Mise binary hash differs from the pin"
chmod 0755 "$mise_binary"
fi
echo "Tart verified: 2.41.1 ($TART_TEAM); Mise $MISE_VERSION is checked when preparing a base"

# Source VM: Tart addresses it by name inside its own home.
if [ "$policy_only" -eq 0 ]; then
source_vm=${source_vm%/}
[ -d "$source_vm" ] && [ ! -L "$source_vm" ] || die "--source-vm is not a directory: $source_vm"
source_name=${source_vm##*/}
prep_home=${source_vm%/vms/*}
[ "$prep_home/vms/$source_name" = "$source_vm" ] || die "--source-vm must be laid out as <tart home>/vms/<name>"
for f in config.json disk.img nvram.bin; do [ -f "$source_vm/$f" ] || die "source VM lacks $f"; done
# macOS caps Unix socket paths at 103 bytes and Tart keeps one in each VM directory.
socket_fits "$prep_home" || die "$prep_home/vms/$base/control.sock is over 103 bytes; move the source Tart home to a shorter path or pass a shorter --base"
socket_fits "$tart_home" || die "$tart_home/vms/$base/control.sock is over 103 bytes; use a shorter --tart-home or --base"

# Storage.
if [ -n "$container" ]; then
  [[ "$container" =~ ^disk[0-9]+$ ]] || die "--create-volume needs an APFS container such as disk9"
  diskutil apfs list "$container" >/dev/null 2>&1 || die "$container is not an APFS container"
  refuse_shared_container "$container"
  if [ -d "/Volumes/$VOLUME" ]; then
    [ "$(container_of "/Volumes/$VOLUME")" = "$container" ] \
      || die "/Volumes/$VOLUME already exists on another container"
  else
    free=$(diskutil apfs list "$container" | awk -F': *' '/Capacity Not Allocated/ && !n++ {split($2, a, " "); print a[1]}')
    [ "${free:-0}" -gt $((MIN_STORAGE_KB * 1024)) ] || die "$container has less than 120 GB unallocated"
  fi
else
  existing=$tart_home
  while [ ! -e "$existing" ]; do existing=$(dirname "$existing"); done
  volume_root=$(df "$existing" | awk 'NR==2{for (i = 9; i <= NF; i++) printf "%s%s", $i, (i < NF ? " " : "")}')
  [ "$volume_root" != / ] && [ "$volume_root" != /System/Volumes/Data ] \
    || die "--tart-home must be on a dedicated external volume, not the system disk"
  storage_container=$(container_of "$volume_root")
  [ -n "$storage_container" ] || die "$volume_root is not an APFS volume"
  refuse_shared_container "$storage_container"
  diskutil info "$volume_root" | grep -E 'Owners: +Enabled' >/dev/null \
    || die "ownership is disabled on $volume_root (sudo diskutil enableOwnership $volume_root)"
  [ "$(df -k "$volume_root" | awk 'NR==2{print $4}')" -gt "$MIN_STORAGE_KB" ] || die "less than 120 GB free on $volume_root"
fi
[ "$(df -k /System/Volumes/Data | awk 'NR==2{print $4}')" -gt "$MIN_INTERNAL_KB" ] \
  || die "internal disk is below the sealed runtime floor (at least 50 GiB)"
fi

# SSH: Remote Login must already be on; this never enables it globally.
nc -z -G 2 127.0.0.1 22 >/dev/null 2>&1 || die "Remote Login is off (System Settings > General > Sharing)"
grep -Eqi '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*' /private/etc/ssh/sshd_config \
  || die "sshd_config lacks the standard sshd_config.d include"
if grep -lEi '^[[:space:]]*(DenyUsers|DenyGroups|AllowGroups)[[:space:]]' /private/etc/ssh/sshd_config /private/etc/ssh/sshd_config.d/* 2>/dev/null; then
  echo "note: sshd has Deny*/AllowGroups rules; step 6 stops if they exclude $account"
fi

# Existing state, reported so a rerun shows what it will skip.
if id "$account" >/dev/null 2>&1; then
  ! id -Gn "$account" | tr ' ' '\n' | grep -xE 'admin|wheel' >/dev/null || die "$account exists and is privileged"
  echo "account $account exists"
fi
[ ! -e "$receipt" ] || echo "base $base already qualified"
echo "preflight ok"
[ "$apply" -eq 1 ] || { printf '\nRead-only preflight only. Rerun with --apply.\n'; exit 0; }

step "1 sudo (enter your Mac admin password once)"
sudo -v || die "sudo authentication failed"
( while sudo -n -v 2>/dev/null; do sleep 60; done ) &
KEEPALIVE=$!
trap 'kill "$KEEPALIVE" 2>/dev/null; sudo -k' EXIT
caffeinate -i -s -w $$ &

# Refuse an incomplete existing credential pair before any install mutation.
cred=/Users/$account/.partitura-native-login.password
kc=/Users/$account/Library/Keychains/login.keychain-db
if sudo test -e "$kc"; then
  sudo test -e "$cred" || die "existing keychain has no saved credential; explicit host repair required"
elif [ "$policy_only" -eq 1 ]; then
  die "installed host requires an initialized credential/keychain; explicit host repair required"
fi
if [ "$policy_only" -eq 0 ]; then
step "2 build storage"
if [ -n "$container" ] && [ ! -d "/Volumes/$VOLUME" ]; then
  sudo diskutil apfs addVolume "$container" APFS "$VOLUME" -reserve "$VOLUME_RESERVE" || die "could not create $VOLUME"
fi
if [ -n "$container" ]; then
  diskutil info "/Volumes/$VOLUME" | grep -E 'Owners: +Enabled' >/dev/null \
    || sudo diskutil enableOwnership "/Volumes/$VOLUME" || die "could not enable ownership on $VOLUME"
  diskutil info "/Volumes/$VOLUME" | grep -E 'Owners: +Enabled' >/dev/null || die "ownership is still disabled on $VOLUME"
fi
echo "storage ready"

step "3 build account and private directories"
bash "$MB/bootstrap-host.sh" --runtime-root "$runtime_root" --tart-home "$tart_home" --account "$account" --apply \
  || die "account bootstrap failed"

step "4 prepare and qualify the base VM (boots one preparation VM; 5-15 minutes)"
if [ -e "$receipt" ]; then
  "${PY[@]}" -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(r["sourceSha256"]!=sys.argv[2] or r["basePath"]!=sys.argv[3])' \
    "$receipt" "$source_sha" "$tart_home/vms/$base" || die "existing receipt $receipt is for a different source or path"
  echo "base already qualified; skipping"
else
  prep=(--source "$source_name" --source-sha256 "$source_sha" --base "$base" --tart "$tart" --tart-home "$prep_home"
        --runner "$MB/guest-run.sh" --qualifier "$MB/qualify-base.sh" --guest-user "$GUEST_USER"
        --mise-binary "$mise_binary" --mise-version "$MISE_VERSION" --mise-sha256 "$MISE_SHA"
        --node-version "$NODE_VERSION" --python-version "$PYTHON_VERSION"
        --dedicated-tart-home "$tart_home" --dedicated-account "$account" --receipt "$receipt")
  bash "$MB/prepare-base.sh" "${prep[@]}" || die "base preflight failed"
  bash "$MB/prepare-base.sh" "${prep[@]}" --apply || die "base preparation failed"
fi

fi

step "5 install the broker and restricted SSH policy (quiet while it rehashes the base)"
out=$inputs/out-$host
render=(settings --clone "$checkout" --receipt "$receipt" --root-dir "$ROOT"
  --tart-app "$tart_app" --tart-sha256 "$TART_SHA" --mise-binary "$mise_binary" --source-path "$source_vm"
  --host "$host" --account "$account" --guest-user "$GUEST_USER"
  --runtime-root "$runtime_root" --tart-home "$tart_home" --out "$out")
# Keep this array nonempty for macOS Bash 3.2 with nounset.
policy_args+=(--predecessor-manifest-sha256 "$predecessor")
for key in "${authorized_keys[@]}"; do render+=(--authorized-key "$key"); done
"${PY[@]}" "$MB/provision.py" "${render[@]}" "${policy_args[@]}" > "$out.hashes" || die "could not render host settings"
manifest_sha=$(awk -F= '/^manifest_sha256=/{print $2}' "$out.hashes")
settings_sha=$(sha "$out/settings.json")
bundle=$inputs/partitura-${commit:0:12}.bundle
[ -f "$bundle" ] || "${GIT[@]}" -C "$checkout" bundle create "$bundle" HEAD >/dev/null 2>&1 \
  || die "could not bundle the Partitura checkout"
sudo mkdir -p -m 0700 "$ROOT"
if ! sudo test -e "$ROOT/checkout"; then
  # Clone beside the final path and rename, so an interrupted clone never
  # leaves a partial checkout that a rerun would treat as installed.
  sudo rm -rf "$ROOT/checkout.partial"
  sudo install -m 0600 "$bundle" "$ROOT/source.bundle"
  sudo -H "${ROOT_GIT[@]}" clone --quiet --no-hardlinks --template= "$ROOT/source.bundle" "$ROOT/checkout.partial" \
    && sudo mv "$ROOT/checkout.partial" "$ROOT/checkout" || die "root checkout failed"
fi
[ "$(sudo -H "${ROOT_GIT[@]}" -C "$ROOT/checkout" rev-parse HEAD)" = "$commit" ] || die "root checkout is not at $commit"
[ -z "$(sudo -H "${ROOT_GIT[@]}" -C "$ROOT/checkout" status --porcelain)" ] || die "root checkout is dirty"
if ! sudo test -e "$ROOT/tart.app"; then
  sudo ditto --rsrc "$tart_app" "$ROOT/tart.app" && sudo chown -R root:wheel "$ROOT/tart.app" || die "could not copy Tart"
fi
[ "$(root_sha "$ROOT/tart.app/Contents/MacOS/tart")" = "$TART_SHA" ] || die "root copy of Tart differs"
sudo install -m 0600 "$out/settings.json" "$ROOT/settings.json"
[ "$(root_sha "$ROOT/settings.json")" = "$settings_sha" ] || die "root copy of the settings differs"
RMB=$ROOT/checkout/deploy/mac-build
set +e; sudo -H "${PY[@]}" "$RMB/host_setup.py" --config "$ROOT/settings.json" --check; rc=$?; set -e
case $rc in 0|2) ;; *) die "host_setup --check exited $rc" ;; esac
step "5a initialize missing fresh-host credentials"
cred=/Users/$account/.partitura-native-login.password
kc=/Users/$account/Library/Keychains/login.keychain-db
state=$INSTALL/provisioning
asbuild() { sudo -H -u "$account" "$@"; }
# Stable, protected state survives a newer commit's root staging directory.
sudo install -d -o root -g wheel -m 0700 "$state"
if sudo test -e "$kc"; then
  sudo test -e "$cred" || die "existing keychain has no saved credential; explicit host repair required"
  echo "existing credential/keychain preserved; account password is unchanged"
else
  [ "$policy_only" -eq 0 ] || die "--policy-only requires an initialized credential/keychain"
  if ! sudo test -e "$cred"; then
    echo "Paste a NEW password for $account (store it in your password manager first). Asked twice."
    sudo -H "${PY[@]}" "$RMB/provision.py" bootstrap-binding --account "$account" || die "credential bootstrap binding failed"
    sudo cat "$RMB/credential-writer.py" | asbuild "${PY[@]}" - --bootstrap || die "credential writer failed"
  fi
  if ! sudo test -e "$state/password-set"; then
    sudo -H "${PY[@]}" "$RMB/provision.py" password --account "$account" || die "setting the account password failed"
    sudo touch "$state/password-set"
  fi
  # No existing keychain is deleted or replaced automatically.
  sudo cat "$RMB/provision.py" | asbuild "${PY[@]}" - keychain || die "keychain create failed"
  echo "build keychain created from the saved credential"
fi

case $rc in
  0) echo "host files already installed" ;;
  2)
    STAGE=$ROOT/stage-$(date -u +%Y%m%dT%H%M%SZ)
    sudo -H "${PY[@]}" "$RMB/host_setup.py" --config "$ROOT/settings.json" --stage "$STAGE" || die "staging failed"
    [ "$(root_sha "$STAGE/managed-files.json")" = "$manifest_sha" ] || die "staged manifest differs from the rendered one"
    for mode in --check --apply; do
      sudo -H "${PY[@]}" "$RMB/native_host.py" --stage "$STAGE" --account "$account" \
        --tart-sha256 "$TART_SHA" --manifest-sha256 "$manifest_sha" --predecessor-manifest-sha256 "$predecessor" "$mode" || die "native_host $mode failed"
    done
    ;;
  *) die "host_setup --check exited $rc" ;;
esac

step "6 admit $account to SSH (public key only, forced build command)"
sudo -H "${PY[@]}" "$RMB/provision.py" sshd --account "$account" --apply || die "sshd admission failed"
sudo -H "${PY[@]}" "$RMB/remote_login.py" --account "$account" --apply || die "Remote Login admission failed"

step "7 final policy/readback"
sudo -H "${PY[@]}" "$RMB/host_setup.py" --config "$ROOT/settings.json" --check || die "post-install check failed"
echo "the first approved broker-session build proves unlock; daemon relock qualification is separate"

step "8 readback for the gateway"
host_key=$(awk '{print $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub)
cat <<EOF
builder:          $host
base sha256:      $("${PY[@]}" -c 'import json,sys; print(json.load(open(sys.argv[1]))["baseSha256"])' "$receipt")
broker commit:    $commit
host identity:    $("${PY[@]}" -c 'import json,sys; print(json.load(open(sys.argv[1]))["broker"]["host_id"])' "$out/settings.json")
profile:          $("${PY[@]}" -c 'import json,sys; print(json.load(open(sys.argv[1]))["broker"]["profile"])' "$out/settings.json")
authorized keys:  ${#authorized_keys[@]} restricted keys
known_hosts line: <tailnet name of $host> $host_key
gateway transport: User $account, IdentityFile <private key>, StrictHostKeyChecking yes
EOF
step "DONE"
printf '\nProvisioned. Add the known_hosts line and target to the gateway transport secrets.\n'
