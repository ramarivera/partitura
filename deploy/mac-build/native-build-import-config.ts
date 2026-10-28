import { isAbsolute, resolve } from "node:path";
import { Schema } from "effect";
import { TransportMetadata } from "../../src/services/native-build-models.js";

const Path = Schema.String.check(Schema.isMinLength(1));
const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Owner = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  organizationId: Schema.String.check(Schema.isMinLength(1)),
  pullRequest: Positive,
  repositoryId: Schema.String.check(Schema.isMinLength(1)),
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
});
export const NativeImportOwners = Schema.Struct({
  originalOwners: Schema.Record(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
    Owner,
  ),
  unresolved: Schema.Array(Schema.Never),
});
export const NativeImportPlan = Schema.Struct({
  databasePath: Path,
  ownerSnapshotPath: Path,
  stateRoot: Path,
  scratchRoot: Path,
  cacheRoot: Path,
  otherRoots: Schema.Array(Path).check(Schema.isMinLength(1)),
  bytesPerBuilder: Positive,
  bytesTotal: Positive,
  suffix: Schema.String.check(Schema.isMinLength(1)),
  slots: Schema.Array(
    Schema.Struct({
      builderId: Schema.String.check(
        Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/u),
      ),
      legacyRoot: Path,
      privateKeyPath: Path,
      transport: TransportMetadata,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
});
export type NativeImportPlan = typeof NativeImportPlan.Type;
export const decodeNativeImportPlan = (value: unknown) => {
  const plan = Schema.decodeUnknownSync(NativeImportPlan)(value, {
    onExcessProperty: "error",
  });
  const paths = [
    plan.databasePath,
    plan.ownerSnapshotPath,
    plan.stateRoot,
    plan.scratchRoot,
    plan.cacheRoot,
    ...plan.otherRoots,
    ...plan.slots.flatMap((slot) => [slot.legacyRoot, slot.privateKeyPath]),
  ];
  if (
    paths.some((path) => !isAbsolute(path) || resolve(path) !== path) ||
    plan.bytesPerBuilder > plan.bytesTotal ||
    new Set(plan.slots.map((slot) => slot.builderId)).size !== plan.slots.length
  )
    throw new Error("invalid-native-import-plan");
  return plan;
};
