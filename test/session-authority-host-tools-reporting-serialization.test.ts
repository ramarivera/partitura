import { mkdir } from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Schema } from "effect";
import { InputId } from "../src/domain/ids.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  testPath,
  toolExternalUrlCalls,
  orderEvents,
  withAuthority,
  testSessionId,
  testIssueId,
  testOrganizationId,
  install,
} = fixture;

describe("SessionAuthority host-tool mutation gate", () => {
  it.live(
    "reports a pull request from the saved assistant draft at agent end",
    () =>
      withAuthority(
        () =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            const installationRepo = yield* InstallationRepo;
            const runRepo = yield* RunRepo;
            yield* installationRepo.put(install(testOrganizationId));
            yield* runRepo.create({
              sessionId: testSessionId,
              organizationId: testOrganizationId,
              issueId: Option.some(testIssueId),
            });
            yield* Effect.promise(() =>
              mkdir(testPath("pr-draft"), { recursive: true }),
            );
            yield* runRepo.update(testSessionId, {
              state: "orphaned",
              workspacePath: Option.some(testPath("pr-draft")),
              ompSessionFile: Option.some(testPath("pr-draft/session.jsonl")),
            });
            yield* authority.processSession(testSessionId);
            expect(fixture.workerEventListener).toBeDefined();
            if (fixture.workerEventListener === undefined) return;

            const projected = yield* Deferred.make<void>();
            fixture.projectionWaiter = projected;
            fixture.projectionExpected = 2;
            fixture.workerEventListener({
              type: "message_end",
              message: {
                role: "assistant",
                content:
                  "Opened https://github.com/acme/project/pull/42 for review.",
              },
            });
            fixture.workerEventListener({ type: "agent_end" });
            yield* Deferred.await(projected);

            expect(toolExternalUrlCalls).toEqual([
              {
                sessionId: testSessionId,
                urls: [
                  {
                    label: "Pull request",
                    url: "https://github.com/acme/project/pull/42",
                  },
                ],
              },
            ]);
          }),
        { withLinearGateway: true },
      ),
  );

  it.live("cancel waits for an in-flight mutation holding the gate", () =>
    withAuthority(
      () =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          const runInputRepo = yield* RunInputRepo;
          yield* installationRepo.put(install(testOrganizationId));
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.some(testIssueId),
          });
          yield* Effect.promise(() =>
            mkdir(testPath("mutation-gate-order"), { recursive: true }),
          );
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            workspacePath: Option.some(testPath("mutation-gate-order")),
            ompSessionFile: Option.some(
              testPath("mutation-gate-order/session.jsonl"),
            ),
          });
          yield* authority.processSession(testSessionId);
          const listener = fixture.hostToolListener;
          expect(listener).toBeDefined();
          if (listener === undefined) return;

          // Block the mutation inside the gateway's Linear call while it
          // holds the session gate.
          fixture.commentEnteredSignal = yield* Deferred.make<void>();
          fixture.commentRelease = yield* Deferred.make<void>();
          const mutationFiber = yield* Effect.forkChild(
            listener({
              id: "call-blocked",
              toolCallId: "tool-blocked",
              toolName: "linear_create_comment",
              arguments: { body: "in-flight" },
            }),
          );
          yield* Deferred.await(fixture.commentEnteredSignal);

          // A user stop arrives while the in-flight mutation holds the gate.
          yield* runInputRepo.enqueue({
            id: Schema.decodeUnknownSync(InputId)(
              `${testSessionId}:stop:stop-1`,
            ),
            sessionId: testSessionId,
            kind: "stop",
            body: "Stop requested",
            payload: {},
          });
          const cancelFiber = yield* Effect.forkChild(
            authority.processSession(testSessionId),
          );
          yield* Effect.yieldNow;
          Deferred.doneUnsafe(fixture.commentRelease, Effect.void);
          yield* Fiber.await(mutationFiber);
          yield* Fiber.join(cancelFiber);
          expect(orderEvents).toContain("worker-stopped");
          expect(orderEvents).toContain("comment-completed");
        }),
      { withLinearGateway: true },
    ),
  );
});
