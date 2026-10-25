# Isolated macOS build jobs

Partitura owns source transfer, one disposable Tart VM per job, artifact transfer,
cancellation and cleanup. It doesn't know a repository's build system, toolchain
version, signing process or secret manager. The generic base includes Mise and
cached Node/Python runtimes. It doesn't require the operator's Mise configuration,
toolbox checkout or fnox infrastructure.
The native integration isn't deployed or live-qualified yet.

## Repository contract

Commit `.partitura/native-build.sh` in the repository. Partitura checks out the
requested commit inside an unprivileged guest and runs:

```sh
mise exec -- /bin/bash .partitura/native-build.sh "$action"
```

An action is a lowercase name containing letters, digits and hyphens, such as
`build`, `test`, or `archive`. The repository script decides which actions it
supports and exits nonzero for unknown actions. The repository's `mise.toml`
selects tool versions and overrides the generic defaults. Cached versions need no
download. The repository owns additional dependency installation, toolchain checks
and the actual build. The checked-out history is shallow at the
requested commit, so tasks needing older history must fetch it themselves.

The script receives `CI=1`, `PARTITURA_JOB_ID`, `PARTITURA_COMMIT`,
`PARTITURA_PULL_REQUEST` and `PARTITURA_ARTIFACT_DIR`. Put outputs to retrieve in
`PARTITURA_ARTIFACT_DIR`. Partitura adds a `result.json` receipt after a successful
task, archives that directory without extracting it on the gateway, and verifies
the transferred bytes against the host's size and SHA-256 receipt.

For a dependency-free task:

```sh
#!/bin/bash
set -euo pipefail
case "$1" in
  test) printf '%s\n' "$PARTITURA_COMMIT" > "$PARTITURA_ARTIFACT_DIR/commit.txt" ;;
  *) exit 2 ;;
esac
```

A project may install or use its preferred tools from this script. Project
credentials require an explicitly configured, scoped delivery method. Partitura
never implicitly inherits an operator keychain, home, SSH agent, signing identity
or secret-manager identity. A reusable generic base must contain no project keys.
Don't share a project-specific base across unrelated repositories.

## Host setup and automation

The host needs an Apple silicon Mac supported by Tart, working SSH connectivity,
Python 3, enough disk and memory, and a clean macOS base compatible with its Tart
version. A macOS image and restricted SSH transport are required infrastructure.
The guest needs a selected Apple Command Line Tools or Xcode installation for Git, clang and
make. A full Xcode installation and a particular SDK version are repository
requirements, rather than Partitura requirements.

The host account defaults to `partitura-build`. The guest account defaults to
`partitura`. Both are unprivileged. The selected base, guest account and guest home
are configuration inputs, rather than repository-specific names. The base holds
the generic Partitura runner, qualification script, Mise and cached common
runtimes. Its guest runner, qualifier and Mise binary are root-owned mode 0555.
No host directories, graphics, audio, USB devices or clipboard are shared.

Host preparation must finish before enabling jobs. The automation validates the
selected base and executable pins, installs the generic guest code, prepares the
restricted account and private storage, and records the sealed base hash and
qualification receipt. Protected account, SSH policy and credential changes still
require deployment approval. Host-specific paths, authorized public key, source
image provenance, accepted Apple licenses and resource capacity must be supplied
or checked explicitly. The installer must fail clearly for missing prerequisites;
a successful source check alone doesn't prove host preparation or a usable VM.

The toolbox deployment is optional fleet integration. The standalone host setup
doesn't depend on the operator's toolbox, Mise configuration, fnox, or knowledge
of a particular repository. It installs the pinned portable Mise binary into the
guest and prepares the common tool cache there.
Start from [settings.example.json](settings.example.json) in a private scratch
directory. Its `REVIEWED_*` strings are required inputs, not valid defaults.
Record a full Partitura commit and the hashes of its broker, guest runner,
launcher, installer and qualifier. Record the signed Tart executable's hash and
the selected source VM's tree hash. `host_setup.tree_sha256()` defines that tree
hash, including relative paths, file modes and contents. Use the same clean source
for qualification and record its macOS image provenance and accepted Apple
licenses. A previously configured consumer VM isn't a clean source.

The standalone sequence is:

1. Download the pinned portable Mise asset with
   `deploy/build-tools/fetch-mise.sh`. It checks the upstream SHA-256 and leaves
   the host's own Mise installation untouched.
2. Run `bootstrap-host.sh --runtime-root PATH --tart-home PATH --account NAME`
   for its read-only plan. After approval, add `--apply` to create the account
   and private storage.
3. Run `prepare-base.sh --help`, then its preflight with the source VM name and
   hash, preparation Tart home, runner, qualifier, guest user and exact Mise,
   Node and Python inputs. Supply `--dedicated-tart-home` and
   `--dedicated-account` for the broker's private destination. After approval,
   add `--apply`. It prepares and qualifies a clone, stops it, promotes it into
   the dedicated account's storage, and writes the destination hash and receipt.
   The source VM stays intact.
   If guest downloads are unavailable, run `prepare-runtime-cache.sh MISE_BINARY
   MISE_SHA256 NODE_VERSION PYTHON_VERSION NEW_OUTPUT_DIRECTORY` on the Mac host.
   It uses an isolated Mise home and config and rejects discovered operator
   configuration. The resulting archive contains only the two exact runtime
   trees. Pass its path and printed SHA-256 to `prepare-base.sh` with
   `--runtime-cache` and `--runtime-cache-sha256`. Preparation validates its hash,
   paths, links and size, snapshots it privately, then extracts it as the
   unprivileged guest account. Qualification still checks the installed runtimes.
