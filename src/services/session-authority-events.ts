import { createHash } from "node:crypto";
import { Clock, Effect, Option, Ref, type Semaphore } from "effect";
import {
  type DatabaseError,
  type RowDecodeError,
  RpcProtocolError,
  type RpcTimeoutError,
} from "../domain/errors.js";
import type { SessionId } from "../domain/ids.js";
import type { AgentRun } from "../domain/models.js";
import type { LinearGateway } from "./linear-gateway.js";
import { removeMcpConfig } from "./mcp-config.js";
import type { ActivityProjector } from "./projector.js";
import type { RpcEvent, RpcWorkerHandle } from "./rpc-worker.js";
import {
  assistantResponseTextFromRpcEvent,
  deviationFromRpcEvent,
  extractPullRequestUrls,
  planItems,
} from "./session-authority-helpers.js";
import type { RunEventRepo, RunRepo } from "./store/repositories.js";

type EventFailure =
  | DatabaseError
  | RowDecodeError
  | RpcProtocolError
  | RpcTimeoutError;
export const makeEventHandler = ({
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
}: {
  runRepo: RunRepo["Service"];
  owner: string;
  dropWorker: (id: SessionId) => Effect.Effect<void>;
  releaseIfNoWorker: (id: SessionId) => Effect.Effect<void>;
  eventSequenceRef: Ref.Ref<ReadonlyMap<SessionId, number>>;
  runEventRepo: RunEventRepo["Service"];
  recordRunEvent: (
    id: SessionId,
    sequence: number,
    event: RpcEvent,
  ) => Effect.Effect<void, DatabaseError>;
  projector: ActivityProjector["Service"];
  withSessionMutationGate: <A, E, R>(
    id: SessionId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  getWorker: (
    id: SessionId,
  ) => Effect.Effect<Option.Option<{ readonly worker: RpcWorkerHandle }>>;
  pendingUiRef: Ref.Ref<
    ReadonlyMap<SessionId, { readonly id: string; readonly method: string }>
  >;
  updateRun: RunRepo["Service"]["update"];
  finishLocalCommand: (
    id: SessionId,
    worker: RpcWorkerHandle,
    source: string,
  ) => Effect.Effect<void, EventFailure>;
  captureWorkerState: (
    id: SessionId,
    worker: RpcWorkerHandle,
  ) => Effect.Effect<void, EventFailure>;
  assistantDraftRef: Ref.Ref<ReadonlyMap<SessionId, string>>;
  linearOption: Option.Option<LinearGateway["Service"]>;
  reportedPullRequestUrlsRef: Ref.Ref<
    ReadonlyMap<SessionId, ReadonlySet<string>>
  >;
  bestEffort: <A, E>(
    description: string,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<void>;
  clearWorkspaceCredentials: (run: AgentRun) => Effect.Effect<void>;
  clearSessionStopDeferrals: (id: SessionId) => Effect.Effect<void>;
  sessionMutationGatesRef: Ref.Ref<ReadonlyMap<SessionId, Semaphore.Semaphore>>;
}) => {
  return Effect.fn("SessionAuthority.handleEvent")(function* (
    sessionId: SessionId,
    event: RpcEvent,
  ): Effect.fn.Return<
    void,
    DatabaseError | RowDecodeError | RpcProtocolError | RpcTimeoutError
  > {
    const current = yield* runRepo.get(sessionId);
    if (
      Option.isNone(current) ||
      current.value.desiredState === "canceled" ||
      current.value.state === "canceled"
    ) {
      return;
    }
    const run = current.value;
    if (
      Option.getOrNull(run.leaseOwner) !== owner ||
      Option.getOrElse(run.leaseExpiresAt, () => 0) <
        (yield* Clock.currentTimeMillis)
    ) {
      yield* dropWorker(sessionId);
      yield* releaseIfNoWorker(sessionId);
      return;
    }
    const existingSequence = (yield* Ref.get(eventSequenceRef)).get(sessionId);
    if (existingSequence === undefined) {
      const maxSequence = yield* runEventRepo.maxRpcSequence(sessionId);
      yield* Ref.update(eventSequenceRef, (m) =>
        new Map(m).set(sessionId, maxSequence),
      );
    }
    const sequence = yield* Ref.modify(eventSequenceRef, (m) => {
      const next = new Map(m);
      const value = (next.get(sessionId) ?? 0) + 1;
      next.set(sessionId, value);
      return [value, next] as const;
    });
    yield* recordRunEvent(sessionId, sequence, event);

    const deviation = deviationFromRpcEvent(event);
    if (deviation !== null) {
      if (Option.isSome(run.issueId)) {
        const eventId =
          typeof event.id === "string"
            ? event.id
            : createHash("sha256").update(deviation).digest("hex").slice(0, 16);
        yield* projector.deviation(
          sessionId,
          `deviation:${sessionId}:${eventId}`,
          deviation,
        );
      } else {
        yield* Effect.logWarning("deviation.comment.skipped").pipe(
          Effect.annotateLogs({
            sessionId,
            reason: "run has no Linear issue",
          }),
        );
      }
    }
    if (event.type === "driver_approval" && typeof event.id === "string") {
      const requestId = event.id;
      yield* withSessionMutationGate(
        sessionId,
        Effect.gen(function* () {
          const latest = yield* runRepo.get(sessionId);
          if (
            Option.isNone(latest) ||
            latest.value.desiredState === "canceled" ||
            ["canceled", "failed", "succeeded"].includes(latest.value.state)
          )
            return;
          const worker = yield* getWorker(sessionId);
          if (
            Option.isSome(worker) &&
            worker.value.worker.driverSession !== undefined
          ) {
            yield* worker.value.worker.driverSession
              .respond(requestId, { _tag: "Approve", scope: "once" })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new RpcProtocolError({
                      method: "approve",
                      message: error.message,
                    }),
                ),
              );
          }
        }),
      );
      return;
    }
    if (event.type === "extension_ui_request") {
      const id = event.id;
      const method = event.method;
      if (
        typeof id === "string" &&
        typeof method === "string" &&
        ["select", "confirm", "input", "editor"].includes(method)
      ) {
        yield* Ref.update(pendingUiRef, (pending) => {
          const next = new Map(pending);
          next.set(sessionId, { id, method });
          return next;
        });
        const title =
          typeof event.title === "string" ? event.title : "Input required";
        const message = typeof event.message === "string" ? event.message : "";
        const options = Array.isArray(event.options)
          ? event.options.filter(
              (option): option is string => typeof option === "string",
            )
          : [];
        yield* projector.elicitation(
          sessionId,
          `rpc-ui:${event.id}`,
          [title, message].filter(Boolean).join("\n\n"),
          options.length > 0 ? options : undefined,
        );
        yield* updateRun(sessionId, { state: "waiting" });
        return;
      }
    }

    if (event.type === "prompt_result" && event.agentInvoked === false) {
      const worker = yield* getWorker(sessionId);
      if (Option.isSome(worker)) {
        yield* finishLocalCommand(
          sessionId,
          worker.value.worker,
          typeof event.id === "string" ? event.id : `prompt-result:${sequence}`,
        );
      }
      return;
    }
    if (event.type === "error" || event.type === "worker_exited") {
      return yield* Effect.fail(
        new RpcProtocolError({
          method: "worker",
          message:
            typeof event.message === "string"
              ? event.message
              : "Partitura worker failed",
        }),
      );
    }
    if (event.type === "driver_plan") {
      yield* projector.plan(
        sessionId,
        typeof event.driverEventKey === "string"
          ? event.driverEventKey
          : `plan:${sessionId}:${sequence}`,
        planItems(event.items),
      );
      return;
    }
    if (
      event.type === "driver_request_resolved" &&
      typeof event.id === "string"
    ) {
      yield* Ref.update(pendingUiRef, (pending) => {
        if (pending.get(sessionId)?.id !== event.id) return pending;
        const next = new Map(pending);
        next.delete(sessionId);
        return next;
      });
    }
    const worker = yield* getWorker(sessionId);
    const terminalAgentEnd =
      event.type === "agent_end" && event.willContinue !== true;
    if (
      Option.isSome(worker) &&
      (event.type === "agent_start" ||
        event.type === "turn_end" ||
        event.type === "agent_end")
    ) {
      yield* captureWorkerState(sessionId, worker.value.worker);
    }

    if (event.type === "message_end") {
      const draft = assistantResponseTextFromRpcEvent(event);
      if (draft.length > 0) {
        yield* Ref.update(assistantDraftRef, (current) => {
          const next = new Map(current);
          next.set(sessionId, draft);
          return next;
        });
      }
    }

    if (terminalAgentEnd) {
      const savedDraft = (yield* Ref.get(assistantDraftRef)).get(sessionId);
      const finalText =
        typeof event.driverEventKey === "string"
          ? assistantResponseTextFromRpcEvent(event)
          : (savedDraft ?? assistantResponseTextFromRpcEvent(event));
      const discovered = extractPullRequestUrls(finalText);
      if (discovered.length > 0 && Option.isSome(linearOption)) {
        const existing = yield* Ref.get(reportedPullRequestUrlsRef);
        const already = existing.get(sessionId) ?? new Set<string>();
        const fresh = discovered.filter((url) => !already.has(url));
        if (fresh.length > 0) {
          const nextSet = new Set(already);
          for (const url of fresh) nextSet.add(url);
          yield* Ref.update(reportedPullRequestUrlsRef, (current) => {
            const next = new Map(current);
            next.set(sessionId, nextSet);
            return next;
          });
          yield* bestEffort(
            `report ${fresh.length} pull request URL(s) to Linear`,
            linearOption.value.addSessionExternalUrls({
              sessionId,
              urls: fresh.map((url) => ({ label: "Pull request", url })),
            }),
          );
        }
      }
      yield* Effect.logInfo("run.completed").pipe(
        Effect.annotateLogs({
          event: "run.completed",
          sessionId,
          attempt: run.attempt,
        }),
      );
      yield* updateRun(sessionId, {
        state: "succeeded",
        nextAttemptAt: Option.none(),
      });
      yield* projector.projectRpcEvent(sessionId, sequence, event).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* clearWorkspaceCredentials(run);
            if (Option.isSome(run.workspacePath)) {
              yield* removeMcpConfig(run.workspacePath.value);
            }
            yield* dropWorker(sessionId);
            yield* Ref.update(reportedPullRequestUrlsRef, (reported) => {
              const next = new Map(reported);
              next.delete(sessionId);
              return next;
            });
            yield* Ref.update(assistantDraftRef, (drafts) => {
              const next = new Map(drafts);
              next.delete(sessionId);
              return next;
            });
            yield* clearSessionStopDeferrals(sessionId);
            yield* Ref.update(sessionMutationGatesRef, (gates) => {
              const next = new Map(gates);
              next.delete(sessionId);
              return next;
            });
            yield* releaseIfNoWorker(sessionId);
          }),
        ),
      );
      return;
    }

    yield* projector.projectRpcEvent(sessionId, sequence, event);
  });
};
