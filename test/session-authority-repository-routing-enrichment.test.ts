import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { InputId, ProjectId, TeamId, WorkspaceId } from "../src/domain/ids.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { safeSessionKey } from "../src/services/workspace.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  workerSpawnInputs,
  withAuthority,
  testSessionId,
  testIssueId,
  testOrganizationId,
  install,
} = fixture;

describe("SessionAuthority repository routing enrichment", () => {
  it.live(
    "cancels a sparse webhook when the enriched issue team is inaccessible",
    () =>
      withAuthority(
        () =>
          Effect.gen(function* () {
            const runs = yield* RunRepo;
            yield* (yield* InstallationRepo).put({
              ...install(testOrganizationId),
              accessibleTeamIds: Option.some([]),
              canAccessAllPublicTeams: Option.some(false),
            });
            fixture.linearIssueTeamId = "api-team";
            yield* runs.create({
              sessionId: testSessionId,
              organizationId: testOrganizationId,
              issueId: Option.some(testIssueId),
            });
            yield* (yield* RunInputRepo).enqueue({
              id: Schema.decodeUnknownSync(InputId)("denied-routing-input"),
              sessionId: testSessionId,
              kind: "created",
              body: "Fix routing",
              payload: {},
            });
            yield* (yield* SessionAuthority).processSession(testSessionId);
            const run = Option.getOrThrow(yield* runs.get(testSessionId));
            expect(run.state).toBe("canceled");
            expect(run.terminalReason).toEqual(
              Option.some("Linear team access was removed"),
            );
            expect(run.teamId).toEqual(Option.some("api-team"));
            expect(fixture.linearIssueReads).toBe(1);
            expect(workerSpawnInputs).toEqual([]);
          }),
        { withLinearGateway: true },
      ),
  );
  it.live("preserves known team and project IDs when issue lookup fails", () =>
    withAuthority(
      () =>
        Effect.gen(function* () {
          const runs = yield* RunRepo;
          yield* (yield* InstallationRepo).put(install(testOrganizationId));
          const teamId = Schema.decodeUnknownSync(TeamId)("known-team");
          const projectId =
            Schema.decodeUnknownSync(ProjectId)("known-project");
          fixture.linearIssueLookupFails = true;
          yield* runs.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.some(testIssueId),
            teamId: Option.some(teamId),
            projectId: Option.some(projectId),
          });
          yield* (yield* RunInputRepo).enqueue({
            id: Schema.decodeUnknownSync(InputId)("preserved-routing-input"),
            sessionId: testSessionId,
            kind: "created",
            body: "Fix routing",
            payload: {},
          });
          yield* (yield* SessionAuthority).processSession(testSessionId);
          const run = Option.getOrThrow(yield* runs.get(testSessionId));
          expect(run.teamId).toEqual(Option.some(teamId));
          expect(run.projectId).toEqual(Option.some(projectId));
          expect(fixture.linearIssueReads).toBe(1);
        }),
      { withLinearGateway: true },
    ),
  );
  for (const route of [
    "project",
    "issue-label",
    "project-label",
    "team",
    "webhook",
    "default",
  ] as const) {
    it.live(`routes sparse webhooks using ${route} context`, () =>
      withAuthority(
        () =>
          Effect.gen(function* () {
            const repositories = yield* WorkspaceRepo;
            const runs = yield* RunRepo;
            yield* (yield* InstallationRepo).put(install(testOrganizationId));
            fixture.linearIssueTeamId = "api-team";
            fixture.linearIssueProjectId = "api-project";
            fixture.linearIssueLabels = ["REPO:ONYXIO", "driver:omp"];
            fixture.linearProjectLabels = ["PROJECT:ONYXIO"];
            fixture.linearIssueLookupFails =
              route === "webhook" || route === "default";
            const id = Schema.decodeUnknownSync(WorkspaceId)("routed-repo");
            const fallbackId =
              Schema.decodeUnknownSync(WorkspaceId)("default-repo");
            for (const repoId of [id, fallbackId]) {
              yield* repositories.createRepository({
                id: repoId,
                organizationId: testOrganizationId,
                url: "https://github.com/fixture/routing.git",
                ref: "main",
                isDefault: repoId === fallbackId,
                projectIds:
                  repoId === id && (route === "project" || route === "webhook")
                    ? [
                        Schema.decodeUnknownSync(ProjectId)(
                          route === "webhook"
                            ? "webhook-project"
                            : "api-project",
                        ),
                      ]
                    : [],
                teamIds:
                  repoId === id && route === "team"
                    ? [Schema.decodeUnknownSync(TeamId)("api-team")]
                    : [],
                labels:
                  repoId === id
                    ? route === "issue-label"
                      ? ["repo:onyxio"]
                      : route === "project-label"
                        ? ["project:onyxio"]
                        : []
                    : [],
              });
            }
            yield* runs.create({
              sessionId: testSessionId,
              organizationId: testOrganizationId,
              issueId: Option.some(testIssueId),
            });
            yield* (yield* RunInputRepo).enqueue({
              id: Schema.decodeUnknownSync(InputId)("routing-input"),
              sessionId: testSessionId,
              kind: "created",
              body: "Fix routing",
              payload:
                route === "webhook"
                  ? {
                      agentSession: {
                        issue: {
                          teamId: "webhook-team",
                          projectId: "webhook-project",
                        },
                      },
                    }
                  : {},
            });
            // Reuse a real checkout to exercise resolution without network access.
            const cwd = join(
              fixture.authorityTestRoot,
              safeSessionKey(testSessionId),
            );
            yield* Effect.promise(async () => {
              await mkdir(cwd, { recursive: true });
              const init = Bun.spawn(["git", "init", cwd], {
                stdout: "ignore",
                stderr: "pipe",
              });
              if ((await init.exited) !== 0)
                throw new Error(await new Response(init.stderr).text());
              await writeFile(
                join(cwd, ".linear-gateway-workspace.json"),
                JSON.stringify({
                  repositoryId: route === "default" ? fallbackId : id,
                  url: "https://github.com/fixture/routing.git",
                  ref: "main",
                }),
              );
            });
            yield* (yield* SessionAuthority).processSession(testSessionId);
            const run = Option.getOrThrow(yield* runs.get(testSessionId));
            expect(run.repositoryId).toEqual(
              Option.some(route === "default" ? fallbackId : id),
            );
            expect(run.teamId).toEqual(
              Option.fromNullishOr(
                route === "webhook"
                  ? "webhook-team"
                  : route === "default"
                    ? null
                    : "api-team",
              ),
            );
            expect(run.projectId).toEqual(
              Option.fromNullishOr(
                route === "webhook"
                  ? "webhook-project"
                  : route === "default"
                    ? null
                    : "api-project",
              ),
            );
            expect(workerSpawnInputs).toHaveLength(1);
            expect(fixture.linearIssueReads).toBe(1);
          }),
        { withLinearGateway: true },
      ),
    );
  }
});
