import { writeFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect } from "effect";
import { BuilderRegistry } from "../src/services/builder-registry.js";
import {
  BuilderRegistryFiles,
  registryIO,
} from "../src/services/builder-registry-files.js";
import { BuilderRegistryIdentity } from "../src/services/builder-registry-identity.js";
import { BuilderRegistryError } from "../src/services/builder-registry-json.js";
import { makeBuilderRegistryState } from "../src/services/builder-registry-state.js";
import { BuilderSecretProvider } from "../src/services/builder-secret-provider.js";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import { NativeSecretBudget } from "../src/services/native-build-secret-budget.js";
import { NativeBuildSecretCache } from "../src/services/native-build-secret-cache.js";
import { NativeSecretJournal } from "../src/services/native-build-secret-journal.js";
import { NativeSecretError } from "../src/services/native-build-secret-protocol.js";
import {
  bytes,
  document,
  entry,
  fakeBuilderAdapters,
} from "./fixtures/builder-registry.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
for (const action of ["disable", "remove"] as const)
  it.effect(`journal EIO cannot prevent ${action} publication`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path(action));
        const fake = fakeBuilderAdapters();
        let broken = false;
        const journal: typeof NativeSecretJournal.Service = {
          ...f.journal,
          transaction: (update, at) =>
            broken
              ? Effect.fail(NativeSecretError.new("journal-repair-required"))
              : f.journal.transaction(update, at),
        };
        const budget = yield* NativeSecretBudget.make.pipe(
          Effect.provideService(BuilderRegistryConfig, f.settings),
          Effect.provideService(NativeSecretJournal, journal),
        );
        const cache = yield* f.openCache(
          { read: () => Effect.die("no provider contact") },
          journal,
          budget,
        );
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
        broken = true;
        yield* write(
          document(action === "remove" ? [] : [entry("primary", false)]),
        );
        yield* registry.reload();
        expect(registry.snapshot().entries.some((item) => item.available)).toBe(
          false,
        );
        expect(registry.snapshot().desired?.builders).toHaveLength(
          action === "remove" ? 0 : 1,
        );
      }),
    ),
  );

it.effect(
  "over-capacity registry polls never rewrite the provider journal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("poll"));
        let writes = 0;
        const journal: typeof NativeSecretJournal.Service = {
          ...f.journal,
          transaction: (update, at) => {
            writes++;
            return f.journal.transaction(update, at);
          },
        };
        const budget = yield* NativeSecretBudget.make.pipe(
          Effect.provideService(BuilderRegistryConfig, f.settings),
          Effect.provideService(NativeSecretJournal, journal),
        );
        const cache = yield* f.openCache(
          { read: () => Effect.die("no read") },
          journal,
          budget,
        );
        const fake = fakeBuilderAdapters();
        const builders = Array.from({ length: 9 }, (_, i) => ({
          ...entry(`builder-${i}`),
          secretSource: {
            type: "onepassword" as const,
            vaultId: f.settings.vaultId ?? "",
            itemId: String(i).padStart(26, "b"),
          },
        }));
        yield* registryIO(() =>
          writeFile(f.settings.registryFile ?? "", bytes(document(builders)), {
            mode: 0o600,
          }),
        );
        const registry = yield* BuilderRegistry.make.pipe(
          Effect.provideService(BuilderRegistryConfig, f.settings),
          Effect.provideService(BuilderSecretProvider, fake.provider),
          Effect.provideService(BuilderRegistryIdentity, fake.identity),
          Effect.provideService(NativeBuildSecretCache, cache),
          Effect.provide(BuilderRegistryFiles.layer),
        );
        writes = 0;
        for (let i = 0; i < 3; i++) yield* registry.reload();
        expect(registry.snapshot().capacityError).toBe("budget-capacity");
        expect(writes).toBe(0);
      }),
    ),
);

it.effect(
  "unrelated publication preserves explicit refresh for an already-disabled builder",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("disabled-refresh"));
        const fake = fakeBuilderAdapters();
        const cache = yield* f.openCache({ read: () => Effect.die("no read") });
        const state = yield* makeBuilderRegistryState(
          fake.provider,
          fake.identity,
          Date.now,
          (ids) =>
            cache
              .supersede(ids)
              .pipe(
                Effect.mapError((error) =>
                  BuilderRegistryError.new(error.code),
                ),
              ),
        );
        yield* state.publish(document([entry("primary", false)]));
        const id = yield* cache.accept(
          "human",
          [{ ...f.source(), builderId: "primary" }],
          "org",
        );
        yield* state.publish(
          document([
            { ...entry("primary", false), minimumFreeBytes: 70_000_000_000 },
          ]),
        );
        expect(cache.progress(id)?.sources[0]?.status).toBe("pending");
      }),
    ),
);

