import { writeFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BuilderRegistry } from "../src/services/builder-registry.js";
import { GatewayConfig } from "../src/services/config.js";
import { NativeBuildFleet } from "../src/services/native-build-fleet.js";
import { NativeBuildFleetRecovery } from "../src/services/native-build-fleet-recovery.js";
import { NativeBuildSecretCache } from "../src/services/native-build-secret-cache.js";
import { NativeSecretJournal } from "../src/services/native-build-secret-journal.js";
import { NativeSecretError } from "../src/services/native-build-secret-protocol.js";
import {
  NativeBuildStateService,
  newRecovery,
} from "../src/services/native-build-state.js";
import { NativeBuildTransport } from "../src/services/native-build-transport.js";
import { entry } from "./fixtures/builder-registry.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { fleetActor, fleetFixture } from "./fixtures/native-build-fleet.js";
import { registryJob } from "./fixtures/native-build-registry.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const held = {
  ...newRecovery(),
  state: "operator-required" as const,
  lastReason: "missing-credentials" as const,
};
const openFleet = (
  f: Effect.Success<ReturnType<typeof fleetFixture>>,
  cache = f.cache,
) =>
  NativeBuildFleet.make.pipe(
    Effect.provideService(GatewayConfig, f.config),
    Effect.provideService(BuilderRegistry, f.registry),
    Effect.provideService(NativeBuildStateService, f.native.state),
    Effect.provideService(NativeBuildTransport, f.native.transport),
    Effect.provideService(NativeBuildSecretCache, cache),
    Effect.provideService(NativeSecretJournal, f.journal),
    Effect.provideService(NativeBuildFleetRecovery, f.recovery),
  );
it.live(
  "publication supersedes only operation identities captured before the new revision is visible",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("publish-window"));
        const source = {
          builderId: "primary",
          source: "file:primary.json",
          revision: 1,
          retained: false,
        };
        const old = yield* f.cache.accept(
          "human",
          [source],
          fleetActor.organizationId,
        );
        let fresh = "";
        const supersede = f.cache.supersede;
        f.cache.supersede = (...args) =>
          Effect.gen(function* () {
            expect(
              f.registry.snapshot().desired?.builders[0]?.secretRevision,
            ).toBe(2);
            fresh = yield* f.cache.accept(
              "human",
              [{ ...source, revision: 2 }],
              fleetActor.organizationId,
            );
            yield* supersede(...args);
          });
        yield* f.write([entry("primary", true, 2)]);
        expect(f.cache.progress(old)?.sources[0]?.status).toBe("superseded");
        expect(f.cache.progress(fresh)?.sources[0]?.status).toBe("pending");
        yield* f.cache.tick();
        expect(f.cache.progress(fresh)?.sources[0]?.status).toBe("succeeded");
      }),
    ),
);
it.live(
  "fleet startup reattaches a persisted retained refresh to exact generation restoration",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("refresh-restart"));
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
          recovery: { ...held },
        });
        yield* f.native.state.transaction((draft) => draft.jobs.push(job));
        const id = yield* f.cache.accept(
          "human",
          [source],
          fleetActor.organizationId,
        );
        const restarted = yield* f.openCache({
          read: (_source, reserve) => reserve(4).pipe(Effect.as(f.record)),
        });
        yield* openFleet(f, restarted);
        expect(f.native.transport.hasCredential(generation.id)).toBe(false);
        yield* restarted.tick();
        expect(restarted.progress(id)?.done).toBe(true);
        for (
          let i = 0;
          i < 100 && !f.native.transport.hasCredential(generation.id);
          i++
        )
          yield* Effect.sleep(5);
        expect(f.native.transport.hasCredential(generation.id)).toBe(true);
      }),
    ),
);
it.live(
  "refresh completion matches private source identity when two retained sources have revision zero",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("retained-identities"));
        const generations = [];
        for (const name of ["failed", "succeeded"]) {
          const generation = yield* f.native.state.addGeneration(
            "removed",
            { ...f.native.metadata, source: `file:${name}.json` },
            f.native.key,
          );
          generations.push(generation);
          yield* f.native.state.transaction((draft) =>
            draft.jobs.push(
              registryJob(generation, {
                state: "interrupted",
                recovery: { ...held },
              }),
            ),
          );
        }
        const failed = generations[0],
          succeeded = generations[1];
        if (!failed || !succeeded) throw new Error("missing generation");
        const { operationId } = yield* f.fleet.refresh(fleetActor, {
          scope: "all",
        });
        yield* f.journal.transaction((draft) => {
          const operation = draft.operations.find(
            (op) => op.id === operationId,
          );
          const work = operation?.sources.find(
            (work) => work.source === failed.transport.source,
          );
          if (!work) throw new Error("missing work");
          work.status = "failed";
          work.code = "builder-record-invalid";
        });
        for (let i = 0; i < 3; i++) yield* f.cache.tick();
        expect(f.cache.progress(operationId)?.done).toBe(true);
        for (
          let i = 0;
          i < 100 && !f.native.transport.hasCredential(succeeded.id);
          i++
        )
          yield* Effect.sleep(5);
        expect(f.native.transport.hasCredential(succeeded.id)).toBe(true);
        expect(f.native.transport.hasCredential(failed.id)).toBe(false);
      }),
    ),
);
for (const action of ["reconcile", "decommission"] as const)
  it.live(
    `human ${action} releases selected source bundles after durable resolution`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fleetFixture(path(`bundle-${action}`));
          const job = registryJob(f.native.generation, {
            state: "interrupted",
            recovery: { ...held },
          });
          yield* f.native.state.transaction((draft) => draft.jobs.push(job));
          const reservation = yield* f.native.state.reserve(
            job,
            "source.bundle",
            16,
          );
          yield* testAwait(
            writeFile(reservation.path, Buffer.alloc(16), { mode: 0o600 }),
          );
          yield* reservation.commit();
          expect(f.native.state.accounting().usedBytes).toBeGreaterThanOrEqual(
            16,
          );
          yield* testAwait(f.native.plan({ unknown: true }));
          yield* f.fleet.humanAction(
            fleetActor,
            "primary",
            {
              expectedHostId: job.verifiedHostId,
              recoveryIds: [job.jobId],
              reason: "Release resolved input",
              ...(action === "decommission"
                ? {
                    evidenceReference: "Approved offline disposal",
                    acknowledgeUnverifiedCleanup: true,
                  }
                : {}),
            },
            action,
          );
          expect(f.native.state.snapshot().jobs[0]?.recovery.state).toBe(
            "admin-resolved",
          );
          expect(yield* testAwait(Bun.file(reservation.path).exists())).toBe(
            false,
          );
          expect(f.native.state.accounting().usedBytes).toBe(0);
        }),
      ),
  );
