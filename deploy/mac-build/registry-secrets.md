# Registry credential provider and operator tools

The conductor assembles the isolated provider and operation service in registry
mode only. Legacy mode keeps its original clients and starts no SDK helper.
No fleet item has been read or written to qualify this implementation. See
[the cutover and rollback runbook](registry-cutover.md) before enabling registry mode.

## Qualification and packaging

Live SDK access defaults to disabled. Keep `NATIVE_BUILD_OP_QUALIFIED=false`
until a separately approved dummy-vault qualification proves the fixed field IDs,
base64/newline roundtrip and upper bounds on requests for initialization and whole
item reads. Also confirm the account-wide allocation with its owner. No token or
vault should be provisioned merely to test image packaging.

Both `@1password/sdk` and `@1password/sdk-core` are pinned exactly to `0.5.0`.
Their lockfile integrity values are:

- SDK: `sha512-k6kov3pcA7PRg2tev9CgTfEf/3JSyAp11BPQNCEsqAD32QbqM032OXC1rfjyC8Ba0sfH+NHYZxcifUZToyGyYA==`
- Core: `sha512-9g7LWOKRKdePZ85evVgE9xEom3DAg3hRIyQdOwLPvpL/F7KpDXmUHMi72rsqJxKaDbWApXmrYjDExMSPqUg7xw==`

The existing Node pin is 24.22.1. The Node-target helper externalizes the SDK/core,
which remain in production node_modules with `nodejs/core_bg.wasm`. The final image
build imports the wrapper/core, verifies the WASM file, checks helper syntax and
executes the built helper with EOF, without SDK initialization or credentials.
Bun gateway/operator bundles never import the SDK at runtime.

The published wrapper retries after `DesktopSessionExpiredError`, including
reinitialization. The WASM request amplification hasn't been bounded by an offline
method-count test. Local costs of 8 initialization units and 4 read units are
operation reservations, not a measured hard network-request guarantee. Unknown
amplification blocks live enablement; qualification may require larger cost
reservations within the same account allocation.

## Private helper and operation service

The parent uses only `/opt/partitura/bin/node`, a gateway-owned installation cwd,
an environment allowlist and inherited private pipes. Token files are descriptor
checked, owned by the gateway and mode 0400, with a private 0700 parent directory. The parent rereads the token only for
an already authorized pending operation. Changes aren't refresh triggers. The
helper has one client and serial requests, closed bounded length-prefixed frames,
opaque IDs and discarded stderr. Core dumps are disabled by the entrypoint.
Every initialization/read has a 10-second parent deadline. Timeout or interruption
terminates the group, escalates within 2 seconds and reaps it before reuse.

The cache accepts startup, accepted registry edits and explicit refresh operations.
Builds, health checks and SSH failures don't refill it. Failures keep last good
process credentials. Startup alone retries transient errors, at most 8 attempts
inside its original durable 2-hour window. A terminal/expired source remains held
across restart and operation-history pruning until a successful human refresh or
new registry revision resolves it. Successful startup sources aren't polled.

Operations record acceptance, actual read start, source revision, partial outcome,
last success and next fit. A refresh arriving after a read starts gets one trailing
read, subject to cooldown and budget. Agent unchanged-success refresh is
`cached-noop`, which doesn't change last success or debit provider units.

There are at most 320 distinct queued sources, with only the first 64 runnable,
retained recovery first and then builder ID. Completed operation history is bounded
to 128 records and can be evicted to accept work. Public success/terminal-source
metadata is bounded to 320 bindings; exceeding that fails closed. Assembly calls
`retainNeeded` with the complete enabled plus retained-recovery inventory to prune
retired bindings without changing charges, cooldowns or org limits. It must never
supply only a UI page or desired entries while recovery obligations exist.
Disabled entries with no obligations aren't startup inputs.

Default non-borrowing daily/hourly buckets are bootstrap 160/80, startup retry
80/40, human/registry 120/60, agent 40/20, within shared totals 400/200. Each actual
attempt reserves durably before dispatch; failed/ambiguous attempts aren't refunded.
Reservation also marks the attempt running in that transaction. Disable, removal
or revision changes supersede only work still pending. An already-charged read,
including one whose helper is finishing initialization, proceeds and consumes its
reserved budget. Its obsolete result cannot publish into the desired registry.
This avoids charging an attempt and then cancelling it before the item read.
Failed pending-work supersession is fenced in memory and retried before dispatch.
On restart, persisted non-retained work stays held until a valid registry snapshot
revalidates its builder, source and revision. Invalid or unreadable desired state
cannot dispatch that work. Retained recovery refreshes remain independent.

