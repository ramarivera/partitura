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
const ArtifactSha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const ArtifactBytes = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(2147483648),
);
const ArtifactFields = {
  artifactSha256: Schema.optionalKey(ArtifactSha256),
  artifactBytes: Schema.optionalKey(ArtifactBytes),
};
// A failed workflow may carry the repository's own logs as its artifact.
export const FailedReceiptSchema = Schema.Struct({
  ...FailureFields,
  ...ArtifactFields,
  state: Schema.Literal("failed"),
});
export const SucceededReceiptSchema = Schema.Struct({
  state: Schema.Literal("succeeded"),
  artifactSha256: ArtifactSha256,
  artifactBytes: ArtifactBytes,
});
// Running evidence can identify a stage, but cannot claim a terminal diagnostic
// or artifact. Validate it before resetting the unavailable-lookup budget.
export const RunningReceiptSchema = Schema.Struct({
  state: Schema.Literal("running"),
  stage: FailureFields.stage,
  failureCode: Schema.optionalKey(Schema.Never),
  artifactSha256: Schema.optionalKey(Schema.Never),
  artifactBytes: Schema.optionalKey(Schema.Never),
  bootExitCode: Schema.optionalKey(Schema.Never),
  workflowExitCode: Schema.optionalKey(Schema.Never),
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
