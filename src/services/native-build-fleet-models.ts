import { Schema } from "effect";

export const FleetBuilderId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/u),
);
export const FleetOpaqueId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{32}$/u),
);
export const FleetHostId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u),
);
export const FleetRefresh = Schema.Union([
  Schema.Struct({ scope: Schema.Literal("builder"), builder: FleetBuilderId }),
  Schema.Struct({ scope: Schema.Literal("all") }),
]);
export const FleetReconcile = Schema.Struct({
  expectedHostId: FleetHostId,
  recoveryIds: Schema.Array(FleetOpaqueId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export const FleetDecommission = Schema.Struct({
  ...FleetReconcile.fields,
  evidenceReference: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(512),
  ),
  acknowledgeUnverifiedCleanup: Schema.Literal(true),
});
export type FleetAction = typeof FleetReconcile.Type;
export interface FleetActor {
  readonly kind: "human" | "agent";
  readonly organizationId: string;
  readonly sessionHash: string;
}
export class NativeFleetError extends Schema.TaggedError<NativeFleetError>()(
  "@Gateway/NativeFleetError",
  {
    code: Schema.String,
    status: Schema.Literals([400, 403, 404, 409, 429, 503]),
  },
) {
  static readonly new = (
    code: string,
    status: NativeFleetError["status"] = 503,
  ) => new NativeFleetError({ code, status });
}
const Audit = Schema.Struct({
  id: FleetOpaqueId,
  at: Schema.Number,
  actor: Schema.String,
  organizationId: Schema.String,
  builderId: FleetBuilderId,
  hostId: FleetHostId,
  recoveryIds: Schema.Array(FleetOpaqueId),
  action: Schema.Literals(["reconcile", "decommission"]),
  reason: Schema.String,
  evidenceReference: Schema.optionalKey(Schema.String),
  before: Schema.Array(Schema.String),
  after: Schema.Array(Schema.String),
  outcome: Schema.Literals([
    "pending",
    "admin-resolved",
    "abandoned-unverified",
    "failed",
  ]),
  epoch: Schema.optionalKey(FleetOpaqueId),
});
export const FleetMetadata = Schema.Struct({
  retiredHosts: Schema.Array(FleetHostId).check(Schema.isMaxLength(256)),
  maintenance: Schema.Array(
    Schema.Struct({
      id: FleetOpaqueId,
      builderId: FleetBuilderId,
      hostId: FleetHostId,
      jobId: FleetOpaqueId,
      state: Schema.Literals([
        "pending",
        "admin-resolved",
        "abandoned-unverified",
      ]),
    }),
  ).check(Schema.isMaxLength(256)),
  starts: Schema.Array(
    Schema.Struct({ hostId: FleetHostId, at: Schema.Number }),
  ).check(Schema.isMaxLength(256)),
  audit: Schema.Array(Audit).check(Schema.isMaxLength(512)),
});
export type MutableFleetMetadata = {
  -readonly [K in keyof typeof FleetMetadata.Type]: Array<
    (typeof FleetMetadata.Type)[K][number]
  >;
};
export const emptyFleetMetadata = (): MutableFleetMetadata => ({
  retiredHosts: [],
  maintenance: [],
  starts: [],
  audit: [],
});
