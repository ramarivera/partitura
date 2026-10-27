import { describe, expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { InputId, WorkspaceId } from "../src/domain/ids.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  workerSpawnInputs,
  withAuthority,
  testSessionId,
  testOrganizationId,
  seedInterrupted,
} = fixture;

describe("Recovery review regressions", () => {
  it.effect(
    "serializes new input behind worker teardown and the failure transition",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          yield* seedInterrupted(testSessionId);
          yield* authority.processSession(testSessionId);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          fixture.workerStopBlock = { entered, release };
          if (fixture.workerEventListener === undefined)
            throw new Error("worker listener missing");
          fixture.workerEventListener({
            type: "worker_exited",
            message: "worker failed",
          });
          yield* Deferred.await(entered);
          expect(yield* authority.activeWorkerCount()).toBe(1);
          // This prompt predates the scheduled retry and must remain under backoff.
          yield* Effect.gen(function* () {
            const service = yield* RunInputRepo;
            return yield* service.enqueue({
              id: Schema.decodeUnknownSync(InputId)("during-teardown"),
              sessionId: testSessionId,
              kind: "prompted",
              body: "continue",
              payload: {},
              createdAt: yield* Clock.currentTimeMillis,
            });
          });
          const processing = yield* Effect.forkChild(
            authority.processSession(testSessionId),
          );
          yield* Effect.yieldNow;
          expect(
            Option.isNone(
              yield* Effect.sync(() =>
                Option.fromUndefinedOr(processing.pollUnsafe()),
              ),
            ),
          ).toBe(true);
          expect(workerSpawnInputs).toHaveLength(1);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(processing);
          expect(workerSpawnInputs).toHaveLength(1);
          expect(yield* authority.activeWorkerCount()).toBe(0);
          expect(
            Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(testSessionId)),
            ).state,
          ).toBe("orphaned");
        }),
      ),
  );

  it.effect(
    "only fresh actionable input bypasses the persisted retry deadline",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          yield* seedInterrupted(testSessionId);
          const repositoryId =
            Schema.decodeUnknownSync(WorkspaceId)("retry-workspace");
          yield* WorkspaceRepo.use((service) =>
            service.createRepository({
              organizationId: testOrganizationId,
              id: repositoryId,
              url: "https://example.invalid/retry",
              ref: "main",
            }),
          );
          yield* RunRepo.use((service) =>
            service.update(testSessionId, {
              repositoryId: Option.some(repositoryId),
            }),
          );
          yield* TestClock.adjust(1000);
          yield* RunInputRepo.use((service) =>
            service.enqueue({
              id: Schema.decodeUnknownSync(InputId)("old-retry-input"),
              sessionId: testSessionId,
              kind: "prompted",
              body: "old input",
              payload: {},
              createdAt: 1000,
            }),
          );
          yield* RunRepo.use((service) =>
            service.update(testSessionId, {
              state: "orphaned",
              nextAttemptAt: Option.some(300000),
            }),
          );
          // A renewal changes updatedAt after scheduling and must not reset the cutoff.
          yield* TestClock.adjust(1000);
          yield* RunRepo.use((service) =>
            service.claimLease(testSessionId, "foreign", 10),
          );
          yield* RunRepo.use((service) =>
            service.releaseLease(testSessionId, "foreign"),
          );
          yield* authority.processSession(testSessionId);
          expect(workerSpawnInputs).toHaveLength(0);
          yield* RunInputRepo.use((service) =>
            service.enqueue({
              id: Schema.decodeUnknownSync(InputId)("fresh-retry-input"),
              sessionId: testSessionId,
              kind: "prompted",
              body: "new input",
              payload: {},
              createdAt: 1500,
            }),
          );
          yield* authority.processSession(testSessionId);
          expect(workerSpawnInputs).toHaveLength(1);
          expect(
            Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(testSessionId)),
            ).state,
          ).toBe("running");
        }),
      ),
  );
});
