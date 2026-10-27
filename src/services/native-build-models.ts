import { Schema } from "effect";
import { builderId } from "./native-build-file-io.js";
import {
  FleetMetadata,
  type MutableFleetMetadata,
} from "./native-build-fleet-models.js";

const Id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
const Name = Schema.String.check(Schema.isPattern(builderId));
const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
export const TransportMetadata = Schema.Struct({
  source: Text,
  hostId: Schema.String.check(
    Schema.isPattern(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u,
    ),
  ),
  hostname: Text,
  sshUser: Text,
  port: Count,
  hostKeys: Schema.Array(
    Schema.Struct({
      type: Text,
      base64: Schema.String.check(Schema.isMaxLength(8192)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});
export type NativeTransportMetadata = typeof TransportMetadata.Type;
const Generation = Schema.Struct({
  id: Id,
  builderId: Name,
  transport: TransportMetadata,
  equalityTag: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  createdAt: Count,
});
export type NativeGeneration = typeof Generation.Type;
export const Recovery = Schema.Struct({
  state: Schema.Literals([
    "not-required",
    "pending",
    "cancel-requested",
    "reconciling",
    "resolved-terminal",
    "resolved-unknown",
    "operator-required",
    "admin-resolved",
  ]),
  attempts: Count,
  busyObservations: Count,
  deadline: Count,
  nextAt: Count,
  busySince: Schema.NullOr(Count),
  lastReason: Schema.Literals([
    "none",
    "unavailable",
    "busy",
    "deadline",
    "wrong-host",
    "protocol-mismatch",
    "missing-credentials",
    "cleanup-required",
    "keychain-relock-pending",
    "unknown-on-broker",
  ]),
  heartbeat: Schema.NullOr(Count),
  returnEventUsed: Schema.Boolean,
  returnEligible: Schema.optionalKey(Schema.Boolean),
  observation: Schema.optionalKey(
    Schema.Literals([
      "unavailable",
      "broker-state-unavailable",
      "needs-refresh",
      "host-key-mismatch",
      "credentials-pending",
      "credentials-failed",
    ]),
  ),
  resolvedEpoch: Schema.NullOr(Id),
});
export type NativeRecovery = {
  -readonly [K in keyof typeof Recovery.Type]: (typeof Recovery.Type)[K];
};
export const RegistryJob = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Id,
  organizationId: Text,
  sessionId: Text,
  builderId: Name,
  generationId: Id,
  verifiedHostId: Text,
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  pullRequest: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(99_999_999),
  ),
  action: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u)),
  attempt: Id,
  epoch: Id,
  submissionExpiresAt: Count,
  state: Schema.Literals([
    "starting",
    "submitting",
    "running",
    "succeeded",
    "failed",
    "interrupted",
  ]),
  recovery: Recovery,
  createdAt: Count,
  updatedAt: Count,
  artifactSha256: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  ),
  artifactBytes: Schema.optionalKey(Count),
  artifactExpired: Schema.optionalKey(Schema.Boolean),
  failureCode: Schema.optionalKey(Text),
  stage: Schema.optionalKey(Text),
  imported: Schema.optionalKey(Schema.Boolean),
  importBinding: Schema.optionalKey(
    Schema.Struct({
      sourceRoot: Schema.String,
      recordSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      artifact: Schema.Literals([
        "none",
        "remote-only",
        "copy-pending",
        "cached",
      ]),
    }),
  ),
});
export type NativeRegistryJob = {
  -readonly [K in keyof typeof RegistryJob.Type]: (typeof RegistryJob.Type)[K];
} & { recovery: NativeRecovery };
export const Metadata = Schema.Struct({
  version: Schema.Literal(1),
  generations: Schema.Array(Generation),
  jobs: Schema.Array(RegistryJob),
  fleet: Schema.optionalKey(FleetMetadata),
});
export type MetadataValue = {
  version: 1;
  generations: NativeGeneration[];
  jobs: NativeRegistryJob[];
  fleet?: MutableFleetMetadata;
};
export const newRecovery = (): NativeRecovery => ({
  state: "not-required",
  attempts: 0,
  busyObservations: 0,
  deadline: 0,
  nextAt: 0,
  busySince: null,
  lastReason: "none",
  heartbeat: null,
  returnEventUsed: false,
  resolvedEpoch: null,
});
export const unresolvedRecovery = (job: NativeRegistryJob) =>
  ["pending", "cancel-requested", "reconciling", "operator-required"].includes(
    job.recovery.state,
  );
export const terminalNativeJob = (job: NativeRegistryJob) =>
  ["succeeded", "failed", "interrupted"].includes(job.state);
export const nativeLimits = {
  bundle: 1024 ** 3,
  artifact: 2 * 1024 ** 3,
  overhead: 65_536,
  retention: 30 * 86400_000,
};

export interface NativeStateOptions {
  readonly stateRoot: string;
  readonly scratchRoot: string;
  readonly cacheRoot: string;
  /** All supplied legacy/file-secret/workspace roots. Assembly must supply the complete set. */
  readonly otherRoots?: readonly string[];
  readonly bytesPerBuilder: number;
  readonly bytesTotal: number;
  readonly freeMargin?: number;
  /** Hermetic filesystem adapter. Production defaults to statfs. */
  readonly filesystem?: (
    path: string,
  ) => Promise<{ type: number; bavail: number; bsize: number }>;
}
