import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { makeBuilderRegistryState } from "../src/services/builder-registry-state.js";
import {
  document,
  entry,
  fakeBuilderAdapters,
  host,
} from "./fixtures/builder-registry.js";

it.effect(
  "per-field edits read only for enabled add, re-enable, source/revision changes and rename",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters();
        const registry = yield* makeBuilderRegistryState(
          fake.provider,
          fake.identity,
        );
        const publish = (builders: Parameters<typeof document>[0]) =>
          registry
            .publish(document(builders))
            .pipe(Effect.andThen(registry.awaitIdle()));
        yield* publish([entry(), entry("backup", false)]);
        expect(fake.reads).toEqual(["primary:1"]);
        const generation = registry.snapshot().entries[0]?.generationId;
        yield* registry.publish({
          ...document([entry("backup", false), entry()]),
          defaultBuilder: "primary",
          selection: { fallback: "none", fallbackBuilders: [] },
        });
        expect(registry.snapshot().revision).toBe(1);
        yield* publish([
          { ...entry(), minimumFreeBytes: 60 * 1024 ** 3 },
          entry("backup", false, 2),
        ]);
        yield* registry.publish({
          ...document([entry(), entry("backup", false, 2)]),
          defaultBuilder: "backup",
        });
        yield* registry.publish({
          ...document([entry(), entry("backup", false, 2)]),
          selection: {
            fallback: "before-submission",
            fallbackBuilders: ["backup"],
          },
        });
        yield* registry.awaitIdle();
        expect(fake.reads).toEqual(["primary:1"]);
        expect(registry.snapshot().entries[0]?.generationId).toBe(generation);
        yield* publish([entry("primary", false), entry("backup", false, 2)]);
        yield* publish([entry("primary", true, 2), entry("backup", false, 2)]);
        yield* publish([
          {
            ...entry("primary", true, 2),
            secretSource: { type: "file", name: "rotated.json" },
          },
          entry("backup", false, 2),
        ]);
        yield* publish([entry("renamed")]);
        yield* publish([]);
        expect(fake.reads).toEqual([
          "primary:1",
          "primary:2",
          "primary:2",
          "renamed:1",
        ]);
        expect(registry.snapshot().entries).toEqual([]);
      }),
    ),
);

it.effect(
  "a blocked provider never delays disable/remove and obsolete results never publish",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters();
        const blocked = yield* Deferred.make<void>();
        fake.blocks.set("primary:1", blocked);
        const registry = yield* makeBuilderRegistryState(
          fake.provider,
          fake.identity,
        );
        yield* registry.publish(document());
        yield* Effect.yieldNow;
        expect(fake.reads).toEqual(["primary:1"]);
        yield* registry.publish(document([entry("primary", false)]));
        expect(registry.snapshot().entries[0]?.available).toBe(false);
        yield* registry.publish(document([]));
        yield* Deferred.succeed(blocked, undefined);
        yield* registry.awaitIdle();
        expect(registry.snapshot().entries).toEqual([]);
        expect(fake.checks).toEqual([]);
      }),
    ),
);

it.effect(
  "rapid accepted revisions retain only the latest pending item read",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters(),
          blocked = yield* Deferred.make<void>();
        fake.blocks.set("primary:1", blocked);
        const registry = yield* makeBuilderRegistryState(
          fake.provider,
          fake.identity,
        );
        yield* registry.publish(document());
        yield* Effect.yieldNow;
        yield* registry.publish(document([entry("primary", true, 2)]));
        yield* registry.publish(document([entry("primary", true, 3)]));
        expect(registry.snapshot().entries[0]?.available).toBe(false);
        yield* Deferred.succeed(blocked, undefined);
        yield* registry.awaitIdle();
        expect(fake.reads).toEqual(["primary:1", "primary:3"]);
        expect(fake.checks).toEqual(["primary:3"]);
        expect(registry.snapshot().entries[0]?.available).toBe(true);
      }),
    ),
);

it.effect(
  "a late conflicting host blocks both entries, and removal requires fresh cached health",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters(),
          blocked = yield* Deferred.make<void>();
        const registry = yield* makeBuilderRegistryState(
          fake.provider,
          fake.identity,
        );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        fake.hosts.set("backup:1", host(1));
        fake.blocks.set("backup:1", blocked);
        yield* registry.publish(document([entry(), entry("backup")]));
        expect(registry.snapshot().entries[0]?.available).toBe(true);
        yield* Deferred.succeed(blocked, undefined);
        yield* registry.awaitIdle();
        expect(registry.snapshot().entries.map((item) => item.reason)).toEqual([
          "duplicate-host",
          "duplicate-host",
        ]);
        const healthBlocked = yield* Deferred.make<void>();
        fake.healthBlocks.set("primary", healthBlocked);
        yield* registry.publish(document());
        expect(registry.snapshot().entries[0]?.available).toBe(false);
        yield* Deferred.succeed(healthBlocked, undefined);
        yield* registry.awaitIdle();
        expect(registry.snapshot().entries[0]?.available).toBe(true);
        expect(fake.reads).toEqual(["primary:1", "backup:1"]);
        expect(fake.checks.filter((id) => id === "primary:1")).toHaveLength(2);
      }),
    ),
);

