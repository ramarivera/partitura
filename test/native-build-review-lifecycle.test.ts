import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { NativeOperationError } from "../src/services/native-build-errors.js";
import { NativeSecretError } from "../src/services/native-build-secret-protocol.js";
import { entry } from "./fixtures/builder-registry.js";
import { fleetActor, fleetFixture } from "./fixtures/native-build-fleet.js";
import { registryJob } from "./fixtures/native-build-registry.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();

it.live(
  "bundle cleanup EIO cannot turn durable human resolution into an error",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("cleanup-eio"));
        const job = registryJob(f.native.generation, {
          state: "interrupted",
          recovery: {
            ...registryJob(f.native.generation).recovery,
            state: "operator-required",
            lastReason: "missing-credentials",
          },
        });
        yield* f.native.state.transaction((data) => data.jobs.push(job));
        f.native.state.remove = () =>
          Effect.fail(NativeOperationError.new("cleanup-eio"));
        const result = yield* f.fleet.humanAction(
          fleetActor,
          "primary",
          {
            expectedHostId: job.verifiedHostId,
            recoveryIds: [job.jobId],
            reason: "Dispose abandoned input",
            evidenceReference: "Approved offline disposal",
            acknowledgeUnverifiedCleanup: true,
          },
          "decommission",
        );
        expect(result.operationId).toMatch(/^[a-f0-9]{32}$/);
        expect(f.native.state.snapshot().jobs[0]?.recovery.state).toBe(
          "admin-resolved",
        );
        expect(f.native.state.snapshot().fleet?.audit.at(-1)?.outcome).toBe(
          "abandoned-unverified",
        );
      }),
    ),
);
it.live(
  "marker-only decommission requires the named current builder to belong to the host",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("marker-owner"));
        yield* f.recovery.observe("primary", {
          protocolVersion: 2,
          kind: "health",
          hostId: f.native.metadata.hostId,
          maintenanceJobId: "e".repeat(32),
        });
        const id = f.native.state.snapshot().fleet?.maintenance[0]?.id;
        if (!id) return yield* Effect.die("missing marker");
        expect(
          yield* Effect.flip(
            f.fleet.humanAction(
              fleetActor,
              "unrelated",
              {
                expectedHostId: f.native.metadata.hostId,
                recoveryIds: [id],
                reason: "Explicit disposal",
                evidenceReference: "Approved disposal",
                acknowledgeUnverifiedCleanup: true,
              },
              "decommission",
            ),
          ),
        ).toMatchObject({ code: "fleet-recovery-conflict" });
        expect(f.native.state.snapshot().fleet?.maintenance[0]?.state).toBe(
          "pending",
        );
        yield* f.write([entry("renamed")]);
        const result = yield* f.fleet.humanAction(
          fleetActor,
          "renamed",
          {
            expectedHostId: f.native.metadata.hostId,
            recoveryIds: [id],
            reason: "Same host after rename",
            evidenceReference: "Approved disposal",
            acknowledgeUnverifiedCleanup: true,
          },
          "decommission",
        );
        expect(result.operationId).toMatch(/^[a-f0-9]{32}$/);
      }),
    ),
);
it.live(
  "a refresh accepted after its obsolete capture is fenced at dispatch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("late-refresh"));
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const accept = f.cache.accept;
        f.cache.accept = (...args) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.andThen(accept(...args)),
          );
        const refreshing = yield* f.fleet
          .refresh(fleetActor, { scope: "builder", builder: "primary" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* f.write([entry("primary", true, 2)]);
        yield* Deferred.succeed(resume, undefined);
        const op = yield* Fiber.join(refreshing);
        yield* f.cache.tick();
        expect(f.cache.progress(op.operationId)?.sources[0]?.status).toBe(
          "superseded",
        );
        expect(f.reads).toEqual([]);
        expect(f.journal.snapshot().charges).toEqual([]);
      }),
    ),
);
it.effect(
  "startup normalization retries after EIO before dispatching restored running work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("normalization-retry"));
        const source = { ...f.source(), source: "file:primary.json" };
        const cache = yield* f.openCache({
          read: () => Effect.succeed(f.record),
        });
        const id = yield* cache.accept("startup", [source], "");
        yield* f.journal.transaction((draft) => {
          const work = draft.operations.find((op) => op.id === id)?.sources[0];
          if (!work) throw new Error("missing operation");
          work.status = "running";
          work.attempts = 1;
        }, 0);
        let fail = true,
          reads = 0;
        const journal: typeof f.journal = {
          ...f.journal,
          transaction: (...args) => {
            if (fail) {
              fail = false;
              return Effect.fail(
                NativeSecretError.new("journal-repair-required"),
              );
            }
            return f.journal.transaction(...args);
          },
        };
        const restarted = yield* f.openCache(
          {
            read: () =>
              Effect.sync(() => {
                reads++;
                return f.record;
              }),
          },
          journal,
        );
        expect(restarted.progress(id)?.sources[0]?.status).toBe("running");
        yield* restarted.revalidatePending([source]);
        yield* restarted.tick();
        expect(reads).toBe(1);
        expect((yield* restarted.wait(id)).sources[0]?.status).toBe(
          "succeeded",
        );
      }),
    ),
);
