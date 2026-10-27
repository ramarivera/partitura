# Registry fleet controls

Registry mode assembles the shared fleet service and its browser/per-run adapters.
Legacy mode omits it: authorized fleet requests return `503 fleet-disabled`, refresh
isn't advertised to workers, and both legacy clients keep their original routing.
See [the cutover and rollback runbook](registry-cutover.md) before enabling it.

## Browser administration

Gateway administrators open `/admin/native-builders` from the admin console.
Every endpoint requires the existing browser session, an allowed organization,
and the `GATEWAY_ADMIN_ORGANIZATION_IDS` grant. POST also requires a matching
Origin and CSRF token. There is no bearer alternative or refresh CLI. Responses
are `no-store`; public `/health` still reports reconciler liveness.

- `GET /api/admin/native-builders` returns a sanitized fleet snapshot. It does
  not probe a host or read credentials. It includes removed builders with
  unresolved obligations, draining generations, disk policy, startup state,
  provider budgets/cold-start capacity, scratch accounting and recent human audit
  outcomes. Connection destinations, usernames, source IDs, fingerprints, paths,
  raw provider/SSH errors and tenant execution records aren't returned.
- `POST /api/admin/native-builders/:id/refresh` accepts exactly `{}`. Explicitly
  selected disabled entries are allowed. The all endpoint is
  `POST /api/admin/native-builders/refresh`, also exactly `{}`. All includes enabled
  entries and retained recovery sources, deduplicated by source. The existing
  durable cache owns organization/source limits and non-borrowing budgets.
- `GET /api/admin/native-builders/refreshes/:operationId` shows partial outcomes.
  `pending`, `cached-noop`, successful reads and `needs-refresh` remain distinct.
  Refresh operations survive restart in the provider journal. Health/action
  progress is bounded process-local state; its durable evidence is in metadata.
- `POST /api/admin/native-builders/:id/check-health` accepts exactly `{}` and uses
  cached credentials. It is single-flight per physical host, permits one start
  per host per 15 seconds and at most four concurrent checks, with a 12-second
  deadline. Authentication failures never schedule a credential read.

All bodies are limited to 4 KiB with closed schemas. Mutations return 202 and an
opaque operation ID. Human recovery finishes its bounded round before returning;
its progress is already terminal. Refresh and health checks run in scoped fibers.
The page polls progress for at most two minutes, then leaves the operation ID
visible with a Resume progress link for another bounded polling round.

## Human cleanup decisions

Reconciliation and decommission are browser-only actions with an explicit
confirmation. Neither has an agent tool. Both share the state owner's physical
host recovery lock with automatic original-generation recovery and are limited
to one human action start per host per minute, persisted across restart.

`POST /api/admin/native-builders/:id/reconcile` accepts exactly
`expectedHostId`, `recoveryIds` and `reason`. Select 1–64 opaque obligation IDs and
a reason of 1–256 characters. The authenticated current generation must match
every selected physical host. The gateway sends cancel, reconcile, terminal
status when applicable, and fresh matching-epoch health. The entire round is
limited to 150 seconds. Terminal receipts persist before health. Wrong identity,
unknown live runner, unavailable transport or incomplete cleanup preserves the
hold. Other unselected obligations continue to block admission. Original job
ownership, generation and historical artifact access never change.

Unknown authenticated maintenance markers become private host obligations, with
no invented tenant or execution record. They use the same bounded cleanup path.
Reconciliation also requires each selected job or maintenance obligation to
belong to the endpoint's logical builder. A matching physical host ID doesn't
permit another logical builder's credentials to clear it. Restore a verified
current connection under the original logical ID before reconciling a removed
builder's obligations, or use explicitly approved offline decommission.

`POST /api/admin/native-builders/:id/decommission` additionally requires
`evidenceReference`, 1–512 characters, and `acknowledgeUnverifiedCleanup: true`.
The human must confirm the old installation is powered off, wiped or removed
from service. This can resolve a removed builder's obligations while offline.
It records `abandoned-unverified` and permanently denies that physical host ID.
It makes no claim that a VM was deleted or a keychain locked. A replacement
installation needs a new host ID. Evidence is displayed as text, never fetched.

The private metadata audit records actor session hash and organization, logical
builder/host, selected obligations, reason/evidence, before/after states, outcome
and reconciled epoch. The UI projects recent audit text without actor/tenant/job
lists. Metadata bounds are 512 recent audits and 256 maintenance/retired-host
entries; retired host IDs are never evicted to make room. Capacity exhaustion
refuses the action.

## Assembly and deployment approval

Slice 8 provides one shared registry, state, transport, provider journal and cache
to the fleet service, admin and session authority. Cached admission health skips
reserved hosts and reads no provider items. Legacy startup omits these layers.

Saved generation metadata on main has a source binding but no secret revision.
A retained source absent from desired state uses revision 0 for its explicit
refresh operation. It restores only generations with an exact existing HMAC
match, and never becomes a desired admission credential.

Code merge doesn't authorize production exposure, tool grants, real credential
refresh, human cleanup/decommission, mounts, host profile changes or deployment.
Live 1Password remains disabled pending the approved dummy-vault qualification
from slice 6. No live fleet acceptance is established by the hermetic tests.
