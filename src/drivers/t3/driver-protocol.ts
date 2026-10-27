import { Effect, Option, Result, Schema } from "effect";
import {
  DriverError,
  type TurnHandle,
  type TurnOutcome,
  type TurnStatus,
  type WorkspaceSpec,
} from "../driver.js";
import type { RunView } from "./mapping.js";
import type { T3RpcError } from "./rpc-client.js";
import {
  ACTIVE_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type ThreadProjection,
  ThreadProjection as ThreadProjectionSchema,
  type WorkspaceStrategy,
} from "./wire.js";

export const fromRpcError =
  (operation: string, mutating: boolean) =>
  (error: T3RpcError): DriverError =>
    new DriverError({
      driver: "t3",
      operation,
      reason: error.reason,
      // A rejected command was refused by T3's orchestrator, so nothing
      // committed; any other failure after the frame left may have landed.
      submission:
        mutating && error.sent && error.reason !== "rejected"
          ? "possibly-submitted"
          : "not-submitted",
      message: error.message,
    });

export const withSubmission =
  (submission: DriverError["submission"]) =>
  (error: DriverError): DriverError =>
    new DriverError({
      driver: error.driver,
      operation: error.operation,
      reason: error.reason,
      submission,
      message: error.message,
    });

export const protocolError = (operation: string, message: string) =>
  new DriverError({
    driver: "t3",
    operation,
    reason: "protocol",
    submission: "not-submitted",
    message,
  });

export const isTransient = (error: DriverError): boolean =>
  error.reason === "lost" ||
  error.reason === "timeout" ||
  error.reason === "unavailable";

export const workspaceStrategy = (
  workspace: WorkspaceSpec,
): WorkspaceStrategy => {
  switch (workspace._tag) {
    case "Directory":
      return { type: "existing_worktree", worktreePath: workspace.path };
    case "ProjectRoot":
      return workspace.branch === undefined
        ? { type: "root" }
        : { type: "root", branch: workspace.branch };
    case "DriverWorktree":
      return workspace.branch === undefined
        ? { type: "worktree", baseRef: workspace.baseRef }
        : {
            type: "worktree",
            baseRef: workspace.baseRef,
            branch: workspace.branch,
          };
  }
};

/** The newest root run that holds the thread (not queued, not finished). */
export const activeRun = (projection: ThreadProjection) =>
  projection.runs
    .filter(
      (run) =>
        ACTIVE_RUN_STATUSES.has(run.status) &&
        run.delegatedTaskId === undefined,
    )
    .sort((a, b) => b.ordinal - a.ordinal)[0];

export type Located =
  | {
      readonly _tag: "Run";
      readonly turnId: string;
      readonly delivery: TurnHandle["delivery"];
    }
  | { readonly _tag: "Unlinked" };

/** Finds the run T3 linked to our message (its own run, or the steered one). */
export const locateTurn = (
  projection: ThreadProjection,
  messageId: string,
): Located | null => {
  const own = projection.runs.find((run) => run.userMessageId === messageId);
  if (own !== undefined) {
    return {
      _tag: "Run",
      turnId: own.id,
      delivery: own.status === "queued" ? "queued" : "started",
    };
  }
  const message = projection.messages.find((entry) => entry.id === messageId);
  if (message === undefined) return null;
  return message.runId === null
    ? { _tag: "Unlinked" }
    : { _tag: "Run", turnId: message.runId, delivery: "steered" };
};

export interface OutcomeState {
  readonly runs: ReadonlyMap<string, RunView>;
  readonly failure: DriverError | null;
}

export const isTerminal = (status: string): status is TurnStatus =>
  TERMINAL_RUN_STATUSES.has(status);

/** Terminal outcome of `turnId`, following restart continuations. */
export const resolveOutcome = (
  state: OutcomeState,
  turnId: string,
): Option.Option<Result.Result<TurnOutcome, DriverError>> => {
  if (state.failure !== null) return Option.some(Result.fail(state.failure));
  const seen = new Set<string>();
  let current = turnId;
  while (!seen.has(current)) {
    seen.add(current);
    const run = state.runs.get(current);
    if (run === undefined || !isTerminal(run.status)) return Option.none();
    const continuation = [...state.runs.values()].find(
      (candidate) => candidate.restartContinuationOfRunId === current,
    );
    if (
      continuation !== undefined &&
      (run.status === "cancelled" || run.status === "interrupted")
    ) {
      current = continuation.id;
      continue;
    }
    return Option.some(
      Result.succeed({
        turnId: run.id,
        status: run.status,
        finalText: run.finalText,
        error:
          run.error ??
          (run.status === "failed"
            ? "The T3 run failed without an error item"
            : null),
      }),
    );
  }
  return Option.none();
};

export const decodeProjection = (operation: string) => (value: unknown) =>
  Schema.decodeUnknownEffect(ThreadProjectionSchema)(value).pipe(
    Effect.mapError(() =>
      protocolError(
        operation,
        "T3 thread projection did not match the pinned wire schema",
      ),
    ),
  );
