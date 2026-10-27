import { lstat, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import * as fc from "fast-check";
import { describe, expect, vi } from "vitest";
import { buildGitHubExtraHeader } from "../src/services/github-app.js";
import { WorkspaceRepo } from "../src/services/store/repositories.js";
import {
  isWithin,
  makeWorkspace,
  safeSessionKey,
  Workspace,
} from "../src/services/workspace.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

import {
  createRepository,
  expectWorkspaceFailure,
  fixtureIo,
  gitFixture,
  MARKER_FILE,
  organizationId,
  readGitConfig,
  readGitConfigAll,
  repositoryRecord,
  resolveWith,
  runGit,
  sessionId,
  withWorkspace,
  workspaceId,
} from "./workspace-test-helpers.js";

describe("Workspace", () => {
  it.live(
    "rejects invalid repository records with their typed repository error",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        yield* withWorkspace(
          fixture.workspaceRoot,
          Effect.gen(function* () {
            const repository = yield* WorkspaceRepo;
            const result = yield* Effect.result(
              repository.createRepository({
                organizationId: organizationId("org"),
                id: workspaceId("unsafe-repository"),
                url: "--upload-pack=unsafe",
                ref: "main",
              }),
            );
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isSuccess(result))
              throw new Error("Expected RowDecodeError");
            if (result.failure._tag !== "@Gateway/RowDecodeError") {
              throw new Error(
                `Expected RowDecodeError, got ${result.failure._tag}`,
              );
            }
            expect(result.failure.entity).toBe("RepositoryRecord");
          }),
        );
      }),
  );

  it.live("rejects root and target symlinks without following them", () =>
    Effect.gen(function* () {
      const fixture = yield* gitFixture;
      yield* withWorkspace(
        fixture.workspaceRoot,
        Effect.gen(function* () {
          const repository = yield* WorkspaceRepo;
          const record = yield* createRepository(repository, fixture, "one");
          const linkedRoot = join(fixture.root, "linked-workspaces");
          yield* fixtureIo("workspace root symlink", () =>
            symlink(fixture.source, linkedRoot),
          );

          const linkedWorkspace = yield* makeWorkspace({
            workspaceRoot: linkedRoot,
            repo: repository,
            githubApp: undefined,
          });
          expectWorkspaceFailure(
            yield* Effect.result(
              linkedWorkspace.materialize(sessionId("linked-root"), record),
            ),
            "root_not_directory",
          );

          yield* fixtureIo("workspace root creation", () =>
            mkdir(fixture.workspaceRoot),
          );
          const target = join(
            fixture.workspaceRoot,
            safeSessionKey("linked-target"),
          );
          yield* fixtureIo("workspace target symlink", () =>
            symlink(fixture.source, target),
          );
          const workspace = yield* makeWorkspace({
            workspaceRoot: fixture.workspaceRoot,
            repo: repository,
            githubApp: undefined,
          });
          expectWorkspaceFailure(
            yield* Effect.result(
              workspace.materialize(sessionId("linked-target"), record),
            ),
            "target_not_directory",
          );
        }),
      );
    }),
  );

  it.live(
    "rejects mismatched reuse and failed checkouts without creating a valid marker",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        yield* withWorkspace(
          fixture.workspaceRoot,
          Effect.gen(function* () {
            const repository = yield* WorkspaceRepo;
            const workspace = yield* Workspace;
            const firstRepository = yield* createRepository(
              repository,
              fixture,
              "one",
            );
            const secondRepository = yield* createRepository(
              repository,
              fixture,
              "two",
            );
            const reusedSession = sessionId("mismatched-reuse");
            yield* workspace.materialize(reusedSession, firstRepository);
            expectWorkspaceFailure(
              yield* Effect.result(
                workspace.materialize(reusedSession, secondRepository),
              ),
              "marker_mismatch",
            );

            const failingRepository = yield* createRepository(
              repository,
              fixture,
              "missing-ref",
              {
                ref: "missing-ref",
              },
            );
            const failingSession = sessionId("failed-checkout");
            expectWorkspaceFailure(
              yield* Effect.result(
                workspace.materialize(failingSession, failingRepository),
              ),
              "git_failed",
            );
            const failedTarget = join(
              fixture.workspaceRoot,
              safeSessionKey("failed-checkout"),
            );
            expect(
              yield* Effect.result(
                fixtureIo("failed workspace marker read", () =>
                  readFile(join(failedTarget, MARKER_FILE), "utf8"),
                ),
              ),
            ).toMatchObject({ _tag: "Failure" });
          }),
        );
      }),
  );

  it.live("releases every bounded git fixture when its scope closes", () =>
    Effect.gen(function* () {
      const root = yield* Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* gitFixture;
          return fixture.root;
        }),
      );
      const metadata = yield* Effect.result(
        fixtureIo("post-scope fixture stat", () => lstat(root)),
      );
      expect(Result.isFailure(metadata)).toBe(true);
    }),
  );
});

