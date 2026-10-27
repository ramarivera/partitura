import { Schema } from "effect";

// Frozen persisted decoder from c8d86b8e1375752af4832078c4a0efedddf90a72.
// Keep this independent of current diagnostics to test actual downgrade compatibility.
const FailureFields = {
  failureCode: Schema.optionalKey(
    Schema.Literals([
      "host-key-unavailable",
      "cleanup-required",
      "unlock-failed",
      "host-capacity-unavailable",
      "workflow-failed",
    ]),
  ),
  stage: Schema.optionalKey(
    Schema.Literals([
      "capacity",
      "unlock",
      "clone",
      "boot",
      "workflow",
      "artifact",
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
export const LegacyJobSchema = Schema.Struct({
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
