import { Schema } from "effect";

const FailureFields = {
  failureCode: Schema.optionalKey(
    Schema.Literals([
      "host-key-unavailable",
      "cleanup-required",
      "unlock-failed",
      "host-capacity-unavailable",
      "host-disk-space-unavailable",
      "workflow-failed",
      "execution-interrupted",
      "receive-interrupted",
      "keychain-policy-unavailable",
    ]),
  ),
  stage: Schema.optionalKey(
    Schema.Literals([
      "capacity",
      "disk-preflight",
      "disk-post-transfer",
      "unlock",
      "clone",
      "boot",
      "workflow",
      "artifact",
      "cleanup",
      "receiving",
      "keychain-policy",
    ]),
  ),
  bootExitCode: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(-255),
      Schema.isLessThanOrEqualTo(255),
    ),
  ),
  workflowExitCode: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(-255),
      Schema.isLessThanOrEqualTo(255),
    ),
  ),
};
const ArtifactFields = {
  artifactSha256: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  ),
  artifactBytes: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(2147483648),
    ),
  ),
};
// A failed workflow may carry the repository's own logs as its artifact.
export const FailedReceiptSchema = Schema.Struct({
  ...FailureFields,
  ...ArtifactFields,
  state: Schema.Literal("failed"),
});
export const NativeBuildJobSchema = Schema.Struct({
  ...FailureFields,
  job: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  sessionId: Schema.String,
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  action: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u)),
  state: Schema.Literals([
    "starting",
    "running",
    "succeeded",
    "failed",
    "interrupted",
  ]),
  ...ArtifactFields,
});
export type NativeBuildJob = {
  -readonly [K in keyof typeof NativeBuildJobSchema.Type]: (typeof NativeBuildJobSchema.Type)[K];
};

/** Shared by receipt ingress, persisted records and the offline rollback tool. */
export function validateNativeBuildDiagnostics(
  failure: Omit<typeof FailedReceiptSchema.Type, "state">,
) {
  if (
    (failure.failureCode === "host-key-unavailable" &&
      failure.stage !== "boot") ||
    (failure.failureCode === "execution-interrupted" &&
      failure.stage !== "cleanup") ||
    (failure.failureCode === "receive-interrupted" &&
      failure.stage !== "receiving") ||
    (failure.failureCode === "keychain-policy-unavailable" &&
      failure.stage !== "keychain-policy") ||
    (failure.failureCode === "unlock-failed" && failure.stage !== "unlock") ||
    (failure.failureCode === "host-capacity-unavailable" &&
      failure.stage !== "capacity") ||
    (failure.failureCode === "host-disk-space-unavailable") !==
      (failure.stage === "disk-preflight" ||
        failure.stage === "disk-post-transfer") ||
    (failure.bootExitCode !== undefined && failure.stage !== "boot") ||
    (failure.failureCode === "workflow-failed" &&
      failure.stage !== "workflow") ||
    (failure.workflowExitCode !== undefined &&
      failure.failureCode !== "workflow-failed") ||
    ((failure.artifactSha256 !== undefined ||
      failure.artifactBytes !== undefined) &&
      (failure.failureCode !== "workflow-failed" ||
        failure.artifactSha256 === undefined ||
        failure.artifactBytes === undefined))
  )
    throw new Error("Inconsistent native build failure diagnostic");
}
