# Gateway agent drivers

The authority runs OMP and T3 Code through `AgentDriver`. OMP keeps its existing
allowlisted environment, per-session uid allocation, MCP proxy, inline Linear
host tools, and credential cleanup. The compatibility adapter preserves OMP RPC
extension events while feeding both drivers into the existing lifecycle and
activity projector. T3 event identities remain stable across snapshot replays.

## Select a driver

Repository records have `defaultDriver`, either `omp` or `t3`. Existing rows
migrate to `omp`. The authenticated repository create/update API accepts this
field; omitting it on update preserves the value.

For each new run, the authority reads the repository record and the issue's
current Linear labels. `driver:t3` or `driver:omp` overrides the default. Matching
ignores case and surrounding whitespace. Conflicting overrides warn on the
Linear issue and fall through to organization defaults or the repository's
default driver. No gateway restart is required. A persisted session ref keeps
its driver across retries and follow-up turns; changing labels doesn't migrate
an existing conversation between runtimes.

The authority freezes the run's settings when its first worker starts, after
repository selection. A run waiting for repository selection uses the defaults
and labels available at dispatch. Retries and follow-up turns reuse the frozen
settings, even if an administrator changes the defaults or issue labels.

## Repository routing

Before selecting a repository, the authority fetches the current Linear issue's
team, project, issue labels, and project labels. Agent-session webhooks often
omit those fields. The same issue snapshot supplies driver labels and lifecycle
checks, and the run stores the enriched team and project IDs. If the read fails,
the gateway logs a warning and uses the webhook context.

Routing precedence stays explicit repository ID, issue labels, project labels,
project ID, team ID, then the default repository. Label matching ignores case.

## T3 connection modes

`T3_MODE=launch` is the deployed mode. The gateway starts a private
`t3 serve` for each T3 session and stops it with the session. `T3_MODE=remote`
(or a bare `T3_BASE_URL`) connects every session to one external daemon with
`T3_TOKEN` or `T3_TOKEN_FILE`; the file is reread on connection. A shared
daemon can't reach mode-0700 per-uid workspaces, so remote mode fails closed
when `WORKER_UID_BASE` isolation is active, before any project or thread is
created. Remote mode also rejects repositories with Nix packages and workspaces
with retained Git credentials or config includes, before contacting T3. Launch mode rejects `T3_BASE_URL` and `T3_TOKEN*` so a shared daemon
can't be configured by accident.

Both modes take `T3_PROVIDER_INSTANCE` and `T3_MODEL`. Launch mode accepts only
`claude-cliproxy` or `codex-cliproxy`, the two instances it renders, and needs
`CLIPROXYAPI_BASE_URL` with `CLIPROXYAPI_API_KEY`.

### Per-session launcher (`src/drivers/t3/launcher.ts`)

For a T3 run the authority prepares the workspace exactly as for OMP: it
allocates the session uid, chowns the workspace (mode 0700), prepends the
repository's Nix PATH, and connects the workspace's GitHub remote to a
session-scoped Git broker URL. The broker keeps installation credentials in the
gateway and revokes the URL when the session ends. Then it:

1. Writes `$T3CODE_HOME/userdata/settings.json` and the Codex `config.toml` as
   the worker uid through `src/workspace-worker.ts` (`t3-config`). State lives
   in `<workspace>/.omp-home/t3`, which Git already excludes. Only
   `claude-cliproxy` (binary `claude-cliproxy`) and `codex-cliproxy` (Responses
   provider at `<proxy>/v1`, key from `CLIPROXYAPI_API_KEY`) are enabled. No
   credential is written to either file.
2. In isolated mode, kills any process still running as the session uid, so a
   daemon from an earlier attempt can't hold the T3 state directory.
3. Runs `t3 auth session issue --scope orchestration:read --scope
   orchestration:operate` as the worker uid against that state directory. The
   bearer is valid only for this daemon and stays in gateway memory.
4. Starts `t3 serve --host 127.0.0.1 --port <port> --base-dir <state>
   <workspace>` through the same `setpriv` hardening as OMP workers, in its own
   process group, with the worker env allowlist, `HOME=<workspace>/.omp-home`,
   telemetry off, and `CLIPROXYAPI_BASE_URL`/`CLIPROXYAPI_API_KEY`. The token
   issuance step doesn't get the proxy key.
5. Waits until `/.well-known/t3/environment` answers and every listener on the
   port belongs to the session uid.

Ports come from `T3_PORT_BASE` .. `T3_PORT_BASE + T3_PORT_COUNT - 1` (default
47100, count `WORKER_UID_COUNT`), skipping ports that already have a
listener. T3 0.1.2 binds TCP only (`NodeHttpServer.layer({ host, port })`
in `apps/server/src/server.ts`); there is no Unix-socket option.

