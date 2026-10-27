import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
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
  withAuthority,
  testSessionId,
  testIssueId,
  testOrganizationId,
  install,
} = fixture;

describe("SessionAuthority deferred stop handling", () => {
  it.live(
    "skips a deferred stop after repeated lookup failures instead of canceling",
    () =>
      withAuthority(
        () =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            const installationRepo = yield* InstallationRepo;
            const runRepo = yield* RunRepo;
            const runInputRepo = yield* RunInputRepo;
            fixture.linearIssueLookupFails = true;
            yield* installationRepo.put(install(testOrganizationId));
            yield* runRepo.create({
              sessionId: testSessionId,
              organizationId: testOrganizationId,
              issueId: Option.some(testIssueId),
            });
            yield* runRepo.update(testSessionId, {
              state: "orphaned",
              workspacePath: Option.some(testPath("deferred-stop")),
              ompSessionFile: Option.some(
                testPath("deferred-stop/session.jsonl"),
              ),
            });
            const inputId = Schema.decodeUnknownSync(InputId)(
              "deferred-stop-input",
            );
            yield* runInputRepo.enqueue({
              id: inputId,
              sessionId: testSessionId,
              kind: "stop",
              body: "Linear issue status changed",
              payload: {
                type: "AppUserNotification",
                action: "issueStatusChanged",
                notification: { issueId: "issue-1" },
              },
            });

            for (let attempt = 0; attempt < 10; attempt += 1) {
              yield* authority.processSession(testSessionId);
            }

            const pending = yield* runInputRepo.pending(testSessionId);
            expect(pending).toHaveLength(0);
            const run = yield* runRepo.get(testSessionId);
            expect(Option.isSome(run)).toBe(true);
            if (Option.isSome(run)) {
              expect(run.value.state).not.toBe("canceled");
              expect(run.value.desiredState).toBe("running");
            }
          }),
        { withLinearGateway: true },
      ),
  );
});
