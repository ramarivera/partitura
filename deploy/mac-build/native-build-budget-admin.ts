import { Effect } from "effect";
import { BuilderRegistryConfig } from "../../src/services/config-native-build.js";
import { NativeSecretAdmin } from "../../src/services/native-build-secret-admin.js";
import { NativeSecretError } from "../../src/services/native-build-secret-protocol.js";
import { NativeStateConfig } from "../../src/services/native-build-state-ownership.js";

export const runNativeBudgetAdmin = () => {
  const main = Effect.scoped(
    Effect.gen(function* () {
      const [command, ...args] = process.argv.slice(2);
      if (command !== "budget-initialize" && command !== "budget-repair")
        return yield* Effect.fail(
          NativeSecretError.new("provider-operation-invalid"),
        );
      const allowed = new Set([
        "--state-root",
        "--actor",
        "--reason",
        "--acknowledge",
        "--allocation-unused-evidence-file",
      ]);
      const values = new Map<string, string>();
      for (let index = 0; index < args.length; index++) {
        const key = args[index];
        if (!key || !allowed.has(key) || values.has(key))
          return yield* Effect.fail(
            NativeSecretError.new("provider-operation-invalid"),
          );
        if (key === "--acknowledge") values.set(key, "true");
        else {
          const value = args[++index];
          if (!value || value.startsWith("--"))
            return yield* Effect.fail(
              NativeSecretError.new("provider-operation-invalid"),
            );
          values.set(key, value);
        }
      }
      const stateRoot = values.get("--state-root");
      if (!stateRoot)
        return yield* Effect.fail(
          NativeSecretError.new("provider-operation-invalid"),
        );
      if (
        !Number.isSafeInteger(settings.dailyBudget) ||
        !Number.isSafeInteger(settings.hourlyBudget) ||
        settings.hourlyBudget <= 0 ||
        settings.dailyBudget < settings.hourlyBudget
      )
        return yield* Effect.fail(
          NativeSecretError.new("provider-budget-invalid"),
        );
      const service = yield* NativeSecretAdmin.pipe(
        Effect.provide(NativeSecretAdmin.layer),
      );
      return yield* service.setup(
        command === "budget-repair" ? "repair" : "initialize",
        values.get("--actor") ?? "",
        values.get("--reason") ?? "",
        values.has("--acknowledge"),
        values.get("--allocation-unused-evidence-file"),
      );
    }),
  );
  // Construct config at this process boundary without reading gateway secrets.
  const rootIndex = process.argv.indexOf("--state-root");
  const stateRoot = process.argv[rootIndex + 1] ?? "";
  const settings = {
    stateRoot,
    scratchRoot: "/unused",
    cacheRoot: "/unused",
    suffix: "xalda-procyon.ts.net",
    dailyBudget: Number(process.env.NATIVE_BUILD_OP_DAILY_BUDGET ?? "400"),
    hourlyBudget: Number(process.env.NATIVE_BUILD_OP_HOURLY_BUDGET ?? "200"),
    perBuilderBytes: 8 * 1024 ** 3,
    totalBytes: 32 * 1024 ** 3,
  };
  Effect.runPromise(
    main.pipe(
      Effect.provideService(BuilderRegistryConfig, settings),
      Effect.provideService(NativeStateConfig, {
        stateRoot,
        scratchRoot: "/unused",
        cacheRoot: "/unused",
        bytesPerBuilder: settings.perBuilderBytes,
        bytesTotal: settings.totalBytes,
      }),
      Effect.tap((result) =>
        Effect.sync(() => console.log(JSON.stringify(result))),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          console.error(
            error instanceof NativeSecretError
              ? error.code
              : "journal-repair-required",
          );
          process.exitCode = 1;
        }),
      ),
    ),
  ).catch(() => {
    console.error("journal-repair-required");
    process.exitCode = 1;
  });
};

if (import.meta.main) runNativeBudgetAdmin();