Loopback is shared by every uid in the container, so the port isn't the
boundary. Before the bearer leaves the gateway, at launch and on every
reconnect, the launcher reads `/proc/net/tcp` and `/proc/net/tcp6` and requires
that the session uid owns every listener on that port. If another session's
process holds or takes the port, launch fails and no bearer is sent. Isolated
mode refuses to launch when `/proc/net/tcp` can't be read. The daemon prints a
one-time pairing code on startup (12 characters from a 32-symbol alphabet, about
60 bits). The launcher drains stdout/stderr and drops any line mentioning a
token or pairing code from its diagnostics.

Stopping the session (run end, cancellation, failure, gateway shutdown)
detaches the T3 connection without interrupting a remote turn, then terminates the daemon's process group: SIGTERM,
then SIGKILL after 5 s. Releasing a terminal session's uid kills any remaining
process with that uid, as for OMP. A gateway restart starts a new daemon on the
persisted state; the driver reattaches the thread and interrupts its old turn.

Verified against T3 0.1.2 in its own image: two daemons under uids 1001 and
1002, each with a private `HOME` and base dir, ran side by side. Each accepted
its own bearer and rejected the other's with 401, `/proc/net/tcp` reported each
listener under its own uid, and uid 1002 couldn't list uid 1001's state.

Remote endpoints require HTTPS by default, including loopback endpoints. For a
trusted private network only, set `T3_ALLOW_PRIVATE_NETWORK_HTTP=true` to use
HTTP, for example `T3_BASE_URL=http://t3:3773`. HTTP sends the bearer without
transport encryption. This opt-in does not verify the endpoint's network.

### Git and pull requests

Launched T3 agents and OMP workers use a repository-scoped Git HTTP broker.
The workspace holds a revocable session URL, while GitHub App installation
tokens stay in the gateway and refresh through the App service's expiring cache.
Workspace preparation also sets repo-local `user.name` and `user.email` for both
drivers, including reused checkouts. The GitHub App slug comes from `GET /app`;
`GET /users/<slug>[bot]` supplies the bot user ID, which differs from the App ID.
The cached identity is `<slug>[bot]` with
`<bot-user-id>+<slug>[bot]@users.noreply.github.com`. If the bot lookup fails,
the gateway logs a warning and uses `<slug>[bot]@users.noreply.github.com`.
If the App slug itself can't be read, preparation logs a warning and preserves
any existing identity. Git config writes run as the workspace owner and never
change global configuration.

The worker pushes a branch, calls `github_create_pull_request` with its head,
base and title, then includes the PR URL in its final response. The gateway
binds PR creation to the run's repository and links the result to Linear.
The GitHub App
installation needs Contents and Pull requests write access on the repository.
Both modes refuse retained non-gateway Git credentials and config includes
before opening T3. Launch mode checks as the session uid and allows only the
gateway's GitHub extraheader. Remote mode first removes that header and uses
a contract without push instructions. Organization `contract` templates apply
only to OMP; T3 always receives the contract for its connection mode.

`T3_RUNTIME_MODE` defaults to `auto`. The authority answers any approval that
still escalates with `accept` once, inside the session's cancellation mutation
gate. Questions become Linear elicitations and replies return to the originating
request. Multi-question and multi-select forms include their question IDs and
options; reply with a JSON object keyed by ID, with arrays for multi-select
answers. Invalid forms are rejected without sending fabricated answers.
A five-minute lack of progress, a held queue, or exhausted reconnects
interrupts the turn and enters the authority's existing bounded retry policy.
The watchdog pauses for pending user questions. Gateway recovery reattaches the
persisted thread, interrupts any old turn, and sends a continuation attempt.
Historical terminal events don't complete that new attempt. Completion waits for
queued turns before releasing the worker.

## Project provisioning

For a gateway `Directory` workspace, the driver looks up its active project with
`GET /api/projects` before launching the thread. If absent, it submits
`project.create` to `POST /api/projects/mutate`, with a deterministic project id
and command id. It omits `scripts` entirely, because T3 treats any `scripts`
value, even an empty list, as a settings mutation that needs `settings:write`.
It never asks T3 to create the directory.
A concurrent creation or lost mutation response triggers another lookup, so the
existing project is adopted rather than duplicated. `T3_PROJECT_ID` remains
optional for callers that use an existing project root or driver-created worktree.

