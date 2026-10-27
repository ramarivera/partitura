import { Effect, Schema } from "effect";
import {
  FailedReceiptSchema,
  type NativeBuildJob,
  validateNativeBuildDiagnostics,
} from "./native-build-legacy-receipt.js";

/** Legacy status reads stay local. Only uncertain submissions need a bounded,
 * background receipt refresh; polling never waits on an offline SSH connection. */
export const legacyReceiptRefresh = (deps: {
  readonly read: (job: string, signal: AbortSignal) => Promise<string>;
  readonly save: (job: NativeBuildJob) => Promise<void>;
  readonly retain: (job: string) => () => void;
  readonly current: (job: NativeBuildJob) => boolean;
  readonly now?: () => number;
}) => {
  const pending = new Map<string, { attempts: number; next: number }>();
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
    track: (id: string) => pending.set(id, { attempts: 0, next: 0 }),
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
      if (retry.attempts >= 4 || now() < retry.next) return;
      retry.attempts++;
      const backoff =
        [1_000, 5_000, 30_000, 30_000][retry.attempts - 1] ?? 30_000;
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
          if ("state" in response && response.state === "running") return;
          const failure =
            Schema.decodeUnknownSync(FailedReceiptSchema)(response);
          validateNativeBuildDiagnostics(failure);
          if (!deps.current(job)) return;
          const updated = { ...job, ...failure };
          await deps.save(updated);
          Object.assign(job, updated);
          confirm(job.job);
        } catch {
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
