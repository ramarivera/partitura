# Isolated macOS build jobs

Partitura owns source transfer, one disposable Tart VM per job, artifact transfer,
cancellation and cleanup. It doesn't know a repository's build system, toolchain
version, signing process or secret manager. The generic base includes Mise and
cached Node/Python runtimes. It doesn't require the operator's Mise configuration,
toolbox checkout or fnox infrastructure.
Deployment and acceptance are separate steps. Require the live checks below for
the installed revision before calling a configured host ready.

## Disk diagnostic compatibility and offline downgrade

The gateway accepts `host-disk-space-unavailable` only with `disk-preflight`
or `disk-post-transfer`. These diagnostics identify the requested job, commit
and action even when a broker refuses input and closes stdin early. After a broken
stdin, only `disk-preflight` refusals are accepted. Post-transfer and workflow
failures require completed input. `EPIPE` is the qualified broken-pipe signal on
the pinned Bun runtime; other stream errors remain generic failures. Unidentified,
malformed or inconsistent output remains a generic failed build. The existing
`primary` and `backup` clients and their legacy configuration remain in use.
This gateway change doesn't install disk enforcement on a Mac.

Deploy this compatible gateway before approving a host broker that emits the new
disk diagnostics. A pre-change gateway's persisted decoder can't read those new
literals. Before downgrading the gateway:

1. Stop native tool consumers and the gateway. Reconcile unfinished jobs with the
   compatible gateway before stopping it. Don't run two versions against the same
   scratch directory. The offline helper requires an explicit stopped-gateway
   acknowledgement; it doesn't detect or stop a running gateway.
2. Approve and install an old-emitting broker profile before accepting new work
   with the old gateway. This slice doesn't change any installed broker.
3. Run the helper on the Docker host, against the **host paths** backing the
   stopped container's legacy scratch mounts, not its `/app/...` container paths.
   The runtime image doesn't include this source helper. Use a trusted checkout
   of this revision with frozen dependencies already installed and a pinned Bun
   binary. The binary, checkout, all checkout contents including dependencies,
   and every ancestor must be root-owned and not group- or world-writable. Don't
   execute a user-writable checkout as root. Establish this trust before launching
   Bun; the helper cannot undo code that ran during runtime startup or imports.

   Use each configured legacy host scratch path separately and an existing
   root-owned mode-0700 backup directory outside both scratch roots, on the same
   filesystem. Change to `/` and launch with an empty environment, a fixed PATH,
   explicit empty Bun config and dotenv loading disabled. This prevents cwd
   `bunfig.toml` preloads, `.env` and inherited loader settings from running as root.
   For example, using placeholder host paths that must match your deployment:

   ```nu
   cd /
   sudo env -i PATH=/usr/bin:/bin /opt/partitura/bin/bun --config=/dev/null --no-env-file /srv/partitura/source/deploy/mac-build/native-build-admin.ts rollback-disk-diagnostics --legacy-root /srv/partitura/native-build-scratch --backup-root /srv/partitura/native-build-rollback --gateway-stopped
   ```

   The CLI requires this cwd, flag set and environment, and checks ownership and
   writable bits on the executable, checkout root, entry script and their
   ancestors. These are sanity checks after startup, not proof that an untrusted
   checkout or its dependencies are safe to execute.

4. Inspect the JSON result. `projected` lists affected job IDs, `unchanged` lists
   compatible records and `quarantined` lists corrupt/unprojectable records moved
   out of legacy state. The helper exits 2 when it quarantines records. Resolve
   those affected jobs before resuming native tools. It exits 1 without rewriting
   records on preflight failure, including unfinished jobs or unsafe paths. An IO
   failure during mutation can leave a partially completed run; inspect its private
   backups before retrying. Exact original bytes are fsynced under the printed
   backup directory's `originals/`; quarantine lives beside it. Retain those bytes
   for rollback and incident investigation. Never discard unfinished jobs to make
   an old binary start.
5. Start the old gateway only after the affected records and host emitting profile
   are compatible. Preserve the original scratch/artifact ownership and paths.

The projection changes only terminal failed disk diagnostics to
`host-capacity-unavailable` and `capacity`. It preserves the job ID, session owner,
commit, action and terminal state. Valid non-disk records remain byte-for-byte
unchanged, including excess keys the baseline decoder ignores.
Disk records with unknown fields are quarantined rather than silently dropping
unrecognized data during a rewrite. Files must be private, singly linked regular
files; symlinks and unsafe directories are refused. The source and backup roots
must stay private. Root-owned sticky ancestors such as `/tmp` are allowed;
non-sticky writable ancestors and non-root/non-self owners are refused.
An exclusive `.native-build-admin.lock` fences concurrent
offline helpers, not gateway processes. After a helper crash, remove a leftover
lock only after confirming the gateway and all helper processes are stopped and
inspecting any partial backup. No helper operation contacts a Mac or secret provider.

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

When `WORKER_REPOSITORY_AGE_KEYS_JSON` contains an identity for the run's exact
organization and repository, the gateway sends it as the generic job file
`repository-age-identity`. The repository script receives
`PARTITURA_JOB_SECRETS_DIR`, a mode-0700 directory containing mode-0600 files.
A repository that uses fnox can select that file itself. Neither fnox nor any
repository's secret names belong in the base. Model tool arguments cannot
supply or select these secret files. The optional input is bounded to 16 flat
filenames and 64 KiB of JSON, travels on stdin rather than SSH arguments, and
never enters the source bundle or durable ownership record. The host uses an
unlinked temporary transport, and the guest removes secret files on workflow
success or failure before its disposable VM is destroyed.

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
### One-shot provisioning

