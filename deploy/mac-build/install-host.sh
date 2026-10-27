#!/bin/bash
set -euo pipefail
stage="$1"
tart_sha256="$2"
account="$3"
label=net.partitura.native-build-maintenance
plist=/Library/LaunchDaemons/$label.plist
tart_target=/Library/Partitura/NativeBuild/tart.app
tart_new=/Library/Partitura/NativeBuild/.tart.app.new
tart_previous=/Library/Partitura/NativeBuild/.tart.app.previous
for path in /Library /Library/Partitura /Library/Partitura/NativeBuild /Library/LaunchDaemons /private/etc /private/etc/ssh /private/etc/ssh/sshd_config.d; do
  [ ! -L "$path" ] || { echo "refusing symlink path: $path" >&2; exit 1; }
done
for path in "$plist" "$plist.new" "$plist.rollback" /Library/Partitura/NativeBuild/broker.py /Library/Partitura/NativeBuild/credential-writer.py /Library/Partitura/NativeBuild/broker.py.new /Library/Partitura/NativeBuild/credential-writer.py.new /Library/Partitura/NativeBuild/broker.py.rollback /Library/Partitura/NativeBuild/credential-writer.py.rollback /Library/Partitura/NativeBuild/config.json /Library/Partitura/NativeBuild/config.json.new /Library/Partitura/NativeBuild/config.json.rollback /Library/Partitura/NativeBuild/managed-files.json /Library/Partitura/NativeBuild/managed-files.json.new /Library/Partitura/NativeBuild/managed-files.json.rollback /Library/Partitura/NativeBuild/authorized_keys /Library/Partitura/NativeBuild/authorized_keys.new /Library/Partitura/NativeBuild/authorized_keys.rollback /Library/Partitura/NativeBuild/tart.app /Library/Partitura/NativeBuild/.tart.app.new /Library/Partitura/NativeBuild/.tart.app.previous /private/etc/ssh/sshd_config.d/90-partitura-native-build.conf /private/etc/ssh/sshd_config.d/90-partitura-native-build.conf.new /private/etc/ssh/sshd_config.d/90-partitura-native-build.conf.rollback; do
  [ ! -L "$path" ] || { echo "refusing symlink target: $path" >&2; exit 1; }
done
for path in "$plist.new" "$plist.rollback" /Library/Partitura/NativeBuild/broker.py.new /Library/Partitura/NativeBuild/credential-writer.py.new /Library/Partitura/NativeBuild/broker.py.rollback /Library/Partitura/NativeBuild/credential-writer.py.rollback /Library/Partitura/NativeBuild/config.json.new /Library/Partitura/NativeBuild/config.json.rollback /Library/Partitura/NativeBuild/managed-files.json.new /Library/Partitura/NativeBuild/managed-files.json.rollback /Library/Partitura/NativeBuild/authorized_keys.new /Library/Partitura/NativeBuild/authorized_keys.rollback /Library/Partitura/NativeBuild/.tart.app.new /Library/Partitura/NativeBuild/.tart.app.previous /private/etc/ssh/sshd_config.d/90-partitura-native-build.conf.new /private/etc/ssh/sshd_config.d/90-partitura-native-build.conf.rollback; do
  [ ! -e "$path" ] || { echo "refusing stale Tart transaction path: $path" >&2; exit 1; }
