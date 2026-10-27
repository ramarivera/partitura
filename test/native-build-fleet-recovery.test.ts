import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createNativeBuildRecovery } from "../src/services/native-build-recovery.js";
import {
  newRecovery,
  openNativeBuildState,
} from "../src/services/native-build-state.js";
import { decodeBrokerEnvelope } from "../src/services/native-build-transport.js";
import { testAwait } from "./fixtures/native-build-effects.js";
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
  "human current-key reconciliation fences every selected obligation without rebinding original generations",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("current-key"));
        const old = yield* f.native.state.addGeneration(
          "primary",
          { ...f.native.metadata, hostname: "old.example.test" },
          f.native.key,
        );
        const job = registryJob(old, {
          state: "interrupted",
          recovery: { ...held },
        });
        const other = registryJob(old, {
          state: "interrupted",
          recovery: { ...held },
        });
        yield* f.native.state.transaction((draft) =>
          draft.jobs.push(job, other),
        );
        yield* testAwait(f.native.plan({ unknown: true }));
        const input = {
          expectedHostId: job.verifiedHostId,
          recoveryIds: [job.jobId],
          reason: "Current-key cleanup after rotation",
        };
        expect(
          yield* Effect.flip(
            f.fleet.humanAction(
              { ...fleetActor, kind: "agent" },
              "primary",
              input,
              "reconcile",
            ),
          ),
        ).toMatchObject({ code: "fleet-forbidden" });
        const result = yield* f.fleet.humanAction(
          fleetActor,
          "primary",
          input,
          "reconcile",
        );
        const stored = f.native.state.snapshot().jobs[0];
        expect(stored?.generationId).toBe(old.id);
        expect(stored?.organizationId).toBe(job.organizationId);
        expect(stored?.recovery).toMatchObject({
          state: "admin-resolved",
          resolvedEpoch: "b".repeat(32),
        });
        expect(f.native.state.quarantined(job.verifiedHostId)).toBe(true); // Other obligation still holds the host.
        expect(
          (yield* f.fleet.progress(fleetActor, result.operationId)).done,
        ).toBe(true);
        const trace = yield* testAwait(f.native.trace());
        expect(trace.slice(-3).map((call) => call.command)).toEqual([
          `cancel ${job.jobId}`,
          `reconcile ${job.jobId}`,
          "health",
        ]);
        expect(
          trace.slice(-3).every((call) => call.hostname !== "old.example.test"),
        ).toBe(true);
        expect(f.native.state.snapshot().fleet?.audit.at(-1)).toMatchObject({
          actor: fleetActor.sessionHash,
          organizationId: fleetActor.organizationId,
          outcome: "admin-resolved",
          before: ["operator-required"],
        });
        expect(
          yield* Effect.flip(
            f.fleet.humanAction(
              fleetActor,
              "primary",
              { ...input, recoveryIds: [other.jobId] },
              "reconcile",
            ),
          ),
        ).toMatchObject({ status: 429 });
      }),
    ),
);
it.live(
  "wrong-host and cleanup evidence cannot be cleared by explicit human reconciliation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("refuse"));
        const job = registryJob(f.native.generation, {
          state: "interrupted",
          recovery: { ...held, lastReason: "cleanup-required" },
        });
        yield* f.native.state.transaction((draft) => draft.jobs.push(job));
        const input = {
          expectedHostId: job.verifiedHostId,
          recoveryIds: [job.jobId],
          reason: "Try cleanup",
        };
        const count = (yield* testAwait(f.native.trace())).length;
        expect(
          yield* Effect.flip(
            f.fleet.humanAction(
              fleetActor,
              "primary",
              {
                ...input,
                expectedHostId: "22222222-2222-4222-8222-222222222222",
              },
              "reconcile",
            ),
          ),
        ).toMatchObject({ status: 409 });
        expect((yield* testAwait(f.native.trace())).length).toBe(count);
        yield* testAwait(f.native.plan({ cleanup: "cleanup-required" }));
        expect(
          yield* Effect.flip(
            f.fleet.humanAction(fleetActor, "primary", input, "reconcile"),
          ),
        ).toMatchObject({ code: "fleet-cleanup-conflict", status: 409 });
        expect(f.native.state.snapshot().jobs[0]?.recovery).toMatchObject({
          state: "operator-required",
          lastReason: "cleanup-required",
        });
        expect(f.native.state.quarantined(job.verifiedHostId)).toBe(true);
        expect(f.native.state.snapshot().fleet?.audit.at(-1)?.outcome).toBe(
          "failed",
        );
      }),
    ),
);
it.live(
  "offline decommission of a removed builder persists unverified outcome and the host denylist across restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("retired"));
        const job = registryJob(f.native.generation, {
          state: "running",
          recovery: { ...held },
        });
        yield* f.native.state.transaction((draft) => draft.jobs.push(job));
        yield* f.write([]);
        const count = (yield* testAwait(f.native.trace())).length;
        const input = {
          expectedHostId: job.verifiedHostId,
          recoveryIds: [job.jobId],
          reason: "Installation removed",
          evidenceReference: "<script>evidence</script>",
          acknowledgeUnverifiedCleanup: true,
        };
        expect(
          yield* Effect.flip(
            f.fleet.humanAction(
              fleetActor,
              "primary",
              { ...input, acknowledgeUnverifiedCleanup: false },
              "decommission",
            ),
          ),
        ).toMatchObject({ status: 400 });
        yield* f.fleet.humanAction(
          fleetActor,
          "primary",
          input,
          "decommission",
        );
        expect((yield* testAwait(f.native.trace())).length).toBe(count);
        expect(f.native.state.snapshot().jobs[0]).toMatchObject({
          generationId: job.generationId,
          state: "interrupted",
          failureCode: "abandoned-unverified",
        });
        expect(f.native.state.snapshot().fleet?.audit.at(-1)).toMatchObject({
          outcome: "abandoned-unverified",
          evidenceReference: input.evidenceReference,
        });
        yield* f.native.state.close();
        const restored = yield* openNativeBuildState(f.native.options);
        expect(restored.snapshot().fleet?.retiredHosts).toContain(
          job.verifiedHostId,
        );
        expect(restored.quarantined(job.verifiedHostId)).toBe(true);
      }),
    ),
);
it.live(
  "unknown maintenance markers create private host obligations without invented execution ownership",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("maintenance"));
        const jobId = "a".repeat(32);
        yield* f.recovery.observe("primary", {
          protocolVersion: 2,
          kind: "health",
          hostId: f.native.metadata.hostId,
          maintenanceJobId: jobId,
        });
        yield* f.recovery.observe("primary", {
          protocolVersion: 2,
          kind: "health",
          hostId: f.native.metadata.hostId,
          maintenanceJobId: jobId,
        });
        expect(f.native.state.snapshot().jobs).toEqual([]);
        expect(f.native.state.snapshot().fleet?.maintenance).toHaveLength(1);
        expect(f.native.state.quarantined(f.native.metadata.hostId)).toBe(true);
        const view = yield* f.fleet.fleet(fleetActor);
        expect(JSON.stringify(view)).not.toContain(jobId);
        const obligation = view.entries[0]?.maintenance[0];
        if (!obligation) return yield* Effect.die("missing maintenance");
        yield* testAwait(f.native.plan({ unknown: true }));
        yield* f.fleet.humanAction(
          fleetActor,
          "primary",
          {
            expectedHostId: f.native.metadata.hostId,
            recoveryIds: [obligation.id],
            reason: "Clear maintenance fence",
          },
          "reconcile",
        );
        expect(f.native.state.quarantined(f.native.metadata.hostId)).toBe(
          false,
        );
        expect(f.native.state.snapshot().jobs).toEqual([]);
      }),
    ),
);

