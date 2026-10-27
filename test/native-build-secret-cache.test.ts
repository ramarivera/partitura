import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { sourceKey } from "../src/services/native-build-secret-cache.js";
import { NativeSecretError } from "../src/services/native-build-secret-protocol.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.effect(
  "an unfinished startup recovers transient outage, then is never polled",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("startup"));
        let reads = 0;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            Effect.gen(function* () {
              yield* reserve(reads === 0 ? 12 : 4);
              reads++;
              if (reads === 1)
                return yield* Effect.fail(
                  NativeSecretError.new("provider-unavailable"),
                );
              return f.record;
            }),
        });
        const id = yield* cache.accept("startup", [f.source()], "");
        yield* cache.tick();
        expect(cache.progress(id)?.sources[0]).toMatchObject({
          status: "pending",
          attempts: 1,
          nextFit: 60000,
        });
        yield* TestClock.adjust(59999);
        yield* cache.tick();
        expect(reads).toBe(1);
        yield* TestClock.adjust(1);
        yield* cache.tick();
        expect(cache.progress(id)?.sources[0]).toMatchObject({
          status: "succeeded",
          attempts: 2,
        });
        expect(
          f.journal
            .snapshot()
            .charges.map((charge) => [charge.bucket, charge.units]),
        ).toEqual([
          ["bootstrap", 12],
          ["retry", 4],
        ]);
        yield* TestClock.adjust(86400000);
        yield* cache.tick();
        expect(reads).toBe(2);
      }),
    ),
);

for (const code of [
  "provider-auth-failed",
  "provider-auth-mode-error",
  "field-id-missing",
  "builder-record-invalid",
])
  it.effect(`terminal startup ${code} never retries`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path(code));
        let reads = 0;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            Effect.gen(function* () {
              yield* reserve(12);
              reads++;
              return yield* Effect.fail(NativeSecretError.new(code));
            }),
        });
        const id = yield* cache.accept("startup", [f.source()], "");
        yield* cache.tick();
        yield* TestClock.adjust(600000);
        yield* cache.tick();
        expect(reads).toBe(1);
        expect(cache.progress(id)?.sources[0]).toMatchObject({
          status: "failed",
          code,
        });
        yield* TestClock.adjust(86400001);
        yield* cache.tick();
        const restarted = yield* f.openCache({
          read: () => Effect.die("terminal source reread"),
        });
        const resumed = yield* restarted.accept("startup", [f.source()], "");
        yield* restarted.tick();
        expect(restarted.progress(resumed)?.sources[0]?.status).toBe("failed");
      }),
    ),
  );

it.effect(
  "startup stops at eight charged attempts and explicit failures do not retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("bounded"));
        let reads = 0;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            Effect.gen(function* () {
              yield* reserve(4);
              reads++;
              return yield* Effect.fail(
                NativeSecretError.new("provider-timeout"),
              );
            }),
        });
        const id = yield* cache.accept("startup", [f.source()], "");
        for (let attempt = 0; attempt < 8; attempt++) {
          yield* cache.tick();
          if (attempt < 7)
            yield* TestClock.adjust(
              Math.max(60000, Math.min(600000, 30000 * 2 ** attempt)),
            );
        }
        expect(reads).toBe(8);
        expect(cache.progress(id)?.sources[0]).toMatchObject({
          attempts: 8,
          status: "failed",
        });
        const human = yield* cache.accept("human", [f.source()], "org");
        yield* TestClock.adjust(60000);
        yield* cache.tick();
        expect(cache.progress(human)?.sources[0]?.status).toBe("failed");
        yield* TestClock.adjust(600000);
        yield* cache.tick();
        expect(reads).toBe(9);
      }),
    ),
);

it.effect(
  "a delayed startup expires without renewing its deadline on restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("expiry"));
        const never = { read: () => Effect.die("expired read") };
        const first = yield* f.openCache(never);
        const id = yield* first.accept("startup", [f.source()], "");
        yield* TestClock.adjust(7100000);
        const restoredJournal = yield* f.openJournal;
        const restarted = yield* f.openCache(never, restoredJournal);
        const next = yield* restarted.accept("startup", [f.source()], "");
        expect(restarted.progress(next)?.sources[0]?.nextFit).toBe(0);
        yield* TestClock.adjust(100000);
        yield* restarted.tick();
        expect(restarted.progress(next)?.sources[0]?.status).toBe("failed");
        expect(first.progress(id)?.deadline).toBe(7200000);
      }),
    ),
);

it.effect(
  "refresh accepted after read start gets one trailing read after cooldown",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("trailing"));
        const entered = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        let reads = 0;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            Effect.gen(function* () {
              yield* reserve(4);
              if (++reads === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return f.record;
            }),
        });
        const first = yield* cache.accept("human", [f.source()], "org");
        const running = yield* Effect.forkScoped(cache.tick());
        yield* Deferred.await(entered);
        const second = yield* cache.accept("human", [f.source()], "org");
        const third = yield* cache.accept("human", [f.source()], "org");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        expect(cache.progress(first)?.done).toBe(true);
        expect(cache.progress(second)?.done).toBe(false);
        yield* cache.tick();
        expect(reads).toBe(1);
        yield* TestClock.adjust(60000);
        yield* cache.tick();
        expect(reads).toBe(2);
        expect(cache.progress(second)?.done).toBe(true);
        expect(cache.progress(third)?.done).toBe(true);
      }),
    ),
);