Agent attempts additionally have 5 source reads per rolling day per org. Explicit
submissions share 10/min/org, and refresh-all is limited globally to once per 5 min.
Source cooldown is 60 seconds; rate limits impose at least 15 minutes globally.
Wall-clock rollback clamps to the persisted high-water time. Three admitted startup
cycles in 15 minutes defer later cycles until 30 minutes after the last one.

Capacity reports independent daily/hourly complete cold starts, subtracts unfinished
bootstrap demand and checks `Cstart(N)=8+4N`, or zero for file-only pools. New desired
pools that can't cover 4/day and 2/hour hold new or changed enabled 1Password
entries with `budget-capacity`. Disables, removals and policy changes still publish;
unchanged serving entries retain their state. Custom total budgets retain bucket proportions.

## Initialize and repair locally

The journal is `<state-root>/provider-journal.json`, mode 0600. Its persistent
installation marker is `<parent-of-state-root>/native-build-provider.initialized`,
outside the native state volume. Keep the parent private and separately persistent.
The journal and engine use the same scoped kernel `owner.lock`. Ordinary startup
requires both journal and marker and never initializes a missing allowance.

With the gateway stopped, a human root operator uses the built tool:

```sh
bun /app/dist/operator/native-build-admin.js budget-initialize \
  --state-root /app/data/native-build-registry \
  --actor '<human identity>' --reason '<allocation decision>' --acknowledge
bun /app/dist/operator/native-build-admin.js budget-repair \
  --state-root /app/data/native-build-registry \
  --actor '<human identity>' --reason '<repair reason>' --acknowledge
```

Use the same `NATIVE_BUILD_OP_DAILY_BUDGET` and `NATIVE_BUILD_OP_HOURLY_BUDGET`
settings as the deployment. Without evidence of unused allocation, initialization
spends every bucket for 24 hours. Initialization alone can take
`--allocation-unused-evidence-file <protected-path>`, a mode 0400/0600 closed JSON
record with `allocationUnused:true`, `accountId`, matching `actor` and `reason`.
The human is responsible for independently establishing that allocation evidence.

Repair preserves the marker, privately archives original journal bytes, retains
readable usage and fills all buckets for 24 hours. It doesn't offer an unauthenticated
backup restore shortcut. Root, the exclusive lock, actor, reason and acknowledgement
are required. Neither command is an agent tool or an HTTP endpoint.

## Operator item procedure

After separate Mac provisioning and independent host-ID/pin verification, an
approved operator runs `/app/dist/operator/builder-secret.js` with `create`, `update`
or `validate`, explicit `--vault-id`, and `--item-id` for update/validate. Supply
`--input-file <protected-file>` for create/update, using the file provider's exact
8-field record format. Keys remain canonical base64 and preserve their original
bytes. No literal key or token argument is accepted.

Disable core dumps with `ulimit -c 0` in the operator shell before running the tool.
Choose exactly one of `--desktop-account <account-name>` or
`--token-file <separate-provisioning-token-file>`. Runtime gateway identity is
read-only and cannot use write commands. The tool stays disabled unless the human
also passes `--qualification-approved`, which requires the separate qualification
and provisioning approval. This flag isn't authorization to use a real vault now.

Create writes explicit SecureNote/section/field IDs. Update gets the item, replaces
fields by ID while preserving version metadata, puts once and reads back. Writes
aren't blindly retried. Validate reads and normalizes without printing fields.
Output is limited to success, fixed errors and the item ID. After an update, use
the future admin Refresh button or bump `secretRevision`; the item tool never
invokes a bearer refresh endpoint or claims an item edit was automatically noticed.

Image deployment, runtime token/vault provisioning, item reads/writes, registry
assembly and cutover all require their separate secret/host/deployment approvals.

On restart, completed refresh receipts contain no credential bytes. Enabled-source
startup resolution or retained-source startup resolution restores the keys through
the budgeted startup path, including a refresh that completed before installation.
Retained startup waits for a valid registry snapshot so it cannot duplicate the
desired source read while the registry is unreadable. Valid snapshots and recovery
obligation changes prune unused success bindings and in-memory snapshots. Pending
operations stay protected, and an unreadable registry suspends pruning. Bounded
operation receipts remain available until the normal operation-history eviction.
