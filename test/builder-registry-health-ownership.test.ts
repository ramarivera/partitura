import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { makeBuilderRegistryState } from "../src/services/builder-registry-state.js";
import { document, fakeBuilderAdapters } from "./fixtures/builder-registry.js";

it.effect(
  "a timed-out forced health waiter cannot interrupt an existing registry worker",
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
        const ready = yield* Deferred.make<void>();
        fake.healthBlocks.set("primary", ready);
        const worker = yield* registry
          .refreshHealth("primary", false, true)
          .pipe(Effect.forkChild);
        while (fake.checks.length < 2) yield* Effect.yieldNow;
        const waiter = yield* registry
          .refreshHealth("primary", false, true)
          .pipe(Effect.timeoutOption(12000), Effect.forkChild);
        yield* TestClock.adjust(12000);
        expect(Option.isNone(yield* Fiber.join(waiter))).toBe(true);
        expect(worker.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(ready, undefined);
        yield* Fiber.join(worker);
        yield* registry.awaitIdle();
        expect(registry.current("primary")?.recheck).toBe(false);
        expect(registry.snapshot().entries[0]?.available).toBe(true);
      }),
    ),
);