it.effect(
  "cached-noop spends no provider units and never advances last success",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("noop"));
        let reads = 0;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            reserve(4).pipe(
              Effect.as(f.record),
              Effect.tap(() =>
                Effect.sync(() => {
                  reads++;
                }),
              ),
            ),
        });
        const first = yield* cache.accept("startup", [f.source()], "");
        yield* cache.tick();
        const success = cache.progress(first)?.sources[0]?.lastSuccessAt;
        yield* TestClock.adjust(60000);
        const noop = yield* cache.accept("agent", [f.source()], "org");
        yield* cache.tick();
        expect(cache.progress(noop)?.sources[0]).toMatchObject({
          status: "cached-noop",
          lastSuccessAt: success,
        });
        expect(reads).toBe(1);
        expect(f.journal.snapshot().charges).toHaveLength(1);
      }),
    ),
);

it.effect(
  "unsuccessful human refresh retains process cache without changing success time",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("last-good"));
        let fail = false;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            Effect.gen(function* () {
              yield* reserve(4);
              if (fail)
                return yield* Effect.fail(
                  NativeSecretError.new("provider-unavailable"),
                );
              return f.record;
            }),
        });
        yield* cache.accept("startup", [f.source()], "");
        yield* cache.tick();
        const original = cache.cached(f.source());
        fail = true;
        yield* TestClock.adjust(60000);
        const id = yield* cache.accept("human", [f.source()], "org");
        yield* cache.tick();
        expect(cache.progress(id)?.sources[0]?.status).toBe("failed");
        expect(cache.cached(f.source())).toEqual(original);
        expect(f.journal.snapshot().successes[sourceKey(f.source())]).toBe(0);
      }),
    ),
);

it.effect(
  "source cooldown and provider backoff survive journal restart and clock rollback",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("backoff"));
        let reads = 0;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            reserve(4).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  reads++;
                }),
              ),
              Effect.andThen(
                Effect.fail(NativeSecretError.new("provider-rate-limited")),
              ),
            ),
        });
        const id = yield* cache.accept("startup", [f.source()], "");
        yield* cache.tick();
        expect(cache.progress(id)?.sources[0]?.nextFit).toBe(900000);
        const journal = yield* f.openJournal;
        expect(journal.snapshot().providerBackoff).toBe(900000);
        expect(journal.snapshot().cooldowns[f.source().source]).toBe(60000);
        yield* journal.transaction(() => {}, -1000);
        expect(journal.snapshot().highWater).toBe(0);
        yield* TestClock.adjust(899999);
        yield* cache.tick();
        expect(reads).toBe(1);
      }),
    ),
);

it.effect(
  "file reads consume zero provider budget and queued reads coalesce",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("file"));
        let reads = 0;
        const cache = yield* f.openCache({
          read: () =>
            Effect.sync(() => {
              reads++;
              return f.record;
            }),
        });
        const source = { ...f.source(), source: "file:primary.json" };
        const first = yield* cache.accept("human", [source], "org"),
          second = yield* cache.accept("human", [source], "org");
        yield* cache.tick();
        expect(reads).toBe(1);
        expect(cache.progress(first)?.done).toBe(true);
        expect(cache.progress(second)?.done).toBe(true);
        expect(f.journal.snapshot().charges).toEqual([]);
        expect((yield* cache.capacity([source])).cost).toBe(0);
      }),
    ),
);

it.effect(
  "bounded worklist feeds retained sources first, then builder ID, and omits none",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("worklist"));
        const reads: string[] = [];
        const cache = yield* f.openCache({
          read: (source) =>
            Effect.sync(() => {
              reads.push(source);
              return f.record;
            }),
        });
        const sources = Array.from({ length: 70 }, (_, index) => ({
          source: `file:builder-${index}.json`,
          revision: 1,
          builderId: `builder-${String(index).padStart(3, "0")}`,
          retained: index >= 65,
        }));
        const id = yield* cache.accept("startup", sources.toReversed(), "");
        for (let index = 0; index < sources.length; index++)
          yield* cache.tick();
        expect(reads).toEqual(
          [...sources.slice(65), ...sources.slice(0, 65)].map(
            (source) => source.source,
          ),
        );
        expect(cache.progress(id)?.sources).toHaveLength(70);
        expect(cache.progress(id)?.done).toBe(true);
        expect(
          (yield* cache
            .accept(
              "human",
              Array.from({ length: 321 }, (_, index) => ({
                ...f.source(index),
                source: `file:overflow-${index}.json`,
              })),
              "org",
            )
            .pipe(Effect.flip)).code,
        ).toBe("provider-operation-invalid");
      }),
    ),
);

