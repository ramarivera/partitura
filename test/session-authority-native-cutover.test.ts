import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { bytes, document, entry } from "./fixtures/builder-registry.js";
import {
  cutoverFixture,
  cutoverRequest,
} from "./fixtures/native-build-cutover.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { testPaths } from "./fixtures/paths.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const path = testPaths();
const fixture = createAuthorityFixture();
it.live(
  "an existing registry worker sees hot add/edit/remove and follows its immutable owned job without legacy bypass",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("live-worker"));
        yield* f.write(document([]));
        const live = yield* f.boot();
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
              const cwd = fixture.testPath("cutover-worker");
              yield* runs.update(fixture.testSessionId, {
                state: "orphaned",
                workspacePath: Option.some(cwd),
                ompSessionFile: Option.some(join(cwd, "session.jsonl")),
              });
              yield* authority.processSession(fixture.testSessionId);
              const listener = fixture.hostToolListener;
              if (!listener) return yield* Effect.die("missing worker tools");
              const names = fixture.registeredHostTools.map(
                (tool) => tool.name,
              );
              expect(names).toContain("native_build_start");
              expect(names).toContain("native_build_builders");
              expect(names).not.toContain("native_build_refresh");
              const call = (
                toolName: string,
                args: Record<string, unknown> = {},
              ) =>
                listener({
                  id: "call",
                  toolCallId: "call",
                  toolName,
                  arguments: args,
                });
              expect((yield* call("native_build_builders")).details).toEqual(
                [],
              );
              expect(
                (yield* call("native_build_start", cutoverRequest)).isError,
              ).toBe(true);
              yield* f.write(document([entry()]));
              yield* live.registry.reload();
              yield* live.registry.awaitIdle();
              expect((yield* call("native_build_builders")).details).toEqual([
                { id: "primary", available: true },
              ]);
              const input = {
                commit: cutoverRequest.commit,
                pullRequest: 7,
                action: "archive",
              };
              const started = yield* call("native_build_start", input);
              expect(started.isError).not.toBe(true);
              const data = started.details as {
                job: string;
                builder: string;
                state: string;
              };
              expect(data.builder).toBe("primary");
              expect(Object.keys(data).sort()).toEqual([
                "action",
                "builder",
                "commit",
                "job",
                "pullRequest",
                "state",
              ]);
              yield* live.jobs.wait(data.job);
              const originalJob = live.state
                .snapshot()
                .jobs.find((job) => job.jobId === data.job);
              expect(originalJob?.generationId).toBeDefined();
              const sourcePath = join(
                f.settings.fileSecretRoot ?? "",
                "primary.json",
              );
              yield* testAwait(chmod(sourcePath, 0o600));
              yield* testAwait(
                writeFile(
                  sourcePath,
                  bytes({
                    ...f.primary,
                    hostname: "primary-rotated.example.test",
                  }),
                ),
              );
              yield* testAwait(chmod(sourcePath, 0o400));
              yield* f.write(
                document([entry("primary", true, 2), entry("backup")]),
              );
              yield* live.registry.reload();
              yield* live.registry.awaitIdle();
              expect((yield* call("native_build_builders")).details).toEqual([
                { id: "primary", available: true },
                { id: "backup", available: true },
              ]);
              const edited = yield* call("native_build_start", input);
              expect(edited.isError).not.toBe(true);
              const nextData = edited.details as { job: string };
              yield* live.jobs.wait(nextData.job);
              const editedJob = live.state
                .snapshot()
                .jobs.find((job) => job.jobId === nextData.job);
              expect(editedJob?.generationId).not.toBe(
                originalJob?.generationId,
              );
              expect(
                live.state.snapshot().jobs.find((job) => job.jobId === data.job)
                  ?.generationId,
              ).toBe(originalJob?.generationId);
              yield* f.write(document([entry("backup")]));
              yield* live.registry.reload();
              yield* live.registry.awaitIdle();
              expect((yield* call("native_build_builders")).details).toEqual([
                { id: "backup", available: true },
              ]);
              expect(
                (yield* call("native_build_status", { job: data.job })).details,
              ).toMatchObject({ builder: "primary", state: "succeeded" });
              expect(
                (yield* call("native_build_status", {
                  job: data.job,
                  builder: "backup",
                })).isError,
              ).toBe(true);
              expect(
                (yield* call("native_build_start", {
                  ...input,
                  builder: "primary",
                })).isError,
              ).toBe(true);
              const artifact = yield* call("native_build_artifact", {
                job: data.job,
              });
              expect(artifact.isError).not.toBe(true);
              expect(artifact.details).toMatchObject({
                builder: "primary",
                path: join(cwd, ".omp-home", "native-build", `${data.job}.tar`),
              });
              expect(
                (yield* call("native_build_cancel", { job: data.job })).isError,
              ).not.toBe(true);
              expect(live.state.snapshot().jobs).toHaveLength(2);
            }),
          {
            nativeJobs: live.jobs,
            withLinearGateway: true,
            configOverride: (config) => ({
              ...config,
              nativeBuildRegistry: f.settings,
              nativeBuild: {
                sshConfigFile: "/nonexistent-legacy-config",
                scratchRoot: "/nonexistent-legacy-root",
              },
            }),
          },
        );
      }),
    ),
);
