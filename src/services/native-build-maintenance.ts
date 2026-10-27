import { Effect } from "effect";
import { opaqueId } from "./native-build-file-io.js";
import {
  emptyFleetMetadata,
  NativeFleetError,
} from "./native-build-fleet-models.js";
import type { NativeBuildState } from "./native-build-state.js";
import type { BrokerEnvelope } from "./native-build-transport.js";

/** Shared by initial verification and explicit cached checks, without a registry
 * dependency. Unknown broker markers never acquire tenant/execution ownership. */
export const observeNativeMaintenance = Effect.fn(
  "NativeBuildState.observeMaintenance",
)(function* (
  state: NativeBuildState,
  builderId: string,
  health: BrokerEnvelope,
) {
  if (health.kind !== "health" || !health.maintenanceJobId) return;
  yield* state.transaction((draft) => {
    if (
      draft.jobs.some(
        (job) =>
          job.jobId === health.maintenanceJobId &&
          job.verifiedHostId === health.hostId,
      )
    )
      return;
    draft.fleet ??= emptyFleetMetadata();
    const fleet = draft.fleet;
    const index = fleet.maintenance.findIndex(
      (item) =>
        item.hostId === health.hostId && item.jobId === health.maintenanceJobId,
    );
    const existing = fleet.maintenance[index];
    if (existing) {
      fleet.maintenance[index] = { ...existing, state: "pending" };
      return;
    }
    // The bound is on live obligations. Completed history is already audited.
    fleet.maintenance = fleet.maintenance.filter(
      (item) => item.state === "pending",
    );
    if (fleet.maintenance.length >= 256)
      throw NativeFleetError.new("fleet-capacity", 409);
    fleet.maintenance.push({
      id: opaqueId(),
      builderId,
      hostId: health.hostId,
      jobId: health.maintenanceJobId ?? "",
      state: "pending",
    });
  });
});
