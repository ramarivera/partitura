import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SessionAuthority } from "../src/services/session-authority.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const { orderEvents, withAuthority, testSessionId, seedInterrupted } = fixture;

describe("Recovery and concurrency regressions", () => {
  it.effect("layer finalization shuts down workers and releases leases", () =>
    Effect.gen(function* () {
      yield* withAuthority(
        () =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            yield* seedInterrupted(testSessionId);
            yield* authority.processSession(testSessionId);
            expect(orderEvents).not.toContain("worker-stopped");
          }),
        {
          afterShutdown: (db) => {
            const row = db
              .query("SELECT lease_owner FROM agent_run WHERE session_id=?")
              .get(testSessionId);
            expect(row).toEqual({ lease_owner: null });
          },
        },
      );
      expect(orderEvents).toContain("worker-stopped");
      expect(fixture.workerEventListener).toBeUndefined();
    }),
  );
});
