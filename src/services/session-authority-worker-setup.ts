import { join } from "node:path";
import type { Scope } from "effect";
import { Cause, Effect, Fiber, Option, Queue, Ref } from "effect";
import {
  type DatabaseError,
  type NixEnvironmentError,
  type RowDecodeError,
  type RpcProtocolError,
  RpcSpawnError,
  type RpcTimeoutError,
  type WorkspaceError,
} from "../domain/errors.js";
import type { SessionId } from "../domain/ids.js";
import type { AgentRun } from "../domain/models.js";
import type { NixEnvironment } from "./nix-environment.js";
import type { RpcEvent, RpcWorkerHandle } from "./rpc-worker.js";
import type { makeEventHandler } from "./session-authority-events.js";
import type { makeLinearHostToolsForRun } from "./session-authority-host-tools.js";
import type { makeWorkerLifecycle } from "./session-authority-lifecycle.js";
import type {
  SessionSandboxHandle,
  SessionSandboxRelay,
} from "./session-sandbox.js";
import type { RunRepo, WorkspaceRepo } from "./store/repositories.js";
import type { makeWorkspace } from "./workspace.js";
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

export const makeWorkerSetup = ({
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
}: {
  linearHostToolsForRun: ReturnType<typeof makeLinearHostToolsForRun>;
  withSessionProcessing: <A, E, R>(
    id: SessionId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  handleEvent: ReturnType<typeof makeEventHandler>;
  handleFailure: ReturnType<typeof makeWorkerLifecycle>["handleFailure"];
  failureMessage: <E>(cause: Cause.Cause<E>) => string;
  releaseIfNoWorker: (id: SessionId) => Effect.Effect<void>;
  scope: Scope.Scope;
  workersRef: Ref.Ref<ReadonlyMap<SessionId, WorkerState>>;
  updateRun: RunRepo["Service"]["update"];
  captureWorkerState: ReturnType<
    typeof makeWorkerLifecycle
  >["captureWorkerState"];
  repositoryAgeIdentity: (run: AgentRun) => string | undefined;
  workspaceRepo: WorkspaceRepo["Service"];
  nixEnvironment: NixEnvironment["Service"];
  workspace: Effect.Success<ReturnType<typeof makeWorkspace>>;
  stopGitBroker: (id: SessionId) => void;
  gitBrokers: Map<SessionId, { readonly stop: () => void }>;
  openSandboxRelay: (
    id: SessionId,
    target: "gateway" | "worker",
    port: number,
  ) => Effect.Effect<SessionSandboxRelay, RpcSpawnError>;
}) => {
  const registerLinearHostTools = Effect.fn(
    "SessionAuthority.registerLinearHostTools",
  )(function* (
    run: AgentRun,
    worker: RpcWorkerHandle,
    workspacePath: string,
    workerUid: string | undefined,
  ): Effect.fn.Return<void, RpcProtocolError | RpcTimeoutError> {
    if (
      worker.driverSession?.capabilities.hostTools !== undefined &&
      worker.driverSession.capabilities.hostTools !== "inline"
    )
      return;
    if (
      typeof worker.onHostToolCall !== "function" ||
      typeof worker.setHostTools !== "function"
    ) {
      return;
    }
    const { definitions, handler } = linearHostToolsForRun(
      run,
      workspacePath,
      workerUid,
    );
    yield* worker.onHostToolCall(handler);
    // Host-tool registration is part of the worker contract. A failure
    // must fail startup rather than silently running without Linear tools.
    yield* worker.setHostTools(definitions);
  });

  const attachWorker = Effect.fn("SessionAuthority.attachWorker")(function* (
    run: AgentRun,
    worker: RpcWorkerHandle,
    workspacePath: string,
    workerUid: string | undefined,
  ) {
    const queue = yield* Queue.unbounded<RpcEvent>();

    const unsubscribe = yield* worker.onEvent((event) => {
      Queue.offerUnsafe(queue, event);
    });

    const consumer = yield* Effect.forkIn(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((event) =>
            withSessionProcessing(
              run.sessionId,
              handleEvent(run.sessionId, event).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : handleFailure(run.sessionId, {
                        message: failureMessage(cause),
                      }).pipe(
                        Effect.ensuring(releaseIfNoWorker(run.sessionId)),
                      ),
                ),
              ),
            ),
          ),
        ),
      ),
      scope,
    );

    yield* Ref.update(workersRef, (workers) => {
      const next = new Map(workers);
      next.set(run.sessionId, {
        worker,
        queue,
        consumer,
        unsubscribe,
      });
      return next;
    });

    yield* worker.start();
    yield* registerLinearHostTools(run, worker, workspacePath, workerUid).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          // Registration happens after the worker is started and indexed;
          // tear down that state before propagating the contract failure.
          yield* Fiber.interrupt(consumer);
          yield* unsubscribe();
          yield* worker.stop();
          yield* Ref.update(workersRef, (workers) => {
            const next = new Map(workers);
            next.delete(run.sessionId);
            return next;
          });
          return yield* Effect.fail(error);
        }),
      ),
    );
    yield* updateRun(run.sessionId, { state: "running" });
    yield* captureWorkerState(run.sessionId, worker);

    const ompSessionId = yield* worker.sessionId;
    const ompSessionFile = yield* worker.sessionFile;

    yield* Effect.logInfo("work.ready").pipe(
      Effect.annotateLogs({
        event: "work.ready",
        sessionId: run.sessionId,
        attempt: run.attempt,
        cwd: Option.getOrNull(run.workspacePath),
        ompSessionId: Option.getOrElse(ompSessionId, () => null),
        ompSessionFile: Option.getOrElse(ompSessionFile, () => null),
      }),
    );
  });

  const applyRepositoryAgeIdentity = Effect.fn(
    "SessionAuthority.applyRepositoryAgeIdentity",
  )(function* (
    run: AgentRun,
    cwd: string,
    environment: Record<string, string>,
  ) {
    delete environment.FNOX_AGE_KEY_FILE;
    const identity = repositoryAgeIdentity(run);
    const path = yield* Effect.tryPromise({
      try: () =>
        workspaceProcess(cwd, "age-identity", {
          identity: identity ?? null,
        }),
      catch: () =>
        new RpcSpawnError({
          message: "Could not prepare scoped repository age identity",
        }),
    });
    if (identity !== undefined) {
      environment.FNOX_AGE_KEY_FILE = path;
      environment.HOME = join(cwd, ".omp-home");
    }
  });

  /** Repository Nix PATH and, on resume, a fresh repo-scoped Git credential. */
  const applyRepositoryEnvironment = Effect.fn(
    "SessionAuthority.applyRepositoryEnvironment",
  )(function* (
    run: AgentRun,
    cwd: string,
    environment: Record<string, string>,
    refreshWorkspaceCredentials: boolean,
    sandbox: { readonly handle: SessionSandboxHandle } | undefined,
  ): Effect.fn.Return<
    void,
    | DatabaseError
    | RowDecodeError
    | NixEnvironmentError
    | RpcSpawnError
    | WorkspaceError
  > {
    if (Option.isSome(run.repositoryId)) {
      const repository = yield* workspaceRepo.getRepository(
        run.organizationId,
        run.repositoryId.value,
      );

      if (Option.isSome(repository)) {
        const prepared = yield* nixEnvironment.prepare(repository.value).pipe(
          Effect.tap((result) =>
            Effect.logInfo("nix.environment_prepared").pipe(
              Effect.annotateLogs({
                event: "nix.environment_prepared",
                sessionId: run.sessionId,
                repositoryId: repository.value.id,
                cacheKey: result.cacheKey,
                reused: result.reused,
                pathEntryCount: result.pathEntries.length,
              }),
            ),
          ),
          Effect.catchTag(
            "@Gateway/NixEnvironmentError",
            (error: NixEnvironmentError) =>
              Effect.logWarning("nix.environment_failed").pipe(
                Effect.annotateLogs({
                  event: "nix.environment_failed",
                  sessionId: run.sessionId,
                  repositoryId: repository.value.id,
                  errorTag: error._tag,
                  reason: error.reason,
                }),
                Effect.andThen(Effect.fail(error)),
              ),
          ),
        );

        environment.PATH = [...prepared.pathEntries, environment.PATH ?? ""]
          .filter((entry) => entry.length > 0)
          .join(":");
        if (refreshWorkspaceCredentials) {
          yield* workspace.refreshGitHubExtraHeader(
            run.sessionId,
            repository.value,
            cwd,
          );
        }
        stopGitBroker(run.sessionId);
        const broker = yield* workspace.openGitBroker(
          run.sessionId,
          repository.value,
          sandbox?.handle.gatewayAddress,
        );
        if (broker === undefined) {
          yield* workspace.clearGitBrokerConfig(run.sessionId, cwd);
        } else {
          gitBrokers.set(run.sessionId, broker);
          const relay =
            sandbox === undefined
              ? undefined
              : yield* openSandboxRelay(run.sessionId, "gateway", broker.port);
          yield* workspace.configureGitBroker(
            run.sessionId,
            cwd,
            broker,
            relay?.baseUrl,
          );
        }
      } else {
        stopGitBroker(run.sessionId);
        yield* workspace.clearGitBrokerConfig(run.sessionId, cwd);
      }
    } else {
      stopGitBroker(run.sessionId);
      yield* workspace.clearGitBrokerConfig(run.sessionId, cwd);
    }
  });

  return {
    attachWorker,
    applyRepositoryAgeIdentity,
    applyRepositoryEnvironment,
  };
};
