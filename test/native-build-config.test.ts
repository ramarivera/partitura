import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { GatewayConfig } from "../src/services/config.js";
import { loadBuilderRegistrySettings } from "../src/services/config-native-build.js";

const settings = (
  values: Record<string, string>,
  roots: readonly string[] = [],
) =>
  loadBuilderRegistrySettings(roots).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown(values, { preserveEmptyStrings: true }),
      ),
    ),
  );
it.effect(
  "registry settings are static, canonical and separate from legacy settings",
  () =>
    Effect.gen(function* () {
      const defaults = yield* settings({});
      expect(defaults.registryFile).toBeUndefined();
      expect(defaults.stateRoot).toBe("/app/data/native-build-registry");
      expect(defaults.scratchRoot).toBe("/app/native-build-registry-scratch");
      expect(defaults.cacheRoot).toBe("/run/partitura-native");
      expect(defaults.suffix).toBe("xalda-procyon.ts.net");
      expect(defaults.perBuilderBytes).toBe(8 * 1024 ** 3);
      expect(defaults.totalBytes).toBe(32 * 1024 ** 3);
      expect(defaults.dailyBudget).toBe(400);
      expect(defaults.hourlyBudget).toBe(200);
      expect(
        (yield* settings({
          NATIVE_BUILD_REGISTRY_FILE: "/run/builders/registry.json",
        })).registryFile,
      ).toBe("/run/builders/registry.json");
    }),
);

for (const [key, value] of Object.entries({
  NATIVE_BUILD_REGISTRY_FILE: "relative.json",
  NATIVE_BUILD_STATE_ROOT: "/a/../b",
  NATIVE_BUILD_CACHE_ROOT: "",
  NATIVE_BUILD_FILE_SECRET_ROOT: "/run/keys/",
  NATIVE_BUILD_OP_TOKEN_FILE: "token",
  NATIVE_BUILD_OP_VAULT_ID: "op://vault",
  NATIVE_BUILD_ALLOWED_HOST_SUFFIX: "-bad.test",
  NATIVE_BUILD_OP_DAILY_BUDGET: "0",
  NATIVE_BUILD_OP_HOURLY_BUDGET: "401",
  NATIVE_BUILD_REGISTRY_SCRATCH_BYTES_TOTAL: "1e12",
  NATIVE_BUILD_REGISTRY_SCRATCH_BYTES_PER_BUILDER: "9007199254740992",
}))
  it.effect(`rejects malformed ${key}`, () =>
    Effect.gen(function* () {
      expect((yield* Effect.exit(settings({ [key]: value })))._tag).toBe(
        "Failure",
      );
    }),
  );

it.effect(
  "scratch refuses equality, ancestors and descendants of every protected/legacy/worker root",
  () =>
    Effect.gen(function* () {
      for (const other of [
        "/native/scratch",
        "/native",
        "/native/scratch/child",
      ])
        expect(
          (yield* Effect.exit(
            settings(
              {
                NATIVE_BUILD_REGISTRY_FILE: "/run/registry.json",
                NATIVE_BUILD_REGISTRY_SCRATCH_ROOT: "/native/scratch",
              },
              [other],
            ),
          ))._tag,
        ).toBe("Failure");
      for (const key of [
        "NATIVE_BUILD_STATE_ROOT",
        "NATIVE_BUILD_CACHE_ROOT",
        "NATIVE_BUILD_FILE_SECRET_ROOT",
      ])
        expect(
          (yield* Effect.exit(
            settings({
              NATIVE_BUILD_REGISTRY_FILE: "/run/registry.json",
              NATIVE_BUILD_REGISTRY_SCRATCH_ROOT: "/native/scratch",
              [key]: "/native",
            }),
          ))._tag,
        ).toBe("Failure");
      expect(
        (yield* settings(
          {
            NATIVE_BUILD_REGISTRY_FILE: "/run/registry.json",
            NATIVE_BUILD_REGISTRY_SCRATCH_ROOT: "/native/scratch",
          },
          ["/native/scratch-other"],
        )).scratchRoot,
      ).toBe("/native/scratch");
    }),
);

