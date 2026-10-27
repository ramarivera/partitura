import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Result, Schema } from "effect";
import { WorkspaceId } from "../src/domain/ids.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import { RunRepo, WorkspaceRepo } from "../src/services/store/repositories.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  workerSpawnInputs,
  withAuthority,
  testSessionId,
  testOrganizationId,
  seedInterrupted,
} = fixture;

describe("Recovery admission fencing", () => {
  it.effect("doesn't spawn from a preparation whose lease was replaced", () =>
    withAuthority((db) =>
      Effect.gen(function* () {
        const authority = yield* SessionAuthority;
        yield* seedInterrupted(testSessionId);
        const repoId =
          Schema.decodeUnknownSync(WorkspaceId)("preparation-fence");
        yield* WorkspaceRepo.use((service) =>
          service.createRepository({
            organizationId: testOrganizationId,
            id: repoId,
            url: "https://example.invalid/unused",
            ref: "main",
          }),
        );
        yield* RunRepo.use((service) =>
          service.update(testSessionId, {
            repositoryId: Option.some(repoId),
          }),
        );
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        fixture.nixPrepareBlock = { entered, release };
        const preparing = yield* Effect.forkChild(
          authority.processSession(testSessionId).pipe(Effect.result),
        );
        yield* Deferred.await(entered);
        db.query(
          "UPDATE agent_run SET lease_owner='replacement' WHERE session_id=?",
        ).run(testSessionId);
        yield* Deferred.succeed(release, undefined);
        expect(Result.isFailure(yield* Fiber.join(preparing))).toBe(true);
        expect(workerSpawnInputs).toEqual([]);
        expect(
          Option.getOrThrow(
            yield* RunRepo.use((service) => service.get(testSessionId)),
          ).leaseOwner,
        ).toEqual(Option.some("replacement"));
      }),
    ),
  );

  it.effect(
    "fails an interrupted final attempt without starting a sixth worker",
    () =>
      withAuthority((db) =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          yield* seedInterrupted(testSessionId);
          db.query("UPDATE agent_run SET attempt=5 WHERE session_id=?").run(
            testSessionId,
          );
          yield* authority.processRunnable();
          const run = Option.getOrThrow(
            yield* RunRepo.use((service) => service.get(testSessionId)),
          );
          expect(run.state).toBe("failed");
          expect(run.attempt).toBe(5);
          expect(workerSpawnInputs).toEqual([]);
        }),
      ),
  );
});
