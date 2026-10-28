import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { NativeTransportError } from "../src/services/native-build-transport.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import {
  cutoverFixture,
  cutoverRequest,
} from "./fixtures/native-build-cutover.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { testPaths } from "./fixtures/paths.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const path = testPaths();
const fixture = createAuthorityFixture();
for (const state of ["running", "succeeded"] as const)
  it.live(
    `registry tool cancels a ${state} job with unresolved recovery and projects the reconciled result`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* cutoverFixture(path(state));
          const live = yield* f.boot();
          yield* live.registry.awaitIdle();
          yield* fixture.withAuthority(
            () =>
              Effect.gen(function* () {
                yield* (yield* InstallationRepo).put(
                  fixture.install(fixture.testOrganizationId),
                );
                const runs = yield* RunRepo;
                yield* runs.create({
                  sessionId: fixture.testSessionId,
                  organizationId: fixture.testOrganizationId,
                  issueId: Option.none(),
                });
                const cwd = fixture.testPath("cancel-worker");
                yield* runs.update(fixture.testSessionId, {
                  state: "orphaned",
                  workspacePath: Option.some(cwd),
                  ompSessionFile: Option.some(join(cwd, "session.jsonl")),
                });
                yield* (yield* SessionAuthority).processSession(
                  fixture.testSessionId,
                );
                const job = yield* live.jobs.start({
                  ...cutoverRequest,
                  organizationId: fixture.testOrganizationId,
                  sessionId: fixture.testSessionId,
                  workspacePath: cwd,
                });
                yield* live.jobs.wait(job.jobId);
                // Model a persisted running job whose broker finished before the next
                // gateway observation, or a terminal receipt still awaiting cleanup.
                yield* live.state.transaction((draft) => {
                  const current = draft.jobs.find(
                    (value) => value.jobId === job.jobId,
                  );
                  if (!current) throw new Error("Missing job");
                  current.state = state;
                  current.recovery.state = "pending";
                  current.recovery.nextAt = 0;
                });
                const before = (yield* testAwait(f.native.trace())).length;
                const listener = fixture.hostToolListener;
                if (!listener) throw new Error("Missing worker tools");
                const response = yield* listener({
                  id: "cancel",
                  toolCallId: "cancel",
                  toolName: "native_build_cancel",
                  arguments: { job: job.jobId },
                });
                expect(response.isError).not.toBe(true);
                expect(response.details).toMatchObject({
                  job: job.jobId,
                  state: "succeeded",
                  cancellationRequested: true,
                });
                expect(
                  live.state.owned(job.organizationId, job.sessionId, job.jobId)
                    .recovery.state,
                ).toBe("resolved-terminal");
                expect(
                  (yield* testAwait(f.native.trace()))
                    .slice(before)
                    .map((value) => value.command.split(" ")[0]),
                ).toContain("cancel");
              }),
            {
              nativeJobs: {
                ...live.jobs,
                status: Effect.fn("Test.unavailableStatus")(() =>
                  Effect.fail(NativeTransportError.new("unavailable")),
                ),
              },
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
