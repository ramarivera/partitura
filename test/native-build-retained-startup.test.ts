import { writeFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BuilderRegistry } from "../src/services/builder-registry.js";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import { NativeBuildSecretCache } from "../src/services/native-build-secret-cache.js";
import { NativeSecretSourceReader } from "../src/services/native-build-secret-reader.js";
import { retainedStartup } from "../src/services/native-build-source-lifecycle.js";
import { NativeBuildStateService } from "../src/services/native-build-state.js";
import { NativeBuildTransport } from "../src/services/native-build-transport.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { fleetActor, fleetFixture } from "./fixtures/native-build-fleet.js";
import { registryJob } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.live(
  "retained startup pauses after a valid registry turns invalid, then resumes and restores a completed refresh lost before installation",
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
        const job = registryJob(generation, {
          state: "interrupted",
          recovery: {
            ...registryJob(generation).recovery,
            state: "operator-required",
            lastReason: "missing-credentials",
          },
        });
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
        expect(f.registry.snapshot().desired).toBeDefined();
        expect(f.registry.snapshot().error).toBeUndefined();
        // Fault a previously valid load before the new recovery obligation appears.
        yield* testAwait(writeFile(f.settings.registryFile ?? "", "{invalid"));
        yield* f.registry.reload();
        yield* f.native.state.transaction((draft) => draft.jobs.push(job));
        yield* Effect.sleep(1100);
        yield* restarted.tick();
        expect(f.registry.snapshot().error).toBeDefined();
        expect(reads).toBe(0);
        expect(f.journal.snapshot().operations).toHaveLength(1);
        yield* f.write([]);
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
