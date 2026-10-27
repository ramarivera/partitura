import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";
import {
  NativeOperationError,
  nativeIO,
} from "../src/services/native-build-errors.js";
import {
  createNativeBuildRecovery,
  recoverNativeMetadata,
} from "../src/services/native-build-recovery.js";
import { openNativeBuildState } from "../src/services/native-build-state.js";
import { createNativeBuildTransport } from "../src/services/native-build-transport.js";
import { memoryBroker } from "./fixtures/native-build-broker.js";
import {
  fixturePrivateKey,
  registryFixture,
  registryJob,
} from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();

for (const scenario of ["slow-rounds", "gateway-downtime"] as const)
  it.live(`host return after ${scenario} still performs its single check`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path(scenario));
        let time = 1_000_000;
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        yield* fixture.state.transaction((draft) => {
          draft.jobs.push(job);
        });
        yield* recoverNativeMetadata(fixture.state, time);
        const broker = memoryBroker(
          () => time,
          (milliseconds) => {
            time += milliseconds;
          },
        );
        broker.settings.unavailable = true;
        broker.settings.unavailableDelay = 140_000;
        const recovery = createNativeBuildRecovery(
          fixture.state,
          broker.transport,
          { now: () => time },
        );
        if (scenario === "slow-rounds") {
          for (let index = 0; index < 5; index++) {
            yield* recovery.tick(job.jobId);
            time = fixture.state.owned("org-a", "session-a", job.jobId).recovery
              .nextAt;
          }
        } else time += 1_000_000;
        yield* fixture.state.close();
        const state = yield* openNativeBuildState(fixture.options);
        yield* recoverNativeMetadata(state, time);
        const restart = createNativeBuildRecovery(state, broker.transport, {
          now: () => time,
        });
        yield* restart.tick(job.jobId);
        expect(
          state.owned("org-a", "session-a", job.jobId).recovery.lastReason,
        ).toBe("deadline");
        expect(
          state.owned("org-a", "session-a", job.jobId).recovery.returnEventUsed,
        ).toBe(false);
        const before = broker.calls.length;
        time = state.owned("org-a", "session-a", job.jobId).recovery.nextAt;
        broker.settings.unavailable = false;
        yield* restart.tick(job.jobId);
        expect(broker.calls.slice(before).map((call) => call.command)).toEqual([
          "health",
          `cancel ${job.jobId}`,
          `reconcile ${job.jobId}`,
          "health",
        ]);
        expect(
          state.owned("org-a", "session-a", job.jobId).recovery.state,
        ).toBe("resolved-unknown");
        expect(
          state.owned("org-a", "session-a", job.jobId).recovery.returnEventUsed,
        ).toBe(true);
      }),
    ),
  );

it.live(
  "transient broker, auth and host-key observations preserve an unused return check",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("flap"));
        let time = 1_000_000;
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        job.recovery = {
          ...job.recovery,
          state: "operator-required",
          lastReason: "unavailable",
          deadline: 1,
        };
        yield* fixture.state.transaction((draft) => {
          draft.jobs.push(job);
        });
        const broker = memoryBroker(() => time),
          recovery = createNativeBuildRecovery(
            fixture.state,
            broker.transport,
            { now: () => time },
          );
        broker.settings.healthError = true;
        yield* recovery.tick(job.jobId);
        expect(
          fixture.state.owned("org-a", "session-a", job.jobId).recovery
            .observation,
        ).toBe("unavailable");
        broker.settings.healthError = false;
        for (const failure of [
          "needs-refresh",
          "host-key-mismatch",
          "unavailable",
        ] as const) {
          time += 300_000;
          broker.settings.healthFailure = failure;
          yield* recovery.tick(job.jobId);
          const current = fixture.state.owned("org-a", "session-a", job.jobId);
          expect(current.recovery.observation).toBe(failure);
          expect(current.recovery.returnEventUsed).toBe(false);
          expect(current.recovery.lastReason).toBe("unavailable");
        }
        broker.settings.healthFailure = "";
        time += 300_000;
        yield* recovery.tick(job.jobId);
        expect(
          fixture.state.owned("org-a", "session-a", job.jobId).recovery.state,
        ).toBe("resolved-unknown");
      }),
    ),
);

it.live(
  "pending key restore can complete, while current-only credentials never override an original generation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("pending-keys"));
        const newKey = yield* nativeIO(() =>
          fixturePrivateKey(join(fixture.root, "current-key")),
        );
        const current = yield* fixture.state.addGeneration(
          "primary",
          { ...fixture.metadata, hostname: "current.example.test" },
          newKey,
        );
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        yield* fixture.state.transaction((draft) => {
          draft.jobs.push(job);
        });
        yield* fixture.state.close();
        const state = yield* openNativeBuildState(fixture.options);
        const transport = yield* createNativeBuildTransport(state, {
          suffix: "example.test",
          executable: fixture.executable,
        });
        yield* recoverNativeMetadata(state, 100_000);
        const recovery = createNativeBuildRecovery(state, transport, {
          now: () => 100_000,
        });
        yield* recovery.tick(job.jobId);
        expect(
          state.owned("org-a", "session-a", job.jobId).recovery.observation,
        ).toBe("credentials-pending");
        yield* transport.restore(fixture.metadata.source, [newKey]);
        expect(transport.hasCredential(current.id)).toBe(true);
        expect(transport.credentialState(fixture.generation.id)).toBe(
          "missing",
        );
        const next = createNativeBuildRecovery(state, transport, {
          now: () => 110_000,
        });
        yield* next.tick(job.jobId);
        expect(
          state.owned("org-a", "session-a", job.jobId).recovery.lastReason,
        ).toBe("missing-credentials");
        const trace = yield* nativeIO(() =>
          readFile(join(fixture.root, "trace.jsonl")),
        ).pipe(Effect.flip);
        expect(trace.cause).toMatchObject({ code: "ENOENT" });
      }),
    ),
);