These shapes were checked against T3 **v0.1.2**, commit **044f0725**, in
[`packages/contracts/src/project.ts`](https://github.com/pingdotgg/t3code/blob/v0.1.2/packages/contracts/src/project.ts),
[`packages/contracts/src/environmentHttp.ts`](https://github.com/pingdotgg/t3code/blob/v0.1.2/packages/contracts/src/environmentHttp.ts),
and [`apps/server/src/project/http.ts`](https://github.com/pingdotgg/t3code/blob/v0.1.2/apps/server/src/project/http.ts).
The API needs only `orchestration:read` and `orchestration:operate` scopes.

## Gaps

- Launched T3 agents receive Linear tools and `github_create_pull_request`
  through a gateway MCP endpoint with a per-session bearer. Git pushes use the
  session's Git broker. These paths require live qualification alongside the
  selected provider and sandbox; a passing contract test alone doesn't prove
  an agent can complete the workflow.
- Organization MCP servers configured for OMP workers aren't rendered into T3
  provider settings yet.
- Native same-uid mode (no `WORKER_UID_BASE`) runs each daemon with a private
  state directory and bearer, but every session shares the gateway uid, so
  it's a development mode, not an isolation boundary.

The in-process T3 tests prove gateway behavior against the pinned contract,
and the launcher tests run a real child process through the lifecycle. They
don't establish the deployed Linear-session-to-PR acceptance target.

The T3 watchdog interrupts a turn after five minutes without progress. While
a tool is running, it allows up to thirty minutes without progress so quiet
dependency installs and builds can finish. Tool completion restores the
five-minute budget. Hung tools still reach the bounded timeout.
## Per-run settings

Each new run resolves its driver, model alias, effort, and runtime mode from
issue labels, project labels, organization settings, then the existing runtime
configuration. The effective values and sources are stored in `run_settings`
before a worker starts, so retries and gateway recovery reuse the same choice.
Organization edits and label changes affect later runs without restarting the
gateway.

The admin console's Run settings panel stores organization-scoped defaults,
label prefixes, and model aliases. An OMP alias names a curated `provider/model`
from the worker profile. A T3 alias names a configured provider instance and
model, with typed option values. Labels only select a configured alias; they
can't supply provider options or credentials. The full-access label toggle is
enabled by default.

OMP 18.8.6 receives `--model` and `--thinking` for the selected model and effort.
Its approval modes map to the CLI's supported `--approval-mode` values:
`approval-required` uses `always-ask`, `auto` and `auto-accept-edits` use
`write`, and `full-access` uses `yolo`. The worker uid and workspace security
boundaries still apply. T3 receives the selected `ModelSelection` and runtime
mode through its normal session start request and, for a launched daemon, its
per-session settings file.

Unknown labels and multiple values for the same setting generate a Linear issue
comment and fall through to the next settings tier. They don't stop the run.

## Optional native build tools

OMP and T3 workers can use `native_build_start`, `native_build_status`,
`native_build_artifact`, and `native_build_cancel` when the gateway has both
`NATIVE_BUILD_SSH_CONFIG_FILE` and `NATIVE_BUILD_SCRATCH_ROOT` configured.
The gateway opens the SSH client on first use. The SSH config and scratch path
stay on the gateway, and job IDs are scoped to the session that started them.
Artifact delivery returns only a path inside that session workspace, its SHA-256,
and byte count. T3 receives the tools through its per-session MCP endpoint.
Host setup and live acceptance requirements are in
`deploy/mac-build/README.md`; source tests don't qualify a live Mac host.

## Optional existing T3 device backup

`T3_DEVICE_BACKUP_CONFIG_JSON` or its `_FILE` alternative enables the
`t3_device_backup` host tool for explicitly configured organizations. Both OMP
and T3 workers receive it through the existing session host-tool bridge.
Configure `baseUrl`, `tokenFile`, `workspaceRoot`, `organizationHosts`,
`instanceId`, and `model`. The URL must use HTTPS or loopback HTTP. Paths must
be absolute and normalized, and the workspace must already exist on the T3
server. Host IDs come from that server's device configuration.

Provision a dedicated T3 bearer with `orchestration:read` and
`orchestration:operate` scopes into the gateway's secret store. Choose its
expiry and rotation policy explicitly. Never reuse a conversation's MCP
credential or send the bearer or operator SSH keys to workers. The gateway
reads the bearer file on every connection. It creates an idle run-owned thread
without an initial message, so device operations don't start model inference.
The provider and model fields identify that idle thread's existing selection.

The tool lists simulators on configured hosts, opens a stopped unclaimed
simulator, reads device details, launches or terminates an installed app, and
closes the run's device. Screenshot and accessibility operations use the existing
authenticated T3 device proxy after checking run ownership. Screenshot results
remain image content through the worker bridge. Inspection bodies have a 512 KiB
streaming limit and a 20-second timeout; redirects are refused. It refuses
physical devices, foreign hosts and other threads' sessions. Cancellation and worker cleanup release the run's sessions,
including ownership recovered from T3 after a gateway restart. Cleanup leaves
a simulator running if another thread has attached to it. Existing T3 device
support and agent consent must already be enabled.

This supplements the disposable VM route for device checks. T3's existing
remote-device bridge provides discovery, streaming and control; it doesn't
provide remote Xcode builds, app transfer or Metro forwarding. This host tool
exposes device lifecycle, installed-app actions, screenshots, accessibility
inspection and input through the same authenticated device proxy. Input supports
normalized taps, named keys and short text. iOS waits for input admission and
screen configuration before sending HID packets; text supports up to 32 ASCII
characters, newline and tab. Android text supports up to 300 UTF-8 bytes. Input
never retries automatically. Its result reports dispatch, not observed UI behavior;
inspect accessibility or a screenshot afterward, including after a failed call,
before deciding whether another action is needed. Build and app transfer aren't
implemented by this tool. Native build acceptance and live backup acceptance
remain separate checks.