describe("Workspace properties", () => {
  it("generated repository contexts retain explicit, label, project, team, and default precedence", () =>
    fc.assert(
      fc.property(
        fc.record({ suffix: fc.integer({ min: 1, max: 1_000_000 }) }),
        ({ suffix }) => {
          const org = `org-${suffix}`;
          const issueLabel = `issue-${suffix}`;
          const projectLabel = `project-label-${suffix}`;
          const project = `project-${suffix}`;
          const team = `team-${suffix}`;
          const repositories = [
            repositoryRecord({ id: `explicit-${suffix}`, organization: org }),
            repositoryRecord({
              id: `issue-${suffix}`,
              organization: org,
              labels: [issueLabel],
            }),
            repositoryRecord({
              id: `project-label-${suffix}`,
              organization: org,
              labels: [projectLabel],
            }),
            repositoryRecord({
              id: `project-${suffix}`,
              organization: org,
              projectIds: [project],
            }),
            repositoryRecord({
              id: `team-${suffix}`,
              organization: org,
              teamIds: [team],
            }),
            repositoryRecord({
              id: `default-${suffix}`,
              organization: org,
              isDefault: true,
            }),
          ];
          const context = {
            organizationId: org,
            repositoryId: null,
            issueLabels: [issueLabel],
            projectLabels: [projectLabel],
            projectId: project,
            teamId: team,
          };

          expect(
            resolveWith(repositories, {
              ...context,
              repositoryId: `explicit-${suffix}`,
            }),
          ).toMatchObject({
            kind: "match",
            repository: { id: `explicit-${suffix}` },
          });
          expect(resolveWith(repositories, context)).toMatchObject({
            kind: "match",
            repository: { id: `issue-${suffix}` },
          });
          expect(
            resolveWith(repositories, { ...context, issueLabels: [] }),
          ).toMatchObject({
            kind: "match",
            repository: { id: `project-label-${suffix}` },
          });
          expect(
            resolveWith(repositories, {
              ...context,
              issueLabels: [],
              projectLabels: [],
            }),
          ).toMatchObject({
            kind: "match",
            repository: { id: `project-${suffix}` },
          });
          expect(
            resolveWith(repositories, {
              ...context,
              issueLabels: [],
              projectLabels: [],
              projectId: null,
            }),
          ).toMatchObject({
            kind: "match",
            repository: { id: `team-${suffix}` },
          });
          expect(
            resolveWith(repositories, {
              ...context,
              issueLabels: [],
              projectLabels: [],
              projectId: null,
              teamId: null,
            }),
          ).toMatchObject({
            kind: "match",
            repository: { id: `default-${suffix}` },
          });
        },
      ),
    ));

  it("generated competing mappings remain explicit ambiguities with a stable candidate order", () =>
    fc.assert(
      fc.property(
        fc.record({ suffix: fc.integer({ min: 1, max: 1_000_000 }) }),
        ({ suffix }) => {
          const label = `shared-${suffix}`;
          const repositories = [
            repositoryRecord({ id: `first-${suffix}`, labels: [label] }),
            repositoryRecord({ id: `second-${suffix}`, labels: [label] }),
          ];
          const context = {
            organizationId: "org",
            repositoryId: null,
            issueLabels: [label],
            projectLabels: [],
            projectId: null,
            teamId: null,
          };
          const first = resolveWith(repositories, context);
          const second = resolveWith(repositories, context);
          expect(first).toEqual({ kind: "ambiguous", repositories });
          expect(second).toEqual(first);
        },
      ),
    ));

  it("normalized nested paths stay contained while normalized traversals are rejected", () =>
    fc.assert(
      fc.property(
        fc.record({
          segments: fc.array(
            fc.constantFrom("alpha", "beta", "gamma", "delta"),
            {
              maxLength: 8,
            },
          ),
          outsideSegment: fc.constantFrom("outside", "other", "escape"),
        }),
        ({ segments, outsideSegment }) => {
          const root = "/workspace-root";
          expect(isWithin(root, join(root, ...segments))).toBe(true);
          expect(
            isWithin(root, join(root, "safe", "..", "..", outsideSegment)),
          ).toBe(false);
          expect(isWithin(root, join(root, "..", outsideSegment))).toBe(false);
        },
      ),
    ));

  it("workspace identity is deterministic, fixed-width, and collision-resistant for generated session IDs", () =>
    fc.assert(
      fc.property(
        fc.record({ first: fc.uuid(), second: fc.uuid() }),
        ({ first, second }) => {
          const firstKey = safeSessionKey(first);
          expect(safeSessionKey(first)).toBe(firstKey);
          expect(firstKey).toMatch(/^[a-f0-9]{32}$/u);
          if (first !== second)
            expect(safeSessionKey(second)).not.toBe(firstKey);
        },
      ),
    ));
});
it.live(
  "keeps GitHub credentials off every Git argv while cloning and checking out a real fixture",
  () =>
    Effect.gen(function* () {
      const fixture = yield* gitFixture;
      const uid = String(process.getuid?.() ?? 1000);
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.stubEnv("WORKER_UID", uid)),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );
      const nativeSpawn = Bun.spawn;
      const spy = yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(Bun, "spawn").mockImplementation((command, options) => {
            // Native tests can't setgroups. Verify the uid wrapper while executing
            // the real Git operations as the checkout owner.
            if (Array.isArray(command) && command[0] === "/usr/bin/setpriv")
              return nativeSpawn(
                command.slice(command.indexOf("--") + 1),
                options,
              );
            return nativeSpawn(command, options);
          }),
        ),
        (value) => Effect.sync(() => value.mockRestore()),
      );
      const token = "ghs_argv_secret";
      const header = buildGitHubExtraHeader(token);
      const workspace = yield* makeWorkspace({
        workspaceRoot: fixture.workspaceRoot,
        repo: { listRepositories: () => Effect.succeed([]) },
        githubApp: {
          getBotIdentity: () =>
            Effect.succeed({
              name: "test-app[bot]",
              email: "98765+test-app[bot]@users.noreply.github.com",
            }),
          getInstallationToken: () => Effect.succeed(token),
        },
      });
      const globalConfigBefore = yield* fixtureIo("read global config", () =>
        readFile(join(fixture.root, "gitconfig"), "utf8"),
      );
      const target = yield* workspace.materialize(
        "secret-argv-test",
        repositoryRecord({ id: "secret-argv-test", url: fixture.url }),
        uid,
      );
      expect(yield* readGitConfig("user.name", target)).toBe("test-app[bot]");
      expect(yield* readGitConfig("user.email", target)).toBe(
        "98765+test-app[bot]@users.noreply.github.com",
      );
      yield* runGit(["commit", "--allow-empty", "-m", "worker commit"], target);
      expect(
        yield* fixtureIo("read global config", () =>
          readFile(join(fixture.root, "gitconfig"), "utf8"),
        ),
      ).toBe(globalConfigBefore);
      const calls = spy.mock.calls;
      const commands = calls
        .map(([command]) => command)
        .filter((command): command is string[] => Array.isArray(command));
      for (const key of ["user.name", "user.email"]) {
        const configCommand = commands.find((command) => command.includes(key));
        expect(configCommand?.slice(0, 5)).toEqual([
          "/usr/bin/setpriv",
          "--reuid",
          uid,
          "--regid",
          uid,
        ]);
        expect(configCommand).toContain("--local");
      }
      expect(JSON.stringify(commands)).not.toContain(token);
      expect(JSON.stringify(commands)).not.toContain(header);
      const clone = calls.find(
        ([command]) => Array.isArray(command) && command.includes("clone"),
      );
      expect(clone?.[0]).toContain("--");
      expect(clone?.[1]?.env?.GIT_CONFIG_VALUE_0).toBe(header);
      expect(clone?.[1]?.env?.GIT_TERMINAL_PROMPT).toBe("0");
      expect(clone?.[1]?.env?.GIT_ASKPASS).toBe("");
      expect(clone?.[1]?.env).not.toHaveProperty("LINEAR_CLIENT_SECRET");
      expect(
        yield* readGitConfigAll("http.https://github.com/.extraheader", target),
      ).toEqual([]);
      const fetch = calls.find(
        ([command]) => Array.isArray(command) && command.includes("fetch"),
      );
      expect(fetch?.[1]?.env?.GIT_CONFIG_VALUE_0).toBe(header);
    }),
);
