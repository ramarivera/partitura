#!/bin/bash
set -euo pipefail
stage="$1"
tart_sha256="$2"
account="$3"
tart_target=/Library/Partitura/NativeBuild/tart.app
tart_new=/Library/Partitura/NativeBuild/.tart.app.new
tart_previous=/Library/Partitura/NativeBuild/.tart.app.previous
for path in /Library /Library/Partitura /Library/Partitura/NativeBuild /private/etc /private/etc/ssh /private/etc/ssh/sshd_config.d; do
  [ ! -L "$path" ] || { echo "refusing symlink path: $path" >&2; exit 1; }
done
for path in /Library/Partitura/NativeBuild/broker.py /Library/Partitura/NativeBuild/broker.py.new /Library/Partitura/NativeBuild/broker.py.rollback /Library/Partitura/NativeBuild/config.json /Library/Partitura/NativeBuild/config.json.new /Library/Partitura/NativeBuild/config.json.rollback /Library/Partitura/NativeBuild/managed-files.json /Library/Partitura/NativeBuild/managed-files.json.new /Library/Partitura/NativeBuild/managed-files.json.rollback /Library/Partitura/NativeBuild/authorized_keys /Library/Partitura/NativeBuild/authorized_keys.new /Library/Partitura/NativeBuild/authorized_keys.rollback /Library/Partitura/NativeBuild/tart.app /Library/Partitura/NativeBuild/.tart.app.new /Library/Partitura/NativeBuild/.tart.app.previous /private/etc/ssh/sshd_config.d/90-partitura-native-build.conf /private/etc/ssh/sshd_config.d/90-partitura-native-build.conf.new /private/etc/ssh/sshd_config.d/90-partitura-native-build.conf.rollback; do
  [ ! -L "$path" ] || { echo "refusing symlink target: $path" >&2; exit 1; }
done
for path in /Library/Partitura/NativeBuild/broker.py.new /Library/Partitura/NativeBuild/broker.py.rollback /Library/Partitura/NativeBuild/config.json.new /Library/Partitura/NativeBuild/config.json.rollback /Library/Partitura/NativeBuild/managed-files.json.new /Library/Partitura/NativeBuild/managed-files.json.rollback /Library/Partitura/NativeBuild/authorized_keys.new /Library/Partitura/NativeBuild/authorized_keys.rollback /Library/Partitura/NativeBuild/.tart.app.new /Library/Partitura/NativeBuild/.tart.app.previous /private/etc/ssh/sshd_config.d/90-partitura-native-build.conf.new /private/etc/ssh/sshd_config.d/90-partitura-native-build.conf.rollback; do
  [ ! -e "$path" ] || { echo "refusing stale Tart transaction path: $path" >&2; exit 1; }
done
preflight="$(/usr/bin/mktemp -d /private/etc/ssh/.partitura-native-build.XXXXXX)"
dropin=/private/etc/ssh/sshd_config.d/90-partitura-native-build.conf
completed=0
snapshot_ready=0
tart_old_moved=0
tart_new_installed=0
cleanup() {
  status=$?
  trap - EXIT
  rollback_failed=0
  if [ "$completed" -eq 0 ]; then
    if [ "$tart_new_installed" -eq 1 ]; then /bin/rm -rf "$tart_target" || rollback_failed=1; fi
    if [ "$tart_old_moved" -eq 1 ]; then /bin/mv -f "$tart_previous" "$tart_target" || rollback_failed=1; fi
    if [ "$snapshot_ready" -eq 1 ]; then
      restore_managed_file broker /Library/Partitura/NativeBuild/broker.py || rollback_failed=1
      restore_managed_file config /Library/Partitura/NativeBuild/config.json || rollback_failed=1
      restore_managed_file authorized-keys /Library/Partitura/NativeBuild/authorized_keys || rollback_failed=1
      restore_managed_file dropin "$dropin" || rollback_failed=1
      restore_managed_file manifest /Library/Partitura/NativeBuild/managed-files.json || rollback_failed=1
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
/bin/mkdir -m 0700 "$preflight/backups"
backup_managed_file broker /Library/Partitura/NativeBuild/broker.py
backup_managed_file config /Library/Partitura/NativeBuild/config.json
backup_managed_file authorized-keys /Library/Partitura/NativeBuild/authorized_keys
backup_managed_file dropin "$dropin"
backup_managed_file manifest /Library/Partitura/NativeBuild/managed-files.json
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
effective="$(/usr/sbin/sshd -T -f "$preflight/sshd_config" -C user="$account",host=localhost,addr=127.0.0.1)"
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
  "permituserenvironment no"; do
  /usr/bin/grep -Fxq "$expected" <<<"$effective" || { echo "staged sshd policy differs: $expected" >&2; exit 1; }
done
/usr/bin/install -d -o root -g wheel -m 0755 /Library/Partitura /Library/Partitura/NativeBuild
/usr/bin/install -d -o root -g wheel -m 0755 /private/etc/ssh/sshd_config.d
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
atomic_install "$stage/config.json" 0444 /Library/Partitura/NativeBuild/config.json
atomic_install "$stage/authorized_keys" 0444 /Library/Partitura/NativeBuild/authorized_keys
atomic_install "$stage/managed-files.json" 0444 /Library/Partitura/NativeBuild/managed-files.json
/usr/bin/install -o root -g wheel -m 0644 "$stage/sshd_config" "$dropin.new"
/bin/mv -f "$dropin.new" "$dropin"
/usr/sbin/sshd -t
live_effective="$(/usr/sbin/sshd -T -C user="$account",host=localhost,addr=127.0.0.1)"
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
  "permituserenvironment no"; do
  /usr/bin/grep -Fxq "$expected" <<<"$live_effective" || { echo "live sshd policy differs: $expected" >&2; exit 1; }
done
completed=1