[provision-host.sh](provision-host.sh) provisions a new Mac in one run: one sudo
prompt, and one new build-account password pasted twice. Run it as an
administrator from a clean checkout of the commit you want installed:

```bash
bash deploy/mac-build/provision-host.sh \
  --source-vm /Volumes/Fast/pnb/vms/macos-base --source-sha256 SOURCE_TREE_SHA256 \
  --authorized-key "$(cat partitura-native-build.pub)" \
  --create-volume disk9            # or --tart-home on an existing owned volume
```

Without `--apply` it runs only the read-only preflight. That downloads Tart and
Mise into `~/dev/agentic-scratchpads/partitura/host-inputs` and checks them
against the hashes pinned in the script, plus Tart's signing team. It also checks:

- the Command Line Tools tree is root-owned and not group- or other-writable;
- the source VM and build storage paths keep Tart's control socket under macOS's
  103-byte Unix socket limit;
- build storage is a dedicated volume with ownership enabled and 120 GB free,
  never the system disk or a Time Machine destination's container;
- the internal disk meets the sealed floor, initially 50 GiB, and Remote Login is on.

After base preparation, staging and final readback measure available-to-account
bytes on both actual runtime roots with `statvfs`. Each root must satisfy the
sealed floor. APFS free-space values are never added together. The external
120 GiB provisioning requirement/reserve is separate from this runtime floor.

Add `--apply` to provision. It creates the build volume and account, prepares and
qualifies the base VM, installs the broker and restricted SSH policy from a
root-owned checkout of the same commit, and admits the account to SSH. If an
existing global `AllowUsers` line would refuse the account, it appends the
account there. It keeps the previous file outside `sshd_config.d`, because that
directory's include would load a backup. It restores the file if `sshd -t`
fails. The credential writer reads the new password; root then sets the account
password from that saved credential over a private pseudo-terminal, so the
secret never appears in a process argument or environment. It initializes the
build keychain before the managed-file transaction. Fresh-host `--bootstrap`
requires a root-owned mode 0444 account binding created by the root helper under
`/Library/Partitura/NativeBuild/credential-bootstrap.json`. It binds the dedicated
account's name, uid and canonical private home; an arbitrary unprivileged account
cannot bootstrap. An existing installed config must agree with that binding.

The sudo installer never checks, reads settings from or changes settings on the
keychain. On macOS 27, operations through `sudo -u` from the operator's session
fail even with the correct password, while the broker's own SSH session works.
The first separately approved build proves unlock; `unlock-failed` stops before
cloning. Existing credential/keychain pairs are preserved. No rerun deletes or
replaces a keychain. A partial main-era install with both files absent can finish
initialization through a full approved rerun without `--policy-only`, using the
installed account binding. An existing keychain without its credential requires
explicit host repair. Policy-only updates never initialize either file.
Password initialization uses root-private stable state under
`/Library/Partitura/NativeBuild/provisioning`, independent of the source commit.