it.effect(
  "a newer desired revision supersedes a queued obsolete resolution without claiming success",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("superseded"));
        let reads = 0;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            reserve(4).pipe(
              Effect.as(f.record),
              Effect.tap(() =>
                Effect.sync(() => {
                  reads++;
                }),
              ),
            ),
        });
        const old = yield* cache.accept("registry", [f.source()], "");
        const current = yield* cache.accept(
          "registry",
          [{ ...f.source(), revision: 2 }],
          "",
        );
        yield* cache.tick();
        expect(reads).toBe(1);
        expect(cache.progress(old)?.sources[0]?.status).toBe("superseded");
        expect(cache.progress(current)?.sources[0]?.status).toBe("succeeded");
      }),
    ),
);

it.effect(
  "the scoped scheduler automatically retries only unfinished startup sources",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("automatic"));
        const first = yield* Deferred.make<void>();
        const done = yield* Deferred.make<void>();
        let reads = 0;
        const cache = yield* f.openCache(
          {
            read: (_source, reserve) =>
              Effect.gen(function* () {
                yield* reserve(4);
                reads++;
                if (reads === 1) {
                  yield* Deferred.succeed(first, undefined);
                  return yield* Effect.fail(
                    NativeSecretError.new("provider-unavailable"),
                  );
                }
                yield* Deferred.succeed(done, undefined);
                return f.record;
              }),
          },
          f.journal,
          f.budget,
          true,
        );
        const id = yield* cache.accept("startup", [f.source()], "");
        yield* Deferred.await(first);
        while (!cache.progress(id)?.sources[0]?.code) yield* Effect.yieldNow;
        yield* TestClock.adjust(60000);
        yield* Deferred.await(done);
        while (!cache.progress(id)?.done) yield* Effect.yieldNow;
        expect(reads).toBe(2);
        yield* TestClock.adjust(600000);
        expect(reads).toBe(2);
      }),
    ),
);

it.effect(
  "refresh during initialization joins the subsequent get, not a trailing read",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("during-init"));
        const initialized = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        let reads = 0;
        const cache = yield* f.openCache(
          {
            read: (_source, reserve, onReadStart = () => Effect.void) =>
              Effect.gen(function* () {
                yield* reserve(12);
                yield* Deferred.succeed(initialized, undefined);
                yield* Deferred.await(release);
                yield* onReadStart();
                reads++;
                return f.record;
              }),
          },
          f.journal,
          f.budget,
          false,
          true,
        );
        const first = yield* cache.accept("startup", [f.source()], "");
        const running = yield* Effect.forkScoped(cache.tick());
        yield* Deferred.await(initialized);
        expect(
          cache.progress(first)?.sources[0]?.readStartedAt,
        ).toBeUndefined();
        yield* TestClock.adjust(1);
        const late = yield* cache.accept("human", [f.source()], "org");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(running);
        expect(cache.progress(first)?.sources[0]?.status).toBe("succeeded");
        expect(cache.progress(late)?.sources[0]).toMatchObject({
          status: "succeeded",
          readStartedAt: 1,
        });
        expect(reads).toBe(1);
        expect(f.journal.snapshot().charges).toHaveLength(1);
      }),
    ),
);

it.effect(
  "an explicit full-inventory prune releases retired snapshots but preserves quota and unfinished work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("inventory"));
        const cache = yield* f.openCache({
          read: (_source, reserve) => reserve(4).pipe(Effect.as(f.record)),
        });
        yield* cache.accept("startup", [f.source()], "");
        yield* cache.tick();
        const pending = yield* cache.accept("human", [f.source(2)], "org");
        const before = f.journal.snapshot();
        yield* cache.retainNeeded([]);
        expect(cache.cached(f.source())).toBeUndefined();
        expect(f.journal.snapshot().successes).toEqual({});
        expect(cache.progress(pending)?.sources[0]?.status).toBe("pending");
        expect(f.journal.snapshot().charges).toEqual(before.charges);
        expect(f.journal.snapshot().submissions).toEqual(before.submissions);
        expect(f.journal.snapshot().cooldowns).toEqual(before.cooldowns);
      }),
    ),
);

it.effect(
  "accepted registry resolution rereads a previously cached revision instead of treating it as startup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("reaccepted"));
        let reads = 0;
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            reserve(4).pipe(
              Effect.as(f.record),
              Effect.tap(() =>
                Effect.sync(() => {
                  reads++;
                }),
              ),
            ),
        });
        yield* cache.accept("startup", [f.source()], "");
        yield* cache.tick();
        yield* TestClock.adjust(60000);
        const resolution = yield* Effect.forkScoped(
          cache.resolve(f.source(), "registry"),
        );
        while (f.journal.snapshot().operations.length < 2)
          yield* Effect.yieldNow;
        yield* cache.tick();
        yield* TestClock.adjust(20);
        yield* Fiber.join(resolution);
        expect(reads).toBe(2);
        expect(
          f.journal.snapshot().charges.map((charge) => charge.bucket),
        ).toEqual(["bootstrap", "human"]);
      }),
    ),
);
