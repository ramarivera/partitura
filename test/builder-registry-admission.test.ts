import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { makeBuilderRegistryState } from "../src/services/builder-registry-state.js";
import {
  document,
  entry,
  fakeBuilderAdapters,
} from "./fixtures/builder-registry.js";

// Adapted from review-pr48/scripts/confirm-bot-findings.test.ts.
it.effect(
  "failed initial health retries cached credentials with bounded backoff",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let time = 1000;
        const fake = fakeBuilderAdapters();
        fake.healthFailures.add("primary");
        const registry = yield* makeBuilderRegistryState(
          fake.provider,
          fake.identity,
          () => time,
        );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        expect(registry.snapshot().entries[0]?.reason).toBe(
          "builder-health-unavailable",
        );
        for (const delay of [
          5000, 10000, 20000, 40000, 80000, 120000, 120000,
        ]) {
          const attempts = fake.checks.length;
          time += delay - 1;
          yield* registry.admit().pipe(Effect.flip);
          expect(fake.checks).toHaveLength(attempts);
          time++;
          yield* registry.admit().pipe(Effect.flip);
          expect(fake.checks).toHaveLength(attempts + 1);
        }
        fake.healthFailures.delete("primary");
        time += 120000;
        expect((yield* registry.admit()).builderId).toBe("primary");
        expect(fake.reads).toEqual(["primary:1"]);
      }),
    ),
);

it.effect(
  "policy publish during a live refresh cannot strand an admission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let time = 1000;
        const fake = fakeBuilderAdapters();
        const registry = yield* makeBuilderRegistryState(
          fake.provider,
          fake.identity,
          () => time,
        );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        const admission = yield* registry.admit();
        time += 16000;
        const block = yield* Deferred.make<void>();
        fake.healthBlocks.set("primary", block);
        yield* registry.refreshHealth("primary");
        yield* Effect.yieldNow;
        yield* registry.publish(
          document([{ ...entry(), minimumFreeBytes: 60000000000 }]),
        );
        yield* Deferred.succeed(block, undefined);
        fake.healthBlocks.delete("primary");
        yield* registry.awaitIdle();
        expect(
          yield* registry.submit(admission, (floor) => Effect.succeed(floor)),
        ).toBe(60000000000);
      }),
    ),
);

it.effect(
  "a reserved builder refuses a second admission before any health work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let time = 1000;
        const fake = fakeBuilderAdapters();
        const registry = yield* makeBuilderRegistryState(
          fake.provider,
          fake.identity,
          () => time,
        );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        const admission = yield* registry.admit();
        time += 16000;
        yield* registry.admit().pipe(Effect.flip);
        expect(fake.checks).toHaveLength(1);
        yield* registry.submit(admission, () => Effect.void);
        expect(fake.checks).toHaveLength(2);
      }),
    ),
);

it.effect(
  "admission pins its generation before a concurrent disable can retire it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let holds = 0,
          disabled = false;
        const identity = {
          ...fake.identity,
          retain: () =>
            Effect.gen(function* () {
              // Health holds go through verify's lease, so admit's is the only retain.
              if (++holds === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
            }),
        };
        const registry = yield* makeBuilderRegistryState(
          fake.provider,
          identity,
        );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        const admitting = yield* Effect.forkScoped(registry.admit());
        yield* Deferred.await(entered);
        const disabling = yield* Effect.forkScoped(
          registry.publish(document([entry("primary", false)])).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                disabled = true;
              }),
            ),
          ),
        );
        yield* Effect.yieldNow;
        expect(disabled).toBe(false);
        yield* Deferred.succeed(release, undefined);
        const admission = yield* Fiber.join(admitting);
        yield* Fiber.join(disabling);
        expect(admission.signal.aborted).toBe(true);
      }),
    ),
);

for (const profile of ["legacy", "combined"])
  it.effect(`admission refuses the ${profile} health profile`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters();
        const identity = {
          ...fake.identity,
          verify: (...args: Parameters<typeof fake.identity.verify>) =>
            fake.identity.verify(...args).pipe(
              Effect.map((result) => ({
                ...result,
                health: { ...result.health, profile },
              })),
            ),
        };
        const registry = yield* makeBuilderRegistryState(
          fake.provider,
          identity,
        );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        expect(registry.snapshot().entries[0]?.reason).toBe(
          "builder-identity-mismatch",
        );
        yield* registry.admit().pipe(Effect.flip);
      }),
    ),
  );

for (const stricter of ["gateway", "host"] as const)
  for (const disk of ["jobRootFreeBytes", "tartRootFreeBytes"] as const)
    it.effect(
      `admission applies the stricter ${stricter} disk floor to ${disk}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fake = fakeBuilderAdapters();
            const identity = {
              ...fake.identity,
              verify: (...args: Parameters<typeof fake.identity.verify>) =>
                fake.identity.verify(...args).pipe(
                  Effect.map((result) => ({
                    ...result,
                    health: {
                      ...result.health,
                      [disk]: 60 * 1024 ** 3,
                      hostFloorBytes:
                        (stricter === "host" ? 70 : 50) * 1024 ** 3,
                    },
                  })),
                ),
            };
            const registry = yield* makeBuilderRegistryState(
              fake.provider,
              identity,
            );
            yield* registry.publish(
              document([
                {
                  ...entry(),
                  minimumFreeBytes:
                    (stricter === "gateway" ? 70 : 50) * 1024 ** 3,
                },
              ]),
            );
            yield* registry.awaitIdle();
            expect(registry.snapshot().entries[0]?.reason).toBe(
              "builder-disk-policy",
            );
            yield* registry.admit().pipe(Effect.flip);
          }),
        ),
    );

it.effect(
  "availability includes preparation holds and releases them on scope exit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters();
        const registry = yield* makeBuilderRegistryState(
          fake.provider,
          fake.identity,
        );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* registry.admit();
            expect(registry.snapshot().entries[0]).toMatchObject({
              available: false,
              reason: "builder-reserved",
            });
            yield* registry.admit().pipe(Effect.flip);
          }),
        );
        expect(registry.snapshot().entries[0]).toMatchObject({
          available: true,
          reason: undefined,
        });
      }),
    ),
);

it.effect(
  "failed refresh of a previously healthy builder retries without source reads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let time = 1000;
        const fake = fakeBuilderAdapters();
        const registry = yield* makeBuilderRegistryState(
          fake.provider,
          fake.identity,
          () => time,
        );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        fake.healthFailures.add("primary");
        time += 16000;
        yield* registry.admit().pipe(Effect.flip);
        expect(fake.checks).toHaveLength(2);
        fake.healthFailures.delete("primary");
        yield* registry.admit().pipe(Effect.flip);
        expect(fake.checks).toHaveLength(2);
        time += 5000;
        yield* registry.admit();
        expect(fake.checks).toHaveLength(3);
        expect(fake.reads).toEqual(["primary:1"]);
      }),
    ),
);
