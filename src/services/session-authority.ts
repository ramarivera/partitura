import { randomUUID } from "node:crypto";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  type Queue,
  Ref,
  Schedule,
  type Semaphore,
} from "effect";
import {
  type DatabaseError,
  type InstallationRevokedError,
  type InterruptedRunNoActionableInputError,
  type LinearApiError,
  type NixEnvironmentError,
  type RowDecodeError,
  type RpcProtocolError,
  RpcSpawnError,
  type RpcTimeoutError,
  type RunLeaseError,
  type TokenCipherError,
  type TokenRefreshError,
  type WorkspaceError,
} from "../domain/errors.js";
import type { SessionId } from "../domain/ids.js";
import type { AgentRun } from "../domain/models.js";
import { T3PortPool } from "../drivers/t3/launcher.js";
import { GatewayConfig, type T3LaunchConfig } from "./config.js";
import { GitHubApp } from "./github-app.js";
import { LinearGateway } from "./linear-gateway.js";
import { McpOAuth, removeMcpAgentDb } from "./mcp-oauth.js";
import { NativeBuildFleet } from "./native-build-fleet.js";
import { NixEnvironment } from "./nix-environment.js";
import { ActivityProjector } from "./projector.js";
import type { RpcEvent, RpcWorkerHandle } from "./rpc-worker.js";
import { RpcWorker } from "./rpc-worker.js";
import { makeEventHandler } from "./session-authority-events.js";
import { makeLinearHostToolsForRun } from "./session-authority-host-tools.js";
import { makeOpenWorker } from "./session-authority-launch.js";
import { makeWorkerLifecycle } from "./session-authority-lifecycle.js";
import { makeProcessSession } from "./session-authority-process.js";
import {
  makeMutationGates,
  makeProcessingGate,
} from "./session-authority-processing-gate.js";
import { makeWorkerResources } from "./session-authority-resources.js";
import { makeRepositoryRouting } from "./session-authority-routing.js";
import { makeRunSettings } from "./session-authority-settings.js";
import {
  makePendingStopHandler,
  makeStopDecision,
} from "./session-authority-stops.js";
import { makeWorkerSetup } from "./session-authority-worker-setup.js";
import type {
  SessionSandboxHandle,
  SessionSandboxRelay,
} from "./session-sandbox.js";
import {
  AgentSettingsRepo,
  InstallationRepo,
  McpServerRepo,
  PromptTemplateRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "./store/repositories.js";
import { WorkerIdentityRepo } from "./store/worker-identity-repo.js";
import { makeT3DeviceBackup } from "./t3-device-backup.js";
import { makeWorkspace } from "./workspace.js";
import { workspaceProcess } from "./workspace-process.js";

interface WorkerState {
  readonly worker: RpcWorkerHandle;
  readonly queue: Queue.Queue<RpcEvent>;
  readonly consumer: Fiber.Fiber<
    void,
    DatabaseError | RowDecodeError | RpcProtocolError | RpcTimeoutError
  >;
  readonly unsubscribe: () => Effect.Effect<void, never, never>;
}

const failureMessage = <E>(cause: Cause.Cause<E>): string => {
  const failure = Cause.findErrorOption(cause);
  return Option.isSome(failure) && failure.value instanceof Error
    ? failure.value.message
    : Cause.pretty(cause);
};

export {
  assistantResponseTextFromRpcEvent,
  deviationFromRpcEvent,
  extractPullRequestUrls,
  LINEAR_WORKER_CONTRACT,
  linearWorkerPrompt,
  resolveDeviationExtensionPath,
  workerContractFor,
} from "./session-authority-helpers.js";

type AuthorityError =
  | DatabaseError
  | RowDecodeError
  | RpcProtocolError
  | RpcSpawnError
  | RpcTimeoutError
  | RunLeaseError
  | TokenCipherError
  | TokenRefreshError
  | WorkspaceError
  | LinearApiError
  | InstallationRevokedError
  | InterruptedRunNoActionableInputError
  | NixEnvironmentError;

export class SessionAuthority extends Context.Service<SessionAuthority>()(
  "SessionAuthority",
  {
    make: Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const runtime = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(runtime);
      const mcpProxies = new Map<SessionId, () => void>();
      const sandboxHandles = new Map<SessionId, SessionSandboxHandle>();
      const sandboxRelays = new Map<SessionId, SessionSandboxRelay[]>();
      const gitBrokers = new Map<SessionId, { readonly stop: () => void }>();
      // One pool per gateway: launched T3 daemons never share a port.
      let t3PortPool: T3PortPool | undefined;
      const t3Ports = (launch: T3LaunchConfig): T3PortPool => {
        t3PortPool ??= new T3PortPool(launch.portBase, launch.portCount);
        return t3PortPool;
      };
      const stopMcpProxy = (sessionId: SessionId) => {
        mcpProxies.get(sessionId)?.();
        mcpProxies.delete(sessionId);
      };
      const stopSandboxRelays = (sessionId: SessionId) => {
        for (const relay of sandboxRelays.get(sessionId) ?? []) relay.stop();
        sandboxRelays.delete(sessionId);
      };
      const stopGitBroker = (sessionId: SessionId) => {
        gitBrokers.get(sessionId)?.stop();
        gitBrokers.delete(sessionId);
      };
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const sessionId of sandboxHandles.keys())
            stopSandboxRelays(sessionId);
          for (const sessionId of gitBrokers.keys()) stopGitBroker(sessionId);
          for (const stop of mcpProxies.values()) stop();
          mcpProxies.clear();
        }),
      );
      const runRepo = yield* RunRepo;
      const runInputRepo = yield* RunInputRepo;
      const promptTemplateRepo = yield* PromptTemplateRepo;
      const installationRepo = yield* InstallationRepo;
      const runEventRepo = yield* RunEventRepo;
      const agentSettingsRepo = yield* AgentSettingsRepo;
      const workspaceRepo = yield* WorkspaceRepo;
      const projector = yield* ActivityProjector;
      const rpc = yield* RpcWorker;
      const workerIdentities = yield* WorkerIdentityRepo;
      const nixEnvironment = yield* NixEnvironment;
      const config = yield* GatewayConfig;
      const deviceBackup =
        config.t3DeviceBackup === undefined
          ? undefined
          : makeT3DeviceBackup(config.t3DeviceBackup);
      const sandboxMode = config.workerSandboxMode ?? "firecracker";
      if (
        sandboxMode !== "native" &&
        config.sessionSandboxBrokerSocketPath === undefined
      )
        return yield* new RpcSpawnError({
          message: `${sandboxMode} workers require SESSION_SANDBOX_BROKER_SOCKET; native execution is forbidden`,
        });
      const {
        nativeBuildClients,
        nativeBuildJobs,
        repositoryAgeIdentity,
        getNativeBuildClient,
        openSandboxRelay,
        provisionSandbox,
        destroySandbox,
        cancelSessionNativeBuilds,
      } = makeWorkerResources({
        config,
        sandboxMode,
        sandboxHandles,
        sandboxRelays,
        stopSandboxRelays,
      });
      const mcpOAuth = yield* McpOAuth;
      const linearOption = yield* Effect.serviceOption(LinearGateway);
      const mcpServerRepoOption = yield* Effect.serviceOption(McpServerRepo);

      const stopShouldApply = makeStopDecision(linearOption);

      const owner = `authority:${yield* Effect.sync(() => randomUUID())}`;
      /**
       * Swallow only failures from non-critical cleanup or explicitly
       * best-effort external side effects. State transitions and persistence
       * effects must stay outside this helper so their failures remain typed
       * and visible to the authority caller.
       */
      const bestEffort = <A, E>(
        description: string,
        effect: Effect.Effect<A, E, never>,
      ): Effect.Effect<void, never, never> =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("authority.best_effort_failed").pipe(
              Effect.annotateLogs({
                event: "authority.best_effort_failed",
                description,
                error: String(error),
              }),
            ),
          ),
          Effect.asVoid,
        );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            [...sandboxHandles.keys()],
            (sessionId) =>
              bestEffort(
                `destroy sandbox for ${sessionId} during shutdown`,
                destroySandbox(sessionId),
              ),
            { discard: true, concurrency: "unbounded" },
          );
          yield* Effect.promise(async () => {
            await Promise.all(
              [...nativeBuildClients.values()].map(async (client) => {
                try {
                  await (await client).close();
                } catch {
                  // Shutdown cleanup must not prevent other finalizers.
                }
              }),
            );
          });
        }),
      );

      const updateRun = (
        sessionId: SessionId,
        patch: Parameters<typeof runRepo.update>[1],
      ) => runRepo.update(sessionId, { ...patch, leaseOwner: owner });
      const leasedSessions = yield* Ref.make<ReadonlySet<SessionId>>(new Set());
      const workerSlots = yield* Ref.make<ReadonlySet<SessionId>>(new Set());
      const processingSessions = yield* Ref.make<ReadonlySet<SessionId>>(
        new Set(),
      );
      // Count owners and waiters so idle session gates are released without
      // allowing a second gate to be created while an older waiter still exists.
      const processingGates = yield* Ref.make(
        new Map<SessionId, { semaphore: Semaphore.Semaphore; users: number }>(),
      );
      const withSessionProcessing = makeProcessingGate(processingGates);
      const leaseDurationMs = config.leaseDurationMs;
      const maxAttempts = 5;

      const runUrlForSession =
        config.publicUrl != null
          ? (sessionId: SessionId) =>
              new URL(
                `/runs/${encodeURIComponent(sessionId)}`,
                config.publicUrl,
              ).toString()
          : null;

      const githubAppOption = yield* Effect.serviceOption(GitHubApp);
      const workspace = yield* makeWorkspace({
        workspaceRoot: config.workspaceRoot,
        gitTimeoutMs: config.gitTimeoutMs ?? 120_000,
        repo: workspaceRepo,
        githubApp:
          config.githubAppId !== undefined &&
          config.githubAppPrivateKey !== undefined &&
          Option.isSome(githubAppOption)
            ? githubAppOption.value
            : undefined,
      });
      const clearWorkspaceCredentials = (
        run: AgentRun,
      ): Effect.Effect<void, never, never> =>
        Option.match(run.workspacePath, {
          onNone: () => Effect.void,
          onSome: (path) =>
            Effect.andThen(
              workspace.clearGitHubExtraHeader(run.sessionId, path),
              Effect.andThen(
                removeMcpAgentDb(path),
                Effect.tryPromise({
                  try: () =>
                    workspaceProcess(path, "age-identity", { identity: null }),
                  catch: () =>
                    new RpcSpawnError({
                      message: "Could not remove scoped age identity",
                    }),
                }).pipe(
                  Effect.asVoid,
                  Effect.catch(() =>
                    Effect.logWarning(
                      "worker.age_identity_cleanup_failed",
                    ).pipe(Effect.annotateLogs({ sessionId: run.sessionId })),
                  ),
                ),
              ),
            ),
        });
      const { ensureIssueLifecycle, augmentResolution } = makeRepositoryRouting(
        linearOption,
        workspaceRepo,
        config,
      );

      const workersRef = yield* Ref.make<ReadonlyMap<SessionId, WorkerState>>(
        new Map(),
      );
      const eventSequenceRef = yield* Ref.make<ReadonlyMap<SessionId, number>>(
        new Map(),
      );
      const pendingUiRef = yield* Ref.make<
        ReadonlyMap<SessionId, { readonly id: string; readonly method: string }>
      >(new Map());
      const reportedPullRequestUrlsRef = yield* Ref.make<
        ReadonlyMap<SessionId, ReadonlySet<string>>
      >(new Map());
      const assistantDraftRef = yield* Ref.make<ReadonlyMap<SessionId, string>>(
        new Map(),
      );
      const stopDeferralCountsRef = yield* Ref.make<
        ReadonlyMap<SessionId, ReadonlyMap<string, number>>
      >(new Map());
      // Serializes cancel() with Linear host-tool mutations per session:
      // the desiredState check and the Linear call happen inside the same
      // gate, so a stop landing mid-dispatch is either seen (mutation
      // refused) or blocks until the in-flight mutation completes.
      const sessionMutationGatesRef = yield* Ref.make<
        ReadonlyMap<SessionId, Semaphore.Semaphore>
      >(new Map());
      const {
        withSessionMutationGate,
        withCancelMutationGate,
        releaseMutationGate,
        recordStopDeferral,
        clearSessionStopDeferrals,
      } = makeMutationGates(sessionMutationGatesRef, stopDeferralCountsRef);

      const getWorker = (
        sessionId: SessionId,
      ): Effect.Effect<Option.Option<WorkerState>, never, never> =>
        Ref.get(workersRef).pipe(
          Effect.map((workers) => Option.fromNullishOr(workers.get(sessionId))),
        );

      const releaseIfNoWorker = (
        sessionId: SessionId,
      ): Effect.Effect<void, never, never> =>
        Effect.gen(function* () {
          const workers = yield* Ref.get(workersRef);
          if (!workers.has(sessionId)) {
            yield* bestEffort(
              "release terminal worker uid",
              Effect.gen(function* () {
                const current = yield* runRepo.get(sessionId);
                if (
                  Option.isSome(current) &&
                  ["succeeded", "failed", "canceled"].includes(
                    current.value.state,
                  )
                ) {
                  // The broker checks durable Docker labels even after a gateway
                  // restart. A failed destroy must leave this identity reserved.
                  yield* destroySandbox(sessionId);
                  yield* workerIdentities.release(
                    sessionId,
                    config.workspaceRoot,
                  );
                }
              }),
            );
            yield* Ref.update(workerSlots, (slots) => {
              const next = new Set(slots);
              next.delete(sessionId);
              return next;
            });
            yield* Ref.update(leasedSessions, (sessions) => {
              const next = new Set(sessions);
              next.delete(sessionId);
              return next;
            });
            yield* bestEffort(
              "release lease after authority cleanup",
              runRepo.releaseLease(sessionId, owner),
            );
          }
        });

      const {
        recordRunEvent,
        captureWorkerState,
        finishLocalCommand,
        dropWorker,
        cancel,
        handleFailure,
      } = makeWorkerLifecycle({
        runEventRepo,
        updateRun,
        projector,
        bestEffort,
        deviceBackup,
        runRepo,
        stopMcpProxy,
        stopGitBroker,
        cancelSessionNativeBuilds,
        workersRef,
        destroySandbox,
        withCancelMutationGate,
        owner,
        leaseDurationMs,
        leasedSessions,
        getWorker,
        pendingUiRef,
        clearWorkspaceCredentials,
        releaseMutationGate,
        clearSessionStopDeferrals,
        releaseIfNoWorker,
        maxAttempts,
      });

      const handleEvent = makeEventHandler({
        runRepo,
        owner,
        dropWorker,
        releaseIfNoWorker,
        eventSequenceRef,
        runEventRepo,
        recordRunEvent,
        projector,
        withSessionMutationGate,
        getWorker,
        pendingUiRef,
        updateRun,
        finishLocalCommand,
        captureWorkerState,
        assistantDraftRef,
        linearOption,
        reportedPullRequestUrlsRef,
        bestEffort,
        clearWorkspaceCredentials,
        clearSessionStopDeferrals,
        sessionMutationGatesRef,
      });

      const nativeFleet = yield* Effect.serviceOption(NativeBuildFleet);
      const linearHostToolsForRun = makeLinearHostToolsForRun({
        owner,
        ...(Option.isSome(nativeFleet)
          ? { nativeFleet: nativeFleet.value }
          : {}),
        deviceBackup,
        config,
        withSessionMutationGate,
        runRepo,
        workspaceRepo,
        githubAppOption,
        runPromise,
        getNativeBuildClient,
        repositoryAgeIdentity,
        nativeBuildJobs,
        sandboxHandles,
        linearOption,
        reportedPullRequestUrlsRef,
      });

      const {
        attachWorker,
        applyRepositoryAgeIdentity,
        applyRepositoryEnvironment,
      } = makeWorkerSetup({
        linearHostToolsForRun,
        withSessionProcessing,
        handleEvent,
        handleFailure,
        failureMessage,
        releaseIfNoWorker,
        scope,
        workersRef,
        updateRun,
        captureWorkerState,
        repositoryAgeIdentity,
        workspaceRepo,
        nixEnvironment,
        workspace,
        stopGitBroker,
        gitBrokers,
        openSandboxRelay,
      });

      const resolveWorkerSettings = makeRunSettings({
        workspaceRepo,
        agentSettingsRepo,
        runInputRepo,
        linearOption,
        config,
      });

      const openWorker = makeOpenWorker({
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
      });

      const startWorker = (...args: Parameters<typeof openWorker>) =>
        openWorker(...args).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              stopMcpProxy(args[0].sessionId);
              stopGitBroker(args[0].sessionId);
              stopSandboxRelays(args[0].sessionId);
              yield* bestEffort(
                `destroy failed sandbox for ${args[0].sessionId}`,
                destroySandbox(args[0].sessionId),
              );
            }),
          ),
        );

      const handlePendingStops = makePendingStopHandler({
        runRepo,
        runInputRepo,
        owner,
        leaseDurationMs,
        leasedSessions,
        stopShouldApply,
        recordStopDeferral,
        cancel,
      });

      const processSession = makeProcessSession({
        processingSessions,
        runRepo,
        runInputRepo,
        cancel,
        owner,
        leaseDurationMs,
        leasedSessions,
        handlePendingStops,
        runEventRepo,
        getWorker,
        workerSlots,
        config,
        installationRepo,
        updateRun,
        clearWorkspaceCredentials,
        projector,
        releaseMutationGate,
        clearSessionStopDeferrals,
        maxAttempts,
        ensureIssueLifecycle,
        startWorker,
        promptTemplateRepo,
        finishLocalCommand,
        runUrlForSession,
        linearOption,
        workspace,
        augmentResolution,
        workerIdentities,
        sandboxMode,
        pendingUiRef,
        handleFailure,
        failureMessage,
        releaseIfNoWorker,
        withSessionProcessing,
      });

      const processRunnable = Effect.fn("SessionAuthority.processRunnable")(
        function* (): Effect.fn.Return<void, AuthorityError> {
          yield* projector.flushPending();
          const now = yield* Clock.currentTimeMillis;
          const cancellationPending = yield* runRepo.listCancellationPending();
          const runnable = yield* runRepo.listRunnable(now);
          const sessionsWithInputs =
            yield* runInputRepo.listSessionsWithPendingInputs();
          const sessionIds = new Set<SessionId>([
            ...cancellationPending.map((run) => run.sessionId),
            ...sessionsWithInputs,
            ...runnable.map((r) => r.sessionId),
          ]);
          for (const sessionId of sessionIds) {
            yield* processSession(sessionId).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("authority.session_failed").pipe(
                      Effect.annotateLogs({
                        sessionId,
                        error: Cause.pretty(cause),
                      }),
                    ),
              ),
            );
          }
          yield* projector.flushPending();
        },
      );

      const shutdown = Effect.fn("SessionAuthority.shutdown")(
        function* (): Effect.fn.Return<void, AuthorityError> {
          const workers = yield* Ref.get(workersRef);
          for (const [sessionId, workerState] of workers) {
            yield* Fiber.interrupt(workerState.consumer);
            yield* dropWorker(sessionId);
          }
          for (const sessionId of yield* Ref.get(leasedSessions)) {
            yield* bestEffort(
              "release lease during shutdown",
              runRepo.releaseLease(sessionId, owner),
            );
          }
          yield* Ref.set(leasedSessions, new Set());
          yield* Ref.set(workerSlots, new Set());
          yield* Ref.set(eventSequenceRef, new Map());
          yield* Ref.set(pendingUiRef, new Map());
          yield* Ref.set(reportedPullRequestUrlsRef, new Map());
          yield* Ref.set(stopDeferralCountsRef, new Map());
          yield* Ref.set(sessionMutationGatesRef, new Map());
          // Shutdown intentionally does not remove mcp.json: it has no run
          // or workspace context, so terminal-path cleanup owns deletion.
          yield* projector.flushPending();
        },
      );

      const renewLeases = Effect.gen(function* () {
        for (const sessionId of yield* Ref.get(leasedSessions)) {
          yield* runRepo.renewLease(sessionId, owner, leaseDurationMs).pipe(
            Effect.flatMap((renewed) =>
              renewed
                ? Effect.void
                : Effect.forkIn(
                    withSessionProcessing(
                      sessionId,
                      dropWorker(sessionId).pipe(
                        Effect.ensuring(releaseIfNoWorker(sessionId)),
                      ),
                    ),
                    scope,
                  ).pipe(Effect.asVoid),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("authority.lease_renewal_failed").pipe(
                Effect.annotateLogs({ sessionId, error: Cause.pretty(cause) }),
              ),
            ),
          );
        }
      });
      yield* Effect.addFinalizer(() =>
        shutdown().pipe(
          Effect.catchCause((cause) =>
            Effect.logError("authority.shutdown_failed").pipe(
              Effect.annotateLogs({ error: Cause.pretty(cause) }),
            ),
          ),
        ),
      );
      yield* Effect.forkScoped(
        Effect.repeat(
          renewLeases,
          Schedule.spaced(Math.max(1, Math.floor(leaseDurationMs / 3))),
        ),
      );

      const activeWorkerCount = Effect.fn("SessionAuthority.activeWorkerCount")(
        function* (): Effect.fn.Return<number, never> {
          const workers = yield* Ref.get(workersRef);
          return workers.size;
        },
      );

      return {
        processRunnable,
        processSession,
        shutdown,
        activeWorkerCount,
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide([
      ActivityProjector.layer,
      InstallationRepo.layer,
      McpServerRepo.layer,
      McpOAuth.layer,
      PromptTemplateRepo.layer,
      RunEventRepo.layer,
      RunInputRepo.layer,
      RunRepo.layer,
      LinearGateway.layer,
      WorkspaceRepo.layer,
      AgentSettingsRepo.layer,
      GatewayConfig.layer,
      GitHubApp.layer,
      RpcWorker.layer,
      WorkerIdentityRepo.layer,
      NixEnvironment.layer,
    ]),
  );
}