done
preflight="$(/usr/bin/mktemp -d /private/etc/ssh/.partitura-native-build.XXXXXX)"
dropin=/private/etc/ssh/sshd_config.d/90-partitura-native-build.conf
completed=0
snapshot_ready=0
tart_old_moved=0
tart_new_installed=0
daemon_touched=0
daemon_was_loaded=0
policy_touched=0
policy_snapshot=null
cleanup() {
  status=$?
  trap - EXIT
  rollback_failed=0
  if [ "$completed" -eq 0 ]; then
    if [ "$daemon_touched" -eq 1 ]; then
      # Never bootstrap the predecessor while a new instance is still loaded.
      if /bin/launchctl print "system/$label" >/dev/null 2>&1; then
        /bin/launchctl bootout "system/$label" || rollback_failed=1
      fi
    fi
    if [ "$tart_new_installed" -eq 1 ]; then /bin/rm -rf "$tart_target" || rollback_failed=1; fi
    if [ "$tart_old_moved" -eq 1 ]; then /bin/mv -f "$tart_previous" "$tart_target" || rollback_failed=1; fi
    if [ "$snapshot_ready" -eq 1 ]; then
      restore_managed_file broker /Library/Partitura/NativeBuild/broker.py || rollback_failed=1
      restore_managed_file writer /Library/Partitura/NativeBuild/credential-writer.py || rollback_failed=1
      restore_managed_file config /Library/Partitura/NativeBuild/config.json || rollback_failed=1
      restore_managed_file authorized-keys /Library/Partitura/NativeBuild/authorized_keys || rollback_failed=1
      restore_managed_file dropin "$dropin" || rollback_failed=1
      restore_managed_file manifest /Library/Partitura/NativeBuild/managed-files.json || rollback_failed=1
      restore_managed_file plist "$plist" || rollback_failed=1
    fi
    if [ "$policy_touched" -eq 1 ]; then
      keychain_policy restore "$policy_snapshot" || rollback_failed=1
    fi
    if [ "$daemon_touched" -eq 1 ] && [ "$daemon_was_loaded" -eq 1 ] && [ "$rollback_failed" -eq 0 ]; then
      /bin/launchctl bootstrap system "$plist" || rollback_failed=1
      /bin/launchctl print "system/$label" >/dev/null || rollback_failed=1
    fi
  elif [ "$tart_old_moved" -eq 1 ]; then
    /bin/rm -rf "$tart_previous" || rollback_failed=1
  fi
  /bin/rm -rf "$tart_new" || rollback_failed=1
  if [ "$rollback_failed" -ne 0 ]; then
    echo "native host rollback incomplete; backups retained at $preflight" >&2
    exit 1
  fi
  /bin/rm -rf "$preflight" || true
  exit "$status"
}
trap cleanup EXIT
backup_managed_file() {
  name="$1"
  target="$2"
  if [ -e "$target" ]; then
    /bin/cp -p "$target" "$preflight/backups/$name"
    owner="$(/usr/bin/stat -f %u "$target")"
    group="$(/usr/bin/stat -f %g "$target")"
    mode="$(/usr/bin/stat -f %Lp "$target")"
    /usr/bin/printf "%s %s %s\\n" "$owner" "$group" "$mode" > "$preflight/backups/$name.metadata"
    /usr/bin/touch "$preflight/backups/$name.present"
  fi
}
restore_managed_file() {
  name="$1"
  target="$2"
  if [ -f "$preflight/backups/$name.present" ]; then
    read -r owner group mode < "$preflight/backups/$name.metadata"
    /usr/bin/install -o "$owner" -g "$group" -m "$mode" "$preflight/backups/$name" "$target.rollback" || return 1
    /bin/mv -f "$target.rollback" "$target" || return 1
  else
    /bin/rm -f "$target" "$target.rollback" || return 1
  fi
  /bin/rm -f "$target.new" || return 1
}
atomic_install() {
  target="$3"
  /usr/bin/install -o root -g wheel -m "$2" "$1" "$target.new"
  /bin/mv -f "$target.new" "$target"
}
keychain_policy() {
  /usr/bin/sudo --non-interactive -H -u "$account" /usr/bin/env -i \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="/Users/$account" \
    DEVELOPER_DIR=/Library/Developer/CommandLineTools \
    /usr/bin/python3 -I -c "$policy_script" "$@"
}
policy_script="$(/usr/bin/python3 -I "$stage/provision.py" policy-script)"
/usr/bin/plutil -lint "$stage/maintenance.plist" >/dev/null
loaded="$(/bin/launchctl list)"
if /usr/bin/awk -v label="$label" '$3 == label { found=1 } END { exit !found }' <<<"$loaded"; then
  daemon_was_loaded=1
