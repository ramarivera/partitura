# Internal registry engine, slice 4

The engine is source-only. Both production legacy slots still use
`createNativeBuildClient`. Registry loading, provider reads, scheduling and
conductor/tool assembly belong to later slices. Never expose the engine's
internal `status` record directly to agent tools. Its host identity, generation,
epoch, attempt and recovery details need a coarse projection before production
wiring: ordinary agents see only a logical builder ID with available or
unavailable, plus their own jobs. Host IDs, source IDs, disk, busy and health
detail, credential paths and other orgs' jobs require gateway-admin authority.

The modules expose Effect 4 services with named methods and layers. Assembly
provides `NativeStateConfig`, `NativeTransportConfig` and `NativeEngineConfig`,
and shares one scope across state, transport and engine. Scope exit interrupts
job fibers, aborts/drains transfer pipelines, reaps process groups, removes tmpfs
credentials and releases the state lock. Manual `close` is available for an
ordered shutdown but isn't required to finalize resources. Descriptor-level IO
and atomic metadata publication live in separate adapters. Short filesystem
commits finish before interruption can release ownership.

`openNativeBuildState` takes exclusive kernel ownership of disjoint private
state, scratch and tmpfs cache roots. Supply every legacy, file-secret and
worker root in `otherRoots`. Keep `matching.key` with metadata backups. Losing
it requires reconciliation, never silently creating a replacement. Independent
gateway instances must never share state or cache. Scratch admission debits
outstanding reservations against free space as well as per-builder and total
quotas. Generation credential leases don't retain unrelated expired jobs.

`createNativeBuildTransport` restores only exact current/retiring-key HMAC
matches against saved public destinations. Restore reports failures per
generation and continues with the others. Concurrent loads share one flight.
A generation is credential-pending until its source restore completes; pending
provider reads must retry according to the two-hour startup policy. A completed
restore with no exact key marks that generation missing. Materialization failures
settle as failed credentials and place recovery in a missing-credentials hold
with a credentials-failed observation; they never poll as pending indefinitely.
Neither pending nor missing credentials can be replaced by the current
generation's destination or key. Keep a generation lease for every published admission candidate. Capacity
pruning disposes credentials for removed generations.

The SSH diagnostic classifier recognizes only tested OpenSSH 9.2p1 diagnostics.
Other versions remain generic transport failures. Qualify the target image
before enabling auth-denial classification in deployment. Transient health and
auth observations preserve an unused host-return check and retain their actual
reason. Ordinary deadline expiry, including gateway downtime, also preserves
that single check. Wrong-host and malformed protocol assertions remain manual.

A terminal receipt is persisted before cleanup IO and never releases quarantine
alone. Every run-v2 outcome except identified host-busy requires cancel tombstone,
fenced reconciliation with epoch rotation, status readback when known, and fresh
matching clean post-reconcile health. Recovery removes obsolete bundles once jobs
resolve. Corrupt cached artifacts can be refetched after consumer leases have
been released.

## Offline import

`importLegacyNativeSlot` takes explicit slot roots, transport scalars, a protected
key path and exact pins or narrow known_hosts. It never parses SSH config,
contacts a host, starts a build or modifies source records.

Legacy records contain neither an organization nor a PR number. Before import,
the operator must quiesce the slot and obtain `originalOwners`, a trusted snapshot
from the original durable run repository keyed by legacy job ID. Each entry binds
session, original organization and verified PR. The separate `resolveOwner`
adapter reads the current durable repository. Import refuses a missing original
binding or any mismatch, including tenant reassignment after quiescence. Neither
input may come from model arguments or claims inside legacy JSON. Unknown
ownership refuses the whole slot and preserves originals for repair. This stays
a library until approved operator assembly can supply both durable inputs.

Import records a binding to source root, original record SHA-256, generation and
owner. Matching retries reuse jobs and attempts without overwriting recovery or
execution state. A failed copy leaves `copy-pending`; retry discards an owned
partial and resumes the copy. If a crash happens after the atomic rename, retry
verifies the final tar and completes the checkpoint. The source remains intact.

Artifact import states are explicit:

- `none`: the receipt contains no artifact.
- `remote-only`: legacy never cached the tar locally. Digest and size remain
  recorded, and retrieval can fetch later through the original generation.
- `copy-pending`: a local source tar needs a completed verified copy.
- `cached`: the imported local tar was copied and verified.

A missing local tar doesn't fail the slot. A present unsafe or mismatched tar
still refuses import. Remote-only retrieval can later report broker expiration
or unavailability; import never claims the artifact bytes were copied.

Only run import after separately approved drain/quiescence, backups,
tmpfs/swap/mount/UID qualification and cutover planning. This slice imported no
production records. Actual host identity, clocks, disk floors, keychain behavior,
OpenSSH diagnostics and native build acceptance still need approved host tests.
