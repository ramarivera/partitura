import { createHash } from "node:crypto";
import { Clock, Effect, type Fiber, Option, Queue, Ref } from "effect";
import type {
  DatabaseError,
  RowDecodeError,
  RpcProtocolError,
  RpcSpawnError,
  RpcTimeoutError,
} from "../domain/errors.js";
import type { SessionId, SourceKey } from "../domain/ids.js";
import type { AgentRun } from "../domain/models.js";
import { removeMcpConfig } from "./mcp-config.js";
import type { ActivityProjector } from "./projector.js";
import type { RpcEvent, RpcWorkerHandle } from "./rpc-worker.js";
import {
  failureCorrelationId,
  isString,
  jsonValue,
  planItems,
} from "./session-authority-helpers.js";
import type { RunEventRepo, RunRepo } from "./store/repositories.js";
import type { makeT3DeviceBackup } from "./t3-device-backup.js";

interface WorkerState {
  readonly worker: RpcWorkerHandle;
  readonly queue: Queue.Queue<RpcEvent>;
  readonly consumer: Fiber.Fiber<
    void,
    DatabaseError | RowDecodeError | RpcProtocolError | RpcTimeoutError
  >;
  readonly unsubscribe: () => Effect.Effect<void, never, never>;
}

export const makeWorkerLifecycle = ({
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
}: {
  runEventRepo: RunEventRepo["Service"];
  updateRun: RunRepo["Service"]["update"];
  projector: ActivityProjector["Service"];
  bestEffort: <A, E>(
    description: string,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<void>;
  deviceBackup: ReturnType<typeof makeT3DeviceBackup> | undefined;
  runRepo: RunRepo["Service"];
  stopMcpProxy: (id: SessionId) => void;
  stopGitBroker: (id: SessionId) => void;
  cancelSessionNativeBuilds: (id: SessionId) => Effect.Effect<void>;
  workersRef: Ref.Ref<ReadonlyMap<SessionId, WorkerState>>;
  destroySandbox: (id: SessionId) => Effect.Effect<void, RpcSpawnError>;
  withCancelMutationGate: <A, E, R>(
    id: SessionId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  owner: string;
  leaseDurationMs: number;
  leasedSessions: Ref.Ref<ReadonlySet<SessionId>>;
  getWorker: (id: SessionId) => Effect.Effect<Option.Option<WorkerState>>;
  pendingUiRef: Ref.Ref<
    ReadonlyMap<SessionId, { readonly id: string; readonly method: string }>
  >;
  clearWorkspaceCredentials: (run: AgentRun) => Effect.Effect<void>;
  releaseMutationGate: (id: SessionId) => Effect.Effect<void>;
  clearSessionStopDeferrals: (id: SessionId) => Effect.Effect<void>;
  releaseIfNoWorker: (id: SessionId) => Effect.Effect<void>;
  maxAttempts: number;
}) => {
  const recordRunEvent = Effect.fn("SessionAuthority.recordRunEvent")(
    function* (
      sessionId: SessionId,
      sequence: number,
      event: RpcEvent,
    ): Effect.fn.Return<void, DatabaseError> {
      const type = event.type;
      let sourceKey =
        typeof event.driverEventKey === "string"
          ? event.driverEventKey
          : `rpc:${sessionId}:${sequence}:${type}`;
      let kind = type;
      let level: "debug" | "info" | "warn" | "result" | "error" = "info";
      let text: string | null = type;

      switch (type) {
        case "agent_start":
          kind = "agent";
          text = "Partitura agent started";
          level = "info";
          break;
        case "turn_start":
          kind = "turn";
          text = "Partitura agent turn started";
          level = "info";
          break;
        case "turn_end":
          kind = "turn";
          text = "Partitura agent turn ended";
          level = "info";
          break;
        case "agent_end":
          kind = "agent";
          text =
            event.willContinue === true
              ? "Partitura agent turn ended (will continue)"
              : "Partitura agent ended";
          level = "result";
          break;
        case "tool_execution_start":
          kind = "tool";
          text = `Tool started: ${jsonValue(event.toolName ?? event.tool)}`;
          level = "info";
          break;
        case "tool_execution_end":
          kind = "tool";
          text = `Tool completed: ${jsonValue(event.toolName ?? event.tool)}`;
          level = event.error ? "error" : "result";
          break;
        case "message_end":
          kind = "message";
          text = "Partitura message ended";
          level = "info";
          break;
        case "prompt_result":
          kind = "prompt";
          text =
            event.agentInvoked === false
              ? "Partitura command completed without agent"
              : "Partitura prompt result";
          level = event.agentInvoked === false ? "result" : "info";
          break;
        case "extension_ui_request": {
          if (typeof event.id === "string") {
            sourceKey = `rpc-ui:${event.id}`;
          }
          const title =
            typeof event.title === "string" ? event.title : "Input required";
          const message =
            typeof event.message === "string" ? event.message : "";
          text = [title, message].filter(Boolean).join("\n\n");
          level = "warn";
          break;
        }
        case "error":
          text =
            typeof event.message === "string"
              ? event.message
              : "Partitura worker failed";
          break;
        default:
          text = type;
      }

      const now = yield* Clock.currentTimeMillis;
      yield* runEventRepo.upsert({
        sourceKey: sourceKey as SourceKey,
        sessionId,
        kind,
        level,
        text,
        payload: event,
        status: "observed",
        now,
      });
    },
  );

  const captureWorkerState = Effect.fn("SessionAuthority.captureWorkerState")(
    function* (
      sessionId: SessionId,
      worker: RpcWorkerHandle,
    ): Effect.fn.Return<
      void,
      DatabaseError | RowDecodeError | RpcProtocolError | RpcTimeoutError
    > {
      if (worker.driverSession?.ref.driver === "t3") return;
      const state = yield* worker.getState();
      const fromStateSessionId = isString(state.sessionId)
        ? Option.some(state.sessionId)
        : Option.none<string>();
      const fromStateSessionFile = isString(state.sessionFile)
        ? Option.some(state.sessionFile)
        : Option.none<string>();
      const workerSessionId = yield* worker.sessionId;
      const workerSessionFile = yield* worker.sessionFile;
      const ompSessionId = Option.isSome(fromStateSessionId)
        ? fromStateSessionId
        : workerSessionId;
      const ompSessionFile = Option.isSome(fromStateSessionFile)
        ? fromStateSessionFile
        : workerSessionFile;
      yield* updateRun(sessionId, { ompSessionId, ompSessionFile });
      if (Array.isArray(state.todoPhases)) {
        const items = planItems(state.todoPhases);
        if (items.length > 0) {
          const fingerprint = yield* Effect.sync(() =>
            createHash("sha256")
              .update(JSON.stringify(items))
              .digest("hex")
              .slice(0, 16),
          );
          yield* projector.plan(
            sessionId,
            `plan:${sessionId}:${fingerprint}`,
            items,
          );
        }
      }
    },
  );

  const abortForCleanup = (
    sessionId: SessionId,
    worker: RpcWorkerHandle,
  ): Effect.Effect<void, never, never> =>
    bestEffort(`abort worker for ${sessionId}`, worker.abort());

  const finishLocalCommand = Effect.fn("SessionAuthority.finishLocalCommand")(
    function* (
      sessionId: SessionId,
      worker: RpcWorkerHandle,
      sourceId: string,
    ): Effect.fn.Return<
      void,
      DatabaseError | RowDecodeError | RpcProtocolError | RpcTimeoutError
    > {
      yield* captureWorkerState(sessionId, worker);
      yield* updateRun(sessionId, {
        state: "waiting",
        nextAttemptAt: Option.none(),
      });
      yield* projector.thought(
        sessionId,
        `local-command:${sourceId}`,
        "The Partitura command completed without starting an agent turn.",
      );
    },
  );

  const dropWorker = (sessionId: SessionId) =>
    Effect.gen(function* () {
      if (deviceBackup !== undefined) {
        yield* bestEffort(
          "close T3 backup devices",
          Effect.gen(function* () {
            const run = yield* runRepo.get(sessionId);
            if (Option.isSome(run))
              yield* deviceBackup.release(run.value.organizationId, sessionId);
          }),
        );
      }
      stopMcpProxy(sessionId);
      stopGitBroker(sessionId);
      yield* cancelSessionNativeBuilds(sessionId);
      const state = (yield* Ref.get(workersRef)).get(sessionId);
      if (state !== undefined) {
        yield* state.unsubscribe();
        yield* state.worker.stop();
        yield* Queue.shutdown(state.queue);
        yield* Ref.update(workersRef, (workers) => {
          const next = new Map(workers);
          if (next.get(sessionId) === state) next.delete(sessionId);
          return next;
        });
      }
      yield* bestEffort(
        `destroy sandbox for ${sessionId}`,
        destroySandbox(sessionId),
      );
    });

  const cancel = Effect.fn("SessionAuthority.cancel")(function* (
    run: AgentRun,
  ): Effect.fn.Return<void, DatabaseError | RowDecodeError> {
    // Hold the mutation gate for the whole cancellation: an in-flight
    // host-tool mutation completes first, and a mutation arriving
    // after the gate is acquired sees the canceled run in its in-gate
    // re-read and is refused.
    yield* withCancelMutationGate(
      run.sessionId,
      Effect.gen(function* () {
        if (!["succeeded", "failed", "canceled"].includes(run.state)) {
          const claimed = yield* runRepo.claimLease(
            run.sessionId,
            owner,
            leaseDurationMs,
          );
          if (!claimed) return;
          yield* Ref.update(leasedSessions, (sessions) =>
            new Set(sessions).add(run.sessionId),
          );
        }
        if (Option.isSome(run.workspacePath)) {
          yield* removeMcpConfig(run.workspacePath.value);
        }
        const state = yield* getWorker(run.sessionId);
        if (Option.isSome(state)) {
          yield* abortForCleanup(run.sessionId, state.value.worker);
          yield* dropWorker(run.sessionId);
        }
        yield* Ref.update(pendingUiRef, (pending) => {
          const next = new Map(pending);
          next.delete(run.sessionId);
          return next;
        });
        yield* clearWorkspaceCredentials(run);
        if (
          run.state !== "succeeded" &&
          run.state !== "failed" &&
          run.state !== "canceled"
        ) {
          yield* updateRun(run.sessionId, {
            state: "canceled",
            terminalReason: Option.some("Stopped by Linear user"),
          });
          yield* Effect.logInfo("run.canceled").pipe(
            Effect.annotateLogs({
              event: "run.canceled",
              sessionId: run.sessionId,
              attempt: run.attempt,
            }),
          );
          yield* projector.terminal(
            run.sessionId,
            `stop:${run.sessionId}`,
            "response",
            "Stopped as requested.",
          );
        }
      }),
    );
    yield* releaseMutationGate(run.sessionId);
    yield* clearSessionStopDeferrals(run.sessionId);
    yield* releaseIfNoWorker(run.sessionId);
  });

  const handleFailure = Effect.fn("SessionAuthority.handleFailure")(function* (
    sessionId: SessionId,
    error: { readonly message: string },
    incrementAttempt = false,
  ): Effect.fn.Return<void, DatabaseError | RowDecodeError> {
    const message = error.message;
    yield* dropWorker(sessionId);

    yield* Effect.logWarning("authority.failure").pipe(
      Effect.annotateLogs({
        event: "authority.failure",
        sessionId,
        error: message,
      }),
    );

    const current = yield* runRepo.get(sessionId);
    if (
      Option.isNone(current) ||
      current.value.state === "succeeded" ||
      current.value.state === "failed" ||
      current.value.state === "canceled"
    ) {
      return;
    }

    if (
      Option.getOrNull(current.value.leaseOwner) !== owner ||
      Option.getOrElse(current.value.leaseExpiresAt, () => 0) <
        (yield* Clock.currentTimeMillis)
    )
      return;
    if (incrementAttempt && current.value.attempt < maxAttempts)
      yield* updateRun(sessionId, { incrementAttempt: true });
    const refreshed = yield* runRepo.get(sessionId);
    if (Option.isNone(refreshed)) return;
    const run = refreshed.value;
    if (run.desiredState === "canceled") {
      yield* cancel(run);
      return;
    }

    if (run.attempt >= maxAttempts) {
      if (Option.isSome(run.workspacePath)) {
        yield* removeMcpConfig(run.workspacePath.value);
      }
      const correlationId = failureCorrelationId(
        sessionId,
        run.attempt,
        message,
      );
      yield* clearWorkspaceCredentials(run);
      yield* updateRun(run.sessionId, {
        state: "failed",
        terminalReason: Option.some(`${message} [${correlationId}]`),
        nextAttemptAt: Option.none(),
      });
      yield* Effect.logInfo("run.failed").pipe(
        Effect.annotateLogs({
          event: "run.failed",
          sessionId,
          attempt: run.attempt,
          correlationId,
          terminalReason: `${message} [${correlationId}]`,
        }),
      );
      yield* projector.terminal(
        sessionId,
        `failure:${correlationId}`,
        "error",
        `The Partitura run failed after ${run.attempt} attempts. Reference: ${correlationId}`,
      );
      yield* releaseMutationGate(sessionId);
      yield* clearSessionStopDeferrals(sessionId);
      return;
    }

    const delay = Math.min(300_000, 10_000 * 2 ** Math.min(run.attempt, 5));
    const jitter = yield* Effect.sync(() => Math.floor(Math.random() * 1_000));
    const now = yield* Clock.currentTimeMillis;
    const nextAttemptAt = now + delay + jitter;
    yield* updateRun(run.sessionId, {
      state: "orphaned",
      terminalReason: Option.some(message),
      nextAttemptAt: Option.some(nextAttemptAt),
    });
    yield* Effect.logInfo("run.retried").pipe(
      Effect.annotateLogs({
        event: "run.retried",
        sessionId,
        attempt: run.attempt,
        delay,
        nextAttemptAt,
      }),
    );
  });

  return {
    recordRunEvent,
    captureWorkerState,
    finishLocalCommand,
    dropWorker,
    cancel,
    handleFailure,
  };
};
