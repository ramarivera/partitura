import { Effect, Schema } from "effect";
import {
  FailedReceiptSchema,
  type NativeBuildJob,
  RunningReceiptSchema,
  SucceededReceiptSchema,
  validateNativeBuildDiagnostics,
} from "./native-build-legacy-receipt.js";

export const LEGACY_NATIVE_BUILD_RUN_TIMEOUT_MS = 3_600_000;
/** Allow final cleanup/receipt publication after the SSH run deadline. */
export const LEGACY_NATIVE_BUILD_RECEIPT_GRACE_MS = 5 * 60_000;

/** Legacy status reads stay local. Background refresh bounds unavailable lookups
 * while keeping live builds observable; polling never waits on offline SSH. */
export const legacyReceiptRefresh = (deps: {
  readonly read: (job: string, signal: AbortSignal) => Promise<string>;
  readonly save: (job: NativeBuildJob) => Promise<void>;
  readonly retain: (job: string) => () => void;
  readonly current: (job: NativeBuildJob) => boolean;
  readonly now?: () => number;
}) => {
  const pending = new Map<
    string,
    { failures: number; next: number; expiresAt: number }
  >();
  const flights = new Map<
    string,
    { task: Promise<void>; abort: AbortController }
  >();
  const now = deps.now ?? Date.now;
  const confirm = (id: string) => {
    pending.delete(id);
  };
  let closed = false;
  return {
    track: (id: string) =>
      pending.set(id, {
        failures: 0,
        next: 0,
        expiresAt:
          now() +
          LEGACY_NATIVE_BUILD_RUN_TIMEOUT_MS +
          LEGACY_NATIVE_BUILD_RECEIPT_GRACE_MS,
      }),
    confirmed: (job: NativeBuildJob) =>
      job.state === "succeeded" ||
      // Only this refusal precedes runner/VM/keychain ownership. Other failed
      // receipts, including execution-interrupted, can precede reconciliation;
      // cancel must still retry cleanup even after a confirmed status receipt.
      (job.state === "failed" &&
        job.stage === "disk-preflight" &&
        job.failureCode === "host-disk-space-unavailable"),
    confirm,
    poll: (job: NativeBuildJob) => {
      const retry = pending.get(job.job);
      if (closed || !retry) return;
      const flight = flights.get(job.job);
      if (flight) return flight.task;
      if (retry.failures >= 4 || now() < retry.next) return;
      // A live broker may still be building long after the SSH run was lost.
      // Successful non-terminal reads back off without spending the error budget.
      let backoff = 30_000;
      const release = deps.retain(job.job);
      const abort = new AbortController();
      const task = (async () => {
        try {
          const response: unknown = JSON.parse(
            await deps.read(job.job, abort.signal),
          );
          if (
            typeof response !== "object" ||
            response === null ||
            !("job" in response) ||
            response.job !== job.job ||
            !("commit" in response) ||
            response.commit !== job.commit ||
            !("action" in response) ||
            response.action !== job.action
          )
            throw new Error("Invalid native build receipt identity");
          if ("state" in response && response.state === "running") {
            Schema.decodeUnknownSync(RunningReceiptSchema)(response);
            // Late requests may still fetch a terminal receipt. A running reply
            // after the deadline exhausts polling without changing job status.
            retry.failures = now() >= retry.expiresAt ? 4 : 0;
            return;
          }
          const receipt =
            "state" in response && response.state === "succeeded"
              ? Schema.decodeUnknownSync(SucceededReceiptSchema)(response)
              : Schema.decodeUnknownSync(FailedReceiptSchema)(response);
          if (receipt.state === "failed")
            validateNativeBuildDiagnostics(receipt);
          if (!deps.current(job)) return;
          const updated = { ...job, ...receipt };
          await deps.save(updated);
          Object.assign(job, updated);
          confirm(job.job);
        } catch {
          retry.failures++;
          backoff =
            [1_000, 5_000, 30_000, 30_000][retry.failures - 1] ?? 30_000;
          await Effect.runPromise(
            Effect.logWarning("Native failure receipt unavailable", {
              code: "native-receipt-unavailable",
            }),
          );
        } finally {
          retry.next = now() + backoff;
          release();
          flights.delete(job.job);
        }
      })();
      flights.set(job.job, { task, abort });
      return task;
    },
    close: async () => {
      closed = true;
      const active = [...flights.values()];
      for (const flight of active) flight.abort.abort();
      await Promise.all(active.map((flight) => flight.task));
    },
  };
};
