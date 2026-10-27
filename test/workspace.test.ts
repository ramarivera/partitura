import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { describe, expect, vi } from "vitest";
import { buildGitHubExtraHeader } from "../src/services/github-app.js";
import { WorkspaceRepo } from "../src/services/store/repositories.js";
import {
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
  fixtureIo,
  gitFixture,
  MARKER_FILE,
  organizationId,
  projectId,
  readGitConfig,
  readGitConfigAll,
  repositoryRecord,
  runGit,
  sessionId,
  teamId,
  withWorkspace,
  workspaceId,
} from "./workspace-test-helpers.js";

describe("Workspace", () => {
  it.live(
    "routes explicit repository, labels, project, team, and default mappings by precedence",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        yield* withWorkspace(
          fixture.workspaceRoot,
          Effect.gen(function* () {
            const repository = yield* WorkspaceRepo;
            const workspace = yield* Workspace;
            yield* createRepository(repository, fixture, "explicit");
            yield* createRepository(repository, fixture, "issue", {
              labels: ["issue-label"],
            });
            yield* createRepository(repository, fixture, "project-label", {
              labels: ["project-label"],
            });
            yield* createRepository(repository, fixture, "project", {
              projectIds: ["project"],
            });
            yield* createRepository(repository, fixture, "team", {
              teamIds: ["team"],
            });
            yield* createRepository(repository, fixture, "default", {
              isDefault: true,
            });

            expect(
              yield* workspace.resolve({
                organizationId: organizationId("org"),
                repositoryId: workspaceId("explicit"),
                issueLabels: ["issue-label"],
                projectLabels: ["project-label"],
                projectId: projectId("project"),
                teamId: teamId("team"),
              }),
            ).toMatchObject({ kind: "match", repository: { id: "explicit" } });
            expect(
              yield* workspace.resolve({
                organizationId: organizationId("org"),
                repositoryId: null,
                issueLabels: [" ISSUE-LABEL "],
                projectLabels: ["project-label"],
                projectId: projectId("project"),
                teamId: teamId("team"),
              }),
            ).toMatchObject({ kind: "match", repository: { id: "issue" } });
            expect(
              yield* workspace.resolve({
                organizationId: organizationId("org"),
                repositoryId: null,
                issueLabels: [],
                projectLabels: ["PROJECT-LABEL"],
                projectId: projectId("project"),
                teamId: teamId("team"),
              }),
            ).toMatchObject({
              kind: "match",
              repository: { id: "project-label" },
            });
            expect(
              yield* workspace.resolve({
                organizationId: organizationId("org"),
                repositoryId: null,
                issueLabels: [],
                projectLabels: [],
                projectId: projectId("project"),
                teamId: teamId("team"),
              }),
            ).toMatchObject({ kind: "match", repository: { id: "project" } });
            expect(
              yield* workspace.resolve({
                organizationId: organizationId("org"),
                repositoryId: null,
                issueLabels: [],
                projectLabels: [],
                projectId: null,
                teamId: teamId("team"),
              }),
            ).toMatchObject({ kind: "match", repository: { id: "team" } });
            expect(
              yield* workspace.resolve({
                organizationId: organizationId("org"),
                repositoryId: null,
                issueLabels: [],
                projectLabels: [],
                projectId: null,
                teamId: null,
              }),
            ).toMatchObject({ kind: "match", repository: { id: "default" } });
            expect(
              yield* workspace.resolve({
                organizationId: organizationId("org"),
                repositoryId: workspaceId("missing"),
                issueLabels: [],
                projectLabels: [],
                projectId: null,
                teamId: null,
              }),
            ).toEqual({ kind: "none" });
          }),
        );
      }),
  );

  it.live("reports all competing repository mappings as an ambiguity", () =>
    Effect.gen(function* () {
      const fixture = yield* gitFixture;
      yield* withWorkspace(
        fixture.workspaceRoot,
        Effect.gen(function* () {
          const repository = yield* WorkspaceRepo;
          const workspace = yield* Workspace;
          yield* createRepository(repository, fixture, "team-one", {
            teamIds: ["team"],
          });
          yield* createRepository(repository, fixture, "team-two", {
            teamIds: ["team"],
          });

          expect(
            yield* workspace.resolve({
              organizationId: organizationId("org"),
              repositoryId: null,
              issueLabels: [],
              projectLabels: [],
              projectId: null,
              teamId: teamId("team"),
            }),
          ).toMatchObject({
            kind: "ambiguous",
            repositories: [{ id: "team-one" }, { id: "team-two" }],
          });
        }),
      );
    }),
  );

  it.live(
    "materializes a detached checkout once and safely reuses its repository-bound target",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        yield* withWorkspace(
          fixture.workspaceRoot,
          Effect.gen(function* () {
            const repository = yield* WorkspaceRepo;
            const workspace = yield* Workspace;
            const record = yield* createRepository(repository, fixture, "one");
            const id = sessionId("session-one");

            const first = yield* workspace.materialize(id, record);
            const second = yield* workspace.materialize(id, record);
            expect(second).toBe(first);
            expect(
              yield* fixtureIo("workspace read", () =>
                readFile(join(first, "README.txt"), "utf8"),
              ),
            ).toBe("fixture\n");
            expect(
              JSON.parse(
                yield* fixtureIo("workspace marker read", () =>
                  readFile(join(first, MARKER_FILE), "utf8"),
                ),
              ),
            ).toEqual({
              repositoryId: "one",
              url: fixture.url,
              ref: "main",
            });
            expect(
              yield* fixtureIo("workspace git head", async () => {
                const process = Bun.spawn(
                  ["git", "status", "--porcelain=v2", "--branch"],
                  {
                    cwd: first,
                    stdout: "pipe",
                    stderr: "pipe",
                  },
                );
                const [exitCode, stdout] = await Promise.all([
                  process.exited,
                  new Response(process.stdout).text(),
                ]);
                if (exitCode !== 0)
                  throw new Error("workspace HEAD is not inspectable");
                return stdout;
              }),
            ).toContain("# branch.head (detached)");
          }),
        );
      }),
  );

  it.live(
    "removes stale gateway GitHub credentials when reusing a workspace",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        const id = sessionId("github-reuse-refresh");
        const record = repositoryRecord({
          id: "github-reuse-refresh",
          url: "https://github.com/octo-org/private-repo.git",
        });
        yield* fixtureIo("workspace root creation", () =>
          mkdir(fixture.workspaceRoot, { recursive: true }),
        );
        const target = join(fixture.workspaceRoot, safeSessionKey(id));
        yield* fixtureIo("workspace target creation", () => mkdir(target));
        yield* runGit(["init"], target);
        yield* runGit(
          [
            "config",
            "--local",
            "http.https://github.com/.extraheader",
            buildGitHubExtraHeader("stale-token"),
          ],
          target,
        );
        yield* runGit(
          [
            "config",
            "--local",
            "--add",
            "http.https://github.com/.extraheader",
            "X-User: retained",
          ],
          target,
        );
        yield* fixtureIo("workspace marker creation", () =>
          writeFile(
            join(target, MARKER_FILE),
            JSON.stringify({
              repositoryId: record.id,
              url: record.url,
              ref: record.ref,
            }),
          ),
        );
        let tokenCalls = 0;
        const workspace = yield* makeWorkspace({
          workspaceRoot: fixture.workspaceRoot,
          repo: { listRepositories: () => Effect.succeed([]) },
          githubApp: {
            getBotIdentity: () =>
              Effect.succeed({
                name: "test-app[bot]",
                email: "98765+test-app[bot]@users.noreply.github.com",
              }),
            getInstallationToken: () => {
              tokenCalls += 1;
              return Effect.succeed("fresh-token");
            },
          },
        });
        yield* workspace.materialize(id, record);
        expect(yield* readGitConfig("user.name", target)).toBe("test-app[bot]");
        expect(yield* readGitConfig("user.email", target)).toBe(
          "98765+test-app[bot]@users.noreply.github.com",
        );
        yield* runGit(
          ["commit", "--allow-empty", "-m", "worker commit"],
          target,
        );
        yield* runGit(["config", "--local", "--unset", "user.email"], target);
        yield* workspace.materialize(id, record);
        expect(yield* readGitConfig("user.email", target)).toBe(
          "98765+test-app[bot]@users.noreply.github.com",
        );
        yield* runGit(["config", "--local", "--unset", "user.name"], target);
        yield* workspace.refreshGitHubExtraHeader(id, record, target);
        expect(yield* readGitConfig("user.name", target)).toBe("test-app[bot]");
        expect(tokenCalls).toBe(0);
        expect(
          yield* readGitConfigAll(
            "http.https://github.com/.extraheader",
            target,
          ),
        ).toEqual(["X-User: retained"]);
        yield* workspace.clearGitHubExtraHeader(id, target);
        expect(
          yield* readGitConfigAll(
            "http.https://github.com/.extraheader",
            target,
          ),
        ).toEqual(["X-User: retained"]);
      }),
  );

  it.live(
    "replaces stale broker rewrites for each worker launch and clears them",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        const id = sessionId("github-broker-rewrite");
        const record = repositoryRecord({
          id: "github-broker-rewrite",
          url: "https://github.com/octo-org/private-repo.git",
        });
        const target = join(fixture.workspaceRoot, safeSessionKey(id));
        yield* fixtureIo("workspace target creation", () =>
          mkdir(target, { recursive: true }),
        );
        yield* runGit(["init"], target);
        const workspace = yield* makeWorkspace({
          workspaceRoot: fixture.workspaceRoot,
          repo: { listRepositories: () => Effect.succeed([]) },
          githubApp: {
            getBotIdentity: () =>
              Effect.succeed({ name: "bot", email: "bot@example.test" }),
            getInstallationToken: () => Effect.succeed("fresh-token"),
          },
        });
        const first = yield* Effect.acquireRelease(
          workspace.openGitBroker(id, record),
          (broker) => Effect.sync(() => broker?.stop()),
        );
        expect(first).toBeDefined();
        if (first === undefined) return;
        yield* workspace.configureGitBroker(id, target, first);
        expect(yield* readGitConfig("push.negotiate", target)).toBe("true");
        expect(yield* readGitConfig(first.gitConfigKey, target)).toBe(
          record.url,
        );

        const second = yield* Effect.acquireRelease(
          workspace.openGitBroker(id, record),
          (broker) => Effect.sync(() => broker?.stop()),
        );
        expect(second).toBeDefined();
        if (second === undefined) return;
        yield* workspace.configureGitBroker(id, target, second);
        expect(
          yield* readGitConfig(first.gitConfigKey, target),
        ).toBeUndefined();
        expect(yield* readGitConfig(second.gitConfigKey, target)).toBe(
          record.url,
        );

        yield* workspace.clearGitBrokerConfig(id, target);
        expect(
          yield* readGitConfig(second.gitConfigKey, target),
        ).toBeUndefined();
      }),
  );

  it.live(
    "never writes the bot identity into a repository enclosing a non-checkout target",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        const outer = join(fixture.root, "enclosing-repo");
        const inner = join(outer, "not-a-checkout");
        yield* fixtureIo("enclosing repo creation", () =>
          mkdir(inner, { recursive: true }),
        );
        yield* runGit(["init"], outer);
        const id = sessionId("identity-scope");
        const record = repositoryRecord({
          id: "identity-scope",
          url: "https://github.com/octo-org/private-repo.git",
        });
        const workspace = yield* makeWorkspace({
          workspaceRoot: fixture.workspaceRoot,
          repo: { listRepositories: () => Effect.succeed([]) },
          githubApp: {
            getBotIdentity: () =>
              Effect.succeed({
                name: "test-app[bot]",
                email: "98765+test-app[bot]@users.noreply.github.com",
              }),
            getInstallationToken: () => Effect.succeed("fresh-token"),
          },
        });
        const refreshed = yield* Effect.result(
          workspace.refreshGitHubExtraHeader(id, record, inner),
        );
        expect(Result.isSuccess(refreshed)).toBe(true);
        expect(yield* readGitConfig("user.name", outer)).toBeUndefined();
        expect(yield* readGitConfig("user.email", outer)).toBeUndefined();
        expect(
          yield* readGitConfig("http.https://github.com/.extraheader", outer),
        ).toBeUndefined();
        const broker = yield* Effect.acquireRelease(
          workspace.openGitBroker(id, record),
          (value) => Effect.sync(() => value?.stop()),
        );
        expect(broker).toBeDefined();
        if (broker === undefined) return;
        yield* workspace.configureGitBroker(id, inner, broker);
        expect(
          yield* readGitConfig(broker.gitConfigKey, outer),
        ).toBeUndefined();
        yield* fixtureIo("unsafe Git directory link", () =>
          symlink(join(outer, ".git"), join(inner, ".git")),
        );
        yield* workspace.configureGitBroker(id, inner, broker);
        expect(
          yield* readGitConfig(broker.gitConfigKey, outer),
        ).toBeUndefined();
      }),
  );

  it.live("unsets GitHub credentials when reusing without configuration", () =>
    Effect.gen(function* () {
      const fixture = yield* gitFixture;
      const id = sessionId("github-reuse-unset");
      const record = repositoryRecord({
        id: "github-reuse-unset",
        url: "https://github.com/octo-org/private-repo.git",
      });
      yield* fixtureIo("workspace root creation", () =>
        mkdir(fixture.workspaceRoot, { recursive: true }),
      );
      const target = join(fixture.workspaceRoot, safeSessionKey(id));
      yield* fixtureIo("workspace target creation", () => mkdir(target));
      yield* runGit(["init"], target);
      yield* runGit(
        [
          "config",
          "--local",
          "http.https://github.com/.extraheader",
          buildGitHubExtraHeader("stale-token"),
        ],
        target,
      );

      yield* fixtureIo("workspace marker creation", () =>
        writeFile(
          join(target, MARKER_FILE),
          JSON.stringify({
            repositoryId: record.id,
            url: record.url,
            ref: record.ref,
          }),
        ),
      );
      const workspace = yield* makeWorkspace({
        workspaceRoot: fixture.workspaceRoot,
        repo: { listRepositories: () => Effect.succeed([]) },
        githubApp: undefined,
      });
      yield* workspace.materialize(id, record);
      expect(
        yield* readGitConfig("http.https://github.com/.extraheader", target),
      ).toBeUndefined();
    }),
  );

  it.live(
    "preserves a user-installed GitHub extraheader when clearing credentials",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        const id = sessionId("github-reuse-preserve-foreign");
        const record = repositoryRecord({
          id: "github-reuse-preserve-foreign",
          url: "https://github.com/octo-org/private-repo.git",
        });
        yield* fixtureIo("workspace root creation", () =>
          mkdir(fixture.workspaceRoot, { recursive: true }),
        );
        const target = join(fixture.workspaceRoot, safeSessionKey(id));
        yield* fixtureIo("workspace target creation", () => mkdir(target));
        yield* runGit(["init"], target);
        const foreignHeader = "Authorization: Bearer user-installed";
        yield* runGit(
          [
            "config",
            "--local",
            "http.https://github.com/.extraheader",
            foreignHeader,
          ],
          target,
        );
        yield* fixtureIo("workspace marker creation", () =>
          writeFile(
            join(target, MARKER_FILE),
            JSON.stringify({
              repositoryId: record.id,
              url: record.url,
              ref: record.ref,
            }),
          ),
        );
        const workspace = yield* makeWorkspace({
          workspaceRoot: fixture.workspaceRoot,
          repo: { listRepositories: () => Effect.succeed([]) },
          githubApp: undefined,
        });
        yield* workspace.materialize(id, record);
        expect(
          yield* readGitConfigAll(
            "http.https://github.com/.extraheader",
            target,
          ),
        ).toEqual([foreignHeader]);
      }),
  );

  it.live(
    "preserves foreign GitHub extraheaders alongside gateway credentials",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        const id = sessionId("github-reuse-preserve-mixed");
        const record = repositoryRecord({
          id: "github-reuse-preserve-mixed",
          url: "https://github.com/octo-org/private-repo.git",
        });
        yield* fixtureIo("workspace root creation", () =>
          mkdir(fixture.workspaceRoot, { recursive: true }),
        );
        const target = join(fixture.workspaceRoot, safeSessionKey(id));
        yield* fixtureIo("workspace target creation", () => mkdir(target));
        yield* runGit(["init"], target);
        const gatewayHeader = buildGitHubExtraHeader("stale-token");
        const foreignHeader = "Authorization: Bearer user-installed";
        yield* runGit(
          [
            "config",
            "--local",
            "--add",
            "http.https://github.com/.extraheader",
            gatewayHeader,
          ],
          target,
        );
        yield* runGit(
          [
            "config",
            "--local",
            "--add",
            "http.https://github.com/.extraheader",
            foreignHeader,
          ],
          target,
        );
        yield* fixtureIo("workspace marker creation", () =>
          writeFile(
            join(target, MARKER_FILE),
            JSON.stringify({
              repositoryId: record.id,
              url: record.url,
              ref: record.ref,
            }),
          ),
        );
        const workspace = yield* makeWorkspace({
          workspaceRoot: fixture.workspaceRoot,
          repo: { listRepositories: () => Effect.succeed([]) },
          githubApp: undefined,
        });
        yield* workspace.materialize(id, record);
        expect(
          yield* readGitConfigAll(
            "http.https://github.com/.extraheader",
            target,
          ),
        ).toEqual([foreignHeader]);
      }),
  );

  it.live("scrubs GitHub credentials from clone failures", () =>
    Effect.gen(function* () {
      const fixture = yield* gitFixture;
      const token = "credential-token";
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
      const result = yield* Effect.result(
        workspace.materialize(
          sessionId("github-clone-failure"),
          repositoryRecord({
            id: "github-clone-failure",
            url: "https://github.com/octo-org/repository-that-does-not-exist.git",
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isSuccess(result)) return;
      expect(result.failure.message).toContain("git clone");
      expect(result.failure.message).not.toContain(token);
      expect(result.failure.message).not.toContain(
        buildGitHubExtraHeader(token),
      );
    }),
  );

  it.live("cleans GitHub credentials from a terminal workspace", () =>
    Effect.gen(function* () {
      const fixture = yield* gitFixture;
      const id = sessionId("github-terminal-cleanup");
      yield* fixtureIo("workspace root creation", () =>
        mkdir(fixture.workspaceRoot, { recursive: true }),
      );
      const target = join(fixture.workspaceRoot, safeSessionKey(id));
      yield* fixtureIo("workspace target creation", () => mkdir(target));
      yield* runGit(["init"], target);
      yield* runGit(
        [
          "config",
          "--local",
          "http.https://github.com/.extraheader",
          buildGitHubExtraHeader("terminal-token"),
        ],
        target,
      );
      const workspace = yield* makeWorkspace({
        workspaceRoot: fixture.workspaceRoot,
        repo: { listRepositories: () => Effect.succeed([]) },
        githubApp: undefined,
      });
      yield* workspace.clearGitHubExtraHeader(id, target);
      expect(
        yield* readGitConfig("http.https://github.com/.extraheader", target),
      ).toBeUndefined();
    }),
  );

  it.live("rejects SSH-style GitHub URLs before minting credentials", () =>
    Effect.gen(function* () {
      const fixture = yield* gitFixture;
      const id = sessionId("github-ssh-reuse");
      const record = repositoryRecord({
        id: "github-ssh-reuse",
        url: "git@github.com:octo-org/private-repo.git",
      });
      yield* fixtureIo("workspace root creation", () =>
        mkdir(fixture.workspaceRoot, { recursive: true }),
      );
      const target = join(fixture.workspaceRoot, safeSessionKey(id));
      yield* fixtureIo("workspace target creation", () => mkdir(target));
      yield* runGit(["init"], target);
      yield* fixtureIo("workspace marker creation", () =>
        writeFile(
          join(target, MARKER_FILE),
          JSON.stringify({
            repositoryId: record.id,
            url: record.url,
            ref: record.ref,
          }),
        ),
      );
      let tokenCalls = 0;
      const workspace = yield* makeWorkspace({
        workspaceRoot: fixture.workspaceRoot,
        repo: { listRepositories: () => Effect.succeed([]) },
        githubApp: {
          getBotIdentity: () =>
            Effect.succeed({
              name: "test-app[bot]",
              email: "98765+test-app[bot]@users.noreply.github.com",
            }),
          getInstallationToken: () => {
            tokenCalls += 1;
            return Effect.succeed("unexpected-token");
          },
        },
      });
      const rejected = yield* Effect.result(workspace.materialize(id, record));
      expect(Result.isFailure(rejected)).toBe(true);
      expect(tokenCalls).toBe(0);
      expect(
        yield* readGitConfig("http.https://github.com/.extraheader", target),
      ).toBeUndefined();
    }),
  );
});
