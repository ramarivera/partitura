import { Context, Effect, Layer } from "effect";
import { NativeOperationError, nativeTry } from "./native-build-errors.js";
import {
  applyNativeReceipt,
  cleanNativeHealth,
} from "./native-build-receipt.js";
import {
  type NativeBuildState,
  NativeBuildStateService,
  type NativeGeneration,
  type NativeRecovery,
  type NativeRegistryJob,
  terminalNativeJob,
  unresolvedRecovery,
} from "./native-build-state.js";
import {
  type NativeBrokerTransport,
  NativeBuildTransport,
  NativeTransportError,
} from "./native-build-transport.js";

export {
  applyNativeReceipt,
  cleanNativeHealth,
} from "./native-build-receipt.js";

const delays = [0, 5_000, 15_000, 30_000, 60_000, 120_000];

/** Must complete before remote scheduling or ingress. Never dispatches run-v2. */
export const recoverNativeMetadata = Effect.fn(
  "NativeBuildRecovery.recoverMetadata",
)(function* (state: NativeBuildState, now = Date.now()) {
  yield* state.transaction((draft) => {
    for (const job of draft.jobs) {
      if (terminalNativeJob(job) && job.recovery.state === "not-required")
        continue;
      if (job.state === "starting" && !job.imported) {
        job.state = "interrupted";
        job.updatedAt = now;
      } else if (!terminalNativeJob(job) || unresolvedRecovery(job)) {
        if (job.recovery.state === "not-required")
          job.recovery.state = "pending";
        if (!job.recovery.deadline) {
          job.recovery.deadline = now + 900_000;
          job.recovery.nextAt = now;
        }
      }
    }
  });
  for (const job of state.snapshot().jobs) {
    if (job.importBinding?.artifact !== "copy-pending")
      yield* state.remove(`${state.jobPath(job)}/artifact.partial`);
    if (terminalNativeJob(job) && !unresolvedRecovery(job))
      yield* state.remove(`${state.jobPath(job)}/source.bundle`);
  }
});
export function createNativeBuildRecovery(
  state: NativeBuildState,
  transport: NativeBrokerTransport,
  options: { readonly now?: () => number; readonly jitter?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const inFlight = new Set<string>();
  const failures = new Map<string, NativeOperationError>();
  const update = (id: string, mutate: (job: NativeRegistryJob) => void) =>
    state.transaction((draft) => {
      const job = draft.jobs.find((candidate) => candidate.jobId === id);
      if (!job) throw NativeOperationError.new("native-job-not-found");
      mutate(job);
    });
  const hold = (
    id: string,
    reason: NativeRecovery["lastReason"],
    observation?: NativeRecovery["observation"],
  ) =>
    update(id, (job) => {
      job.recovery.state = "operator-required";
      job.recovery.lastReason = reason;
      if (observation !== undefined) job.recovery.observation = observation;
      job.recovery.returnEligible = [
        "unavailable",
        "busy",
        "deadline",
      ].includes(reason);
      job.recovery.nextAt =
        now() +
        300_000 +
        Math.floor(
          Math.max(0, Math.min(1, options.jitter?.() ?? Math.random())) *
            30_000,
        );
    });
  const round = Effect.fn("NativeBuildRecovery.round")(function* (
    job: NativeRegistryJob,
    generation: NativeGeneration,
    returned: boolean,
  ) {
    const remaining = returned
      ? 150_000
      : Math.min(150_000, job.recovery.deadline - now());
    if (remaining <= 0) return yield* hold(job.jobId, "deadline");
    // Commit before allocating the Effect timeout. Failed writes own no timer.
    yield* update(job.jobId, (current) => {
      current.recovery.state = "cancel-requested";
      current.recovery.attempts++;
    });
    // The broker reports transient state/IO failures as an authenticated
    // error envelope. Those follow the unavailable retry schedule; any other
    // unexpected kind is a protocol mismatch.
    const send = (command: string) =>
      transport
        .envelope(generation, command, job, { timeout: remaining })
        .pipe(
          Effect.flatMap((envelope) =>
            envelope.kind === "error" &&
            envelope.code === "broker-state-unavailable"
              ? Effect.fail(NativeTransportError.new("unavailable"))
              : Effect.succeed(envelope),
          ),
        );
    const remote = Effect.gen(function* () {
      const cancelled = yield* send(`cancel ${job.jobId}`);
      if (cancelled.kind !== "cancellation-requested")
        return yield* Effect.fail(
          NativeTransportError.new("protocol-mismatch"),
        );
      yield* update(job.jobId, (current) => {
        current.recovery.state = "reconciling";
      });
      const reconciled = yield* send(`reconcile ${job.jobId}`);
      if (
        ["busy", "cleanup-required", "keychain-relock-pending"].includes(
          reconciled.kind,
        )
      )
        return { reconciled, receipt: undefined };
      if (
        !["reconciled-terminal", "reconciled-unknown"].includes(reconciled.kind)
      )
        return yield* Effect.fail(
          NativeTransportError.new("protocol-mismatch"),
        );
      const receipt =
        reconciled.kind === "reconciled-terminal"
          ? yield* send(`status ${job.jobId}`)
          : undefined;
      if (
        receipt &&
        (receipt.kind !== "known" ||
          !["succeeded", "failed", "cancelled"].includes(receipt.state ?? ""))
      )
        return yield* Effect.fail(
          NativeTransportError.new("protocol-mismatch"),
        );
      // Preserve authenticated execution evidence before health IO. Recovery
      // stays unresolved until matching clean health releases quarantine.
      if (receipt)
        yield* update(job.jobId, (current) => {
          applyNativeReceipt(current, receipt);
          current.updatedAt = now();
        });
      const health = yield* send("health");
      if (health.epoch !== reconciled.epoch || !cleanNativeHealth(health))
        return yield* Effect.fail(
          NativeTransportError.new("protocol-mismatch"),
        );
      return { reconciled, receipt };
    });
    yield* remote.pipe(
      Effect.timeoutOrElse({
        duration: remaining,
        orElse: () => Effect.fail(NativeTransportError.new("unavailable")),
      }),
      Effect.flatMap(({ reconciled, receipt }) => {
        if (reconciled.kind === "busy") {
          if (returned) return hold(job.jobId, "busy");
          return update(job.jobId, (current) => {
            const recovery = current.recovery;
            recovery.state = "pending";
            recovery.attempts--;
            recovery.busySince ??= now();
            recovery.heartbeat =
              reconciled.runner?.heartbeat === undefined
                ? null
                : // The broker reports epoch seconds as a float; storage keeps
                  // integer milliseconds.
                  Math.floor(reconciled.runner.heartbeat * 1000);
            const fresh =
              recovery.heartbeat !== null &&
              now() - recovery.heartbeat >= 0 &&
              now() - recovery.heartbeat <= 60_000;
            if (!fresh) recovery.busyObservations++;
            recovery.lastReason = "busy";
            recovery.returnEligible = true;
            recovery.nextAt = Math.min(recovery.deadline, now() + 15_000);
            if (
              recovery.busyObservations >= 6 ||
              now() - recovery.busySince >= 750_000 ||
              now() >= recovery.deadline
            ) {
              recovery.state = "operator-required";
              recovery.nextAt = now() + 300_000;
            }
          });
        }
        if (
          reconciled.kind === "cleanup-required" ||
          reconciled.kind === "keychain-relock-pending"
        )
          return hold(job.jobId, reconciled.kind);
        return update(job.jobId, (current) => {
          if (receipt) applyNativeReceipt(current, receipt);
          else if (!terminalNativeJob(current)) current.state = "interrupted";
          current.updatedAt = now();
          current.recovery.state = receipt
            ? "resolved-terminal"
            : "resolved-unknown";
          current.recovery.lastReason = receipt ? "none" : "unknown-on-broker";
          current.recovery.resolvedEpoch = reconciled.epoch ?? null;
        });
      }),
      Effect.catch((error) => {
        failures.set(
          job.jobId,
          NativeOperationError.new("native-recovery-round-failed", error),
        );
        const reason =
          error instanceof NativeTransportError ? error.reason : "unavailable";
        if (reason === "needs-refresh" || reason === "host-key-mismatch")
          return update(job.jobId, (current) => {
            current.recovery.state = "operator-required";
            current.recovery.lastReason = "unavailable";
            current.recovery.observation = reason;
            current.recovery.returnEligible = true;
            current.recovery.nextAt = now() + 300_000;
          });
        if (reason !== "unavailable" || returned)
          return hold(job.jobId, reason);
        return update(job.jobId, (current) => {
          const recovery = current.recovery;
          recovery.lastReason = "unavailable";
          recovery.returnEligible = true;
          recovery.state =
            recovery.attempts >= 6 || now() >= recovery.deadline
              ? "operator-required"
              : "pending";
          recovery.nextAt =
            now() +
            (recovery.state === "operator-required"
              ? 300_000
              : (delays[recovery.attempts] ?? 120_000));
        });
      }),
    );
  });
  const tick = Effect.fn("NativeBuildRecovery.tick")((id: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (inFlight.has(id)) return;
        const job = state
          .snapshot()
          .jobs.find((candidate) => candidate.jobId === id);
        if (!job || !unresolvedRecovery(job) || job.recovery.nextAt > now())
          return;
        if (
          [...inFlight].some(
            (other) =>
              state
                .snapshot()
                .jobs.find((candidate) => candidate.jobId === other)
                ?.verifiedHostId === job.verifiedHostId,
          )
        )
          return;
        const generation = yield* nativeTry(() => {
          const generation = state
            .snapshot()
            .generations.find((candidate) => candidate.id === job.generationId);
          if (!generation || generation.transport.hostId !== job.verifiedHostId)
            throw NativeOperationError.new("native-state-corrupt");
          return generation;
        });
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            inFlight.add(id);
            return [state.retainGeneration(generation.id), state.retainJob(id)];
          }),
          (releases) =>
            Effect.gen(function* () {
              for (const release of releases) release();
              inFlight.delete(id);
              const current = state
                .snapshot()
                .jobs.find((candidate) => candidate.jobId === id);
              if (
                current &&
                terminalNativeJob(current) &&
                !unresolvedRecovery(current)
              )
                yield* state
                  .remove(`${state.jobPath(current)}/source.bundle`)
                  .pipe(Effect.orDie);
            }),
        );
        if (!transport.hasCredential(generation.id)) {
          if (
            job.recovery.state === "operator-required" &&
            job.recovery.lastReason === "missing-credentials"
          )
            return;
          const credentialState = transport.credentialState?.(generation.id);
          if (credentialState === "pending")
            yield* update(id, (current) => {
              current.recovery.observation = "credentials-pending";
              current.recovery.nextAt = now() + 5_000;
            });
          else
            yield* hold(
              id,
              "missing-credentials",
              credentialState === "failed" ? "credentials-failed" : undefined,
            );
          return;
        }
        if (job.recovery.state === "operator-required") {
          if (
            job.recovery.returnEventUsed ||
            !(
              job.recovery.returnEligible ??
              ["unavailable", "busy", "deadline"].includes(
                job.recovery.lastReason,
              )
            )
          )
            return;
          yield* update(id, (current) => {
            current.recovery.nextAt = now() + 300_000;
          });
          const health = yield* transport
            .envelope(generation, "health", undefined, { timeout: 30_000 })
            .pipe(
              Effect.catch((error) => {
                failures.set(
                  id,
                  NativeOperationError.new(
                    "native-host-return-check-failed",
                    error,
                  ),
                );
                if (
                  error instanceof NativeTransportError &&
                  ["wrong-host", "protocol-mismatch"].includes(error.reason)
                )
                  return hold(
                    id,
                    error.reason as "wrong-host" | "protocol-mismatch",
                  ).pipe(Effect.as(undefined));
                return update(id, (current) => {
                  current.recovery.observation =
                    error instanceof NativeTransportError &&
                    (error.reason === "needs-refresh" ||
                      error.reason === "host-key-mismatch")
                      ? error.reason
                      : "unavailable";
                }).pipe(Effect.as(undefined));
              }),
            );
          if (!health) return;
          if (health.kind === "error") {
            yield* update(id, (current) => {
              current.recovery.observation = "unavailable";
            });
            return;
          }
          if (
            health.kind !== "health" ||
            health.hostId !== job.verifiedHostId
          ) {
            yield* hold(id, "wrong-host");
            return;
          }
          yield* update(id, (current) => {
            current.recovery.returnEventUsed = true;
          });
          yield* round(job, generation, true);
          return;
        }
        if (now() >= job.recovery.deadline) {
          yield* hold(id, "deadline");
          return;
        }
        yield* round(job, generation, false);
      }),
    ),
  );
  return {
    tick,
    failure: (id: string) => failures.get(id),
    request: Effect.fn("NativeBuildRecovery.request")((id: string) =>
      update(id, (job) => {
        if (terminalNativeJob(job) && job.recovery.state === "not-required")
          return;
        if (job.state === "starting" && !job.imported) {
          job.state = "interrupted";
          job.updatedAt = now();
          return;
        }
        if (
          [
            "operator-required",
            "resolved-terminal",
            "resolved-unknown",
            "admin-resolved",
          ].includes(job.recovery.state)
        )
          return;
        job.recovery.state = "pending";
        if (!job.recovery.deadline) {
          job.recovery.deadline = now() + 900_000;
          job.recovery.nextAt = now();
        }
      }),
    ),
  };
}
export class NativeBuildRecovery extends Context.Service<NativeBuildRecovery>()(
  "NativeBuildRecovery",
  {
    make: Effect.gen(function* () {
      return createNativeBuildRecovery(
        yield* NativeBuildStateService,
        yield* NativeBuildTransport,
      );
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
