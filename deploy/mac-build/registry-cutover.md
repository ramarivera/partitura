# Registry cutover and rollback

Slice 8 assembles the registry engine. Merging this code does not authorize a
cutover. No rollout, host profile update, import, live provider call or smoke
build was performed for this change. Legacy mode remains the default.

## Static mode and boot

Unset `NATIVE_BUILD_REGISTRY_FILE` selects the original lazy primary/backup clients,
the primary default and their existing tool schemas. No registry mount, native
state lock, provider journal or SDK helper is required in this mode.

Setting that variable selects registry mode for the lifetime of the gateway
process. An invalid, missing or unready registry closes native admission and
reports its error through the admin page. It never falls back to legacy slots.
Complete legacy config pairs may stay configured for rollback, but are not pool
members or fallback candidates. Registry mode advertises its tools even with an
empty pool, so an existing worker can discover a later addition.

The conductor provides one shared state owner, transport, journal/cache, registry,
fleet service and job engine. Native storage opens, validates metadata and rebuilds
scratch accounting before any consumer is constructed. Local recovery interrupts
new-format starting jobs and quarantines ambiguous submitted/imported jobs before
SessionAuthority or HTTP can use them. This is a prerequisite layer rather than a
remote step in `recoverGateway`. Existing SQLite/webhook recovery still finishes
before the server starts. Corrupt native ownership fails startup; it is never
replaced with empty state. Missing/corrupt provider accounting instead disables
provider dispatch and logs `journal-repair-required`, without inventing allowance.
File-provider admission and ordinary Linear ingress can remain available.

Credential resolution and remote recovery run in scoped background fibers. A
sleeping Mac or invalid registry does not hold Linear ingress. Cached admission
health runs every ten seconds, respects health backoff and skips reserved hosts.
It never reads an item. Recovery uses original generations, its finite retry
budget and its one host-return check. Provider startup remains the separate,
bounded two-hour operation. Removed sources needed for recovery are startup inputs.

An explicit builder either admits that builder or fails. An omitted builder uses
only the declared default and ordered pre-admission fallback list. Null default
requires explicit targeting. Selection stops after admission, including bundle
failure, host-busy and ambiguous SSH outcomes. Disable and submitting use the
publication gate: disable first interrupts preparation, while submitting first
drains the immutable generation. Follow-ups use the durable org/session/job binding;
optional builder asserts that original ID, even after removal or default changes.
Ordinary tools expose logical IDs, coarse availability and their own execution
receipts, never fleet destinations, sources, host IDs, disk or health details.

## Approval sequence

Every step below needs separate deployment/host/operation approval. Keep native
starts quiesced through import, profile change and gateway replacement. Unit tests
are code-level acceptance, not evidence that these installed checks have passed.

1. Measure actual roots, usable storage and host disk policy. Leave backup disabled
   unless its real roots pass. Allocate scratch quota below usable capacity by at
   least 2 GiB. Verify rootful Docker without user-namespace remapping, worker UID
   separation, tmpfs confinement, disabled/encrypted swap and disabled core dumps.
2. Deploy the compatible gateway decoder before a broker that emits new disk
   diagnostics. Install and qualify each upgraded broker in its sealed **legacy**
   profile. Verify installed host UUID, independently checked SSH pins and clocks
   within 30 seconds. Registry entries do not provision hosts or accept licenses.
3. Provision stable root-owned directories and separate volumes. Use
   [registry.compose.example.yaml](registry.compose.example.yaml) as an unexecuted
   overlay example. Every state/cache/scratch/record root must be 0700 and disjoint
   from both legacy roots and worker roots. Registry directory is mounted read-only;
   replace its 0600 file through sibling fsync, rename and parent fsync. Never replace
   the mounted directory. Check the expected registry revision from the container;
   an old linked bind mount cannot always detect outside directory replacement.
4. Provision protected 0400 file records, or separately qualify the pinned SDK with
   a dummy vault before enabling live 1Password. `NATIVE_BUILD_OP_QUALIFIED` stays
   false until fixed-ID/base64 roundtrip and request amplification bounds pass.
   Confirm account-wide allocation and complete cold-start capacity, including
   retained recovery sources. Initialize provider accounting explicitly while the
   gateway is stopped using [registry-secrets.md](registry-secrets.md). Never reset
   a journal to fix missing mounts or reclaim allowance.
5. Quiesce all legacy native starts and drain/reconcile both slots. Back up exact
   original slot records, archives, their durable org/session/PR owner snapshot,
   registry metadata and its 0400 `matching.key`. Do not run two owners on one state.
