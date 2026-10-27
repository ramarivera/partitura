import {
  type NativeBuildState,
  type NativeGeneration,
  type NativeRecovery,
  type NativeRegistryJob,
  terminalNativeJob,
  unresolvedRecovery,
} from "./native-build-state.js";
import {
  type BrokerEnvelope,
  type NativeBrokerTransport,
  NativeTransportError,
} from "./native-build-transport.js";

const delays = [0, 5_000, 15_000, 30_000, 60_000, 120_000];
export const cleanNativeHealth = (health: BrokerEnvelope) =>
  health.kind === "health" &&
  health.profile === "registry-only" &&
  health.status !== "busy" &&
  health.runner == null &&
  health.reasons?.every((reason) =>
    ["host-disk-space-unavailable", "host-capacity-unavailable"].includes(
      reason,
    ),
  );
export function applyNativeReceipt(
  job: NativeRegistryJob,
  receipt: BrokerEnvelope,
) {
  if (receipt.kind !== "known")
    throw new NativeTransportError("protocol-mismatch");
  switch (receipt.state) {
    case "receiving":
      job.state = "submitting";
      break;
    case "running":
      job.state = "running";
      break;
    case "cancelled":
      job.state = "interrupted";
      break;
    case "succeeded":
    case "failed":
      job.state = receipt.state;
      break;
    default:
      throw new NativeTransportError("protocol-mismatch");
  }
  if (
    receipt.artifactBytes !== undefined &&
    receipt.artifactSha256 !== undefined
  ) {
    job.artifactBytes = receipt.artifactBytes;
    job.artifactSha256 = receipt.artifactSha256;
  }
  if (receipt.artifactExpired !== undefined)
    job.artifactExpired = receipt.artifactExpired;
  if (receipt.failureCode !== undefined) job.failureCode = receipt.failureCode;
  if (receipt.stage !== undefined) job.stage = receipt.stage;
}

/** Local recovery is eager. Remote rounds are driven later by the owning
 * scoped service, never by ingress, and never issue run-v2. */
export async function recoverNativeMetadata(
  state: NativeBuildState,
  now = Date.now(),
) {
  await state.transaction((draft) => {
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
    await state
      .remove(`${state.jobPath(job)}/artifact.partial`)
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.message === "native-file-busy"))
          throw error;
      });
    if (job.state !== "interrupted" || job.recovery.state !== "not-required")
      continue;
    // Local-only preparation cannot have run a command. A missing file is normal.
    await state
      .remove(`${state.jobPath(job)}/source.bundle`)
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.message === "native-file-busy"))
          throw error;
      });
  }
}