fi
policy_snapshot="$(keychain_policy snapshot)"
[ "$policy_snapshot" != null ] || { echo "initialize the dedicated keychain through one-shot provisioning first" >&2; exit 1; }
/bin/mkdir -m 0700 "$preflight/backups"
backup_managed_file broker /Library/Partitura/NativeBuild/broker.py
backup_managed_file writer /Library/Partitura/NativeBuild/credential-writer.py
backup_managed_file config /Library/Partitura/NativeBuild/config.json
backup_managed_file authorized-keys /Library/Partitura/NativeBuild/authorized_keys
backup_managed_file dropin "$dropin"
backup_managed_file manifest /Library/Partitura/NativeBuild/managed-files.json
backup_managed_file plist "$plist"
snapshot_ready=1
/bin/mkdir -m 0700 "$preflight/dropins"
for current in /private/etc/ssh/sshd_config.d/*.conf; do
  [ -f "$current" ] || continue
  [ "$current" = /private/etc/ssh/sshd_config.d/90-partitura-native-build.conf ] && continue
  /bin/cp -p "$current" "$preflight/dropins/"
done
/bin/cp -p /private/etc/ssh/sshd_config "$preflight/sshd_config.source"
/usr/bin/install -o root -g wheel -m 0644 "$stage/sshd_config" "$preflight/dropins/90-partitura-native-build.conf"
/usr/bin/awk -v replacement="Include $preflight/dropins/*.conf" \
  "\$1 == \"Include\" && \$2 == \"/etc/ssh/sshd_config.d/*\" { \$0 = replacement; replaced = 1 } { print } END { if (!replaced) exit 1 }" \
  "$preflight/sshd_config.source" > "$preflight/sshd_config"
/usr/sbin/sshd -t -f "$preflight/sshd_config"
normalize_sshd_keywords() {
  /usr/bin/awk '{ key = $1; sub(/^[^ \t]+/, tolower(key)); print }'
}
effective="$(/usr/sbin/sshd -T -f "$preflight/sshd_config" -C user="$account",host=localhost,addr=127.0.0.1 | normalize_sshd_keywords)"
for expected in \
  "authorizedkeysfile /Library/Partitura/NativeBuild/authorized_keys" \
  "passwordauthentication no" \
  "kbdinteractiveauthentication no" \
  "authenticationmethods publickey" \
  "forcecommand /usr/bin/python3 /Library/Partitura/NativeBuild/broker.py" \
  "allowtcpforwarding no" \
  "allowagentforwarding no" \
  "x11forwarding no" \
  "permittty no" \
  "permituserenvironment no" \
  "clientaliveinterval 15" \
  "clientalivecountmax 3"; do
  /usr/bin/grep -Fxq "$expected" <<<"$effective" || { echo "staged sshd policy differs: $expected" >&2; exit 1; }
done
/usr/bin/install -d -o root -g wheel -m 0755 /Library/Partitura /Library/Partitura/NativeBuild
/usr/bin/install -d -o root -g wheel -m 0755 /private/etc/ssh/sshd_config.d
# The root wrapper holds runner.lock and durable legacy/registry admission
# fences throughout this transaction. Stop the old daemon before replacing code.
daemon_touched=1
if [ "$daemon_was_loaded" -eq 1 ]; then
  /bin/launchctl bootout "system/$label"
fi
if /bin/launchctl print "system/$label" >/dev/null 2>&1; then
  echo "previous maintenance instance is still loaded" >&2; exit 1
fi
/usr/bin/ditto --rsrc "$stage/tart.app" "$tart_new"
/usr/sbin/chown -R root:wheel "$tart_new"
/bin/chmod -R go-w "$tart_new"
/usr/bin/codesign --verify --deep --strict "$tart_new"
actual_tart_sha256="$(/usr/bin/shasum -a 256 "$tart_new/Contents/MacOS/tart" | /usr/bin/cut -d " " -f 1)"
[ "$actual_tart_sha256" = "$tart_sha256" ] || { echo "staged Tart executable hash differs" >&2; exit 1; }
if [ -e "$tart_target" ]; then
  [ ! -e "$tart_previous" ] || { echo "stale Tart rollback path exists" >&2; exit 1; }
  /bin/mv "$tart_target" "$tart_previous"
  tart_old_moved=1
fi
/bin/mv "$tart_new" "$tart_target"
tart_new_installed=1
atomic_install "$stage/broker.py" 0555 /Library/Partitura/NativeBuild/broker.py
atomic_install "$stage/credential-writer.py" 0555 /Library/Partitura/NativeBuild/credential-writer.py
atomic_install "$stage/config.json" 0444 /Library/Partitura/NativeBuild/config.json
atomic_install "$stage/authorized_keys" 0444 /Library/Partitura/NativeBuild/authorized_keys
atomic_install "$stage/managed-files.json" 0444 /Library/Partitura/NativeBuild/managed-files.json
/usr/bin/install -o root -g wheel -m 0644 "$stage/sshd_config" "$dropin.new"
/bin/mv -f "$dropin.new" "$dropin"
/usr/sbin/sshd -t
live_effective="$(/usr/sbin/sshd -T -C user="$account",host=localhost,addr=127.0.0.1 | normalize_sshd_keywords)"
for expected in \
  "authorizedkeysfile /Library/Partitura/NativeBuild/authorized_keys" \
  "passwordauthentication no" \
  "kbdinteractiveauthentication no" \
  "authenticationmethods publickey" \
  "forcecommand /usr/bin/python3 /Library/Partitura/NativeBuild/broker.py" \
  "allowtcpforwarding no" \
  "allowagentforwarding no" \
  "x11forwarding no" \
  "permittty no" \
  "permituserenvironment no" \
  "clientaliveinterval 15" \
  "clientalivecountmax 3"; do
  /usr/bin/grep -Fxq "$expected" <<<"$live_effective" || { echo "live sshd policy differs: $expected" >&2; exit 1; }
done
policy_touched=1
keychain_policy apply
# Install/activate last, once all script/config/sshd readbacks have passed.
atomic_install "$stage/maintenance.plist" 0644 "$plist"
/bin/launchctl bootstrap system "$plist"
/bin/launchctl print "system/$label" >/dev/null
completed=1
