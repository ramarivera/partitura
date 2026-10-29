# Set up a macOS build host

Partitura supports a one-time manual macOS privacy permission step, followed by
automated provisioning and unattended builds. An administrator password alone
doesn't supply that privacy consent. You don't repeat the permission step for
each build.

This guide is for a fresh host. All names, paths and hashes in examples are
placeholders. Keep actual host inventories, credentials, SSH pins, image hashes
and qualification records in private deployment storage, outside this repository.
For an existing installation, use the upgrade and recovery procedures in the
[native build reference](../deploy/mac-build/README.md), rather than recreating
accounts, keychains or bases.

## Prepare the inputs

Before provisioning, arrange:

- An Apple silicon Mac supported by the pinned Tart release, an administrator
  account, and connectivity from the gateway to the Mac.
- Apple Command Line Tools installed at their standard location. The provisioner
  requires their root-owned Python 3.9 or later. Full Xcode and a specific SDK are
  project requirements; prepare them in the guest image when the project needs
  them, and accept applicable Apple licenses through the supported process.
- A clean, reviewed Partitura checkout at the exact commit to install.
- A stopped, trusted macOS Tart source VM, laid out as
  `TART_HOME/vms/SOURCE_NAME`, with its image provenance recorded and licenses
  accepted. Its Tart guest agent must support `tart exec` and non-interactive
  sudo for preparation, with the developer tools required by
  [base preparation](../deploy/mac-build/README.md#manual-setup). Preparation
  creates the unprivileged build guest if absent and refuses an existing
  administrator account with that name.
- A dedicated external APFS build volume with ownership enabled, in a container
  separate from macOS and Time Machine storage. Fresh provisioning requires more
  than 120 GiB free. Also reserve at least 50 GiB on the internal disk. Keep Tart
  paths short enough for its 103-byte control-socket limit.
- The gateway's authorized public SSH key, a securely stored corresponding
  private key, and an independently verified Mac SSH host key.
- A new dedicated build-account password saved in an approved password manager.
  Keep the operator's administrator password separate.

The provisioner downloads and verifies its pinned Tart and portable Mise inputs.
It doesn't depend on an operator toolbox, personal Mise configuration or secret
manager. Generic bases contain common runtimes; each repository selects its
additional tools and credentials.

## Allow remote storage access once

On the Mac, open **System Settings > General > Sharing > Remote Login**.

1. Enable Remote Login and authenticate when macOS asks.
2. Enable **Allow full disk access for remote users**.
3. Prefer **Only these users** and admit the administrator who will provision the
   host. The provisioner admits the dedicated build account only after installing
   its restricted SSH policy. Don't enable access for every user to work around
   an account-admission error.

This grants privacy access to admitted Remote Login sessions. The provisioner
doesn't set that checkbox, alter the privacy database, disable platform security,
or require a GUI login as the build account. See Apple's
[Remote Login instructions](https://support.apple.com/guide/mac-help/allow-a-remote-computer-to-access-your-mac-mchlp1066/mac).

Open a **new SSH session** to the Mac as the administrator after enabling the
setting. Run preflight and provisioning inside that remote session. A successful
external-disk read in a local Terminal with its own permissions doesn't establish
that Remote Login can access the volume.

## Preflight, then provision

The following are Bash examples, run from the clean Partitura checkout inside
the administrator's remote shell on the Mac. Replace the example values with
your private deployment inputs. Use an existing dedicated volume for this path;
creating a volume is a separate storage decision.

```bash
SOURCE_VM=/Volumes/Source/tart/vms/clean-macos
BUILD_TART_HOME=/Volumes/Builds/pnb/tart
GATEWAY_PUBLIC_KEY=/path/to/gateway-build.pub
```

Stop the source VM before hashing it. Compute the source tree hash using the
same helper as the installer, which includes relative paths, modes and contents:

```bash
SOURCE_SHA256=$(/usr/bin/env DEVELOPER_DIR=/Library/Developer/CommandLineTools \
  /usr/bin/python3 -I - "$SOURCE_VM" <<'PY'
from pathlib import Path
import sys
sys.path.insert(0, str(Path("deploy/mac-build").resolve()))
from host_setup import tree_sha256
print(tree_sha256(Path(sys.argv[1])))
PY
)
```

Record and review the resulting hash with the image provenance. Don't hash a
different image merely to satisfy a mismatch. Run the non-privileged preflight:

```bash
bash deploy/mac-build/provision-host.sh \
  --source-vm "$SOURCE_VM" --source-sha256 "$SOURCE_SHA256" \
  --tart-home "$BUILD_TART_HOME" \
  --authorized-key "$(cat "$GATEWAY_PUBLIC_KEY")"
```

Preflight downloads verified inputs and writes private scratch/status files. It
doesn't apply protected host changes. It checks Remote Login storage access
before downloads or protected changes, then checks tools, capacity and source
layout. If it fails, correct the named prerequisite before retrying.

After reviewing the plan, repeat that command with `--apply`. Keep the SSH
session attached to a terminal. Authenticate for sudo, then enter the dedicated
account's new password twice when prompted. Never put passwords in command
arguments, environment variables, shell history or committed files.

Provisioning creates the unprivileged account, prepares and qualifies a clone,
preserves the source VM, initializes missing credentials/keychain, installs the
sealed broker and restricted public-key SSH policy, and verifies readback.
Existing credential/keychain pairs are preserved. A partial failure isn't a
successful install; inspect the reported step and private status file before
rerunning. Don't remove keychains or safety fences to force a rerun through.

For approved unattended password entry, see the stdin-only
[password wrapper](../deploy/mac-build/README.md#one-shot-provisioning). It
automates known password prompts after the same manual privacy prerequisite.

## Connect the gateway and prove a real build

Host provisioning doesn't register a builder or authorize a gateway cutover.

1. Save the printed host identity, installed commit, base hash and profile in
   private deployment records. Verify the host key independently before adding
   it to the gateway's pinned `known_hosts`. Keep strict host-key checking on.
2. Configure the gateway's transport and scoped credentials. For registry mode,
   follow the [registry setup/cutover](../deploy/mac-build/registry-cutover.md)
   and [credential provisioning](../deploy/mac-build/registry-secrets.md) guides.
   A fresh host defaults to the legacy profile; it must match the gateway mode.
   Don't switch an existing installation's profile or identity implicitly.
3. Check the installed broker's `health` through the gateway's configured,
   pinned SSH transport. In registry mode, the authenticated
   [native builders page](../deploy/mac-build/registry-controls.md) can request a
   health check using cached credentials. Require `ready`, `accepting: true`
   and no blocking reasons before submitting new work.
4. Submit an approved repository build **through Partitura**, using a commit
   containing [`.partitura/native-build.sh`](../deploy/mac-build/README.md#repository-contract).
   Verify the real expected output, artifact transfer and integrity, terminal
   status, disposable-VM cleanup and fresh host health. An echo task or installer
   success doesn't prove an application compiles. The first broker-session build
   also proves keychain unlock; daemon relock qualification remains separate.

Unsigned compilation doesn't require installation, launch, distribution signing
or upload. Those are separate project actions and permissions.

## When a check blocks

- **Storage access denied:** check the Remote Login privacy checkbox, reconnect
  over SSH and rerun preflight. Other volume permission or I/O failures need
  their own diagnosis; don't assume every failure is a privacy denial.
- **Host disk space unavailable:** inspect both `jobRootFreeBytes` and
  `tartRootFreeBytes` against `hostFloorBytes`. Either root can block builds.
  Provisioning's external reserve is separate from the runtime floor. Free or
  relocate only reviewed, inactive data; preserve bases and unfinished recovery
  state. Don't lower the floor or add APFS free-space figures together.
- **SSH admission or host-key mismatch:** correct the specific account policy or
  independently verified pin. Don't enable build-account password login,
  forwarding or an unrestricted shell.
- **Busy or cleanup required:** use the documented cancellation/reconciliation
  path and confirm terminal cleanup. Don't delete lock or fence files manually.
- **Toolchain/build failure:** check the repository workflow and qualified guest
  SDK/runtime versions. Changing host privacy permissions doesn't fix a compiler
  or package-manager error.
