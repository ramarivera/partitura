import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BuilderRegistry } from "../src/services/builder-registry.js";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import {
  NativeBuildSecretCache,
  sourceKey,
} from "../src/services/native-build-secret-cache.js";
import { NativeSecretSourceReader } from "../src/services/native-build-secret-reader.js";
import { retainedStartup } from "../src/services/native-build-source-lifecycle.js";
import { NativeBuildStateService } from "../src/services/native-build-state.js";
import { NativeBuildTransport } from "../src/services/native-build-transport.js";
import { entry } from "./fixtures/builder-registry.js";
import { fleetActor, fleetFixture } from "./fixtures/native-build-fleet.js";
import { registryJob } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
for (const policy of ["disabled", "budget-blocked"] as const)
  it.live(
    `a ${policy} builder's interrupted job retains its startup binding and credential across reload and sweep`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fleetFixture(path(`${policy}-retained`));
          const source = {
            ...f.source(),
            builderId: "vm",
            revision: policy === "disabled" ? 0 : 2,
            retained: true,
          };
          const generation = yield* f.native.state.addGeneration(
            "vm",
            {
              ...f.native.metadata,
              source: source.source,
            },
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
          let capacityRevision: number | undefined;
          const capacity = f.cache.capacity;
          f.cache.capacity = (sources) => {
            capacityRevision = sources.find(
              (item) => item.source === source.source && item.retained,
            )?.revision;
            return capacity(sources).pipe(
              Effect.map((result) => ({
                ...result,
                sufficient:
                  policy === "budget-blocked" ? false : result.sufficient,
              })),
            );
          };
          const builders = [
            entry(),
            {
              ...entry("vm", policy !== "disabled", 2),
              secretSource: {
                type: "onepassword" as const,
                vaultId: f.settings.vaultId,
                itemId: source.source.split(":")[2] ?? "",
              },
            },
          ];
          yield* f.write(builders);
          expect(capacityRevision).toBe(source.revision);
          expect(
            f.registry.snapshot().entries.find((item) => item.id === "vm")
              ?.reason,
          ).toBe(
            policy === "disabled" ? "builder-disabled" : "budget-capacity",
          );
          yield* retainedStartup.pipe(
            Effect.provideService(BuilderRegistry, f.registry),
            Effect.provideService(BuilderRegistryConfig, f.settings),
            Effect.provideService(NativeBuildStateService, f.native.state),
            Effect.provideService(NativeBuildTransport, f.native.transport),
            Effect.provideService(NativeBuildSecretCache, f.cache),
            Effect.provideService(NativeSecretSourceReader, {
              read: () => Effect.succeed(f.record),
            }),
          );
          yield* Effect.repeat(Effect.sleep(5), {
            until: () => f.journal.snapshot().operations.length > 0,
          });
          yield* f.cache.tick();
          yield* Effect.repeat(Effect.sleep(5), {
            until: () => f.native.transport.hasCredential(generation.id),
          });
          const success = f.journal.snapshot().successes[sourceKey(source)];
          expect(success).toBeDefined();
          expect(f.cache.cached(source)).toBeDefined();
          yield* f.registry.reload();
          expect(f.journal.snapshot().successes[sourceKey(source)]).toBe(
            success,
          );
          expect(f.cache.cached(source)).toBeDefined();
          yield* Effect.sleep(1100);
          expect(f.journal.snapshot().successes[sourceKey(source)]).toBe(
            success,
          );
          expect(f.cache.cached(source)).toBeDefined();
          expect(f.reads).toEqual([source.source]);
          const refresh = yield* f.fleet.refresh(fleetActor, { scope: "all" });
          expect(
            f.journal
              .snapshot()
              .operations.find((op) => op.id === refresh.operationId)
              ?.sources.find((work) => work.source === source.source),
          ).toMatchObject(source);
        }),
      ).pipe(Effect.timeout(4000)),
  );