it.effect(
  "charged reservation is running before supersession can observe it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("atomic-running"));
        let after: Effect.Effect<void, NativeSecretError> = Effect.void;
        let reads = 0;
        const budget: typeof NativeSecretBudget.Service = {
          ...f.budget,
          reserve: (...args) =>
            f.budget
              .reserve(...args)
              .pipe(Effect.andThen(Effect.suspend(() => after))),
        };
        const cache = yield* f.openCache(
          {
            read: (_source, reserve) =>
              reserve(12).pipe(
                Effect.tap(() => Effect.sync(() => reads++)),
                Effect.as(f.record),
              ),
          },
          f.journal,
          budget,
        );
        const id = yield* cache.accept("startup", [f.source()], "");
        after = Effect.gen(function* () {
          expect(cache.progress(id)?.sources[0]?.status).toBe("running");
          yield* cache.supersede([f.source().builderId]);
          expect(cache.progress(id)?.sources[0]?.status).toBe("running");
        });
        yield* cache.tick();
        expect(reads).toBe(1);
        expect(cache.progress(id)?.sources[0]?.status).toBe("succeeded");
        expect(f.journal.snapshot().charges).toHaveLength(1);
      }),
    ),
);

it.effect(
  "publication interrupts a stale provider wait even without a durable supersede notification",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters();
        const entered = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const replacement = yield* Deferred.make<void>();
        const state = yield* makeBuilderRegistryState(
          {
            resolve: (item) =>
              item.secretRevision === 1
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Deferred.succeed(interrupted, undefined),
                    ),
                  )
                : Deferred.succeed(replacement, undefined).pipe(
                    Effect.andThen(fake.provider.resolve(item)),
                  ),
          },
          fake.identity,
        );
        yield* state.publish(document());
        yield* Deferred.await(entered);
        yield* state.publish(document([entry("primary", true, 2)]));
        yield* Deferred.await(interrupted);
        yield* Deferred.await(replacement);
        yield* state.awaitIdle();
        expect(state.snapshot().entries[0]?.available).toBe(true);
      }),
    ),
);

for (const action of ["disable", "remove"] as const)
  it.effect(
    `failed ${action} supersession retries before the next provider debit`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* secretFixture(path(`retry-${action}`));
          let broken = false;
          let reads = 0;
          const journal: typeof NativeSecretJournal.Service = {
            ...f.journal,
            transaction: (update, at) =>
              broken
                ? Effect.fail(NativeSecretError.new("journal-repair-required"))
                : f.journal.transaction(update, at),
          };
          const cache = yield* f.openCache(
            {
              read: (_source, reserve) =>
                reserve(4).pipe(
                  Effect.tap(() => Effect.sync(() => reads++)),
                  Effect.as(f.record),
                ),
            },
            journal,
          );
          const fake = fakeBuilderAdapters();
          const registry = yield* makeBuilderRegistryState(
            fake.provider,
            fake.identity,
            Date.now,
            (ids) =>
              cache
                .supersede(ids)
                .pipe(
                  Effect.mapError((error) =>
                    BuilderRegistryError.new(error.code),
                  ),
                ),
          );
          yield* registry.publish(document());
          yield* registry.awaitIdle();
          const source = { ...f.source(), builderId: "primary" };
          const old = yield* cache.accept("human", [source], "org");
          broken = true;
          yield* registry.publish(
            document(action === "remove" ? [] : [entry("primary", false)]),
          );
          expect(
            registry.snapshot().entries.some((item) => item.available),
          ).toBe(false);
          expect(cache.progress(old)?.sources[0]?.status).toBe("pending");
          expect((yield* Effect.flip(cache.tick())).code).toBe(
            "journal-repair-required",
          );
          broken = false;
          yield* cache.tick();
          expect(cache.progress(old)?.sources[0]?.status).toBe("superseded");
          expect(reads).toBe(0);
          expect(f.journal.snapshot().charges).toEqual([]);
          // A later explicit disabled-builder refresh is a different operation.
          const fresh = yield* cache.accept("human", [source], "org");
          yield* cache.tick();
          expect(cache.progress(fresh)?.sources[0]?.status).toBe("succeeded");
          expect(reads).toBe(1);
        }),
      ),
  );

it.effect(
  "supersession preserves a retained source sharing the obsolete builder's operation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("retained-supersede"));
        let reads = 0;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            reserve(4).pipe(
              Effect.tap(() => Effect.sync(() => reads++)),
              Effect.as(f.record),
            ),
        });
        const desired = { ...f.source(1), builderId: "primary" };
        const retained = {
          ...f.source(2),
          builderId: "primary",
          retained: true,
        };
        const id = yield* cache.accept(
          "human",
          [desired, retained],
          "org",
          true,
        );
        yield* cache.supersede(["primary"]);
        const operation = f.journal
          .snapshot()
          .operations.find((item) => item.id === id);
        expect(
          operation?.sources.find((work) => work.source === desired.source)
            ?.status,
        ).toBe("superseded");
        expect(
          operation?.sources.find((work) => work.source === retained.source)
            ?.status,
        ).toBe("pending");
        yield* cache.tick();
        expect(cache.progress(id)?.done).toBe(true);
        expect(reads).toBe(1);
        expect(f.journal.snapshot().charges).toHaveLength(1);
      }),
    ),
);