6. Run the offline `importLegacyNativeSlot` interface in
   [native-build-import.ts](native-build-import.ts) with explicit slot root, key
   path, exact independently verified pins or narrow plain known_hosts, installed
   host UUID, hostname, user, port and source. Bind the original owner snapshot to
   the durable run repository. Unknown/mismatched owners refuse import. Do not parse
   SSH config, use `ssh -G`, follow symlinks or import arbitrary files. Original
   stores remain untouched. Failed copies resume their durable `copy-pending`
   checkpoint; missing on-demand archives become explicit `remote-only` records.
   Arrange current/retiring key access for imported generations, or explicitly
   accept that historical remote artifacts may be unavailable after restart.
7. Switch each drained host to the sealed registry-only profile with an epoch
   rotation. Qualify rejection of legacy run. Only then start the gateway with
   registry mode set and its separate state/scratch. Compare imported counts and
   ownership, physical quarantines, host IDs, budget and expected desired revision.
8. Under separate smoke-build approval, verify add/edit/disable/remove on a live
   worker, cache-only health and actual worker UID confinement. Execute one approved
   repository build through status, artifact delivery and cancellation/cleanup.
   Verify fresh same-host epoch/health before treating cleanup as resolved.

## Deliberate rollback

Stop native starts, drain or reconcile registry submissions and preserve unresolved
obligations. Back up registry metadata, matching key, provider journal/installation
marker and scratch independently. Keep imported originals until retention and
rollback requirements expire. Never copy generation records or submitting jobs into
legacy roots, delete safety fences, or share state between gateway versions.

An approved host profile change must fence/drain registry work, rotate epoch and
restore legacy submission support before a legacy gateway accepts new work. Then
unset `NATIVE_BUILD_REGISTRY_FILE`, restore the untouched complete legacy primary
and backup pairs and restart the gateway in legacy mode. Confirm both original
stores load and that each slot still uses its own SSH config and scratch root.
Registry unavailability alone never performs this mode change. Keep registry
mounts/backups until their cleanup receives separate approval.

For a gateway predating slice 1, stop native tools and first use the root-local
`projectLegacyDiskRecord` operation in
[native-build-admin.ts](native-build-admin.ts). It privately backs up exact bytes
and maps only terminal disk diagnostics to the old capacity vocabulary. Preserve
identity, tenant and terminal outcome. Never project unfinished work into terminal
state. Quarantine corrupt/unprojectable records outside legacy scratch and report
all affected IDs. Install an old-emitting broker profile before accepting work on
that older decoder. Registry records are never inputs to this projection.

## Packaged offline import

The root-only `dist/operator/native-build-import-operator.js` command assembles
that library with a read-only gateway database and a protected original-owner
snapshot. It makes no network requests. Stop the gateway first, preserve backups,
and use the same state/scratch/tmpfs roots as the intended gateway.

Run from `/` using the protected image's Bun and a clean launch environment:

```sh
env -i PATH=/usr/bin:/bin /usr/local/bin/bun --config=/dev/null --no-env-file \
  /app/dist/operator/native-build-import-operator.js \
  --config /run/partitura-import/plan.json --gateway-stopped
```

The config and owner snapshot must be root-owned mode 0400 or 0600 under private
0700 directories. Config has closed fields `databasePath`, `ownerSnapshotPath`,
`stateRoot`, `scratchRoot`, `cacheRoot`, `otherRoots`, `bytesPerBuilder`,
`bytesTotal`, `suffix`, and `slots`. Each of the one or two slots has `builderId`,
`legacyRoot`, `privateKeyPath`, and `transport`. Transport is the explicit
`source`, `hostId`, `hostname`, `sshUser`, `port`, and `hostKeys` record used by
the engine. Supply every legacy and worker root in `otherRoots`. No inline key,
SSH config parser or provider token is accepted.

The owner snapshot uses `{ "originalOwners": { "<job-id>": { "sessionId": "...",
"organizationId": "...", "pullRequest": 123 } }, "unresolved": [] }`. Prepare
it while quiesced from durable session bindings and independently verified
repository/PR identity. A worker's claimed PR number alone is not verification.
The command cross-checks current durable session ownership and native-start
activity. Missing or ambiguous PR evidence, changed tenants, unresolved owners,
unsafe database files and active runs refuse migration. The stopped-gateway flag
is an operator acknowledgement; the native state lock cannot stop a separate
legacy gateway from accepting work.

Output contains only imported-job and slot counts. A later-slot failure can leave
earlier imports committed. Preserve state and retry the same inputs; existing
per-job identity, original-byte checks and artifact copy checkpoints make retries
resumable. Originals are never rewritten. Provider journal initialization remains
a separate, approved allocation operation.
