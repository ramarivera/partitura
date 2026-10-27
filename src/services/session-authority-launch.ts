import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Clock, Effect, Option, Redacted, Scope } from "effect";
import {
  type DatabaseError,
  McpOAuthError,
  type NixEnvironmentError,
  type RowDecodeError,
  type RpcProtocolError,
  RpcSpawnError,
  type RpcTimeoutError,
  type TokenCipherError,
  type TokenRefreshError,
  type WorkspaceError,
} from "../domain/errors.js";
import type { SessionId, SourceKey } from "../domain/ids.js";
import type { AgentRun, McpServerRecord } from "../domain/models.js";
import type { AgentDriver } from "../drivers/driver.js";
import { makeOmpDriver } from "../drivers/omp/driver.js";
import {
  makeT3Driver,
  remoteT3Endpoint,
  t3DriverOptionsFromConfig,
} from "../drivers/t3/driver.js";
import {
  launchedT3Driver,
  launchT3Daemon,
  renderT3LaunchSettings,
  type T3PortPool,
} from "../drivers/t3/launcher.js";
import { openDriverWorker } from "../drivers/worker-adapter.js";
import {
  applyEffortToT3Selection,
  type EffectiveRunSettings,
} from "./agent-settings.js";
import type { GatewayConfig, T3LaunchConfig } from "./config.js";
import type { LinearIssue } from "./linear-gateway.js";
import { startLinearMcpServer } from "./linear-mcp-server.js";
import { resolveEffectiveMcpServers, writeOmpMcpConfig } from "./mcp-config.js";
import { type McpOAuth, materializeMcpAgentDb } from "./mcp-oauth.js";
import type { RpcWorker, RpcWorkerHandle } from "./rpc-worker.js";
import { resolveDeviationExtensionPath } from "./session-authority-helpers.js";
import type { makeLinearHostToolsForRun } from "./session-authority-host-tools.js";
import type { makeRunSettings } from "./session-authority-settings.js";
import type {
  SessionSandboxHandle,
  SessionSandboxRelay,
} from "./session-sandbox.js";
import type {
  McpServerRepo,
  RunEventRepo,
  RunRepo,
  WorkspaceRepo,
} from "./store/repositories.js";
import type { WorkerIdentityRepo } from "./store/worker-identity-repo.js";
import { startWorkerMcpProxy } from "./worker-mcp-proxy.js";
import {
  seedWorkerProfileFiles,
  validateWorkerProfile,
  workerModelArguments,
  workerModelEnvironment,
} from "./worker-profile.js";
import {
  prepareWorkerWorkspace,
  sessionWorkerEnvironment,
  stopWorkerUidProcessesSync,
  workerEnvironment,
} from "./worker-security.js";
import {
  assertT3GitCredentials,
  removeGitHubExtraHeaders,
} from "./workspace.js";
import { workspaceProcess } from "./workspace-process.js";

const ompApprovalMode = (
  mode: EffectiveRunSettings["runtimeMode"],
): "always-ask" | "write" | "yolo" => {
  switch (mode) {
    case "approval-required":
      return "always-ask";
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
    case "auto":
      return "write";
  }
};

type LaunchFailure =
  | DatabaseError
  | RowDecodeError
  | RpcSpawnError
  | NixEnvironmentError
  | WorkspaceError;
