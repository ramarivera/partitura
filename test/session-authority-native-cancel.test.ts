import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Option, Schema } from "effect";
import { InputId } from "../src/domain/ids.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import {
  cutoverFixture,
  cutoverRequest,
} from "./fixtures/native-build-cutover.js";
import { testPaths } from "./fixtures/paths.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const path = testPaths();
const fixture = createAuthorityFixture();
it.live(
  "canceling a registry session cancels its owned starting job on the original generation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("session-cancel"));
        const preparing = yield* Deferred.make<void>();
        const live = yield* f.boot(() =>
          Deferred.succeed(preparing, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        );
        yield* live.registry.awaitIdle();
        const calls: [string, string][] = [];
        const cancelSession = live.jobs.cancelSession;
        live.jobs.cancelSession = (org, session) =>
          Effect.sync(() => {
            calls.push([org, session]);
          }).pipe(Effect.andThen(cancelSession(org, session)));
        yield* fixture.withAuthority(
          () =>
            Effect.gen(function* () {
              const runs = yield* RunRepo;
              const authority = yield* SessionAuthority;
              yield* (yield* InstallationRepo).put(
                fixture.install(fixture.testOrganizationId),
              );
              yield* runs.create({
                sessionId: fixture.testSessionId,
                organizationId: fixture.testOrganizationId,
                issueId: Option.none(),
              });
              const cwd = fixture.testPath("native-cancel-worker");
              yield* runs.update(fixture.testSessionId, {
                state: "orphaned",
                workspacePath: Option.some(cwd),
                ompSessionFile: Option.some(join(cwd, "session.jsonl")),
              });
              yield* authority.processSession(fixture.testSessionId);
              const job = yield* live.jobs.start({
                ...cutoverRequest,
                organizationId: fixture.testOrganizationId,
                sessionId: fixture.testSessionId,
                workspacePath: cwd,
              });
              yield* Deferred.await(preparing);
              yield* (yield* RunInputRepo).enqueue({
                id: Schema.decodeUnknownSync(InputId)("cancel-native"),
                sessionId: fixture.testSessionId,
                kind: "stop",
                body: "stop",
                payload: { type: "AgentSessionEvent", action: "prompted" },
              });
              yield* authority.processSession(fixture.testSessionId);
              expect(
                (yield* runs.get(fixture.testSessionId)).pipe(
                  Option.map((run) => run.state),
                  Option.getOrUndefined,
                ),
              ).toBe("canceled");
              const cancelled = live.state.owned(
                fixture.testOrganizationId,
                fixture.testSessionId,
                job.jobId,
              );
              expect(calls).toContainEqual([
                fixture.testOrganizationId,
                fixture.testSessionId,
              ]);
              expect(cancelled.generationId).toBe(job.generationId);
              expect(cancelled.state).toBe("interrupted");
              expect(cancelled.failureCode).toBe("native-job-interrupted");
            }),
          {
            nativeJobs: live.jobs,
            withLinearGateway: true,
            configOverride: (config) => ({
              ...config,
              nativeBuildRegistry: f.settings,
            }),
          },
        );
      }),
    ),
);
