import { Context, Effect, Layer } from "effect";
import { BuilderRegistryConfig } from "./config-native-build.js";
import { NativeSecretJournal } from "./native-build-secret-journal.js";
import {
  budgetFit,
  budgetLimits,
  day,
  hour,
  type SecretBucket,
} from "./native-build-secret-models.js";
import { NativeSecretError } from "./native-build-secret-protocol.js";

export class NativeSecretBudget extends Context.Service<NativeSecretBudget>()(
  "NativeSecretBudget",
  {
    make: Effect.gen(function* () {
      const journal = yield* NativeSecretJournal;
      const { dailyBudget: daily, hourlyBudget: hourly } =
        yield* BuilderRegistryConfig;
      return {
        reserve: Effect.fn("NativeSecretBudget.reserve")(
          (
            bucket: SecretBucket,
            units: number,
            source: string,
            org: string,
            now: number,
          ) =>
            journal
              .transaction((data, at) => {
                if (units !== 4 && units !== 12)
                  throw NativeSecretError.new("provider-budget-invalid");
                let fit = Math.max(
                  at,
                  data.providerBackoff,
                  data.cooldowns[source] ?? 0,
                  bucket === "bootstrap" || bucket === "retry"
                    ? data.startupBackoff
                    : 0,
                  budgetFit(data, daily, hourly, bucket, units, at),
                );
                if (bucket === "agent") {
                  const attempts = data.agentAttempts.filter(
                    (attempt) => attempt.org === org && attempt.at > at - day,
                  );
                  if (attempts.length >= 5)
                    fit = Math.max(fit, (attempts[0]?.at ?? at) + day);
                }
                if (fit > at) return { allowed: false, nextFit: fit };
                if (
                  data.charges.length >= 10000 ||
                  data.agentAttempts.length >= 10000
                )
                  throw NativeSecretError.new(
                    "provider-budget-exhausted",
                    at + day,
                  );
                data.charges.push({ at, bucket, units, org });
                data.cooldowns[source] = at + 60000;
                if (bucket === "agent") data.agentAttempts.push({ at, org });
                return { allowed: true, nextFit: at };
              }, now)
              .pipe(
                Effect.flatMap((result) =>
                  result.allowed
                    ? Effect.void
                    : Effect.fail(
                        NativeSecretError.new(
                          "provider-budget-exhausted",
                          result.nextFit,
                        ),
                      ),
                ),
              ),
        ),
        startupCycle: Effect.fn("NativeSecretBudget.startupCycle")(
          (now: number) =>
            journal.transaction((data, at) => {
              if (data.startupBackoff > at) return data.startupBackoff;
              if (data.cycles.length >= 3) {
                data.startupBackoff = (data.cycles.at(-1) ?? at) + 1800000;
                return data.startupBackoff;
              }
              data.cycles.push(at);
              return at;
            }, now),
        ),
        capacity: Effect.fn("NativeSecretBudget.capacity")(
          (sources: number, pendingUnits: number, now: number) =>
            journal.transaction((data, at) => {
              const cost = sources === 0 ? 0 : 8 + 4 * sources;
              const [dailyLimit, hourlyLimit] = budgetLimits(
                daily,
                hourly,
                "bootstrap",
              );
              const remaining = (window: number, limit: number) =>
                Math.max(
                  0,
                  limit -
                    data.charges
                      .filter(
                        (charge) =>
                          charge.bucket === "bootstrap" &&
                          charge.at > at - window,
                      )
                      .reduce((sum, charge) => sum + charge.units, 0) -
                    pendingUnits,
                );
              return {
                cost,
                sufficient:
                  cost === 0 ||
                  (dailyLimit >= 4 * cost && hourlyLimit >= 2 * cost),
                dailyColdStarts:
                  cost === 0
                    ? null
                    : Math.floor(remaining(day, dailyLimit) / cost),
                hourlyColdStarts:
                  cost === 0
                    ? null
                    : Math.floor(remaining(hour, hourlyLimit) / cost),
              };
            }, now),
        ),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
