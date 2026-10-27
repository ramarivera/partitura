import { expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { BuilderRegistryIdentity } from "../src/services/builder-registry-identity.js";
import { emptyFleetMetadata } from "../src/services/native-build-fleet-models.js";
import { createNativeBuildRecovery } from "../src/services/native-build-recovery.js";
import {
  NativeBuildStateService,
  newRecovery,
  openNativeBuildState,
} from "../src/services/native-build-state.js";
import { NativeBuildTransport } from "../src/services/native-build-transport.js";
import { memoryBroker } from "./fixtures/native-build-broker.js";
import { fleetActor, fleetFixture } from "./fixtures/native-build-fleet.js";
import { registryJob } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const held = {
  ...newRecovery(),
  state: "operator-required" as const,
  lastReason: "missing-credentials" as const,
};

it.live(
  "an authenticated broker error is a failed cached-health operation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let failed = false;
        const f = yield* fleetFixture(path("error-health"), (transport) => ({
          ...transport,
          envelope: (...args) =>
            failed && args[1] === "health"
              ? Effect.succeed({
                  protocolVersion: 2 as const,
                  kind: "error",
                  hostId: args[0].transport.hostId,
                  code: "broker-state-unavailable",
                })
              : transport.envelope(...args),
        }));
        failed = true;
        const operation = yield* f.fleet.checkHealth(fleetActor, "primary");
        for (
          let i = 0;
          i < 100 &&
          !(yield* f.fleet.progress(fleetActor, operation.operationId)).done;
          i++
        )
          yield* Effect.sleep(5);
        expect(
          yield* f.fleet.progress(fleetActor, operation.operationId),
        ).toMatchObject({ done: true, code: "broker-state-unavailable" });
        expect(f.registry.snapshot().entries[0]?.available).toBe(false);
        expect(f.reads).toEqual([]);
      }),
    ),
);

it.live(
  "initial authenticated maintenance health persists an obligation before any explicit check",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const jobId = "e".repeat(32);
        const f = yield* fleetFixture(
          path("initial-maintenance"),
          (transport) => ({
            ...transport,
            envelope: (...args) =>
              transport.envelope(...args).pipe(
                Effect.map((health) =>
                  args[1] === "health"
                    ? {
                        ...health,
                        maintenanceJobId: jobId,
                        status: "blocked" as const,
                        accepting: false,
                        capacity: 0,
                      }
                    : health,
                ),
              ),
          }),
        );
        expect(f.native.state.snapshot().fleet?.maintenance).toMatchObject([
          { builderId: "primary", jobId, state: "pending" },
        ]);
        expect(f.native.state.snapshot().jobs).toEqual([]);
        expect(f.registry.snapshot().entries[0]?.available).toBe(false);
        yield* f.native.state.close();
        const restarted = yield* openNativeBuildState(f.native.options);
        expect(restarted.snapshot().fleet?.maintenance[0]?.jobId).toBe(jobId);
        expect(restarted.quarantined(f.native.metadata.hostId)).toBe(true);
      }),
    ),
);

it.live(
  "resolved maintenance obligations are evicted before the active capacity limit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("maintenance-cap"));
        const hostId = f.native.metadata.hostId;
        yield* f.native.state.transaction((draft) => {
          draft.fleet = emptyFleetMetadata();
          draft.fleet.maintenance = Array.from({ length: 256 }, (_, index) => ({
            id: index.toString(16).padStart(32, "0"),
            builderId: "primary",
            hostId,
            jobId: (index + 256).toString(16).padStart(32, "0"),
            state: index === 0 ? "pending" : "admin-resolved",
          }));
        });
        yield* f.recovery.observe("primary", {
          protocolVersion: 2,
          kind: "health",
          hostId,
          maintenanceJobId: "f".repeat(32),
        });
        const maintenance = f.native.state.snapshot().fleet?.maintenance ?? [];
        expect(maintenance.length).toBeLessThanOrEqual(256);
        expect(
          maintenance.some(
            (item) => item.id === "0".repeat(32) && item.state === "pending",
          ),
        ).toBe(true);
        expect(
          maintenance.some(
            (item) => item.jobId === "f".repeat(32) && item.state === "pending",
          ),
        ).toBe(true);
      }),
    ),
);