const base = {
  WORKER_SANDBOX_MODE: "native",
  LINEAR_CLIENT_ID: "client",
  LINEAR_CLIENT_SECRET: "secret",
  LINEAR_WEBHOOK_SECRET: "webhook",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
  PUBLIC_URL: "https://example.test",
};
const config = (values: Record<string, string>) =>
  GatewayConfig.make.pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ ...base, ...values })),
    ),
  );
it.effect(
  "unused registry defaults don't constrain a complete legacy deployment",
  () =>
    Effect.gen(function* () {
      const legacy = {
        NATIVE_BUILD_SSH_CONFIG_FILE: "/run/ssh",
        NATIVE_BUILD_SCRATCH_ROOT: "/app",
      };
      expect((yield* config(legacy)).nativeBuild?.scratchRoot).toBe("/app");
      expect(
        (yield* Effect.exit(
          config({
            ...legacy,
            NATIVE_BUILD_REGISTRY_FILE: "/run/registry.json",
          }),
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.exit(
          settings({ NATIVE_BUILD_ALLOWED_HOST_SUFFIX: "127.0.0.1" }),
        ))._tag,
      ).toBe("Failure");
    }),
);
for (const registry of [false, true])
  it.effect(
    `legacy pair validation remains active with registry setting ${registry}`,
    () =>
      Effect.gen(function* () {
        const registryValues = registry
          ? { NATIVE_BUILD_REGISTRY_FILE: "/run/builders/registry.json" }
          : {};
        const paired = {
          NATIVE_BUILD_SSH_CONFIG_FILE: "/run/ssh",
          NATIVE_BUILD_SCRATCH_ROOT: "/legacy/primary",
          NATIVE_BUILD_BACKUP_SSH_CONFIG_FILE: "/run/backup",
          NATIVE_BUILD_BACKUP_SCRATCH_ROOT: "/legacy/backup",
        };
        const valid = yield* config({ ...registryValues, ...paired });
        expect(valid.nativeBuild?.scratchRoot).toBe("/legacy/primary");
        expect(valid.nativeBuildBackup?.scratchRoot).toBe("/legacy/backup");
        expect(
          (yield* Effect.exit(
            config({
              ...registryValues,
              NATIVE_BUILD_SSH_CONFIG_FILE: "/run/ssh",
            }),
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* Effect.exit(
            config({
              ...registryValues,
              NATIVE_BUILD_BACKUP_SCRATCH_ROOT: "/legacy/backup",
            }),
          ))._tag,
        ).toBe("Failure");
      }),
  );

for (const key of ["NATIVE_BUILD_STATE_ROOT", "NATIVE_BUILD_CACHE_ROOT"])
  for (const root of ["/legacy/scratch", "/legacy", "/legacy/scratch/child"])
    it.effect(
      `${key} refuses legacy/worker overlap ${root} only in registry mode`,
      () =>
        Effect.gen(function* () {
          const values = { [key]: root };
          expect(
            (yield* settings(values, ["/legacy/scratch"]))[
              key === "NATIVE_BUILD_STATE_ROOT" ? "stateRoot" : "cacheRoot"
            ],
          ).toBe(root);
          expect(
            (yield* Effect.exit(
              settings(
                {
                  ...values,
                  NATIVE_BUILD_REGISTRY_FILE: "/run/registry/registry.json",
                },
                ["/legacy/scratch"],
              ),
            ))._tag,
          ).toBe("Failure");
        }),
    );

it.effect(
  "registry defaults are disjoint from the example legacy scratch root",
  () =>
    Effect.gen(function* () {
      const loaded = yield* settings(
        { NATIVE_BUILD_REGISTRY_FILE: "/run/builders/registry.json" },
        ["/app/data/native-build"],
      );
      expect(loaded.stateRoot).toBe("/app/data/native-build-registry");
    }),
);

for (const root of ["/workspaces", "/workspaces/secrets", "/"])
  it.effect(
    `NATIVE_BUILD_FILE_SECRET_ROOT refuses worker overlap ${root} in registry mode`,
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          settings(
            {
              NATIVE_BUILD_FILE_SECRET_ROOT: root,
              NATIVE_BUILD_REGISTRY_FILE: "/run/registry/registry.json",
            },
            ["/workspaces"],
          ),
        );
        expect(exit._tag).toBe("Failure");
      }),
  );
