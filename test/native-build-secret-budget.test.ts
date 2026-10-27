import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import { NativeSecretBudget } from "../src/services/native-build-secret-budget.js";
import { NativeSecretJournal } from "../src/services/native-build-secret-journal.js";
import { NativeSecretError } from "../src/services/native-build-secret-protocol.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.effect(
  "agent loops cannot borrow bootstrap/retry units or bypass org-wide attempt limits",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("non-borrowing"));
        for (let i = 0; i < 5; i++)
          yield* f.budget.reserve("agent", 4, f.source(i).source, "org-a", 0);
        const failure = yield* f.budget
          .reserve("agent", 4, f.source(6).source, "org-a", 60000)
          .pipe(Effect.flip);
        expect(failure).toMatchObject({
          code: "provider-budget-exhausted",
          nextFit: 86400000,
        });
        yield* f.budget.reserve("bootstrap", 12, f.source(7).source, "", 60000);
        yield* f.budget.reserve("retry", 12, f.source(8).source, "", 60000);
        expect(
          f.journal
            .snapshot()
            .charges.filter((item) => item.bucket === "agent"),
        ).toHaveLength(5);
        const restartedJournal = yield* f.openJournal;
        const restarted = yield* NativeSecretBudget.make.pipe(
          Effect.provideService(BuilderRegistryConfig, f.settings),
          Effect.provideService(NativeSecretJournal, restartedJournal),
        );
        expect(
          (yield* restarted
            .reserve("agent", 4, f.source(9).source, "org-a", 60000)
            .pipe(Effect.flip)).nextFit,
        ).toBe(86400000);
      }),
    ),
);

it.effect(
  "startup crash breaker admits three cycles, then retains its exact backoff on restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("cycles"));
        for (const at of [0, 1000, 2000])
          expect(yield* f.budget.startupCycle(at)).toBe(at);
        expect(yield* f.budget.startupCycle(3000)).toBe(1802000);
        const restoredJournal = yield* f.openJournal;
        expect(restoredJournal.snapshot().startupBackoff).toBe(1802000);
        expect(
          (yield* f.budget
            .reserve("bootstrap", 12, f.source().source, "", 3000)
            .pipe(Effect.flip)).nextFit,
        ).toBe(1802000);
        yield* f.budget.reserve("human", 4, f.source(2).source, "org", 3000);
        expect(yield* f.budget.startupCycle(1802000)).toBe(1802000);
      }),
    ),
);

it.effect(
  "restart capacity reports independent horizons and refuses an enlarged 64-source pool",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("capacity"));
        expect(yield* f.budget.capacity(2, 0, 0)).toEqual({
          cost: 16,
          sufficient: true,
          dailyColdStarts: 10,
          hourlyColdStarts: 5,
        });
        expect((yield* f.budget.capacity(64, 0, 0)).sufficient).toBe(false);
        yield* f.budget.reserve("bootstrap", 12, f.source().source, "", 0);
        expect(yield* f.budget.capacity(2, 4, 0)).toMatchObject({
          dailyColdStarts: 9,
          hourlyColdStarts: 4,
        });
        expect(yield* f.budget.capacity(0, 0, 0)).toMatchObject({
          cost: 0,
          dailyColdStarts: null,
          hourlyColdStarts: null,
        });
        const cache = yield* f.openCache({
          read: () => Effect.die("capacity must refuse before provider"),
        });
        const enlarged = Array.from({ length: 64 }, (_, index) =>
          f.source(index + 1),
        );
        expect(
          (yield* cache.accept("startup", enlarged, "").pipe(Effect.flip)).code,
        ).toBe("budget-capacity");
      }),
    ),
);

it.effect(
  "explicit submission limits span principals, and all-refresh is global",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("submissions"));
        const cache = yield* f.openCache({
          read: () => Effect.die("accept must not dispatch"),
        });
        for (let i = 0; i < 10; i++)
          yield* cache.accept("agent", [f.source()], "same-org");
        expect(
          (yield* cache
            .accept("human", [f.source()], "same-org")
            .pipe(Effect.flip)).code,
        ).toBe("provider-submission-limited");
        const before = f.journal.snapshot().operations.length;
        expect(f.journal.snapshot().charges).toEqual([]);
        expect(f.journal.snapshot().operations.length).toBe(before);
        yield* cache.accept("human", [f.source()], "another-org", true);
        expect(
          (yield* cache
            .accept("human", [f.source()], "third-org", true)
            .pipe(Effect.flip)).nextFit,
        ).toBe(300000);
      }),
    ),
);

it.effect(
  "budget next-fit waits within the original window, otherwise ends the startup source",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("next-fit"));
        yield* f.journal.transaction(
          (data) =>
            data.charges.push({
              at: 0,
              bucket: "bootstrap",
              units: 80,
              org: "",
            }),
          0,
        );
        const cache = yield* f.openCache({
          read: (_source, reserve) => reserve(12).pipe(Effect.as(f.record)),
        });
        const id = yield* cache.accept("startup", [f.source()], "");
        yield* cache.tick();
        expect(cache.progress(id)?.sources[0]).toMatchObject({
          status: "pending",
          nextFit: 3600000,
          attempts: 0,
        });
        yield* f.journal.transaction((data) => {
          data.charges.push({ at: 0, bucket: "bootstrap", units: 80, org: "" });
        }, 0);
        // Both daily and hourly constraints are consulted, with no borrowing.
        const fit = yield* f.budget
          .reserve("bootstrap", 12, f.source(2).source, "", 0)
          .pipe(Effect.flip);
        expect(fit).toBeInstanceOf(NativeSecretError);
        expect(fit.nextFit).toBe(86400000);
      }),
    ),
);
