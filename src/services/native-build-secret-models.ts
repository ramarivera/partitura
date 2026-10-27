import { Schema } from "effect";

export const SecretBucket = Schema.Literals([
  "bootstrap",
  "retry",
  "human",
  "agent",
]);
export type SecretBucket = typeof SecretBucket.Type;
export const allocations = {
  bootstrap: [160, 80],
  retry: [80, 40],
  human: [120, 60],
  agent: [40, 20],
} as const;
export const SourceStatus = Schema.Literals([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cached-noop",
  "superseded",
]);
const Integer = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
export const SecretSource = Schema.Struct({
  source: Schema.String.check(
    Schema.isPattern(
      /^(?:onepassword:[a-z0-9]{26}:[a-z0-9]{26}|file:[a-z][a-z0-9-]{0,62}\.json)$/u,
    ),
  ),
  revision: Integer,
  builderId: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/u)),
  retained: Schema.Boolean,
});
export type SecretSource = typeof SecretSource.Type;
export const SecretWork = Schema.Struct({
  ...SecretSource.fields,
  createdAt: Integer,
  deadline: Integer,
  status: SourceStatus,
  attempts: Integer,
  nextFit: Integer,
  readStartedAt: Schema.optionalKey(Integer),
  completedAt: Schema.optionalKey(Integer),
  code: Schema.optionalKey(Schema.String),
});
export const SecretOperation = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["startup", "registry", "human", "agent"]),
  org: Schema.String,
  acceptedAt: Integer,
  deadline: Integer,
  all: Schema.Boolean,
  sources: Schema.Array(SecretWork).check(Schema.isMaxLength(320)),
});
export const SecretJournalData = Schema.Struct({
  version: Schema.Literal(1),
  highWater: Integer,
  providerBackoff: Integer,
  charges: Schema.Array(
    Schema.Struct({
      at: Integer,
      bucket: SecretBucket,
      units: Integer,
      org: Schema.String,
    }),
  ).check(Schema.isMaxLength(10000)),
  cooldowns: Schema.Record(Schema.String, Integer),
  successes: Schema.Record(Schema.String, Integer),
  startupStops: Schema.Record(
    Schema.String,
    Schema.Struct({
      code: Schema.String,
      createdAt: Integer,
      deadline: Integer,
      attempts: Integer,
      nextFit: Integer,
    }),
  ),
  submissions: Schema.Array(
    Schema.Struct({ at: Integer, org: Schema.String, all: Schema.Boolean }),
  ).check(Schema.isMaxLength(10000)),
  agentAttempts: Schema.Array(
    Schema.Struct({ at: Integer, org: Schema.String }),
  ).check(Schema.isMaxLength(10000)),
  cycles: Schema.Array(Integer).check(Schema.isMaxLength(10000)),
  startupBackoff: Integer,
  operations: Schema.Array(SecretOperation).check(Schema.isMaxLength(128)),
  audit: Schema.Array(
    Schema.Struct({
      at: Integer,
      actor: Schema.String,
      reason: Schema.String,
      action: Schema.Literals(["initialize", "repair"]),
    }),
  ).check(Schema.isMaxLength(128)),
});
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer A)[]
    ? Mutable<A>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};
export type SecretJournalData = Mutable<typeof SecretJournalData.Type>;
export type SecretOperation = SecretJournalData["operations"][number];
export type SecretWork = SecretOperation["sources"][number];
export const hour = 3600000,
  day = 24 * hour,
  sourceCooldown = 60000;
export function emptySecretJournal(at: number): SecretJournalData {
  return {
    version: 1,
    highWater: at,
    providerBackoff: 0,
    charges: [],
    cooldowns: {},
    successes: {},
    startupStops: {},
    submissions: [],
    agentAttempts: [],
    cycles: [],
    startupBackoff: 0,
    operations: [],
    audit: [],
  };
}
export function pruneSecretJournal(data: SecretJournalData, wallTime: number) {
  const at = Math.max(data.highWater, Math.floor(wallTime));
  data.highWater = at;
  data.charges = data.charges.filter((charge) => charge.at > at - day);
  data.agentAttempts = data.agentAttempts.filter(
    (attempt) => attempt.at > at - day,
  );
  data.submissions = data.submissions.filter((call) => call.at > at - 300000);
  data.cycles = data.cycles.filter((cycle) => cycle > at - 900000);
  data.operations = data.operations.filter(
    (operation) =>
      operation.sources.some(
        (work) => work.status === "pending" || work.status === "running",
      ) || operation.acceptedAt > at - day,
  );
  for (const [source, until] of Object.entries(data.cooldowns))
    if (until <= at) delete data.cooldowns[source];
  return at;
}
export function budgetLimits(
  daily: number,
  hourly: number,
  bucket: SecretBucket,
) {
  const [d, h] = allocations[bucket];
  // Custom allocations retain disjoint proportions and never silently grow.
  return [
    Math.floor((daily * d) / 400),
    Math.floor((hourly * h) / 200),
  ] as const;
}
export function budgetFit(
  data: SecretJournalData,
  daily: number,
  hourly: number,
  bucket: SecretBucket,
  units: number,
  at: number,
) {
  const limits = budgetLimits(daily, hourly, bucket);
  let fit = at;
  for (const [window, limit, own] of [
    [day, daily, false],
    [hour, hourly, false],
    [day, limits[0], true],
    [hour, limits[1], true],
  ] as const) {
    const charges = data.charges
      .filter(
        (charge) =>
          (!own || charge.bucket === bucket) && charge.at > at - window,
      )
      .sort((a, b) => a.at - b.at);
    let used = charges.reduce((sum, charge) => sum + charge.units, 0);
    if (units > limit) return Number.MAX_SAFE_INTEGER;
    for (const charge of charges) {
      if (used + units <= limit) break;
      fit = Math.max(fit, charge.at + window);
      used -= charge.units;
    }
  }
  return fit;
}
