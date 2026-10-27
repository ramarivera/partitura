import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BuilderRegistry } from "../src/services/builder-registry.js";
import { BuilderRegistryError } from "../src/services/builder-registry-json.js";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import { NativeBuildSecretCache } from "../src/services/native-build-secret-cache.js";
import { NativeSecretSourceReader } from "../src/services/native-build-secret-reader.js";
import { retainedStartup } from "../src/services/native-build-source-lifecycle.js";
import { NativeBuildStateService } from "../src/services/native-build-state.js";
import { NativeBuildTransport } from "../src/services/native-build-transport.js";
import { document } from "./fixtures/builder-registry.js";
import { fleetActor, fleetFixture } from "./fixtures/native-build-fleet.js";
import { registryJob } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.live(
  "retained startup waits for a valid desired registry and restores a completed refresh lost before installation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("completed-refresh-restart"));
        const source = {
          ...f.source(),
          builderId: "removed",
          revision: 0,
          retained: true,
        };
        const generation = yield* f.native.state.addGeneration(
          "removed",
          { ...f.native.metadata, source: source.source },
          f.native.key,
        );
        yield* f.native.state.transaction((draft) =>
          draft.jobs.push(
            registryJob(generation, {
              state: "interrupted",
              recovery: {
                ...registryJob(generation).recovery,
                state: "operator-required",
                lastReason: "missing-credentials",
              },
            }),
          ),
        );
        const operation = yield* f.cache.accept(
          "human",
          [source],
          fleetActor.organizationId,
        );
        yield* f.cache.tick();
        expect(f.cache.progress(operation)?.done).toBe(true);
        expect(f.native.transport.hasCredential(generation.id)).toBe(false);
        const oldCharges = f.journal.snapshot().charges;
        // Seed an elapsed provider cooldown, as it would be on a later restart. No live provider is used.
        yield* f.journal.transaction((draft) => {
          draft.cooldowns[source.source] = 0;
        });
        let reads = 0;
        const restarted = yield* f.openCache({
          read: (_source, reserve) =>
            reserve(4).pipe(
              Effect.tap(() => Effect.sync(() => reads++)),
              Effect.as(f.record),
            ),
        });
        expect(restarted.cached(source)).toBeUndefined();
        yield* f.registry.fault(BuilderRegistryError.new("registry-invalid"));
        yield* retainedStartup.pipe(
          Effect.provideService(BuilderRegistry, f.registry),
          Effect.provideService(BuilderRegistryConfig, f.settings),
          Effect.provideService(NativeBuildStateService, f.native.state),
          Effect.provideService(NativeBuildTransport, f.native.transport),
          Effect.provideService(NativeBuildSecretCache, restarted),
          Effect.provideService(NativeSecretSourceReader, {
            read: () => Effect.succeed(f.record),
          }),
        );
        yield* restarted.tick();
        expect(reads).toBe(0);
        expect(f.journal.snapshot().operations).toHaveLength(1);
        yield* f.registry.publish(document([]));
        yield* Effect.repeat(Effect.sleep(10), {
          until: () => f.journal.snapshot().operations.length > 1,
        });
        yield* restarted.tick();
        yield* Effect.repeat(Effect.sleep(5), {
          until: () => f.native.transport.hasCredential(generation.id),
        });
        expect(reads).toBe(1);
        expect(
          f.journal.snapshot().operations.filter((op) => op.kind === "human"),
        ).toHaveLength(1);
        expect(
          f.journal
            .snapshot()
            .charges.filter((charge) => charge.bucket === "human"),
        ).toEqual(oldCharges);
        expect(f.journal.snapshot().operations.at(-1)?.kind).toBe("startup");
      }),
    ).pipe(Effect.timeout(4000)),
);