it.effect(
  "disable winning the publication gate interrupts preparation and prevents submission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters(),
          registry = yield* makeBuilderRegistryState(
            fake.provider,
            fake.identity,
          );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        const admission = yield* registry.admit();
        let spawned = false;
        yield* registry.publish(document([entry("primary", false)]));
        expect(admission.signal.aborted).toBe(true);
        const refusal = yield* registry
          .submit(admission, () =>
            Effect.sync(() => {
              spawned = true;
            }),
          )
          .pipe(Effect.flip);
        expect(refusal.code).toBe("registry-submission-closed");
        expect(spawned).toBe(false);
      }),
    ),
);

it.effect(
  "a committed submitting transition wins the gate and drains across disable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters(),
          registry = yield* makeBuilderRegistryState(
            fake.provider,
            fake.identity,
          );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        const admission = yield* registry.admit(),
          entered = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>();
        const submission = yield* Effect.forkScoped(
          registry.submit(admission, () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          ),
        );
        yield* Deferred.await(entered);
        const disabling = yield* Effect.forkScoped(
          registry.publish(document([entry("primary", false)])),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(submission);
        yield* Fiber.join(disabling);
        expect(admission.signal.aborted).toBe(false);
      }),
    ),
);

it.effect(
  "source edits retain the admitted generation and policy edits recheck its latest floor",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters(),
          registry = yield* makeBuilderRegistryState(
            fake.provider,
            fake.identity,
          );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        const admission = yield* registry.admit();
        yield* registry.publish(document([entry("primary", true, 2)]));
        yield* registry.awaitIdle();
        expect(registry.snapshot().entries[0]?.generationId).not.toBe(
          admission.generationId,
        );
        expect(admission.signal.aborted).toBe(false);
        const floor = yield* registry.submit(admission, (floor) =>
          Effect.succeed(floor),
        );
        expect(floor).toBe(entry().minimumFreeBytes);
        const next = yield* registry.admit();
        yield* registry.publish(
          document([
            { ...entry("primary", true, 2), minimumFreeBytes: 2 * 1024 ** 4 },
          ]),
        );
        expect(
          (yield* registry.submit(next, () => Effect.void).pipe(Effect.flip))
            .code,
        ).toBe("registry-submission-closed");
      }),
    ),
);

it.effect(
  "selection is explicit and retained physical reservations block renamed entries",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = fakeBuilderAdapters(),
          registry = yield* makeBuilderRegistryState(
            fake.provider,
            fake.identity,
          );
        yield* registry.publish({
          ...document([entry("primary", false), entry("backup")]),
          selection: {
            fallback: "before-submission",
            fallbackBuilders: ["backup"],
          },
        });
        yield* registry.awaitIdle();
        expect((yield* registry.admit()).builderId).toBe("backup");
        expect((yield* registry.admit("primary").pipe(Effect.flip)).code).toBe(
          "registry-admission-closed",
        );
        fake.reserved.add(host(1));
        fake.hosts.set("renamed:1", host(1));
        yield* registry.publish(document([entry("renamed")]));
        yield* registry.awaitIdle();
        expect((yield* registry.admit().pipe(Effect.flip)).code).toBe(
          "registry-admission-closed",
        );
      }),
    ),
);

it.effect(
  "health refreshes use cache, never reread a successfully resolved source",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let time = 1000;
        const fake = fakeBuilderAdapters(),
          registry = yield* makeBuilderRegistryState(
            fake.provider,
            fake.identity,
            () => time,
          );
        yield* registry.publish(document());
        yield* registry.awaitIdle();
        time += 16_000;
        const admission = yield* registry.admit();
        expect(admission.builderId).toBe("primary");
        expect(fake.checks).toHaveLength(2);
        expect(fake.reads).toEqual(["primary:1"]);
        time += 16_000;
        yield* registry.submit(admission, () => Effect.void);
        expect(fake.checks).toHaveLength(3);
        expect(fake.reads).toEqual(["primary:1"]);
      }),
    ),
);