it.live(
  "a failed initial recovery state write allocates no remote work or timeout",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("write-failure"));
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        yield* fixture.state.transaction((draft) => {
          draft.jobs.push(job);
        });
        yield* recoverNativeMetadata(fixture.state, 100_000);
        const broker = memoryBroker(() => 100_000);
        const broken = {
          ...fixture.state,
          transaction: <A>(
            _operation: Parameters<typeof fixture.state.transaction<A>>[0],
          ) =>
            Effect.fail(
              NativeOperationError.new("injected-state-write-failed"),
            ),
        };
        const recovery = createNativeBuildRecovery(broken, broker.transport, {
          now: () => 100_000,
        });
        const timeout = vi.spyOn(globalThis, "setTimeout");
        const error = yield* recovery
          .tick(job.jobId)
          .pipe(
            Effect.flip,
            Effect.ensuring(Effect.sync(() => timeout.mockRestore())),
          );
        expect(timeout).not.toHaveBeenCalled();
        expect(error.reason).toBe("injected-state-write-failed");
        expect(broker.calls).toHaveLength(0);
        // Successful retry also proves the in-flight job/host leases were finalized.
        yield* createNativeBuildRecovery(fixture.state, broker.transport, {
          now: () => 100_000,
        }).tick(job.jobId);
        expect(fixture.state.quarantined(fixture.metadata.hostId)).toBe(false);
      }),
    ),
);

it.live(
  "resolved submitting crash removes the obsolete charged source bundle",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("crash-bundle"));
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        yield* fixture.state.transaction((draft) => {
          draft.jobs.push(job);
        });
        const reservation = yield* fixture.state.reserve(
          job,
          "source.bundle",
          4,
        );
        yield* nativeIO(() =>
          writeFile(reservation.path, "test", { mode: 0o600 }),
        );
        yield* reservation.commit();
        yield* recoverNativeMetadata(fixture.state, 100_000);
        const broker = memoryBroker(() => 100_000);
        yield* createNativeBuildRecovery(fixture.state, broker.transport, {
          now: () => 100_000,
        }).tick(job.jobId);
        expect(
          (yield* nativeIO(() => readFile(reservation.path)).pipe(Effect.flip))
            .cause,
        ).toMatchObject({ code: "ENOENT" });
      }),
    ),
);

it.live(
  "a pending original key restore resumes actual remote recovery without a manual hold",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("pending-success"));
        yield* nativeIO(() => fixture.plan({ unknown: true }));
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        yield* fixture.state.transaction((draft) => {
          draft.jobs.push(job);
        });
        yield* fixture.state.close();
        const state = yield* openNativeBuildState(fixture.options);
        const transport = yield* createNativeBuildTransport(state, {
          suffix: "example.test",
          executable: fixture.executable,
        });
        yield* recoverNativeMetadata(state, 100_000);
        yield* createNativeBuildRecovery(state, transport, {
          now: () => 100_000,
        }).tick(job.jobId);
        expect(
          state.owned("org-a", "session-a", job.jobId).recovery.state,
        ).toBe("pending");
        yield* transport.restore(fixture.metadata.source, [fixture.key]);
        yield* createNativeBuildRecovery(state, transport, {
          now: () => 110_000,
        }).tick(job.jobId);
        expect(
          state.owned("org-a", "session-a", job.jobId).recovery.state,
        ).toBe("resolved-unknown");
        expect(
          (yield* nativeIO(() => fixture.trace())).map(
            (entry) => entry.command.split(" ")[0],
          ),
        ).toEqual(["cancel", "reconcile", "health"]);
      }),
    ),
);

it.live(
  "a recovered terminal receipt survives a failed health check and restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("recovered-receipt"));
        const time = 1_000_000;
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        yield* fixture.state.transaction((draft) => {
          draft.jobs.push(job);
        });
        yield* recoverNativeMetadata(fixture.state, time);
        const broker = memoryBroker(() => time);
        broker.settings.terminal = true;
        broker.settings.healthFailure = "unavailable";
        yield* createNativeBuildRecovery(fixture.state, broker.transport, {
          now: () => time,
        }).tick(job.jobId);
        expect(broker.calls.map((call) => call.command.split(" ")[0])).toEqual([
          "cancel",
          "reconcile",
          "status",
          "health",
        ]);
        yield* fixture.state.close();
        const state = yield* openNativeBuildState(fixture.options);
        yield* recoverNativeMetadata(state, time);
        const current = state.owned("org-a", "session-a", job.jobId);
        expect(current.state).toBe("succeeded");
        expect(current.artifactBytes).toBe(7);
        expect(current.artifactSha256).toBe("d".repeat(64));
        // Clean matching health is still required to release quarantine.
        expect(current.recovery.state).toBe("pending");
        expect(current.recovery.lastReason).toBe("unavailable");
        yield* state.close();
      }),
    ),
);

it.live(
  "an authenticated broker-state-unavailable error follows the retry schedule",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("broker-state"));
        const time = 1_000_000;
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        yield* fixture.state.transaction((draft) => {
          draft.jobs.push(job);
        });
        yield* recoverNativeMetadata(fixture.state, time);
        const broker = memoryBroker(() => time);
        broker.settings.cancelError = true;
        yield* createNativeBuildRecovery(fixture.state, broker.transport, {
          now: () => time,
        }).tick(job.jobId);
        const current = fixture.state.owned("org-a", "session-a", job.jobId);
        expect(current.recovery.state).toBe("pending");
        expect(current.recovery.lastReason).toBe("unavailable");
        expect(current.recovery.returnEligible).toBe(true);
      }),
    ),
);