export const makeOpenWorker = ({
  resolveWorkerSettings,
  config,
  workerIdentities,
  sandboxMode,
  applyRepositoryAgeIdentity,
  provisionSandbox,
  applyRepositoryEnvironment,
  linearHostToolsForRun,
  runPromise,
  mcpProxies,
  openSandboxRelay,
  updateRun,
  t3Ports,
  sandboxHandles,
  scope,
  workspaceRepo,
  attachWorker,
  mcpServerRepoOption,
  mcpOAuth,
  runEventRepo,
  rpc,
}: {
  resolveWorkerSettings: ReturnType<typeof makeRunSettings>;
  config: GatewayConfig["Service"];
  workerIdentities: WorkerIdentityRepo["Service"];
  sandboxMode: NonNullable<GatewayConfig["Service"]["workerSandboxMode"]>;
  applyRepositoryAgeIdentity: (
    run: AgentRun,
    cwd: string,
    env: Record<string, string>,
  ) => Effect.Effect<void, RpcSpawnError>;
  provisionSandbox: (
    id: SessionId,
    cwd: string,
    uid: string | undefined,
  ) => Effect.Effect<
    { handle: SessionSandboxHandle; egressProxyUrl: string } | undefined,
    RpcSpawnError
  >;
  applyRepositoryEnvironment: (
    run: AgentRun,
    cwd: string,
    env: Record<string, string>,
    refresh: boolean,
    sandbox: { readonly handle: SessionSandboxHandle } | undefined,
  ) => Effect.Effect<void, LaunchFailure>;
  linearHostToolsForRun: ReturnType<typeof makeLinearHostToolsForRun>;
  runPromise: ReturnType<typeof Effect.runPromiseWith<never>>;
  mcpProxies: Map<SessionId, () => void>;
  openSandboxRelay: (
    id: SessionId,
    target: "gateway" | "worker",
    port: number,
  ) => Effect.Effect<SessionSandboxRelay, RpcSpawnError>;
  updateRun: RunRepo["Service"]["update"];
  t3Ports: (launch: T3LaunchConfig) => T3PortPool;
  sandboxHandles: Map<SessionId, SessionSandboxHandle>;
  scope: Scope.Scope;
  workspaceRepo: WorkspaceRepo["Service"];
  attachWorker: (
    run: AgentRun,
    worker: RpcWorkerHandle,
    cwd: string,
    uid: string | undefined,
  ) => Effect.Effect<
    void,
    | DatabaseError
    | RowDecodeError
    | RpcProtocolError
    | RpcSpawnError
    | RpcTimeoutError
  >;
  mcpServerRepoOption: Option.Option<McpServerRepo["Service"]>;
  mcpOAuth: McpOAuth["Service"];
  runEventRepo: RunEventRepo["Service"];
  rpc: RpcWorker["Service"];
}) => {
  return Effect.fn("SessionAuthority.startWorker")(function* (
    run: AgentRun,
    cwd: string,
    refreshWorkspaceCredentials = false,
    issueSnapshot?: Option.Option<LinearIssue>,
  ): Effect.fn.Return<
    RpcWorkerHandle,
    | DatabaseError
    | RowDecodeError
    | RpcProtocolError
    | RpcSpawnError
    | RpcTimeoutError
    | NixEnvironmentError
    | WorkspaceError
    | TokenCipherError
    | TokenRefreshError
  > {
    if (!existsSync(cwd)) {
      const error = new RpcSpawnError({
        message: `Persisted workspace does not exist: ${cwd}`,
      });
      return yield* Effect.fail(error);
    }
    const { saved, repository, effective } = yield* resolveWorkerSettings(
      run,
      issueSnapshot,
    );
    const kind = effective.driver;
    if (kind === "t3") {
      const t3Config = config.t3Driver;
      if (t3Config === undefined)
        return yield* new RpcSpawnError({
          message:
            "T3 driver is selected but T3_MODE/T3_BASE_URL is not configured",
        });
      const uid = yield* workerIdentities.acquire(
        run.sessionId,
        config.workspaceRoot,
        { retireTerminal: sandboxMode === "native" },
      );
      let driver: AgentDriver;
      if (t3Config.connection._tag === "Remote") {
        // One shared daemon can't reach mode-0700 per-uid workspaces
        // without collapsing session isolation.
        if (uid !== undefined || sandboxMode !== "native")
          return yield* new RpcSpawnError({
            message:
              "A shared T3 daemon cannot serve isolated worker workspaces; set T3_MODE=launch",
          });
        if (
          Option.isSome(repository) &&
          repository.value.nixPackages.length > 0
        )
          return yield* new RpcSpawnError({
            message:
              "Remote T3 cannot receive repository Nix packages; set T3_MODE=launch",
          });
        // Clone credentials can already be present on a newly materialized workspace.
        yield* removeGitHubExtraHeaders(
          cwd,
          run.sessionId,
          config.gitTimeoutMs ?? 120_000,
        );
        yield* assertT3GitCredentials(
          cwd,
          run.sessionId,
          config.gitTimeoutMs ?? 120_000,
        );
        // A shared daemon gets no GitHub, Linear or upstream MCP tokens.
        driver = makeT3Driver({
          ...t3DriverOptionsFromConfig(
            t3Config,
            remoteT3Endpoint(t3Config.connection),
          ),
          modelSelection: applyEffortToT3Selection(
            effective.t3Model === null
              ? t3DriverOptionsFromConfig(
                  t3Config,
                  remoteT3Endpoint(t3Config.connection),
                ).modelSelection
              : {
                  instanceId: effective.t3Model.instanceId,
                  model: effective.t3Model.model,
                  ...(effective.t3Model.options === undefined
                    ? {}
                    : { options: effective.t3Model.options }),
                },
            effective.effort,
          ),
          runtimeMode: effective.runtimeMode,
        });
      } else {
        const launch = t3Config.connection;
        if (config.cliproxyApiBaseUrl === undefined)
          return yield* new RpcSpawnError({
            message: "T3_MODE=launch requires CLIPROXYAPI_BASE_URL",
          });
        yield* Effect.tryPromise({
          try: () => prepareWorkerWorkspace(cwd, uid),
          catch: () =>
            new RpcSpawnError({
              message: "Could not prepare isolated worker workspace",
            }),
        });
        // Always a private HOME: the daemon's state must never be shared.
        const environment = sessionWorkerEnvironment(cwd, process.env);
        yield* applyRepositoryAgeIdentity(run, cwd, environment);
        const sandbox = yield* provisionSandbox(run.sessionId, cwd, uid);
        if (sandbox !== undefined) {
          environment.HTTP_PROXY = sandbox.egressProxyUrl;
          environment.HTTPS_PROXY = sandbox.egressProxyUrl;
          environment.NODE_USE_ENV_PROXY = "1";
          environment.NO_PROXY = [
            "localhost",
            "127.0.0.1",
            "::1",
            sandbox.handle.workerAddress,
            sandbox.handle.gatewayAddress,
            sandbox.handle.relayAddress,
          ].join(",");
        }
        // Same repo-scoped, short-lived Git credential path as OMP workers.
        yield* applyRepositoryEnvironment(
          run,
          cwd,
          environment,
          refreshWorkspaceCredentials,
          sandbox,
        );
        yield* Effect.tryPromise({
          try: () => workspaceProcess(cwd, "tool-directories", null),
          catch: () =>
            new RpcSpawnError({
              message: "Could not prepare worker tool directories",
            }),
        });
        // Inspect as the session uid before any T3 process can read the tree.
        yield* Effect.tryPromise({
          try: () => workspaceProcess(cwd, "check-t3-git", true),
          catch: () =>
            new RpcSpawnError({
              message:
                "T3 refused non-gateway workspace Git credentials or config includes",
            }),
        });
        // The broker retires isolated workers on recovery. A host UID sweep
        // here could kill the VMM and SFTP helper it has just provisioned.
        // Only native daemons need the gateway's process sweep.
        if (uid !== undefined && sandbox === undefined)
          yield* Effect.try({
            try: () => stopWorkerUidProcessesSync(Number(uid)),
            catch: () =>
              new RpcSpawnError({
                message: "Stale T3 processes for this session did not exit",
              }),
          });
        const modelSelection = applyEffortToT3Selection(
          effective.t3Model === null
            ? {
                instanceId: t3Config.providerInstanceId,
                model: t3Config.model,
                ...(t3Config.modelOptions.length === 0
                  ? {}
                  : { options: t3Config.modelOptions }),
              }
            : {
                instanceId: effective.t3Model.instanceId,
                model: effective.t3Model.model,
                ...(effective.t3Model.options === undefined
                  ? {}
                  : { options: effective.t3Model.options }),
              },
          effective.effort,
        );
        const modelEnvironment = workerModelEnvironment({
          cliproxyApiBaseUrl: config.cliproxyApiBaseUrl,
          cliproxyApiKey:
            config.cliproxyApiKey === undefined
              ? undefined
              : Redacted.value(config.cliproxyApiKey),
          claudeExecutable: launch.claudeExecutable,
        });
        const cliproxyApiBaseUrl = config.cliproxyApiBaseUrl;
        const linearTools = linearHostToolsForRun(run, cwd, uid);
        const linearMcp = startLinearMcpServer({
          tools: linearTools.definitions,
          ...(sandbox === undefined
            ? {}
            : { hostname: sandbox.handle.gatewayAddress }),
          call: ({ toolName, arguments: toolArguments }) => {
            const toolCallId = randomUUID();
            return runPromise(
              linearTools.handler({
                id: toolCallId,
                toolCallId,
                toolName,
                arguments: toolArguments,
              }),
            );
          },
        });
        mcpProxies.set(run.sessionId, linearMcp.stop);
        let linearMcpSettings = linearMcp;
        if (sandbox !== undefined) {
          const endpoint = new URL(linearMcp.url);
          const relay = yield* openSandboxRelay(
            run.sessionId,
            "gateway",
            Number(endpoint.port),
          );
          linearMcpSettings = {
            ...linearMcp,
            url: new URL(endpoint.pathname, relay.baseUrl).toString(),
          };
        }
        // Preparation may outlive a lease. Fence again before creating a process.
        yield* updateRun(run.sessionId, {});
        driver = launchedT3Driver(
          launchT3Daemon({
            sessionId: run.sessionId,
            cwd,
            workerUid: uid,
            launch,
            ports: t3Ports(launch),
            environment,
            modelEnvironment: Object.fromEntries(
              Object.entries(modelEnvironment).filter(([name]) =>
                name.startsWith("CLIPROXYAPI_"),
              ),
            ),
            settings: renderT3LaunchSettings({
              cwd: sandbox?.handle.workspace ?? cwd,
              cliproxyApiBaseUrl,
              launch,
              runtimeMode: effective.runtimeMode,
              defaultModel: modelSelection,
              linearMcp: linearMcpSettings,
            }),
            writeSettings: (settings) =>
              workspaceProcess(cwd, "t3-config", settings).then(
                () => undefined,
              ),
            ...(sandbox === undefined ||
            config.sessionSandboxBrokerSocketPath === undefined
              ? {}
              : {
                  sandbox: {
                    brokerSocketPath: config.sessionSandboxBrokerSocketPath,
                    workerAddress: sandbox.handle.workerAddress,
                    createRelay: (port: number) =>
                      openSandboxRelay(run.sessionId, "worker", port),
                  },
                }),
          }),
          (endpoint) => ({
            ...t3DriverOptionsFromConfig(t3Config, endpoint),
            modelSelection: applyEffortToT3Selection(
              effective.t3Model === null
                ? t3DriverOptionsFromConfig(t3Config, endpoint).modelSelection
                : {
                    instanceId: effective.t3Model.instanceId,
                    model: effective.t3Model.model,
                    ...(effective.t3Model.options === undefined
                      ? {}
                      : { options: effective.t3Model.options }),
                  },
              effective.effort,
            ),
            runtimeMode: effective.runtimeMode,
          }),
        );
      }
      const worker = yield* openDriverWorker(driver, {
        sessionKey: run.sessionId,
        title: `Linear ${Option.getOrElse(run.issueId, () => run.sessionId)}`,
        workspace: {
          _tag: "Directory",
          path: sandboxHandles.get(run.sessionId)?.workspace ?? cwd,
        },
        runtimeMode: effective.runtimeMode,
        ...(Option.isSome(saved) ? { resume: { ref: saved.value } } : {}),
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* Effect.gen(function* () {
        yield* workspaceRepo.setDriverSession(
          run.sessionId,
          worker.driverSession.ref,
        );
        // A gateway restart must not leave two turns operating in a workspace.
        if (Option.isSome(saved)) yield* worker.abort();
        yield* attachWorker(run, worker, cwd, uid);
      }).pipe(Effect.onError(() => worker.stop()));
      return worker;
    }
    const command: string[] = [config.ompCliPath];
    if (Option.isSome(run.ompSessionFile)) {
      command.push("--session", run.ompSessionFile.value);
    }

    const deviationExtensionPath = resolveDeviationExtensionPath(sandboxMode);
    if (deviationExtensionPath === null) {
      return yield* Effect.fail(
        new RpcSpawnError({
          message: "Deviation reporting extension is missing",
        }),
      );
    }
    command.push("--extension", deviationExtensionPath);
    for (const extensionPath of config.workerExtensionPaths ?? []) {
      if (!existsSync(extensionPath))
        return yield* Effect.fail(
          new RpcSpawnError({
            message: `Worker extension is missing: ${extensionPath}`,
          }),
        );
      command.push("--extension", extensionPath);
    }
    command.push(
      ...workerModelArguments(
        effective.ompModel ?? undefined,
        Option.isSome(run.ompSessionFile),
      ),
    );
    if (effective.effort !== null) command.push("--thinking", effective.effort);
    command.push("--approval-mode", ompApprovalMode(effective.runtimeMode));

    const workerUid = yield* workerIdentities.acquire(
      run.sessionId,
      config.workspaceRoot,
      { retireTerminal: sandboxMode === "native" },
    );
    yield* Effect.tryPromise({
      try: () => prepareWorkerWorkspace(cwd, workerUid),
      catch: () =>
        new RpcSpawnError({
          message: "Could not prepare isolated worker workspace",
        }),
    });
    const environment =
      workerUid === undefined
        ? workerEnvironment(process.env)
        : sessionWorkerEnvironment(cwd, process.env);
    yield* applyRepositoryAgeIdentity(run, cwd, environment);
    const sandbox = yield* provisionSandbox(run.sessionId, cwd, workerUid);
    if (sandbox !== undefined) {
      environment.HTTP_PROXY = sandbox.egressProxyUrl;
      environment.HTTPS_PROXY = sandbox.egressProxyUrl;
      environment.NODE_USE_ENV_PROXY = "1";
      environment.NO_PROXY = [
        "localhost",
        "127.0.0.1",
        "::1",
        sandbox.handle.workerAddress,
        sandbox.handle.gatewayAddress,
        sandbox.handle.relayAddress,
      ].join(",");
    }
    yield* applyRepositoryEnvironment(
      run,
      cwd,
      environment,
      refreshWorkspaceCredentials,
      sandbox,
    );
    const listMcp: Effect.Effect<
      ReadonlyArray<McpServerRecord>,
      DatabaseError | RowDecodeError | TokenCipherError
    > = Option.isNone(mcpServerRepoOption)
      ? Effect.succeed([])
      : mcpServerRepoOption.value.listMcpServers(run.organizationId);
    const allMcpServers = yield* listMcp.pipe(
      Effect.catchTag("@Gateway/TokenCipherError", (error) =>
        Effect.logWarning("mcp.config.load_failed").pipe(
          Effect.annotateLogs({
            event: "mcp.config.load_failed",
            sessionId: run.sessionId,
            error: error.message,
          }),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
    const effectiveMcpServers = resolveEffectiveMcpServers(
      allMcpServers,
      Option.isSome(run.repositoryId) ? run.repositoryId.value : null,
    );
    const oauthServers = yield* Effect.filter(effectiveMcpServers, (server) =>
      server.transport === "stdio" || Option.isNone(server.url)
        ? Effect.succeed(false)
        : mcpOAuth
            .getCredentialDetails(run.organizationId, server.id)
            .pipe(Effect.map(Option.isSome)),
    );
    let configServers = effectiveMcpServers;
    if (oauthServers.length > 0) {
      const proxy = yield* Effect.try({
        try: () =>
          startWorkerMcpProxy({
            servers: oauthServers,
            ...(sandbox === undefined
              ? {}
              : { bindHost: sandbox.handle.gatewayAddress }),
            allowLoopbackHttp: config.mcpOAuthAllowLoopbackHttp ?? false,
            accessToken: (server, rejectedAccessToken) =>
              runPromise(
                mcpOAuth
                  .mintCredential(run.organizationId, server.id, {
                    ...(rejectedAccessToken === undefined
                      ? {}
                      : { rejectedAccessToken }),
                    serverUrl: Option.getOrThrow(server.url),
                  })
                  .pipe(
                    Effect.flatMap((token) =>
                      Option.isSome(token)
                        ? Effect.succeed(token.value.accessToken)
                        : Effect.fail(
                            new McpOAuthError({
                              message: "MCP credential disconnected",
                              reason: "disconnected",
                            }),
                          ),
                    ),
                  ),
              ),
            refreshFailed: (server) =>
              runPromise(
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis;
                  yield* runEventRepo.upsert({
                    sourceKey:
                      `mcp-refresh:${run.sessionId}:${server.id}` as SourceKey,
                    sessionId: run.sessionId,
                    kind: "mcp_refresh_failed",
                    level: "error",
                    text: `MCP credential renewal failed for ${server.name}. Reconnect this server in the gateway and retry the tool call.`,
                    payload: { serverId: server.id },
                    status: "observed",
                    now,
                  });
                }),
              ),
          }),
        catch: () =>
          new RpcSpawnError({
            message: "Could not start worker MCP proxy",
          }),
      });
      mcpProxies.set(run.sessionId, proxy.stop);
      const relay =
        sandbox === undefined
          ? undefined
          : yield* openSandboxRelay(run.sessionId, "gateway", proxy.port);
      const byId = new Map(
        proxy.servers.map((server) => {
          if (relay === undefined || Option.isNone(server.url))
            return [server.id, server] as const;
          const endpoint = new URL(server.url.value);
          const base = new URL(relay.baseUrl);
          endpoint.hostname = base.hostname;
          endpoint.port = base.port;
          return [
            server.id,
            { ...server, url: Option.some(endpoint.toString()) },
          ] as const;
        }),
      );
      configServers = effectiveMcpServers.map(
        (server) => byId.get(server.id) ?? server,
      );
    }
    if (workerUid)
      yield* Effect.tryPromise({
        try: () => workspaceProcess(cwd, "tool-directories", null),
        catch: () =>
          new RpcSpawnError({
            message: "Could not prepare worker tool directories",
          }),
      });
    const profileDir = config.workerProfileDir;
    if (profileDir !== undefined)
      yield* Effect.tryPromise({
        try: async () => {
          // Validate on every start: the mount can change without a restart.
          const manifest = await validateWorkerProfile(profileDir, {
            cliproxyApiBaseUrl: config.cliproxyApiBaseUrl,
            defaultModel: config.workerDefaultModel,
            maxBytes: config.workerProfileMaxBytes ?? 64 * 1024 * 1024,
            maxEntries: config.workerProfileMaxEntries ?? 10_000,
            requireWorldReadable: workerUid !== undefined,
          });
          return workerUid
            ? workspaceProcess(cwd, "seed-profile", {
                source: profileDir,
                manifest,
              })
            : seedWorkerProfileFiles(cwd, profileDir, manifest);
        },
        catch: (error) =>
          new RpcSpawnError({
            message: `Worker profile seeding failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("worker.profile.seed_failed").pipe(
            Effect.annotateLogs({
              event: "worker.profile.seed_failed",
              sessionId: run.sessionId,
              error: error.message,
            }),
          ),
        ),
      );
    const agentDir = yield* Effect.tryPromise({
      try: () => materializeMcpAgentDb(cwd, []),
      catch: (error) =>
        new RpcSpawnError({
          message: `MCP credential materialization failed: ${String(error)}`,
        }),
    }).pipe(
      Effect.catchTag("@Gateway/RpcSpawnError", (error) =>
        Effect.logWarning("mcp.credentials.materialization_failed").pipe(
          Effect.annotateLogs({
            event: "mcp.credentials.materialization_failed",
            sessionId: run.sessionId,
            error: error.message,
          }),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );
    yield* writeOmpMcpConfig(
      cwd,
      configServers,
      run.sessionId,
      oauthServers.length > 0,
    ).pipe(
      Effect.mapError(
        (error) =>
          new RpcSpawnError({
            message: `MCP config materialization failed: ${error.message}`,
          }),
      ),
      Effect.catchTag("@Gateway/RpcSpawnError", (error) =>
        Effect.logWarning("mcp.config.materialization_failed").pipe(
          Effect.annotateLogs({
            event: "mcp.config.materialization_failed",
            sessionId: run.sessionId,
            error: error.message,
          }),
          Effect.andThen(Effect.fail(error)),
        ),
      ),
    );

    // Preparation may outlive a lease. Fence again before creating a process.
    yield* updateRun(run.sessionId, {});
    const worker = yield* rpc.spawn({
      command,
      ...(workerUid === undefined ? {} : { workerUid }),
      ...(sandbox === undefined ||
      config.sessionSandboxBrokerSocketPath === undefined ||
      workerUid === undefined
        ? {}
        : {
            sandbox: {
              brokerSocketPath: config.sessionSandboxBrokerSocketPath,
              sessionId: run.sessionId,
              workerUid,
            },
          }),
      cwd,
      env: { ...environment, PI_CODING_AGENT_DIR: agentDir },
      injectedEnv: {
        // These proxy values were created by this run's sandbox broker.
        // Inherited gateway proxy settings stay outside workerEnvironment.
        ...(sandbox === undefined
          ? {}
          : {
              HTTP_PROXY: sandbox.egressProxyUrl,
              HTTPS_PROXY: sandbox.egressProxyUrl,
              NODE_USE_ENV_PROXY: "1",
              NO_PROXY: environment.NO_PROXY ?? "",
            }),
        ...workerModelEnvironment({
          cliproxyApiBaseUrl: config.cliproxyApiBaseUrl,
          cliproxyApiKey:
            config.cliproxyApiKey === undefined
              ? undefined
              : Redacted.value(config.cliproxyApiKey),
          claudeExecutable: config.workerClaudeExecutable ?? "claude-cliproxy",
        }),
      },
      sessionId: run.sessionId,
      requestTimeoutMs: config.rpcRequestTimeoutMs ?? 30_000,
    });
    const adapted = yield* openDriverWorker(
      makeOmpDriver(worker),
      {
        sessionKey: run.sessionId,
        title: `Linear ${run.sessionId}`,
        workspace: { _tag: "Directory", path: cwd },
        runtimeMode: effective.runtimeMode,
      },
      worker,
    ).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onError(() => worker.stop()),
    );
    yield* Effect.gen(function* () {
      yield* workspaceRepo.setDriverSession(
        run.sessionId,
        adapted.driverSession.ref,
      );
      yield* attachWorker(run, adapted, cwd, workerUid);
    }).pipe(Effect.onError(() => adapted.stop()));
    return adapted;
  });
};
