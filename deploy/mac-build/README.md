# Restricted native build transport

This source is not installed or live-qualified. The gateway client and forced
command tests use real local processes with fake SSH/Tart endpoints. They don't
prove a signed archive, simulator run, or Mac deployment.

`broker.py` runs outside checkouts as an SSH forced command for a dedicated
unprivileged build account. It accepts only the following commands, with exact
space-separated arguments and no shell evaluation:

- `run <job32hex> <commit40hex> <pr> <archive|native-smoke> <bundleBytes>`
- `status <job32hex>`
- `artifact <job32hex>`
- `cancel <job32hex>`

Source arrives as a Git bundle on stdin. The host stores at most 1 GiB and never
extracts or executes it. Each job clones a configured sealed macOS Tart base,
without host mounts, graphics, audio, USB, or clipboard. A fixed installed guest
runner executes as `previewrunner`, verifies its own hash and the sealed Onyxio
qualifier, checks out the exact commit, installs dependencies, and invokes one
fixed task. `archive` uses `--preview-signing` and has no upload path.
`native-smoke` runs `mise run smoke:boot:native` inside the guest.

The guest receives only the scoped agent and dedicated preview identities
already required by the Onyxio qualifier. Code in that guest can read its own
scoped identities. The sealed base must exclude operator, release and production
identities. No operator home, keychain, SSH agent, or host directory is shared.

One kernel lock serializes jobs. A persisted `active-vm` fence blocks subsequent
jobs after a crash. Cancellation creates a tombstone even before submission. A
live broker watches that tombstone; if its owner died, a new cancel request takes
the lock and removes only the VM named by that job's fence. Cleanup failure keeps
the fence and blocks later builds. Abrupt host loss still needs recovery after
the host returns. The job command bounds guest execution to 45 minutes.

Artifacts are opaque archives, bounded to 2 GiB. The gateway verifies their size
and SHA-256 before copying bytes through the session uid into its workspace.
It never extracts guest archives or opens workspace destinations as root.
Session ownership is checked for status, artifact access and cancellation.
Gateway restart recovery cancels recorded in-flight jobs before accepting new
requests. Private broker logs and credential values aren't returned to workers.

## Deployment inputs

The gateway needs a root-owned mode 0400 SSH config, selected by
`NATIVE_BUILD_SSH_CONFIG_FILE`, and a private writable scratch directory selected
by `NATIVE_BUILD_SCRATCH_ROOT`. The config defines the fixed `partitura-native`
alias, dedicated identity and pinned `UserKnownHostsFile`. The target and private
key belong in encrypted fnox source. Workers receive neither file. Keep strict
host-key checking and disable agent/port forwarding. Removing that one authorized
public key revokes the transport without changing the operator's keys.

The installed host config is `/Library/Partitura/NativeBuild/config.json`.
All its ancestors, the config, and the signed Tart executable must be root-owned
and not group/other writable. `root` and `tartHome` must be canonical mode 0700
directories owned by the dedicated account. Config has exactly these fields:

```json
{
  "tart": "/Library/Partitura/NativeBuild/tart.app/Contents/MacOS/tart",
  "tartSha256": "REVIEWED_EXECUTABLE_SHA256",
  "base": "onyxio-native-macos-base",
  "root": "/Users/onyxio-build/dev/agentic-scratchpads/partitura/native-build",
  "tartHome": "/Volumes/ExtSSD/partitura-native/tart",
  "guestRunnerSha256": "REVIEWED_GUEST_RUNNER_SHA256",
  "qualifierSha256": "REVIEWED_ONYXIO_QUALIFIER_SHA256"
}
```

Install `broker.py` root:wheel 0555 outside checkouts. Install `guest-run.sh`
as `/Library/Partitura/NativeBuild/run.sh`, root:wheel 0555 **inside the sealed
guest**, then record its SHA-256 in the host config. Provision the exact reviewed
Onyxio qualifier at `/Library/ONYXIO/NativePreview/qualify.sh`, with its sealed
fnox binary/config and independent identities. Refreshing a hash alone doesn't
qualify an old base. Re-run the qualifier before sealing it.

The native task contract inspected here is Onyxio PR 232 at
`d96c82a6e7b0f88d2fb3f3e390564234309c7e33`. Current Onyxio main refuses native PR
signing. Do not change that refusal or route builds through an operator checkout.
The requested commit must contain the reviewed preview-signing consumer before
native archive acceptance can pass.

## Host approval and acceptance

The source alone doesn't grant permission to create a host login or SSH rule.
Activation requires approval for the dedicated `onyxio-build` account, its
root-owned forced-command key configuration, and its isolated Tart storage/base.
Use a managed host deployment. The account must have no admin membership,
password login, shell access through the gateway key, forwarding, or PTY.
Don't add gateway keys to the operator account.

After approval, verify account/group state, effective `sshd -T` match settings,
installed hashes/modes, signed Tart, scoped-key positive/negative checks, and
absence of host shares. Then run an actual archive and simulator smoke through
Partitura. Verify artifact hash/source commit and cleanup, denial of arbitrary
commands, cross-session denial, cancellation while running, and crash recovery.
Keep acceptance open until those live paths pass.

Host and gateway artifact retention/quota still needs deployment qualification.
The module caches one verified artifact per job; repeated retrieval reuses it.
Don't claim unattended disk management from the transfer size limits.