4. Copy the resulting base hash and receipt path into the private settings JSON.
   Set its authorized public key and `enabled` only for the approved installation.
   Run `python3 deploy/mac-build/host_setup.py --config PATH --check`. Exit 2
   means prerequisites passed and managed host files need installation. Other
   nonzero exits identify a failed prerequisite.
5. Run the same module with `--stage-host PRIVATE_STAGE_PATH`. Check its staged
   launcher with `python3 PRIVATE_STAGE_PATH/native_host.py --stage
   PRIVATE_STAGE_PATH --account NAME --tart-sha256 HASH
   --manifest-sha256 MANIFEST_HASH --check`. Compute `MANIFEST_HASH` from the
   staged `managed-files.json` before elevation. The approved
   root installation uses those same arguments with `--apply` instead of
   `--check` through the host's sudo route.
6. Run the original `host_setup.py --config PATH --check` again. Require exit 0,
   then run the acceptance checks below before enabling gateway native tools.

All script paths above are relative to the pinned Partitura checkout unless
they name the private stage. `--help` lists each script's full required inputs.
The base needs a working Tart guest agent and noninteractive guest sudo during
preparation. Apple image acquisition, license acceptance and the administrator's
sudo authentication are explicit host prerequisites. None comes from Toolbox,
fnox or a consumer repository. The setup scripts fail when prerequisites or
pins are missing; they don't silently install a different image or toolchain.

## Transport configuration

The gateway uses a private SSH config selected by `NATIVE_BUILD_SSH_CONFIG_FILE`
and a private writable directory selected by `NATIVE_BUILD_SCRATCH_ROOT`. The SSH
config defines the fixed `partitura-native` alias, dedicated identity and pinned
`UserKnownHostsFile`. Use strict host-key checking and disable agent and port
forwarding. Choose your own encrypted secret storage; workers receive neither
the config nor its private key. Revoking that one authorized key revokes the
transport without changing the operator's keys.

macOS may restrict Remote Login to selected users through the existing
`com.apple.access_ssh` service ACL. Account creation and a valid public key don't
grant membership. After installing the restricted SSH policy, run
`sudo python3 deploy/mac-build/remote_login.py --account partitura-build` to check
that prerequisite. With explicit approval, append `--apply` to admit only that
account. The helper verifies the effective forced command, public-key-only
authentication and disabled forwarding/TTY before editing the existing group.
It never creates a service ACL or enables Remote Login globally.

Install `broker.py` root:wheel 0555 outside checkouts. Its config is
`/Library/Partitura/NativeBuild/config.json`; all ancestors and the verified Tart
executable must be root-owned and not group/other writable. `root` and `tartHome`
are canonical mode-0700 directories owned by the dedicated build account.

```json
{
  "tart": "/Library/Partitura/NativeBuild/tart.app/Contents/MacOS/tart",
  "tartSha256": "REVIEWED_EXECUTABLE_SHA256",
  "base": "partitura-macos-base",
  "root": "/Users/partitura-build/dev/agentic-scratchpads/partitura/native-build",
  "tartHome": "/Volumes/Builds/partitura/tart",
  "guestUser": "partitura",
  "guestHome": "/Users/partitura",
  "guestRunnerSha256": "REVIEWED_GUEST_RUNNER_SHA256",
  "qualifierSha256": "REVIEWED_GENERIC_QUALIFIER_SHA256"
}
```

The SSH forced command accepts only these requests with exact arguments and no
shell evaluation:

- `run <job32hex> <commit40hex> <pr> <action> <bundleBytes>`
- `status <job32hex>`
- `artifact <job32hex>`
- `cancel <job32hex>`

Source arrives as an opaque Git bundle on stdin, bounded to 1 GiB. The host never
extracts or executes repository code. The fixed guest runner validates itself and
the generic base qualifier before importing source. Jobs run for at most 45
minutes. Artifact archives are bounded to 2 GiB.

One host lock serializes jobs. A persisted `active-vm` fence blocks subsequent
jobs after a crash. Cancellation creates a tombstone even before submission.
Cleanup deletes only that job's clone. Failed cleanup keeps the fence and blocks
new jobs until recovery establishes that the clone is gone. Host power loss
requires recovery after the host returns. The gateway records ownership and
cancels its interrupted jobs during restart recovery.

Before each new job, the host prunes terminal artifact archives older than seven
days and the oldest archives needed to leave at most 6 GiB of retained output.
The next job can add at most 2 GiB, bounding retained archives to 8 GiB. Failed
jobs remove partial archives immediately. Receipts stay available for status
queries and record `artifactExpired` when pruning removes their archive. An
already-open artifact transfer can finish after its archive is unlinked. Pruning
holds the job lock and never removes a running job's output or VM recovery fences.

## Acceptance

After approved installation, verify account and SSH restrictions, exact installed
hashes/modes, base provenance and qualification, no host shares, a generic
repository task and artifact receipt, cross-session denial, cancellation and crash
recovery. Then test a consumer repository's workflow separately. A successful
consumer build doesn't prove that host setup works without that consumer's tools.
Keep native acceptance open until the full deployed path passes.