export function createNativeBuildRecovery(
  state: NativeBuildState,
  transport: NativeBrokerTransport,
  options: { readonly now?: () => number; readonly jitter?: () => number } = {},
) {
  const now = options.now ?? Date.now;
  const inFlight = new Set<string>();
  const update = (jobId: string, mutate: (job: NativeRegistryJob) => void) =>
    state.transaction((draft) => {
      const job = draft.jobs.find((job) => job.jobId === jobId);
      if (!job) throw new Error("native-job-not-found");
      mutate(job);
    });
  const hold = (jobId: string, reason: NativeRecovery["lastReason"]) =>
    update(jobId, (job) => {
      job.recovery.state = "operator-required";
      job.recovery.lastReason = reason;
      job.recovery.nextAt =
        now() +
        300_000 +
        Math.floor(
          Math.max(0, Math.min(1, options.jitter?.() ?? Math.random())) *
            30_000,
        );
    });
  const generationOf = (job: NativeRegistryJob) => {
    const generation = state
      .snapshot()
      .generations.find((g) => g.id === job.generationId);
    if (!generation || generation.transport.hostId !== job.verifiedHostId)
      throw new Error("native-state-corrupt");
    return generation;
  };
  const round = async (
    job: NativeRegistryJob,
    generation: NativeGeneration,
    returned: boolean,
  ) => {
    const remaining = returned
      ? 150_000
      : Math.min(150_000, job.recovery.deadline - now());
    if (remaining <= 0) {
      await hold(job.jobId, "deadline");
      return;
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new NativeTransportError("unavailable"));
      }, remaining);
    });
    // Debit before IO. A crash can consume a round but cannot refund one.
    await update(job.jobId, (current) => {
      current.recovery.state = "cancel-requested";
      current.recovery.attempts++;
    });
    const send = async (command: string) => {
      if (abort.signal.aborted) throw new NativeTransportError("unavailable");
      const result = await transport.envelope(generation, command, job, {
        signal: abort.signal,
        timeout: remaining,
      });
      if (abort.signal.aborted) throw new NativeTransportError("unavailable");
      return result;
    };
    try {
      const result = await Promise.race([
        (async () => {
          const cancelled = await send(`cancel ${job.jobId}`);
          if (cancelled.kind !== "cancellation-requested")
            throw new NativeTransportError("protocol-mismatch");
          await update(job.jobId, (current) => {
            current.recovery.state = "reconciling";
          });
          const reconciled = await send(`reconcile ${job.jobId}`);
          if (reconciled.kind === "busy") return { reconciled };
          if (
            ["cleanup-required", "keychain-relock-pending"].includes(
              reconciled.kind,
            )
          )
            return { reconciled };
          if (
            !["reconciled-terminal", "reconciled-unknown"].includes(
              reconciled.kind,
            )
          )
            throw new NativeTransportError("protocol-mismatch");
          const receipt =
            reconciled.kind === "reconciled-terminal"
              ? await send(`status ${job.jobId}`)
              : undefined;
          if (
            receipt &&
            (receipt.kind !== "known" ||
              !["succeeded", "failed", "cancelled"].includes(
                receipt.state ?? "",
              ))
          )
            throw new NativeTransportError("protocol-mismatch");
          const health = await send("health");
          if (health.epoch !== reconciled.epoch || !cleanNativeHealth(health))
            throw new NativeTransportError("protocol-mismatch");
          return { reconciled, receipt };
        })(),
        timeout,
      ]);
      const { reconciled } = result;
      if (reconciled.kind === "busy") {
        if (returned) {
          await hold(job.jobId, "busy");
          return;
        }
        await update(job.jobId, (current) => {
          const recovery = current.recovery;
          recovery.state = "pending";
          recovery.attempts--;
          recovery.busySince ??= now();
          recovery.heartbeat =
            reconciled.runner?.heartbeat === undefined
              ? null
              : reconciled.runner.heartbeat * 1000;
          const fresh =
            recovery.heartbeat !== null &&
            now() - recovery.heartbeat >= 0 &&
            now() - recovery.heartbeat <= 60_000;
          if (!fresh) recovery.busyObservations++;
          recovery.lastReason = "busy";
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
      } else if (
        reconciled.kind === "cleanup-required" ||
        reconciled.kind === "keychain-relock-pending"
      )
        await hold(job.jobId, reconciled.kind);
      else {
        await update(job.jobId, (current) => {
          if (result.receipt) applyNativeReceipt(current, result.receipt);
          else if (!terminalNativeJob(current)) current.state = "interrupted";
          current.updatedAt = now();
          current.recovery.state = result.receipt
            ? "resolved-terminal"
            : "resolved-unknown";
          current.recovery.lastReason = result.receipt
            ? "none"
            : "unknown-on-broker";
          current.recovery.resolvedEpoch = reconciled.epoch ?? null;
        });
      }
    } catch (error) {
      const reason =
        error instanceof NativeTransportError ? error.reason : "unavailable";
      const fixed =
        reason === "needs-refresh" || reason === "host-key-mismatch"
          ? "missing-credentials"
          : reason;
      if (fixed !== "unavailable" || returned) {
        await hold(job.jobId, fixed);
        return;
      }
      await update(job.jobId, (current) => {
        const recovery = current.recovery;
        recovery.lastReason = "unavailable";
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
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abort.abort();
    }
  };
  const tick = async (jobId: string) => {
    if (inFlight.has(jobId)) return;
    const job = state.snapshot().jobs.find((job) => job.jobId === jobId);
    if (!job || !unresolvedRecovery(job) || job.recovery.nextAt > now()) return;
    const generation = generationOf(job);
    if (
      [...inFlight].some(
        (id) =>
          state.snapshot().jobs.find((j) => j.jobId === id)?.verifiedHostId ===
          job.verifiedHostId,
      )
    )
      return;
    inFlight.add(jobId);
    const release = state.retainGeneration(generation.id);
    try {
      if (!transport.hasCredential(generation.id)) {
        await hold(jobId, "missing-credentials");
        return;
      }
      if (job.recovery.state === "operator-required") {
        if (
          job.recovery.returnEventUsed ||
          !["unavailable", "busy"].includes(job.recovery.lastReason)
        )
          return;
        await update(jobId, (current) => {
          current.recovery.nextAt = now() + 300_000;
        });
        let health: BrokerEnvelope;
        try {
          health = await transport.envelope(generation, "health", undefined, {
            timeout: 30_000,
          });
        } catch (error) {
          if (
            error instanceof NativeTransportError &&
            error.reason !== "unavailable"
          )
            await hold(
              jobId,
              error.reason === "wrong-host"
                ? "wrong-host"
                : "protocol-mismatch",
            );
          return;
        }
        if (health.kind !== "health" || health.hostId !== job.verifiedHostId) {
          await hold(jobId, "wrong-host");
          return;
        }
        await update(jobId, (current) => {
          current.recovery.returnEventUsed = true;
        });
        await round(job, generation, true);
        return;
      }
      if (now() >= job.recovery.deadline) {
        await hold(jobId, "deadline");
        return;
      }
      await round(job, generation, false);
    } finally {
      release();
      inFlight.delete(jobId);
    }
  };
  return {
    tick,
    request: (jobId: string) =>
      update(jobId, (job) => {
        if (terminalNativeJob(job) && job.recovery.state === "not-required")
          return;
        if (job.state === "starting" && !job.imported) {
          job.state = "interrupted";
          job.updatedAt = now();
          return;
        }
        if (
          job.recovery.state === "operator-required" ||
          ["resolved-terminal", "resolved-unknown", "admin-resolved"].includes(
            job.recovery.state,
          )
        )
          return;
        job.recovery.state = "pending";
        if (!job.recovery.deadline) {
          job.recovery.deadline = now() + 900_000;
          job.recovery.nextAt = now();
        }
      }),
  };
}
