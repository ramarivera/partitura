#!/bin/bash
# Install reviewed source root:wheel 0555 in the sealed macOS guest only.
set +x
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
fail() { printf '%s\n' 'native guest request refused' >&2; exit 1; }
[ "$#" = 6 ] || fail
job=$1 commit=$2 pr=$3 action=$4 runner_sha=$5 qualifier_sha=$6
[[ "$job" =~ ^[a-f0-9]{32}$ && "$commit" =~ ^[a-f0-9]{40}$ && "$pr" =~ ^[1-9][0-9]{0,7}$ ]] || fail
[[ "$runner_sha" =~ ^[a-f0-9]{64}$ && "$qualifier_sha" =~ ^[a-f0-9]{64}$ ]] || fail
case "$action" in archive|native-smoke) ;; *) fail ;; esac
[ "$(id -un):$HOME" = previewrunner:/Users/previewrunner ] || fail
runner=/Library/Partitura/NativeBuild/run.sh
qualifier=/Library/ONYXIO/NativePreview/qualify.sh
for file in /Library /Library/Partitura /Library/Partitura/NativeBuild "$runner" /Library/ONYXIO /Library/ONYXIO/NativePreview "$qualifier"; do
  [ ! -L "$file" ] || fail
  case "$(stat -f '%u:%Lp' "$file")" in 0:555|0:755) ;; *) fail ;; esac
done
[ "$(shasum -a 256 "$runner" | cut -d ' ' -f 1)" = "$runner_sha" ] || fail
[ "$(shasum -a 256 "$qualifier" | cut -d ' ' -f 1)" = "$qualifier_sha" ] || fail
# This must succeed before checkout, install scripts, or credential access.
/bin/bash "$qualifier" >/dev/null
root="$HOME/dev/agentic-scratchpads/partitura/$job"
mkdir -p "${root%/*}"
mkdir "$root"
cd "$root"
cat > source.bundle
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
git init --quiet source
git -C source -c core.hooksPath=/dev/null fetch --quiet ../source.bundle "$commit"
git -C source -c core.hooksPath=/dev/null checkout --quiet --detach FETCH_HEAD
[ "$(git -C source rev-parse HEAD)" = "$commit" ] || fail
rm source.bundle
mkdir artifacts
cd source
# The sealed base owns the toolchain and only scoped agent/preview identities.
# A clean environment above prevents injected operator or model credentials.
export PATH="$HOME/.local/share/mise/shims:$PATH"
export FNOX_AGE_KEY_FILE="$HOME/.config/dbx/onyxio-agent-fnox-age.key"
export FNOX_PROFILE=agent
export CI=1
mise trust > "$root/install.log" 2>&1
mise install >> "$root/install.log" 2>&1
mise run dependencies:install >> "$root/install.log" 2>&1
case "$action" in
  archive)
    # No --upload, release-profile fallback, or caller-supplied task/flags.
    mise run release:native:build-ios --build-number 1 --preview-signing \
      --runtime "onyxio-pr${pr}-${commit:0:7}" --channel "pr-$pr" \
      --work-dir "$root/build" > "$root/build.log" 2>&1
    cp "$root/build/summary.json" "$root/artifacts/summary.json"
    mkdir "$root/artifacts/ipa"
    cp "$root"/build/ipa/*.ipa "$root/artifacts/ipa/"
    ;;
  native-smoke)
    mise run smoke:boot:native > "$root/smoke.log" 2>&1
    ;;
esac
printf '{"job":"%s","commit":"%s","action":"%s","taskExit":0}\n' \
  "$job" "$commit" "$action" > "$root/artifacts/result.json"
