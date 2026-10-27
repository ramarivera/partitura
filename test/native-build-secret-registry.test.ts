import { writeFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BuilderRegistry } from "../src/services/builder-registry.js";
import {
  BuilderRegistryFiles,
  registryIO,
} from "../src/services/builder-registry-files.js";
import { BuilderRegistryIdentity } from "../src/services/builder-registry-identity.js";
import { BuilderSecretProvider } from "../src/services/builder-secret-provider.js";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import { NativeBuildSecretCache } from "../src/services/native-build-secret-cache.js";
import {
  bytes,
  document,
  entry,
  fakeBuilderAdapters,
} from "./fixtures/builder-registry.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.live(
  "capacity refuses an enlarged desired pool before any new read, retaining accepted admission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("capacity"));
        const fake = fakeBuilderAdapters();
        const cache = yield* f.openCache({
          read: () => Effect.die("unexpected provider read"),
        });
        const write = (value: unknown) =>
          registryIO(() =>
            writeFile(f.settings.registryFile ?? "", bytes(value), {
              mode: 0o600,
            }),
          );
        yield* write(document());
        const registry = yield* BuilderRegistry.make.pipe(
          Effect.provideService(BuilderRegistryConfig, f.settings),
          Effect.provideService(BuilderSecretProvider, fake.provider),
          Effect.provideService(BuilderRegistryIdentity, fake.identity),
          Effect.provideService(NativeBuildSecretCache, cache),
          Effect.provide(BuilderRegistryFiles.layer),
        );
        yield* registry.awaitIdle();
        expect(registry.snapshot().entries[0]?.available).toBe(true);
        yield* write(
          document(
            Array.from({ length: 9 }, (_, index) => ({
              ...entry(`new-${index}`),
              secretSource: {
                type: "onepassword" as const,
                vaultId: f.settings.vaultId ?? "",
                itemId: String(index).padStart(26, "b"),
              },
            })),
          ),
        );
        yield* registry.reload();
        yield* registry.awaitIdle();
        expect(registry.snapshot().capacityError).toBe("budget-capacity");
        expect(registry.snapshot().desired).toEqual(document());
        expect(registry.snapshot().entries[0]?.available).toBe(true);
        expect(fake.reads).toEqual(["primary:1"]);
        expect(f.journal.snapshot().charges).toEqual([]);
      }),
    ),
);
