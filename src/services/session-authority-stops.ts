import { Effect, Option, Ref } from "effect";
import type { DatabaseError, RowDecodeError } from "../domain/errors.js";
import type { SessionId } from "../domain/ids.js";
import type { AgentRun } from "../domain/models.js";
import { isDeferredNotificationStopPayload } from "../domain/models.js";
import type { LinearGateway } from "./linear-gateway.js";
import { record } from "./session-authority-helpers.js";
import type { RunInputRepo, RunRepo } from "./store/repositories.js";

export const makePendingStopHandler =
  ({
    runRepo,
    runInputRepo,
    owner,
    leaseDurationMs,
    leasedSessions,
    stopShouldApply,
    recordStopDeferral,
    cancel,
  }: {
    runRepo: RunRepo["Service"];
    runInputRepo: RunInputRepo["Service"];
    owner: string;
    leaseDurationMs: number;
    leasedSessions: Ref.Ref<ReadonlySet<SessionId>>;
    stopShouldApply: (
      id: SessionId,
      input: { readonly kind: string; readonly payload: unknown },
    ) => Effect.Effect<Option.Option<boolean>>;
    recordStopDeferral: (
      id: SessionId,
      inputId: string,
    ) => Effect.Effect<number>;
    cancel: (
      run: AgentRun,
    ) => Effect.Effect<void, DatabaseError | RowDecodeError>;
  }) =>
  (
    sessionId: SessionId,
    initial: Option.Option<AgentRun>,
    inputs: Effect.Success<ReturnType<RunInputRepo["Service"]["pending"]>>,
  ) =>
    Effect.gen(function* () {
      // Stops verify their notification state and cancel without a worker slot.
      if (
        Option.isSome(initial) &&
        inputs.some((input) => input.kind === "stop")
      ) {
        // Lease fencing still applies to stop inputs; capacity limits do not.
        if (!(yield* runRepo.claimLease(sessionId, owner, leaseDurationMs)))
          return true;
        yield* Ref.update(leasedSessions, (sessions) =>
          new Set(sessions).add(sessionId),
        );
        for (const input of inputs.filter((input) => input.kind === "stop")) {
          const latestOption = yield* runRepo.get(sessionId);
          let latest = Option.isSome(latestOption)
            ? latestOption.value
            : initial.value;
          const stopDecision = yield* stopShouldApply(sessionId, input);
          if (Option.isNone(stopDecision)) {
            const deferralCount = yield* recordStopDeferral(
              sessionId,
              input.id,
            );
            if (deferralCount < 10) return true;
            yield* Effect.logWarning(
              "authority.stop_deferral_bound_reached_without_stop",
            ).pipe(
              Effect.annotateLogs({
                event: "authority.stop_deferral_bound_reached_without_stop",
                sessionId,
                inputId: input.id,
                deferralCount,
              }),
            );
            yield* runInputRepo.markProcessed(input.id);
            continue;
          }
          const shouldStop = Option.getOrElse(stopDecision, () => true);
          if (!shouldStop) {
            yield* runInputRepo.markProcessed(input.id);
            continue;
          }
          // A newer prompt may have reopened a terminal run since this
          // stop was enqueued. Persist cancellation again so that prompt
          // remains eligible for the normal canceled-run resume path.
          yield* runInputRepo.applyStop(sessionId);
          const refreshed = yield* runRepo.get(sessionId);
          if (Option.isSome(refreshed)) latest = refreshed.value;
          yield* cancel(latest);
          // The accepted stop also cancels prompts queued before it.
          // Leave later prompts pending so they can resume the run.
          for (const superseded of inputs.slice(
            0,
            inputs.findIndex((candidate) => candidate.id === input.id) + 1,
          ))
            yield* runInputRepo.markProcessed(superseded.id);
          return true;
        }
      }
      return false;
    });

export const makeStopDecision = (
  linearOption: Option.Option<LinearGateway["Service"]>,
) => {
  return Effect.fn("SessionAuthority.stopShouldApply")(function* (
    sessionId: SessionId,
    input: { readonly kind: string; readonly payload: unknown },
  ): Effect.fn.Return<Option.Option<boolean>, never> {
    if (
      input.kind !== "stop" ||
      !isDeferredNotificationStopPayload(input.payload)
    ) {
      return Option.some(true);
    }
    const notification = record(input.payload)
      ? input.payload.notification
      : undefined;
    const issueId =
      record(notification) && typeof notification.issueId === "string"
        ? notification.issueId
        : null;
    if (issueId === null) return Option.some(false);
    if (Option.isNone(linearOption)) return Option.none();
    const linear = linearOption.value;
    return yield* linear.getIssue({ sessionId, issueId }).pipe(
      Effect.map((issue) => Option.some(issue.stateType === "canceled")),
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            "authority.notification_issue_fetch_failed",
          ).pipe(
            Effect.annotateLogs({
              event: "authority.notification_issue_fetch_failed",
              sessionId,
              issueId,
              error: String(error),
            }),
          );
          return Option.none<boolean>();
        }),
      ),
    );
  });
};