The sealed `broker.keychain_policy` defaults to `null`, meaning leave settings
unchanged, including on legacy upgrades. No automatic-lock interval reaches a
production host through the default installer. An explicit policy is an object
with a `lockOnSleep` boolean and integer `lockInterval` in seconds, from 0 through
2147483647. The latter value is the explicit no-idle-timeout sentinel; zero means
an immediate timeout, not never. Lock-on-sleep remains independent. For example,
`{"lockOnSleep":false,"lockInterval":2147483647}` disables both automatic causes.
`useLockInterval` isn't accepted: Apple's API ignores it on write and doesn't
return it on read, so its value can't express whether a timeout is enabled.
See the pinned Apple [API implementation](https://github.com/apple-oss-distributions/Security/blob/Security-61901.0.87.0.1/OSX/libsecurity_keychain/lib/SecKeychain.cpp#L152)
and [security tool's no-timeout mapping](https://github.com/apple-oss-distributions/Security/blob/Security-61901.0.87.0.1/SecurityTool/macOS/keychain_set_settings.c#L184).
Contradictory old three-field policies are rejected during settings/config validation.
For an approved qualification update, `--keychain-policy` accepts that JSON, for
example `'{"lockOnSleep":true,"lockInterval":300}'`.
Choose and qualify the interval on an isolated or backup host before approving it
for a primary. The broker applies it inside its SSH session immediately after
unlock, reads it back before cloning, and fails with `keychain-policy-unavailable`
if that fails or differs. Legacy receipts keep the existing `unlock` /
`unlock-failed` diagnostic so the live gateway can decode them. It saves the
prior settings before mutation in private
`keychain-policy.json`. Receipts/status carry successful prior/requested/readback
values and `preRelockState`; health exposes cached evidence without a keychain
API call. The first prior snapshot is retained for this host across every policy
change, revert and preserve cycle; later requests never replace it. Capture that
original two-field object before changing policy. Unreadable or invalid saved
evidence stops policy changes instead of replacing the original snapshot. An
interval is defense in depth and never clears a fence.

To revert, quiesce the host, take the original `before` object and approve a
policy-only update with `--keychain-policy` set to those exact values. An approved
SSH build must show those exact two fields in its restored readback. A prior
interval of 2147483647 must be restored verbatim, never replaced with zero. Then
approve a second policy-only
update with `--keychain-policy preserve` to stop managing settings. `preserve`
alone doesn't undo a policy already applied. These policy values aren't secrets;
passwords still never enter argv or env. Daemon relock qualification is separate.

For an approved key/policy update on an installed host, use the same entry point
with `--policy-only --apply`, the existing account/base/Tart-home selections and
one or two `--authorized-key` flags. This path skips volume/account/base/password/
keychain creation and doesn't require the original source VM. The installed
qualified-base receipt remains mandatory. Retain all existing public keys for
the first overlap update. Removing the retiring key is a second approved update
after historical work is drained/reconciled. Key comments don't define identity;
duplicate key blobs and more than two keys are refused.

The old single `--authorized-key` flag and old settings `authorized_key` remain
valid. New settings use `authorized_keys`, with one or two unique public keys
when enabled and an empty list when disabled. Supplying both forms is invalid.
The `broker` settings carry `protocol: 2`, `host_id`, `profile`,
`minimum_free_bytes`, `daemon_relock_qualified`, `daemon_relock_macos_build` and
optional `keychain_policy`.
The protocol is fixed by this broker revision; the other fields become the
extended sealed broker config. Fresh installs default to `legacy`, 50 GiB and
unqualified daemon relock. Existing settings without `broker` preserve the
installed profile, floor, qualification and keychain policy instead of resetting them.

`--host-id` supplies an independently recorded UUID or the one-shot renderer
proposes a UUID once and retains it across rerenders. Root apply persists it in
root-owned, non-writable `installation.json` before any managed-file change.
The root journal and installed config must agree with supplied identity/account/
runtime roots. Conflicts stop; key rotation never mints another identity. A new
profile can be supplied with `--profile`, but changing it requires a separate
approved drain/cutover. This slice's rollout keeps both Macs in `legacy`.

Upgrades that add the maintenance plist require
`--predecessor-manifest-sha256 REVIEWED_SHA256`. Independently review and record
the installed root-owned `managed-files.json` and its exact payloads first.
Only the complete previous target set without the plist, or the older exact set
without both plist and credential writer, is accepted. Unknown targets, changed
payloads and unexpected new files stop the upgrade. Subsequent same-target
updates use the validated root-owned manifest normally. The generated, staged
and installed manifest covers the same seven managed targets, including Tart.
The immutable identity journal is separate installation state.

Root apply takes the existing runner lock nonblocking as the dedicated account,
refuses outstanding safety fences/owned clones, and classifies private job state
using the sealed broker's read-only inventory. It reports stale main-era job IDs
without exposing receipt contents. Classified receipt/input debris can be
recovered by the new broker in an authenticated SSH session before accepting
legacy input, including when the unqualified daemon has left a pending relock.
Unknown or unsafe objects stop installation before it creates any fence.

The guard first reports classification without changing admission. The root
wrapper then authorizes fencing and acknowledges readiness before starting the
transaction. A classification timeout creates no fences; a timeout before start
removes only this invocation's new fences and preserves prior incomplete state.
The guard writes matching random tokens into `cleanup-required` and
`maintenance-blocked` before replacing anything. The transaction inherits its
pipe so loss of the wrapper cannot release `runner.lock` during replacement.
The old daemon is stopped before code changes. The transaction snapshots managed
files and the daemon's system-domain load state using `launchctl print system/<label>`.
It installs the plist last and checks launchd after bootstrap. Failure restores
files and the prior load state; it never loads two maintenance instances. There
are no keychain settings operations in this transaction or its rollback.

Successful readback commits the guard, rotates the epoch and requests bounded
boot inventory. Health can't become ready until inventory finishes. A failed
transaction reports a distinct restored result only if rollback succeeded. The
root wrapper then revalidates the original manifest and payloads before asking
the guard to remove its own token-matched fences. The restored predecessor can
keep building. An incomplete rollback, failed revalidation or interrupted guard
retains `installation-incomplete <token>`. Repair the reported cause and rerun
the approved stage/apply; `--check` reports installation needed even if managed
files already match. Only an exact installer token pair is resumable, and a
resumed incomplete install must finish successful readback before release.

If rollback retained backups, use their reported paths and the reviewed
predecessor manifest for separately approved host repair, then finish the
validated installer. Never delete flags by hand. SSH `reconcile` refuses an
installer fence. Ordinary broker cleanup uses an authenticated restricted SSH
command such as `ssh -i KEY -o UserKnownHostsFile=PINNED_HOSTS partitura-build@HOST
'reconcile JOB32HEX'`; the new broker accepts that command in legacy mode. Use
its reported obligation ID, inspect the returned cleanup result and fresh health,
and repeat for bounded batches if required. Cancellation acknowledgement alone
isn't cleanup evidence. Before upgrading a main-era broker, its existing `cancel
JOB32HEX` remains the recovery command. Actual owned clones and safety fences
must be drained before installation.

The run ends with stable identity/profile, base hash and the host-key line for
the gateway's `known_hosts`. No installer action changes a gateway transport or
its independently verified host-key pins.

The source VM must be a clean Tart VM laid out as `<tart home>/vms/<name>`,
with its tree hash computed by `host_setup.tree_sha256()`. Copy it from an
existing builder rather than downloading a new image when the fleet should
share one qualified source.

### Manual setup

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

Root runs Python only from a root-owned interpreter. Before the first root
command, resolve `xcode-select -p` and the interpreter with `/usr/bin/stat`,
`/usr/bin/find` and `/usr/bin/xcrun --find`, not by running Python. If the
selected Xcode sits under the admin-writable `/Applications`, select the
installed Command Line Tools for those processes only, for example
`sudo -H /usr/bin/env DEVELOPER_DIR=/Library/Developer/CommandLineTools /usr/bin/python3 -I ...`,
after checking that the whole tools tree is root-owned and not group- or
other-writable. This doesn't change the global `xcode-select` choice.
`host_setup.py` passes that selection explicitly to its nested `sudo -u`
helpers, and both it and `native_host.py` refuse to run as root when the
interpreter or its prefix has a non-root or writable ancestor.

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

The pinned source under `deploy/mac-build/broker/` is assembled at staging into a deterministic zipapp. The installer continues to install that single artifact as `/Library/Partitura/NativeBuild/broker.py`, root:wheel 0555, and pins its SHA-256 in the existing managed-files manifest. Operators use the same provisioning commands. There is deliberately no source file at the old `deploy/mac-build/broker.py` path, so nothing can pin or copy an unbuilt broker. The deflated archive was byte-identical on zlib 1.2.12 (macOS 27.2 `/usr/bin/python3`), 1.2.13 and 1.3.1; if a zlib change ever alters it, `host_setup.py` refuses with "pinned source hash differs" before installing anything. Its config is
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
  "keychainPath": "/Users/partitura-build/Library/Keychains/login.keychain-db",
  "keychainCredentialPath": "/Users/partitura-build/.partitura-native-login.password",
  "guestRunnerSha256": "REVIEWED_GUEST_RUNNER_SHA256",
  "qualifierSha256": "REVIEWED_GENERIC_QUALIFIER_SHA256"
}
```

The SSH forced command accepts only these requests with exact arguments and no
shell evaluation:

- `run <job32hex> <commit40hex> <pr> <action> <bundleBytes> [secretBytes]`
- `status <job32hex>`
- `artifact <job32hex>`
- `cancel <job32hex>`

With `secretBytes`, stdin starts with that many bytes of generic file JSON,
followed by the source bundle. Without it, the original protocol is unchanged.
Source arrives as an opaque Git bundle on stdin, bounded to 1 GiB. The host never
extracts or executes repository code. The fixed guest runner validates itself and
the generic base qualifier before importing source. Jobs run for at most 45
minutes. Failed startup receipts identify the stage and boot exit code; private
host boot diagnostics retain at most 64 KiB, remain outside artifacts, and are
removed on success. Artifact archives are bounded to 2 GiB.

One host lock serializes jobs. A persisted `active-vm` fence blocks subsequent
jobs after a crash. Cancellation creates a tombstone even before submission.
Cleanup deletes only that job's clone. Failed cleanup keeps the fence and blocks
new jobs until recovery establishes that the clone is gone. Host power loss
requires recovery after the host returns. The gateway records ownership and
cancels its interrupted jobs during restart recovery.

Before each new job, the host prunes terminal artifact archives older than seven
days and the oldest archives to target at most 6 GiB of retained output before
the next job adds at most 2 GiB. Scans restart at the directory's beginning with
a ten-second budget and no resume cursor. Entries beyond that budget can remain
unvisited indefinitely, so this 8-GiB target isn't guaranteed for large
histories. The sealed free-space floor still gates every build. Failed
jobs remove partial archives immediately. Retained receipts record
`artifactExpired` when pruning removes their archive. Registry-only history has
a separate thirty-day retention policy described below; legacy receipts persist
until registry-only cutover. An already-open artifact transfer can finish after
its archive is unlinked. Pruning holds the job lock and never removes a running
job's output or VM recovery fences.

Failed `run` requests return exit status 1 with a JSON receipt. The gateway
validates its job, commit and action before retaining the allowlisted `stage`,
`bootExitCode` and `failureCode` fields. Transport errors and invalid receipts
remain generic failures. `host-key-unavailable` identifies the known boot-log
signature in Virtualization.framework; it doesn't identify which account
prerequisite is missing. `cleanup-required` takes priority and blocks further
jobs until reconciliation. Raw boot logs stay private. `status` can classify a
retained boot log for an older failed job without changing the stored receipt or
booting a VM. Installing this diagnostic support doesn't repair host security
state.

### Registry protocol, source only

The registry broker code adds the following exact commands. They aren't enabled
on an installed Mac by this PR. Installation and profile changes require
separate host rollout approval. The existing primary/backup gateway continues to
use `run`, `status`, `artifact` and `cancel` with their original response shapes
under the legacy profile. Disk failures use the compatible diagnostics described
above.

```text
health
status <job32hex>
cancel <job32hex>
reconcile <job32hex>
run-v2 <job32hex> <commit40hex> <pr> <action> <bundleBytes> <secretBytes> <epoch32hex> <attempt32hex> <expiresUnixSeconds>
artifact <job32hex>
```

Commands use single ASCII spaces, with no trailing whitespace, shell quoting or
evaluation. The maximum command length is 512 characters. PR numbers are
positive decimal integers of at most eight digits; actions match
`[a-z][a-z0-9-]{0,63}`. Bundle length is 1 through 1 GiB. `secretBytes` is
mandatory in `run-v2`, 0 through 65536, and precedes the bundle on stdin. IDs
and epoch are lowercase hex. Expiry is a positive decimal Unix timestamp in
whole seconds, strictly after the host current time. The gateway sets it at most
120 seconds from command creation; the broker accepts at most 150 seconds ahead
to allow the qualified thirty-second clock skew. It checks expiry after any lock
wait and again before input. Accepted jobs retain their full execution timeout.
Installed qualification must verify clock skew within thirty seconds. Each
gateway job has one attempt ID; neither a repeated job nor an attempt reused for
another job executes again.

The original eleven-key installed configuration remains valid and implies legacy
mode. The extended sealed configuration adds: `hostId`, a canonical lowercase
UUID; `profile`, either `legacy` or `registry-only`; `daemonRelockQualified`, a
boolean defaulting to false during rollout; `daemonRelockMacOSBuild`, the
qualifying build string or an empty string while unqualified; and
`minimumFreeBytes`, an integer from 50 GiB through 2^63-1. The first four fields
must appear together. Existing eleven-key and four-field extended configurations
remain valid and default the disk floor to 50 GiB. Only the sealed configuration
can raise the execution floor. Registry-only mode refuses legacy `run`; legacy
mode refuses `run-v2`. Health and reconciliation require an installed host
identity. Legacy status/cancel shapes remain unchanged even with an identity
installed. This installer emits the extended configuration and installs the
maintenance daemon. Optional `keychainPolicy` is `null` to preserve settings or
the sealed settings object described above; older configurations remain valid.

Registry JSON is a closed, newline-terminated envelope of at most 4096 UTF-8
bytes, including `protocolVersion: 2`, installed `hostId` and a fixed `kind`.
Unknown exceptions produce a fixed `broker-state-unavailable` error, never raw
host exception details. Registry command parse/configuration failures produce a
versioned `error` with code `broker-request-refused`, without a host identity
when configuration could not be loaded. Artifact responses remain opaque bytes.
Main kinds are:

| Kind | Fields and meaning |
| --- | --- |
| `health` | `brokerRevision`, `capabilities`, `profile`, `epoch`, `status`, `accepting`, `capacity`, disk byte counts, cached `keychainPolicy` evidence, fixed `reasons` and `housekeepingSkippedEntries`. The latter contains `artifacts` and `history` counts from each category's last pass, zero before a pass or if diagnostics are unreadable. Status is `ready`, `busy` or `blocked`; capacity is 0 or 1. Busy/blocked health exits zero. |
| `known` | Job identity and receipt fields. State is `receiving`, `running`, `succeeded`, `failed` or `cancelled`. Optional diagnostics and artifact fields are allowlisted. `artifactExpired` is a flag, never a state. |
| `unknown-job` | `job`, `tombstonePresent`, `inconsistentDirectory`. No receipt exists. History may have expired after thirty days; this isn't proof the job never ran. An inconsistent directory requires reconciliation. Invalid/unreadable state returns an error instead. |
| `refused` | `job`, `commit`, `action`, `attempt`, `accepted: false`, fixed `code`. Exit 1. Includes `host-busy`, `stale-epoch`, `submission-expired`, `duplicate-job`, `duplicate-attempt`, `cancelled`, `legacy-profile`, `host-reconciled`, `host-maintenance`, `cleanup-required` or `keychain-relock-pending`. `host-maintenance` means inventory is pending, in backoff or encountered transient IO; it doesn't establish a cleanup fault. |
| `cancellation-requested` | `job`. A durable tombstone acknowledgement, never proof of cleanup. |
| `busy` | Reconcile couldn't acquire the lock within two seconds. `job` and nullable safe `runner` heartbeat/stage evidence. The tombstone remains. |
| `reconciled-terminal`, `reconciled-unknown` | `job`, newly persisted `epoch`, fresh `nonce`, `reconciledJobs`. Exclusive-lock inspection established cleanup. No unknown-job success receipt is fabricated. |
| `cleanup-required`, `keychain-relock-pending` | `job`. Cleanup remains fenced; exit 1. |
| `error` | Fixed `code`. Never treat this as unknown-job or cleanup evidence. |

Health reads atomic runner/fence markers without opening or acquiring
`runner.lock`, pruning artifacts, scanning history or accessing any keychain
API. A fresh matching runner is busy; a heartbeat older than sixty seconds or in
the future is uncertain and blocks admission. A backwards clock step makes a
future maintenance retry due rather than permanently invalidating its marker.
Health distinguishes `keychain-relock-pending`, `cleanup-required`,
`runner-stale`, `maintenance-blocked` and `recovery-incomplete`. A separate
cleanup fence wins over busy. Busy health skips global VM inventory and disk
eligibility checks. Before the current boot/revision inventory completes, idle
health reports `inventory-pending` and never admits work. Thereafter it checks
installed inputs, writable roots, capacity and disk. Disk fields are null while
those measurements are skipped. `maintenanceJobId`, when present, comes from an
existing obligation marker and is a private fleet-admin diagnostic.

`run-v2` waits at most five monotonic seconds for the exclusive lock without
reading stdin. A timeout is identified `host-busy`, with no recovery, receipt or
epoch change. Under the lock it checks epoch, tombstone, expiry and replay
before recovery. Successful pre-input recovery rotates the epoch and returns
`host-reconciled`; the incoming job never continues to receiving. Refusals
record a small terminal receipt where storage and lock ownership permit, except
stale epochs or existing tombstones, which must preserve an unknown recovery
outcome. A valid refusal can still exist without a receipt when disk storage
fails. Inventory backoff prevents another scan, but known obligations can still
be recovered under the lock from this SSH context. A completed inventory stays
complete when the daemon leaves a pending keychain relock.

On a clean host, artifact pruning precedes disk measurement using available-to-
account `statvfs` bytes on the actual job and Tart roots. Each root needs the
sealed `minimumFreeBytes` floor, defaulting to 50 GiB; the job root additionally
needs bundle plus secret input headroom before receiving. Free bytes from shared
APFS storage are never added together. The broker records receiving state and a
runner marker before reading bytes. Both input streams check cancellation at
least once per second, with thirty-second secret and 600-second bundle
deadlines. Closed input and termination use the cleanup path. After transfer, it
checks that same floor again and checks capacity before persisting
unlock-attempt/active-VM fences and accessing any keychain API. Disk failures
report `host-disk-space-unavailable` with `disk-preflight` or
`disk-post-transfer`. Recovery operations remain available below the build
floor. A heartbeat write failure conservatively interrupts both legacy and
registry builds. The runner keeps cleanup fences until VM cleanup and any
required relock/readback complete; loss of heartbeat storage never permits
another build to enter.

Cancel acknowledges a durable tombstone with exit zero even if cleanup fails;
acknowledgement never proves cleanup. Registry cancel only writes/fsyncs its
tombstone. Legacy run can complete post-install inventory and pending daemon relock in its
authenticated SSH session before reading input. A real cleanup-required fence
still needs cancel/reconcile. Legacy cancel can reconcile multiple abandoned jobs under the lock,
retaining their fences on failure. Reconcile takes the exclusive lock, inspects
exact `partitura-job-<job32hex>` clones and bounded private state, removes
abandoned input, terminalizes interrupted receiving/running receipts, and
preserves terminal execution outcomes. It never deletes general/operator VMs.
Reconciliation can also clean other abandoned broker jobs, reported in
`reconciledJobs`. It durably records the whole cleanup set before deleting
anything. If unlock might have happened, success requires keychain lock plus
locked-state readback. That recovery API call runs in an exec helper from the
sealed broker source, with isolated Python, closed inherited descriptors, a new
process session, no SSH stdio and a deadline. The local helper entry point is
refused through the SSH forced-command route. Clone layout validation follows
[pinned Tart 2.41.1
VMDirectory.swift](https://github.com/cirruslabs/tart/blob/2.41.1/Sources/tart/VMDirectory.swift)
and has a source-derived fixture. Actual installed Mac qualification is
separate. Epoch rotation precedes durable fence removal. Failed validation,
deletion, readback or state writes retain the safety fence.

The fixed local invocation is `broker.py local-maintenance`. It is rejected
through `SSH_ORIGINAL_COMMAND` and whenever SSH environment markers are present.
The installer installs `/Library/LaunchDaemons/net.partitura.native-build-maintenance.plist`,
root-owned mode 0644, invoking it as the dedicated build account at boot and
every sixty seconds with a fixed interpreter/script and empty environment.
Its stderr is `/Library/Partitura/NativeBuild/maintenance.stderr.log`, a build-account-owned
0600 file in the root-owned install directory. The installer refuses links,
foreign owners and unsafe modes, and preserves existing diagnostics. Each pass
resets the same inode once it reaches 512 KiB; launchd applies a 1 MiB file-size
limit within a pass. Diagnostics contain exception classes and safe broker or
OS messages, never command argv, credentials or filesystem paths.
Every `tart stop` uses an explicit graceful timeout shorter than its subprocess
budget, reserving ten seconds for forced stop and exit when available and using
`--timeout 0` when no graceful wait fits, as specified by
[Tart 2.41.1 Stop.swift](https://github.com/cirruslabs/tart/blob/2.41.1/Sources/tart/Commands/Stop.swift).
The dedicated account alone receives ClientAliveInterval 15 and
ClientAliveCountMax 3 in its existing Match User block.
The code inventories private receipt/owned-clone directories once per boot or
broker revision. Boot identity uses `kern.bootsessionuuid`; revision is the
sealed broker source SHA-256. There's no entry-count admission limit. Each
inventory scan has a ten-second budget and discovers at most 58 cleanup jobs,
leaving room for existing markers in the 64-job recovery record. Incomplete
inventories retain an admission fence. Explicit reconciliation continues in
bounded cleanup batches when daemon recovery lacks owner evidence.
There is no scan resume cursor. If history alone exceeds the ten-second budget,
retries can revisit the same prefix forever, keeping health `inventory-pending`
and refusing both registry and legacy builds. An approved host-admin archival
procedure or a future resumable scan is required before a host reaches that scale.
The threshold depends on the filesystem and hasn't been qualified on APFS.
Subsequent idle minute passes read markers and return without taking the lock or
scanning history, except when periodic history GC is due. If `run-v2` wins the
boot race, it performs the same inventory under the lock before input. With an
obligation, maintenance tries the lock nonblocking and leaves live owners alone.

New runners persist their PID, UTC process birth time and boot UUID privately in
`runner.json` before receiving input. Maintenance daemon recovery first acquires
the exclusive runner lock. Jobs with a clone, unlock evidence, a running receipt,
a safety fence or a recovery entry require an absent original PID, a different
birth time for that PID, or a different valid boot UUID. A matching process stays
blocked even with a free lock. Birth times have second resolution, so PID reuse
within the same second conservatively looks alive. Missing, malformed or
unreadable owner evidence, including markerless migration debris or additional
jobs with execution resources, leaves VMs untouched and reports
`runner-owner-missing`, `runner-owner-unavailable`, `runner-owner-alive` or
`runner-owner-ambiguous`. Inert directories and partial input without execution
resources are cleaned automatically, even without a marker. Owner-evidence
blocks keep exponential backoff and allow bounded retention of unrelated terminal
history, while all discovered jobs remain protected.
Explicit SSH reconciliation remains the repair route for older jobs. Proven
dead jobs use the same exact-clone validation, Tart stop/delete, interrupted
receipt, partial-input removal, keychain recovery and epoch fencing as manual
reconciliation. No process is signaled by a stored PID.

Authenticated SSH paths, including resubmission, legacy pre-input recovery and
legacy cancellation, retain lock-only reconciliation for older owner-less jobs.
The broker holds this non-inherited lock through the entire build, cleanup and
result emission. A live process can release it only after `run_job` has returned;
it cannot resume VM work, even if its final stdout flush stalls. Retrying residual
cleanup under that lock is safe. The unattended daemon additionally demands
process identity proof before touching execution resources.

Each cleanup pass has a 120-second deadline. Transient IO failures retry with
exponential backoff from sixty seconds to fifteen minutes, including retries of
the first boot inventory. A new boot or broker revision starts inventory without
inheriting an older pass's backoff. Waiting for backoff, operator repair or an
unqualified keychain relock exits normally while health stays blocked. Inventory
IO failures report `inventory-unavailable`; invalid inventory reports
`inventory-invalid`, and budget exhaustion reports `inventory-incomplete`.
Validated malformed, linked, foreign or unsafe inventory objects set
`maintenance-blocked` with a fixed reason and require host-admin repair.
Ordinary IO failures and large history never manufacture that operator-only
flag.

After repairing the unsafe object through an approved host procedure, request
explicit authenticated `reconcile <job>` for the affected obligation. It
revalidates inventory under the exclusive lock and clears `maintenance-blocked`
only after a complete inventory, cleanup, required relock/readback and epoch
rotation. Larger inventories can need several bounded reconciliation rounds;
partial progress retains the inventory/admin fence. Never clear the flag by hand
or interpret cancellation acknowledgement as repair. Design section 8.4's
human-admin reconciliation route will invoke this broker operation in a later
slice; that gateway route isn't implemented here.

Registry-only terminal receipts without retained artifacts or input, tombstones
and attempt markers expire after thirty days. GC validates private state,
protects current obligations and removes at most 64 entries per pass without
rotating the admission epoch. Delayed submissions are already expired because
their admission window is at most 150 seconds, far shorter than retention.
It runs daily, or after a minute while a full batch remains. Artifact pruning
and history GC retain invalid individual entries, log fixed category/count
diagnostics and publish the last pass's skipped-entry counts in health. They
don't set `maintenance-blocked`. Whole-pass IO or validation failures retry with
backoff without invalidating a completed inventory. Health counts only cover
the visited prefix, not the whole directory. Scans are time bounded; skipped
artifacts remain subject to the authoritative free-space check. Legacy commands
have no epoch or expiry, so
legacy receipts, tombstones and attempt identities remain until the approved
registry-only cutover. Removing the lifetime entry cap lets an upgraded legacy
host keep building without reopening old commands to replay.

For jobs older than host retention, the gateway must preserve any terminal
outcome it already knows. A previously unresolved job can become interrupted or
unknown-on-broker only after reconciliation and fresh clean health with the
matching epoch. `unknown-job` or `reconciled-unknown` alone never establishes
success, permission to retry, or that the original command didn't execute.

Daemon relock is unqualified by default. Such a pass can remove VM/input debris
but retains `keychain-relock-pending` and the epoch if unlock might have
happened. A later authenticated SSH reconcile or pre-input legacy/`run-v2` recovery
completes relock/readback. Even a sealed qualification becomes ineffective after
a macOS build change. These fake-only tests don't qualify Security.framework
behavior, cross-session relock, power-loss cleanup, sshd keepalives or a
LaunchDaemon. Host installation and qualification require a separate approved
rollout. Code merge performs neither.
## Acceptance

On recent macOS hosts, creating the dedicated Unix account and installing a
qualified base aren't sufficient to prove VM startup. Virtualization.framework
also needs that account's host security state. A fresh headless account can fail
with `VZErrorDomain Code=-9`, `Failed to get current host key`, and `Failed to
create new HostKey`. Check the dedicated account's default keychain and its
locked state, rather than borrowing the operator's keychain or running jobs as
the operator. An account with no default keychain needs explicit provisioning;
some macOS versions also need an initial desktop login for that account. A
manually created keychain alone isn't proven sufficient. See the upstream
[Tart investigation](https://github.com/openai/tart/issues/1146).

The standalone `bootstrap-host.sh` creates the account and private paths, but
doesn't initialize its keychain or desktop security state. The one-shot
`provision-host.sh` initializes a fresh dedicated keychain; it still can't prove
desktop security state. Treat those as unresolved
host prerequisites until a job boots through the installed restricted SSH route.
Provisioning a keychain or changing account authentication requires separate
operator approval. Preserve public-key-only SSH, the forced command and disabled
forwarding. Keep any host keychain credential outside the guest, gateway and
repository. No project credentials belong in this host keychain.

The installed `credential-writer.py` accepts the dedicated account password
through `/dev/tty` with echo disabled, twice. The human runs it with
`sudo -H -u partitura-build /usr/bin/env DEVELOPER_DIR=/Library/Developer/CommandLineTools /usr/bin/python3 -I /Library/Partitura/NativeBuild/credential-writer.py`
on a host that needs the process-scoped Command Line Tools selection, after the approved password initialization. It refuses an existing destination,
an inherited operator HOME, or a different account. The new file is mode 0600;
the earlier `.partitura-native-keychain.password` is left unused and untouched.
The one-shot installer sets a fresh account password from the saved credential
over a private pseudo-terminal. Standalone host setup/bootstrap doesn't set a
password. No installer logs a user in.

Only `run` reads that credential, after receiving the bundle and acquiring the
runner lock. The broker opens the explicit dedicated login keychain and unlocks
it immediately before cloning. It locks after VM cleanup, including failed jobs,
and crash reconciliation locks before removing the active-VM fence. An unlock
failure returns `unlock-failed` before any clone. A lock failure retains the
recovery fence and returns `cleanup-required`. A killed broker cannot immediately
lock; its durable fence blocks new jobs until reconciliation. Private
`keychain.json` records the pre-unlock state without credential data.

The host admission check counts Tart and Virtualization.framework VM processes
across accounts. More than one existing guest or an unqualified hypervisor stops
the job with `host-capacity-unavailable` before keychain access. Unrelated VM
starts can still race this check; the broker never stops another account's VM.

Adding managed targets to an existing installation requires the exact approved
`predecessor_manifest_sha256` in host settings as described above. Source
settings continue to pin `credential_writer_sha256` and installer bytes; the
root launcher additionally pins the settings-only provision helper.

### Approved host qualification

Perform these steps only with explicit host rollout approval, one Mac at a time.
First deploy slice 1's compatible gateway disk decoder. Quiesce native starts,
drain legacy jobs and reconcile all cleanup obligations. Independently measure
available-to-account space on the actual job and Tart roots after base preparation.
Keep the MacBook disabled if either root is below its sealed floor. Review the
predecessor manifest/payloads and the proposed settings and identity before the
one-shot legacy-profile upgrade. The installer changes root-managed broker,
keys/config/sshd files, identity state and launchd registration;
Remote Login admission remains scoped and never enables the service globally.

Read back the exact managed manifest, effective SSH policy for the build account
and an unrelated operator account, and launchd identity/load state. Preserve
keychain settings on the production legacy rollout. For an explicitly requested
policy, use the first approved broker SSH build's receipt/health readback. Verify both restricted public keys separately during a planned overlap.
Record the installed macOS build from `/usr/bin/sw_vers -buildVersion`. A successful SSH settings readback doesn't qualify daemon relock; never use a
sudo-session keychain check.

On an approved isolated qualification host/account using a dedicated test login
keychain and a fake repository task, exercise the installed broker under real
sshd so it unlocks the test keychain. Interrupt that owned test run after its
unlock marker, then let the installed LaunchDaemon clean VM/input state. In the
daemon's security context, require SecKeychainLock followed by
SecKeychainGetStatus reporting locked. Confirm locked state again through a new,
independent sshd session. Also qualify locked-at-boot, killed-run and power-loss
cleanup. Separately qualify any proposed auto-lock policy with a full workflow
longer than its chosen interval, including artifact collection and cleanup. Read
`preRelockState` and the saved policy values from the approved SSH build receipt.
Do this on an isolated or backup host before primary rollout.
Do not borrow the operator's login keychain or clear fences to force a pass.
Until this evidence exists, retain `daemon_relock_qualified: false`; pending
relock must be completed by authenticated SSH reconciliation. These are host
acceptance procedures, not operations this PR performs or new SSH verbs.

Only after reviewing that evidence approve a second settings update using
`--daemon-relock-qualified --daemon-relock-macos-build BUILD`. That assertion
records qualification, it doesn't run or replace it. A current-build mismatch
makes the broker's effective qualification false and retains the conservative
fallback. `--daemon-relock-unqualified` explicitly revokes the assertion. An OS
upgrade needs fresh qualification and a separately approved settings update.

After approved installation, verify account and SSH restrictions, exact installed
hashes/modes, base provenance and qualification, no host shares, a generic
repository task and artifact receipt, cross-session denial, cancellation and crash
recovery. Then test a consumer repository's workflow separately. A successful
consumer build doesn't prove that host setup works without that consumer's tools.
Keep native acceptance open until the full deployed path passes.

## Simulator artifact admission

The backup install path must call `simulator_artifact.admitted_app` before
acquiring the canonical T3 device lease. This admission module is source
preparation; it isn't installed by the native host installer and doesn't expose
an install command. T3 ownership, signed capabilities, durable replay protection
and the install transport still require their separate integration.

An ONYXIO workflow exports an uncompressed tar with exactly one `.app` tree
under `artifacts/` and `artifacts/partitura-simulator.json`:

```json
{
  "format": 1,
  "app": "ONYXIO.app",
  "organizationId": "the-owning-organization",
  "runId": "the-owning-run",
  "repository": "owner/onyxio",
  "commit": "0123456789012345678901234567890123456789",
  "bundleId": "com.example.onyxio"
}
```

The guest runner also adds `artifacts/result.json` after a successful workflow.
Admission permits that regular file up to 64 KiB. Its contents don't authorize
installation or replace the authenticated build binding and transfer receipt.

The installer compares every binding with authenticated job and capability data,
and checks the complete tar's byte count and SHA-256 against the transfer
receipt. Archive-provided identity alone never authorizes installation. Admission
requires an arm64 simulator slice in every Mach-O image, a compatible minimum OS
in the app and images, valid ad-hoc signatures and a nonempty `main.jsbundle`.
A newer build SDK is allowed when the minimum OS is compatible.

Admission limits are 2 GiB transferred, 4 GiB expanded, 50,000 entries and 512
Mach-O images. Traversal, hardlinks, special files, sparse files, name collisions
on case-insensitive or Unicode-normalizing filesystems, extended metadata and
links outside the app are rejected. Internal relative framework links are
supported. No xattrs or archive ownership are restored. Files stay in a private
staging directory until the caller's leased install ends, then normal exit or
failure removes that staging tree.

Run `python3 -m unittest discover -s test -p simulator_artifact_test.py` for the
focused checks. On macOS, this also compiles and ad-hoc signs a small simulator
app using the selected Xcode SDK, then validates it without launching it or
opening a simulator. Python can use the qualified Command Line Tools selection;
the test compiler uses the global Xcode selection for its iOS SDK.

## Registry mode and deliberate rollback

Legacy primary/backup remains the default. Setting `NATIVE_BUILD_REGISTRY_FILE`
selects the assembled registry engine and never silently falls back to legacy.
Code merge does not authorize cutover. Follow the separately approved
[cutover/import/downgrade/rollback sequence](registry-cutover.md) and its
[unexecuted deployment overlay](registry.compose.example.yaml).
See [the engine and offline import contract](registry-engine.md) for Effect scope
ownership, recovery, credential restoration and resumable imports.
