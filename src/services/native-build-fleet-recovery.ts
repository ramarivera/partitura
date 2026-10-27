import { Clock, Context, Effect, Exit, Layer } from "effect";
import { BuilderRegistry } from "./builder-registry.js";
import { nativeTry } from "./native-build-errors.js";
import { opaqueId } from "./native-build-file-io.js";
import {
  emptyFleetMetadata,
  type FleetAction,
  type FleetActor,
  NativeFleetError,
} from "./native-build-fleet-models.js";
import { observeNativeMaintenance } from "./native-build-maintenance.js";
import {
  applyNativeReceipt,
  cleanNativeHealth,
} from "./native-build-receipt.js";
import {
  NativeBuildStateService,
  terminalNativeJob,
  unresolvedRecovery,
} from "./native-build-state.js";
import {
  type BrokerEnvelope,
  NativeBuildTransport,
} from "./native-build-transport.js";

/** Human-only current-key override. Never changes original generation/ownership. */
export class NativeBuildFleetRecovery extends Context.Service<NativeBuildFleetRecovery>()(
  "NativeBuildFleetRecovery",
  {
    make: Effect.gen(function* () {
      const registry = yield* BuilderRegistry;
      const state = yield* NativeBuildStateService;
      const transport = yield* NativeBuildTransport;
      const clock = yield* Clock.Clock;
      const now = () => clock.currentTimeMillisUnsafe();
      const observe = Effect.fn("NativeBuildFleetRecovery.observe")(
        (builderId: string, health: BrokerEnvelope) =>
          observeNativeMaintenance(state, builderId, health),
      );
      const act = Effect.fn("NativeBuildFleetRecovery.act")(function* (
        actor: FleetActor,
        builderId: string,
        input: FleetAction & { readonly evidenceReference?: string },
        action: "reconcile" | "decommission",
      ) {
        if (actor.kind !== "human")
          return yield* Effect.fail(
            NativeFleetError.new("fleet-forbidden", 403),
          );
        const hostId = input.expectedHostId;
        if (action === "decommission" && !input.evidenceReference)
          return yield* Effect.fail(
            NativeFleetError.new("fleet-invalid-request", 400),
          );
        const current = registry.current(builderId);
        const snapshot = state.snapshot();
        if (
          action === "reconcile" &&
          (!current?.identity ||
            current.credential?.transport.hostId !== hostId ||
            current.identity.health.hostId !== hostId)
        )
          return yield* Effect.fail(
            NativeFleetError.new("fleet-host-conflict", 409),
          );
        if (new Set(input.recoveryIds).size !== input.recoveryIds.length)
          return yield* Effect.fail(
            NativeFleetError.new("fleet-invalid-request", 400),
          );
        const selected = input.recoveryIds.map((id) => {
          const job = snapshot.jobs.find(
            (job) => job.jobId === id && unresolvedRecovery(job),
          );
          const maintenance = snapshot.fleet?.maintenance.find(
            (item) => item.id === id && item.state === "pending",
          );
          return { id, job, maintenance };
        });
        // Unknown markers belong to the verified physical host. builderId is observation provenance only.
        if (
          selected.some(({ job, maintenance }) =>
            job
              ? job.verifiedHostId !== hostId || job.builderId !== builderId
              : !maintenance || maintenance.hostId !== hostId,
          )
        )
          return yield* Effect.fail(
            NativeFleetError.new("fleet-recovery-conflict", 409),
          );
        if (
          action === "decommission" &&
          current?.credential?.transport.hostId !== hostId &&
          !selected.some(
            ({ job, maintenance }) =>
              job?.builderId === builderId || maintenance?.hostId === hostId,
          )
        )
          return yield* Effect.fail(
            NativeFleetError.new("fleet-recovery-conflict", 409),
          );
        return yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.suspend(() => {
                const release = state.claimRecovery(hostId);
                return release
                  ? Effect.succeed(release)
                  : Effect.fail(NativeFleetError.new("fleet-host-busy", 409));
              }),
              (release) => Effect.sync(release),
            );
            const before = selected.map(
              ({ job, maintenance }) =>
                job?.recovery.state ?? maintenance?.state ?? "pending",
            );
            const auditId = opaqueId();
            let epoch: string | undefined;
            const audit = (
              outcome:
                | "pending"
                | "admin-resolved"
                | "abandoned-unverified"
                | "failed",
            ) => ({
              id: auditId,
              at: now(),
              actor: actor.sessionHash,
              organizationId: actor.organizationId,
              builderId,
              hostId,
              recoveryIds: [...input.recoveryIds],
              action,
              reason: input.reason,
              before,
              outcome,
              after:
                outcome === "failed" || outcome === "pending"
                  ? before
                  : selected.map(() =>
                      action === "reconcile"
                        ? "admin-resolved"
                        : "abandoned-unverified",
                    ),
              ...(input.evidenceReference === undefined
                ? {}
                : { evidenceReference: input.evidenceReference }),
              ...(epoch === undefined ? {} : { epoch }),
            });
            const run = Effect.gen(function* () {
              const at = now();
              yield* state.transaction((draft) => {
                draft.fleet ??= emptyFleetMetadata();
                const fleet = draft.fleet;
                if (
                  fleet.starts.some(
                    (start) => start.hostId === hostId && start.at > at - 60000,
                  )
                )
                  throw NativeFleetError.new("fleet-rate-limited", 429);
                fleet.starts = fleet.starts.filter(
                  (start) => start.at > at - 60000,
                );
                if (fleet.starts.length >= 256)
                  throw NativeFleetError.new("fleet-capacity", 409);
                fleet.starts.push({ hostId, at });
                fleet.audit = [...fleet.audit.slice(-511), audit("pending")];
              });
              if (action === "reconcile") {
                const generation = current?.identity?.generation;
                if (!generation)
                  return yield* Effect.fail(
                    NativeFleetError.new("fleet-current-key-unavailable"),
                  );
                yield* Effect.acquireRelease(
                  nativeTry(() => state.retainGeneration(generation.id)),
                  (release) => Effect.sync(release),
                );
                for (const { job, maintenance } of selected) {
                  // Maintenance obligations deliberately have no tenant or execution record.
                  const binding = job ?? { jobId: maintenance?.jobId ?? "" };
                  const send = (command: string) =>
                    transport.envelope(generation, command, binding, {
                      timeout: 30000,
                    });
                  const cancel = yield* send(`cancel ${binding.jobId}`);
                  if (cancel.kind !== "cancellation-requested")
                    return yield* Effect.fail(
                      NativeFleetError.new("fleet-cleanup-conflict", 409),
                    );
                  const clean = yield* send(`reconcile ${binding.jobId}`);
                  if (
                    !["reconciled-terminal", "reconciled-unknown"].includes(
                      clean.kind,
                    ) ||
                    !clean.epoch
                  )
                    return yield* Effect.fail(
                      NativeFleetError.new("fleet-cleanup-conflict", 409),
                    );
                  if (job && clean.kind === "reconciled-terminal") {
                    const receipt = yield* send(`status ${binding.jobId}`);
                    if (
                      receipt.kind !== "known" ||
                      !["succeeded", "failed", "cancelled"].includes(
                        receipt.state ?? "",
                      )
                    )
                      return yield* Effect.fail(
                        NativeFleetError.new("fleet-cleanup-conflict", 409),
                      );
                    yield* state.transaction((draft) => {
                      const target = draft.jobs.find(
                        (candidate) => candidate.jobId === job.jobId,
                      );
                      if (!target)
                        throw NativeFleetError.new(
                          "fleet-recovery-conflict",
                          409,
                        );
                      applyNativeReceipt(target, receipt);
                    });
                  }
                  const health = yield* transport.envelope(
                    generation,
                    "health",
                    undefined,
                    { timeout: 30000 },
                  );
                  if (
                    health.hostId !== hostId ||
                    health.epoch !== clean.epoch ||
                    !cleanNativeHealth(health)
                  )
                    return yield* Effect.fail(
                      NativeFleetError.new("fleet-cleanup-conflict", 409),
                    );
                  epoch = clean.epoch;
                }
              }
              yield* state.transaction((draft) => {
                draft.fleet ??= emptyFleetMetadata();
                const fleet = draft.fleet;
                if (
                  action === "decommission" &&
                  !fleet.retiredHosts.includes(hostId)
                ) {
                  if (fleet.retiredHosts.length >= 256)
                    throw NativeFleetError.new("fleet-capacity", 409);
                  fleet.retiredHosts.push(hostId);
                }
                for (const { id } of selected) {
                  const job = draft.jobs.find(
                    (candidate) => candidate.jobId === id,
                  );
                  if (job) {
                    if (
                      job.verifiedHostId !== hostId ||
                      !unresolvedRecovery(job)
                    )
                      throw NativeFleetError.new(
                        "fleet-recovery-conflict",
                        409,
                      );
                    job.recovery.state = "admin-resolved";
                    job.recovery.resolvedEpoch = epoch ?? null;
                    job.updatedAt = now();
                    if (!terminalNativeJob(job)) job.state = "interrupted";
                    if (action === "decommission")
                      job.failureCode = "abandoned-unverified";
                  } else {
                    const index = fleet.maintenance.findIndex(
                      (item) => item.id === id && item.state === "pending",
                    );
                    const item = fleet.maintenance[index];
                    if (!item)
                      throw NativeFleetError.new(
                        "fleet-recovery-conflict",
                        409,
                      );
                    fleet.maintenance[index] = {
                      ...item,
                      state:
                        action === "reconcile"
                          ? "admin-resolved"
                          : "abandoned-unverified",
                    };
                  }
                }
                fleet.audit = [
                  ...fleet.audit
                    .filter((item) => item.id !== auditId)
                    .slice(-511),
                  audit(
                    action === "reconcile"
                      ? "admin-resolved"
                      : "abandoned-unverified",
                  ),
                ];
              });
              // Durable resolution comes first; remove quota-charged inputs just as automatic recovery does.
              for (const { job } of selected)
                if (job)
                  yield* state.remove(`${state.jobPath(job)}/source.bundle`);
              return {
                outcome:
                  action === "reconcile"
                    ? "admin-resolved"
                    : "abandoned-unverified",
                ...(epoch === undefined ? {} : { epoch }),
              };
            });
            return yield* run.pipe(
              Effect.timeoutOrElse({
                duration: 150000,
                orElse: () =>
                  Effect.fail(NativeFleetError.new("fleet-unavailable")),
              }),
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? state
                      .transaction((draft) => {
                        const pending = draft.fleet?.audit.find(
                          (item) =>
                            item.id === auditId && item.outcome === "pending",
                        );
                        if (!pending || !draft.fleet) return;
                        draft.fleet.audit = draft.fleet.audit.map((item) =>
                          item.id === auditId ? audit("failed") : item,
                        );
                      })
                      .pipe(Effect.uninterruptible)
                  : Effect.void,
              ),
            );
          }),
        ).pipe(
          Effect.mapError((error) =>
            error instanceof NativeFleetError
              ? error
              : "cause" in error && error.cause instanceof NativeFleetError
                ? error.cause
                : NativeFleetError.new("fleet-unavailable"),
          ),
        );
      });
      return { act, observe };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies;
}
