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
- the internal disk has 5 GiB free and Remote Login is on.

Add `--apply` to provision. It creates the build volume and account, prepares and
qualifies the base VM, installs the broker and restricted SSH policy from a
root-owned checkout of the same commit, and admits the account to SSH. If an
existing global `AllowUsers` line would refuse the account, it appends the
account there. It keeps the previous file outside `sshd_config.d`, because that
directory's include would load a backup. It restores the file if `sshd -t`
fails. The credential writer reads the new password; root then sets the account
password from that saved credential over a private pseudo-terminal, so the
secret never appears in a process argument or environment. Last, it creates the
build keychain from that credential. It doesn't test the unlock: on macOS 27 an
unlock run through `sudo -u` from the operator's session fails even when the
keychain is right, while the broker's own SSH session unlocks it. The first
build is the proof, and the broker stops with `unlock-failed` before cloning.
To recreate the keychain after that, delete the `keychain-created` marker the
run printed (`sudo rm <inputs>/keychain-created`) and rerun with `--apply`; it
keeps the old keychain beside the new one. The run ends by printing the base hash and the host
key line for the gateway's `known_hosts`. Every step is skipped when its result
already exists, so a rerun after fixing a reported cause continues where it
stopped.

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
days and the oldest archives needed to leave at most 6 GiB of retained output.
The next job can add at most 2 GiB, bounding retained archives to 8 GiB. Failed
jobs remove partial archives immediately. Receipts stay available for status
queries and record `artifactExpired` when pruning removes their archive. An
already-open artifact transfer can finish after its archive is unlinked. Pruning
holds the job lock and never removes a running job's output or VM recovery fences.

Failed `run` requests return exit status 1 with a JSON receipt. The gateway
validates its job, commit and action before retaining the allowlisted `stage`,
`bootExitCode` and `failureCode` fields. Transport errors and invalid receipts
remain generic failures. `host-key-unavailable` identifies the known boot-log
signature in Virtualization.framework; it doesn't identify which account
prerequisite is missing. `cleanup-required` takes priority and blocks further jobs
until reconciliation. Raw boot logs stay private. `status` can classify a retained
boot log for an older failed job without changing the stored receipt or booting a
VM. Installing this diagnostic support doesn't repair host security state.

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

The bootstrap currently creates the account and private paths, but doesn't
initialize its keychain or desktop security state. Treat those as unresolved
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
Neither the installer nor bootstrap sets a password or logs a user in.

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

Adding the writer to an existing installation requires the exact approved
`predecessor_manifest_sha256` in host settings. The stager checks every old
payload against that frozen manifest. Unknown target sets, changed payloads and
an unexpected writer stop the migration. New installs use an empty predecessor
pin. Source settings also pin `credential_writer_sha256`.

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