for (const fault of ["wrong-host", "busy"] as const)
  it.live(
    `human reconciliation retains ${fault} evidence from an authenticated cleanup attempt`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fleetFixture(path(fault));
          const job = registryJob(f.native.generation, {
            state: "interrupted",
            recovery: {
              ...held,
              lastReason: fault === "wrong-host" ? "wrong-host" : "busy",
            },
          });
          yield* f.native.state.transaction((draft) => draft.jobs.push(job));
          yield* testAwait(
            f.native.plan(
              fault === "wrong-host"
                ? { hostId: "22222222-2222-4222-8222-222222222222" }
                : { busy: true },
            ),
          );
          expect(
            yield* Effect.flip(
              f.fleet.humanAction(
                fleetActor,
                "primary",
                {
                  expectedHostId: job.verifiedHostId,
                  recoveryIds: [job.jobId],
                  reason: "Attempt bounded cleanup",
                },
                "reconcile",
              ),
            ),
          ).toMatchObject({ _tag: "@Gateway/NativeFleetError" });
          expect(f.native.state.snapshot().jobs[0]?.recovery.state).toBe(
            "operator-required",
          );
          expect(f.native.state.quarantined(job.verifiedHostId)).toBe(true);
        }),
      ),
  );

it.live("human and automatic recovery share one physical-host lock", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fleetFixture(path("shared-lock"));
      const job = registryJob(f.native.generation, {
        state: "interrupted",
        recovery: {
          ...held,
          nextAt: 0,
          deadline: Date.now() + 60000,
          state: "pending",
        },
      });
      yield* f.native.state.transaction((draft) => draft.jobs.push(job));
      const automatic = createNativeBuildRecovery(
        f.native.state,
        f.native.transport,
      );
      const before = (yield* testAwait(f.native.trace())).length;
      yield* Effect.acquireRelease(
        Effect.sync(() => f.native.state.claimRecovery(job.verifiedHostId)),
        (release) => Effect.sync(() => release?.()),
      );
      yield* automatic.tick(job.jobId);
      expect(
        yield* Effect.flip(
          f.fleet.humanAction(
            fleetActor,
            "primary",
            {
              expectedHostId: job.verifiedHostId,
              recoveryIds: [job.jobId],
              reason: "Busy recovery",
            },
            "reconcile",
          ),
        ),
      ).toMatchObject({ code: "fleet-host-busy" });
      expect((yield* testAwait(f.native.trace())).length).toBe(before);
      expect(f.native.state.snapshot().jobs[0]?.recovery.attempts).toBe(0);
    }),
  ),
);
it.live(
  "human recovery preserves a terminal receipt when subsequent epoch health fails",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("receipt-before-health"));
        const job = registryJob(f.native.generation, {
          state: "interrupted",
          recovery: { ...held },
        });
        yield* f.native.state.transaction((draft) => draft.jobs.push(job));
        yield* testAwait(
          writeFile(
            join(f.native.root, `${job.jobId}.json`),
            JSON.stringify({
              job: job.jobId,
              commit: job.commit,
              action: job.action,
              attempt: job.attempt,
              state: "succeeded",
            }),
            { mode: 0o600 },
          ),
        );
        yield* testAwait(f.native.plan({ epoch: "a".repeat(32) }));
        expect(
          yield* Effect.flip(
            f.fleet.humanAction(
              fleetActor,
              "primary",
              {
                expectedHostId: job.verifiedHostId,
                recoveryIds: [job.jobId],
                reason: "Check receipt durability",
              },
              "reconcile",
            ),
          ),
        ).toMatchObject({ status: 409 });
        expect(f.native.state.snapshot().jobs[0]).toMatchObject({
          state: "succeeded",
          generationId: job.generationId,
          recovery: { state: "operator-required" },
        });
        expect(f.native.state.quarantined(job.verifiedHostId)).toBe(true);
      }),
    ),
);
it.live(
  "maintenance command binding cannot fabricate a known execution receipt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("maintenance-binding"));
        expect(() =>
          decodeBrokerEnvelope(
            JSON.stringify({
              protocolVersion: 2,
              hostId: f.native.metadata.hostId,
              kind: "known",
              job: "a".repeat(32),
              state: "succeeded",
            }),
            f.native.generation,
            { jobId: "a".repeat(32) },
          ),
        ).toThrow("protocol-mismatch");
      }),
    ),
);