it.live(
  "a host maintenance obligation can be reconciled after its observing logical builder is renamed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("maintenance-rename"));
        const marker = "e".repeat(32);
        yield* f.recovery.observe("primary", {
          protocolVersion: 2,
          kind: "health",
          hostId: f.native.metadata.hostId,
          maintenanceJobId: marker,
        });
        const id = f.native.state.snapshot().fleet?.maintenance[0]?.id;
        if (!id) throw new Error("missing obligation");
        yield* f.write([entry("renamed")]);
        yield* testAwait(f.native.plan({ unknown: true }));
        yield* f.fleet.humanAction(
          fleetActor,
          "renamed",
          {
            expectedHostId: f.native.metadata.hostId,
            recoveryIds: [id],
            reason: "Same installation after rename",
          },
          "reconcile",
        );
        expect(f.native.state.snapshot().fleet?.maintenance[0]?.state).toBe(
          "admin-resolved",
        );
      }),
    ),
);
it.effect(
  "restart cannot dispatch unvalidated work after a failed supersession lost its memory fence",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("restart-fence"));
        let fail = false,
          reads = 0;
        const journal: typeof NativeSecretJournal.Service = {
          ...f.journal,
          transaction: (update, at) =>
            fail
              ? Effect.fail(NativeSecretError.new("journal-repair-required"))
              : f.journal.transaction(update, at),
        };
        const reader = {
          read: <E, R>(
            _source: string,
            reserve: (units: number) => Effect.Effect<void, E, R>,
          ) =>
            reserve(4).pipe(
              Effect.tap(() => Effect.sync(() => reads++)),
              Effect.as(f.record),
            ),
        };
        const cache = yield* f.openCache(reader, journal);
        const id = yield* cache.accept("human", [f.source()], "org");
        fail = true;
        expect(
          (yield* Effect.flip(cache.supersede([f.source().builderId]))).code,
        ).toBe("journal-repair-required");
        fail = false;
        const restarted = yield* f.openCache(reader, journal);
        yield* restarted.tick();
        expect(reads).toBe(0);
        expect(f.journal.snapshot().charges).toEqual([]);
        yield* restarted.revalidatePending([]);
        expect(restarted.progress(id)?.sources[0]?.status).toBe("superseded");
      }),
    ),
);
