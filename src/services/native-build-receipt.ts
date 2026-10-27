import type { NativeRegistryJob } from "./native-build-models.js";
import {
  type BrokerEnvelope,
  NativeTransportError,
} from "./native-build-protocol.js";
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
    throw NativeTransportError.new("protocol-mismatch");
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
      throw NativeTransportError.new("protocol-mismatch");
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
