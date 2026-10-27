import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import { NativeSecretBudget } from "../src/services/native-build-secret-budget.js";
import { sourceKey } from "../src/services/native-build-secret-cache.js";
import { NativeSecretJournal } from "../src/services/native-build-secret-journal.js";
import { NativeSecretError } from "../src/services/native-build-secret-protocol.js";
import type { NativeSecretSourceReader } from "../src/services/native-build-secret-reader.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.effect(
  "scheduler survives a journal write failure and completes a later source",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("scheduler-write"));
        const failed = yield* Deferred.make<void>();
        let writes = 0;
        const journal: typeof NativeSecretJournal.Service = {
          ...f.journal,
          transaction: (operation, at) =>
            Effect.gen(function* () {
              if (++writes === 2) {
                yield* Deferred.succeed(failed, undefined);
                return yield* Effect.fail(
                  NativeSecretError.new("journal-repair-required"),
                );
              }
              return yield* f.journal.transaction(operation, at);
            }),
        };
        const cache = yield* f.openCache(
          { read: (_source, reserve) => reserve(4).pipe(Effect.as(f.record)) },
          journal,
          f.budget,
          true,
        );
        yield* Deferred.await(failed);
        const id = yield* cache.accept("human", [f.source(2)], "org");
        yield* TestClock.adjust(1000);
        while (!cache.progress(id)?.done) yield* Effect.yieldNow;
        expect(cache.progress(id)?.sources[0]?.status).toBe("succeeded");
        expect(cache.cached(f.source(2))).toBeDefined();
      }),
    ),
);

it.effect(
  "wait enforces its deadline even when no scheduler tick succeeds",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("wait-deadline"));
        const cache = yield* f.openCache({ read: () => Effect.die("no read") });
        const id = yield* cache.accept("human", [f.source()], "org");
        const waiter = yield* cache
          .wait(id)
          .pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust(7200000);
        expect((yield* Fiber.join(waiter)).code).toBe(
          "provider-operation-expired",
        );
      }),
    ),
);

it.effect(
  "a successful human refresh supersedes an older terminal startup failure on restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("refresh-restart"));
        let failing = true;
        let reads = 0;
        const reader: typeof NativeSecretSourceReader.Service = {
          read: (_source, reserve) =>
            Effect.gen(function* () {
              yield* reserve(4);
              reads++;
              if (failing)
                return yield* Effect.fail(
                  NativeSecretError.new("provider-auth-failed"),
                );
              return f.record;
            }),
        };
        const cache = yield* f.openCache(reader);
        const first = yield* cache.accept("startup", [f.source()], "");
        yield* cache.tick();
        expect(cache.progress(first)?.sources[0]?.status).toBe("failed");
        failing = false;
        yield* TestClock.adjust(60000);
        const refresh = yield* cache.accept("human", [f.source()], "human");
        yield* cache.tick();
        expect(cache.progress(refresh)?.sources[0]?.status).toBe("succeeded");
        yield* TestClock.adjust(60000);
        const journal = yield* f.openJournal;
        const budget = yield* NativeSecretBudget.make.pipe(
          Effect.provideService(BuilderRegistryConfig, f.settings),
          Effect.provideService(NativeSecretJournal, journal),
        );
        const restarted = yield* f.openCache(reader, journal, budget);
        const startup = yield* restarted.accept("startup", [f.source()], "");
        expect(restarted.progress(startup)?.sources[0]?.status).toBe("pending");
        yield* restarted.tick();
        expect(restarted.progress(startup)?.sources[0]?.status).toBe(
          "succeeded",
        );
        expect(reads).toBe(3);
      }),
    ),
);

it.effect(
  "agent refresh after restart reads when durable success has no memory credential",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("agent-restart"));
        yield* f.journal.transaction((data) => {
          data.successes[sourceKey(f.source())] = 0;
        }, 0);
        let reads = 0;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            reserve(4).pipe(
              Effect.tap(() => Effect.sync(() => reads++)),
              Effect.as(f.record),
            ),
        });
        expect(cache.cached(f.source())).toBeUndefined();
        const id = yield* cache.accept("agent", [f.source()], "org");
        expect(cache.progress(id)?.sources[0]?.status).toBe("pending");
        yield* cache.tick();
        expect(cache.cached(f.source())).toBeDefined();
        expect(reads).toBe(1);
      }),
    ),
);

it.effect(
  "progress takes one journal snapshot regardless of operation size",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("one-snapshot"));
        let snapshots = 0;
        const cache = yield* f.openCache(
          { read: () => Effect.die("no read") },
          {
            ...f.journal,
            snapshot: () => {
              snapshots++;
              return f.journal.snapshot();
            },
          },
        );
        const id = yield* cache.accept(
          "human",
          [f.source(), f.source(2)],
          "org",
        );
        snapshots = 0;
        expect(cache.progress(id)?.sources).toHaveLength(2);
        expect(snapshots).toBe(1);
      }),
    ),
);

it.effect(
  "superseding before reservation prevents the pending get and its debit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("supersede-init"));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let reads = 0;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* reserve(4);
              reads++;
              return f.record;
            }),
        });
        const id = yield* cache.accept("startup", [f.source()], "");
        const dispatch = yield* cache.tick().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* cache.supersede([f.source().builderId]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(dispatch);
        expect(reads).toBe(0);
        expect(f.journal.snapshot().charges).toEqual([]);
        expect(cache.progress(id)?.sources[0]?.status).toBe("superseded");
      }),
    ),
);

it.effect(
  "waiters sleep until journal notification or deadline instead of polling",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("wait-notification"));
        let snapshots = 0;
        const cache = yield* f.openCache(
          { read: (_source, reserve) => reserve(4).pipe(Effect.as(f.record)) },
          {
            ...f.journal,
            snapshot: () => {
              snapshots++;
              return f.journal.snapshot();
            },
          },
        );
        const id = yield* cache.accept("human", [f.source()], "org");
        snapshots = 0;
        const waiter = yield* cache.wait(id).pipe(Effect.forkChild);
        while (!snapshots) yield* Effect.yieldNow;
        yield* TestClock.adjust(1000);
        expect(snapshots).toBe(1);
        yield* cache.tick();
        expect((yield* Fiber.join(waiter)).sources[0]?.status).toBe(
          "succeeded",
        );
      }),
    ),
);

it.effect(
  "an older success cannot reset an unfinished startup retry window",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("older-success"));
        yield* f.journal.transaction((data) => {
          data.successes[sourceKey(f.source())] = 0;
        }, 0);
        yield* TestClock.adjust(60000);
        const reader: typeof NativeSecretSourceReader.Service = {
          read: (_source, reserve) =>
            reserve(4).pipe(
              Effect.andThen(
                Effect.fail(NativeSecretError.new("provider-unavailable")),
              ),
            ),
        };
        const cache = yield* f.openCache(reader);
        const first = yield* cache.accept("startup", [f.source()], "");
        yield* cache.tick();
        const original = cache.progress(first);
        yield* TestClock.adjust(1000);
        const restarted = yield* f.openCache(reader);
        const next = yield* restarted.accept("startup", [f.source()], "");
        expect(restarted.progress(next)?.deadline).toBe(original?.deadline);
        expect(restarted.progress(next)?.sources[0]?.attempts).toBe(1);
      }),
    ),
);