it.effect(
  "interrupted human reconciliation finalizes its audit with the Effect clock",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let block = false;
        const f = yield* fleetFixture(path("interrupt-audit"), (transport) => ({
          ...transport,
          envelope: (...args) =>
            block && args[1].startsWith("cancel ")
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.never),
                )
              : transport.envelope(...args),
        }));
        const job = registryJob(f.native.generation, {
          state: "interrupted",
          recovery: { ...held },
        });
        yield* f.native.state.transaction((draft) => draft.jobs.push(job));
        const start = yield* Clock.currentTimeMillis;
        block = true;
        const action = yield* f.fleet
          .humanAction(
            fleetActor,
            "primary",
            {
              expectedHostId: job.verifiedHostId,
              recoveryIds: [job.jobId],
              reason: "Interrupted cleanup",
            },
            "reconcile",
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect(f.native.state.snapshot().fleet?.starts[0]?.at).toBe(start);
        expect(f.native.state.snapshot().fleet?.audit.at(-1)).toMatchObject({
          at: start,
          outcome: "pending",
        });
        yield* TestClock.adjust(3000);
        yield* Fiber.interrupt(action);
        expect(f.native.state.snapshot().fleet?.audit.at(-1)).toMatchObject({
          at: start + 3000,
          outcome: "failed",
        });
        expect(f.native.state.snapshot().jobs[0]?.recovery.state).toBe(
          "operator-required",
        );
        const release = f.native.state.claimRecovery(job.verifiedHostId);
        expect(release).toBeDefined();
        release?.();
      }),
    ),
);

it.live(
  "same-host credentials cannot clear another logical builder's obligation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("builder-binding"));
        const generation = yield* f.native.state.addGeneration(
          "backup",
          f.native.metadata,
          f.native.key,
        );
        const foreign = registryJob(generation, {
          state: "interrupted",
          recovery: { ...held },
        });
        yield* f.native.state.transaction((draft) => draft.jobs.push(foreign));
        for (const job of [foreign]) {
          expect(
            yield* Effect.flip(
              f.fleet.humanAction(
                fleetActor,
                "primary",
                {
                  expectedHostId: job.verifiedHostId,
                  recoveryIds: [job.jobId],
                  reason: "Wrong logical installation",
                },
                "reconcile",
              ),
            ),
          ).toMatchObject({ code: "fleet-recovery-conflict", status: 409 });
        }
        expect(
          f.native.state
            .snapshot()
            .jobs.every((job) => job.recovery.state === "operator-required"),
        ).toBe(true);
        expect(f.native.state.snapshot().fleet?.audit ?? []).toEqual([]);
      }),
    ),
);

it.live(
  "identity reservation delegates to the state predicate without metadata snapshots",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("reservation-predicate"));
        const calls: string[] = [];
        const identity = yield* BuilderRegistryIdentity.make.pipe(
          Effect.provideService(NativeBuildStateService, {
            ...f.native.state,
            snapshot: () => {
              throw new Error("unexpected metadata snapshot");
            },
            quarantined: (id) => {
              calls.push(id);
              return true;
            },
          }),
          Effect.provideService(NativeBuildTransport, f.native.transport),
        );
        expect(identity.reserved(f.native.metadata.hostId)).toBe(true);
        expect(calls).toEqual([f.native.metadata.hostId]);
      }),
    ),
);

it.live(
  "automatic recovery re-reads a human-resolved job after acquiring the host claim",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("claim-race"));
        const job = registryJob(f.native.generation, {
          state: "interrupted",
          recovery: { ...held, state: "admin-resolved" },
        });
        yield* f.native.state.transaction((draft) => draft.jobs.push(job));
        let claimed = false;
        const state = {
          ...f.native.state,
          snapshot: () => {
            const snapshot = f.native.state.snapshot();
            if (!claimed)
              snapshot.jobs[0] = {
                ...job,
                recovery: {
                  ...newRecovery(),
                  state: "pending",
                  deadline: 901000,
                },
              };
            return snapshot;
          },
          claimRecovery: (hostId: string) => {
            const release = f.native.state.claimRecovery(hostId);
            if (release) claimed = true;
            return release;
          },
        };
        const broker = memoryBroker(() => 1000);
        const recovery = createNativeBuildRecovery(state, broker.transport, {
          now: () => 1000,
        });
        yield* recovery.tick(job.jobId);
        expect(claimed).toBe(true);
        expect(broker.calls).toEqual([]);
        expect(f.native.state.snapshot().jobs[0]?.recovery.state).toBe(
          "admin-resolved",
        );
      }),
    ),
);
