import { writeFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { BuilderRegistry } from "../src/services/builder-registry.js";
import {
  BuilderRegistryFiles,
  registryIO,
} from "../src/services/builder-registry-files.js";
import { BuilderRegistryIdentity } from "../src/services/builder-registry-identity.js";
import { BuilderRegistryError } from "../src/services/builder-registry-json.js";
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
  "capacity holds new provider entries while publishing disables, removals and policy changes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("capacity"));
        const fake = fakeBuilderAdapters();
        fake.hosts.set("policy:1", "00000003-1111-4111-8111-111111111111");
        const op = (id: string, revision = 1) => ({
          ...entry(id, true, revision),
          secretSource: {
            type: "onepassword" as const,
            vaultId: f.settings.vaultId ?? "",
            itemId: id.padStart(26, "b"),
          },
        });
        fake.hosts.set("stable:1", "00000004-1111-4111-8111-111111111111");
        fake.hosts.set("changed:1", "00000005-1111-4111-8111-111111111111");
        const cache = yield* f.openCache({
          read: () => Effect.die("unexpected provider read"),
        });
        const write = (value: unknown) =>
          registryIO(() =>
            writeFile(f.settings.registryFile ?? "", bytes(value), {
              mode: 0o600,
            }),
          );
        yield* write(
          document([
            entry(),
            entry("removed"),
            entry("policy"),
            op("stable"),
            op("changed"),
          ]),
        );
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
          document([
            entry("primary", false),
            { ...op("stable"), minimumFreeBytes: 80_000_000_000 },
            op("changed", 2),
            { ...entry("policy"), minimumFreeBytes: 80_000_000_000 },
            ...Array.from({ length: 9 }, (_, index) => ({
              ...entry(`new-${index}`),
              secretSource: {
                type: "onepassword" as const,
                vaultId: f.settings.vaultId ?? "",
                itemId: String(index).padStart(26, "b"),
              },
            })),
          ]),
        );
        yield* registry.reload();
        yield* registry.awaitIdle();
        expect(registry.snapshot().capacityError).toBe("budget-capacity");
        expect(registry.snapshot().desired?.builders).toHaveLength(13);
        expect(
          registry.snapshot().entries.find((item) => item.id === "primary")
            ?.reason,
        ).toBe("builder-disabled");
        expect(
          registry.snapshot().entries.find((item) => item.id === "removed"),
        ).toBeUndefined();
        expect(
          registry
            .snapshot()
            .desired?.builders.find((item) => item.id === "policy")
            ?.minimumFreeBytes,
        ).toBe(80_000_000_000);
        expect(
          registry
            .snapshot()
            .entries.filter((item) => item.reason === "budget-capacity"),
        ).toHaveLength(10);
        expect(fake.reads.sort()).toEqual([
          "changed:1",
          "policy:1",
          "primary:1",
          "removed:1",
          "stable:1",
        ]);
        expect(
          registry.snapshot().entries.find((item) => item.id === "stable")
            ?.available,
        ).toBe(true);
        expect(
          registry.snapshot().entries.find((item) => item.id === "changed")
            ?.reason,
        ).toBe("budget-capacity");
        expect(f.journal.snapshot().charges).toEqual([]);
      }),
    ),
);

for (const edit of ["revision", "disable", "remove"] as const)
  it.effect(
    `publication ${edit} cancels a budget-delayed resolution before any stale read`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* secretFixture(path(`supersede-${edit}`));
          const fake = fakeBuilderAdapters();
          let reads = 0;
          const cache = yield* f.openCache({
            read: (_source, reserve) =>
              reserve(4).pipe(
                Effect.tap(() => Effect.sync(() => reads++)),
                Effect.as(f.record),
              ),
          });
          yield* f.journal.transaction((data) => {
            data.charges.push({
              at: 0,
              bucket: "bootstrap",
              units: 80,
              org: "prefill",
            });
          }, 0);
          const builder = {
            ...entry(),
            secretSource: {
              type: "onepassword" as const,
              vaultId: f.settings.vaultId ?? "",
              itemId: `${"b".repeat(25)}1`,
            },
          };
          const write = (value: unknown) =>
            registryIO(() =>
              writeFile(f.settings.registryFile ?? "", bytes(value), {
                mode: 0o600,
              }),
            );
          yield* write(document([builder]));
          const registry = yield* BuilderRegistry.make.pipe(
            Effect.provideService(BuilderRegistryConfig, f.settings),
            Effect.provideService(BuilderSecretProvider, {
              resolve: (item, trigger = "registry") =>
                cache
                  .resolve(
                    {
                      ...f.source(),
                      builderId: item.id,
                      revision: item.secretRevision,
                    },
                    trigger,
                  )
                  .pipe(
                    Effect.mapError((error) =>
                      BuilderRegistryError.new(error.code),
                    ),
                  ),
            }),
            Effect.provideService(BuilderRegistryIdentity, fake.identity),
            Effect.provideService(NativeBuildSecretCache, cache),
            Effect.provide(BuilderRegistryFiles.layer),
          );
          while (!f.journal.snapshot().operations.length)
            yield* Effect.yieldNow;
          yield* cache.tick();
          expect(f.journal.snapshot().operations[0]?.sources[0]?.code).toBe(
            "provider-budget-exhausted",
          );
          yield* write(
            document(
              edit === "remove"
                ? []
                : [
                    {
                      ...builder,
                      enabled: edit !== "disable",
                      secretRevision: edit === "revision" ? 2 : 1,
                    },
                  ],
            ),
          );
          yield* registry.reload();
          expect(f.journal.snapshot().operations[0]?.sources[0]?.status).toBe(
            "superseded",
          );
          if (edit === "revision") {
            while (f.journal.snapshot().operations.length < 2)
              yield* Effect.yieldNow;
            // The human/registry bucket can run now, without waiting for the exhausted bootstrap bucket.
            yield* cache.tick();
            yield* TestClock.adjust(20);
          } else {
            yield* TestClock.adjust(3600000);
            yield* cache.tick();
          }
          yield* registry.awaitIdle();
          expect(reads).toBe(edit === "revision" ? 1 : 0);
          expect(
            f.journal
              .snapshot()
              .charges.filter((charge) => charge.org !== "prefill"),
          ).toHaveLength(edit === "revision" ? 1 : 0);
          if (edit === "revision") {
            expect(
              f.journal.snapshot().operations[1]?.sources[0],
            ).toMatchObject({ revision: 2, status: "succeeded" });
            expect(registry.snapshot().entries[0]?.available).toBe(true);
          }
        }),
      ),
  );
