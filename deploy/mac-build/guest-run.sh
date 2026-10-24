#!/bin/bash
# Install reviewed source root:wheel 0555 in a project-neutral macOS guest.

run_repository_workflow() {
    local root=$1 job=$2 commit=$3 pr=$4 action=$5
    mkdir -p "${root%/*}"
    mkdir "$root"
    cd "$root"
    cat > source.bundle
    export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
    git init --quiet source
    # Import objects without fetch's full-history connectivity check. The
    # transmitted commit is an explicit shallow root, with no promised parents.
    git -C source bundle unbundle ../source.bundle >/dev/null
    printf '%s\n' "$commit" > source/.git/shallow
    git -C source -c core.hooksPath=/dev/null checkout --quiet --detach "$commit"
    [ "$(git -C source rev-parse HEAD)" = "$commit" ] || return 1
    rm source.bundle
    mkdir artifacts
    cd source
    # Repositories own bootstrap, toolchains, commands and credentials.
    export CI=1
    export PARTITURA_JOB_ID="$job" PARTITURA_COMMIT="$commit"
    export PARTITURA_PULL_REQUEST="$pr" PARTITURA_ARTIFACT_DIR="$root/artifacts"
    [ ! -L .partitura ] && [ -d .partitura ] || return 1
    [ ! -L .partitura/native-build.sh ] && [ -f .partitura/native-build.sh ] || return 1
    MISE_TRUSTED_CONFIG_PATHS="$root/source" mise exec -- \
      /bin/bash .partitura/native-build.sh "$action" > "$root/build.log" 2>&1
    printf '{"job":"%s","commit":"%s","action":"%s","taskExit":0}\n' \
      "$job" "$commit" "$action" > "$root/artifacts/result.json"
}

main() {
    set +x
    set -euo pipefail
    umask 077
    fail() { printf '%s\n' 'native guest request refused' >&2; exit 1; }
    [ "$#" = 6 ] || fail
    local job=$1 commit=$2 pr=$3 action=$4 runner_sha=$5 qualifier_sha=$6
    [[ "$job" =~ ^[a-f0-9]{32}$ && "$commit" =~ ^[a-f0-9]{40}$ && "$pr" =~ ^[1-9][0-9]{0,7}$ ]] || fail
    [[ "$runner_sha" =~ ^[a-f0-9]{64}$ && "$qualifier_sha" =~ ^[a-f0-9]{64}$ ]] || fail
    [[ "$action" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || fail
    [ "$(id -u)" != 0 ] || fail
    [[ "$HOME" = /Users/"$(id -un)" ]] || fail
    local runner=/Library/Partitura/NativeBuild/run.sh
    local qualifier=/Library/Partitura/NativeBuild/qualify.sh
    local file
    for file in /Library /Library/Partitura /Library/Partitura/NativeBuild "$runner" "$qualifier"; do
      [ ! -L "$file" ] || fail
      case "$(stat -f '%u:%Lp' "$file")" in 0:555|0:755) ;; *) fail ;; esac
    done
    [ "$(shasum -a 256 "$runner" | cut -d ' ' -f 1)" = "$runner_sha" ] || fail
    [ "$(shasum -a 256 "$qualifier" | cut -d ' ' -f 1)" = "$qualifier_sha" ] || fail
    # Qualify before checkout, install scripts, or credential access.
    /bin/bash "$qualifier" "$runner_sha" "$qualifier_sha" "$(id -un)" >/dev/null
    export PATH="/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    run_repository_workflow "$HOME/dev/agentic-scratchpads/partitura/$job" "$job" "$commit" "$pr" "$action"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
