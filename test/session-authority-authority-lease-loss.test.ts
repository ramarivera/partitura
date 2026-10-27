import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Option } from "effect";
import { SessionAuthority } from "../src/services/session-authority.js";
import { RunEventRepo, RunRepo } from "../src/services/store/repositories.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const { withAuthority, testSessionId, seedInterrupted } = fixture;

describe("Authority lease loss", () => {
  it.effect(
    "refuses a late success event after another process takes over",
    () =>
      withAuthority((db) =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          yield* seedInterrupted(testSessionId);
          yield* authority.processSession(testSessionId);
          const now = yield* Clock.currentTimeMillis;
          db.query(
            "UPDATE agent_run SET lease_owner='replacement', lease_expires_at=? WHERE session_id=?",
          ).run(now + 60_000, testSessionId);
          if (fixture.workerEventListener === undefined)
            throw new Error("listener missing");
          fixture.workerEventListener({ type: "agent_end" });
          yield* Effect.repeat(authority.activeWorkerCount(), {
            until: (count) => count === 0,
          });
          expect(
            Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(testSessionId)),
            ).state,
          ).toBe("running");
          expect(
            Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(testSessionId)),
            ).leaseOwner,
          ).toEqual(Option.some("replacement"));
          expect(yield* authority.activeWorkerCount()).toBe(0);
          expect(
            (yield* RunEventRepo.use((service) =>
              service.list(testSessionId),
            )).some((event) =>
              Option.getOrElse(event.text, () => "").includes("succeeded"),
            ),
          ).toBe(false);
        }),
      ),
  );
});
