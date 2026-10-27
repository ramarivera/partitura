import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigProvider, Effect, Layer, Result, Schema } from "effect";
import { expect } from "vitest";
import { WorkspaceError } from "../src/domain/errors.js";
import {
  OrganizationId,
  ProjectId,
  SessionId,
  TeamId,
  WorkspaceId,
} from "../src/domain/ids.js";
import type { RepositoryRecord } from "../src/domain/models.js";
import { GatewayConfig } from "../src/services/config.js";
import { WorkspaceRepo } from "../src/services/store/repositories.js";
import { SqliteClientLive } from "../src/services/store/sqlite-client.js";
import { makeWorkspace, Workspace } from "../src/services/workspace.js";
export const MARKER_FILE = ".linear-gateway-workspace.json";
export const TEST_KEY_BASE64 = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

export const organizationId = (value: string) =>
  Schema.decodeUnknownSync(OrganizationId)(value);
export const projectId = (value: string) =>
  Schema.decodeUnknownSync(ProjectId)(value);
export const sessionId = (value: string) =>
  Schema.decodeUnknownSync(SessionId)(value);
export const teamId = (value: string) =>
  Schema.decodeUnknownSync(TeamId)(value);
export const workspaceId = (value: string) =>
  Schema.decodeUnknownSync(WorkspaceId)(value);

export const fixtureFailure = (operation: string) => (cause: unknown) =>
  new WorkspaceError({
    message: `${operation} failed`,
    sessionId: "workspace-fixture",
    reason: "git_failed",
    cause: cause instanceof Error ? cause.message : String(cause),
  });

export const fixtureIo = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: fixtureFailure(operation),
  });

export const runGit = (args: ReadonlyArray<string>, cwd: string) =>
  Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`git ${args[0] ?? "command"} failed: ${stderr.trim()}`);
      }
    },
    catch: fixtureFailure("git command"),
  });

export const readGitConfig = (key: string, cwd: string) =>
  Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn(["git", "config", "--local", "--get", key], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
      ]);
      return exitCode === 0 ? stdout.trim() : undefined;
    },
    catch: fixtureFailure("git config read"),
  });
export const readGitConfigAll = (key: string, cwd: string) =>
  Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn(
        ["git", "config", "--local", "--get-all", key],
        {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
      ]);
      return exitCode === 0
        ? stdout
            .split(/\r?\n/u)
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : [];
    },
    catch: fixtureFailure("git config read"),
  });

interface GitFixture {
  readonly root: string;
  readonly source: string;
  readonly url: string;
  readonly previousGitConfigGlobal: string | undefined;
  readonly workspaceRoot: string;
}

export const gitFixture = Effect.acquireRelease(
  Effect.gen(function* () {
    yield* fixtureIo("fixture parent mkdir", () =>
      mkdir(join(process.cwd(), "data"), { recursive: true }),
    );
    const root = yield* fixtureIo("fixture directory creation", () =>
      mkdtemp(join(process.cwd(), "data", "workspace-test-")),
    );
    const source = join(root, "source");
    yield* fixtureIo("source directory creation", () => mkdir(source));
    yield* runGit(["init", "-b", "main"], source);
    yield* runGit(["config", "user.email", "test@example.com"], source);
    yield* runGit(["config", "user.name", "Gateway Test"], source);
    yield* fixtureIo("fixture write", () =>
      writeFile(join(source, "README.txt"), "fixture\n"),
    );
    yield* runGit(["add", "README.txt"], source);
    yield* runGit(["commit", "-m", "fixture"], source);

    const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    const url = `https://github.com/fixture/repo-${crypto.randomUUID()}.git`;
    const gitConfig = join(root, "gitconfig");
    yield* fixtureIo("git transport config", () =>
      writeFile(
        gitConfig,
        `[url "${source}"]\n\tinsteadOf = ${url}\n[url "${root}/missing"]\n\tinsteadOf = https://github.com/octo-org/repository-that-does-not-exist.git\n`,
      ),
    );
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
    return {
      root,
      source,
      url,
      previousGitConfigGlobal,
      workspaceRoot: join(root, "workspaces"),
    };
  }),
  (fixture) =>
    fixtureIo("fixture cleanup", async () => {
      for (const [name, value] of [
        ["GIT_CONFIG_GLOBAL", fixture.previousGitConfigGlobal],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(fixture.root, { recursive: true, force: true });
    }).pipe(
      Effect.catchTag("@Gateway/WorkspaceError", (error) => Effect.die(error)),
    ),
);

export const gatewayConfigLayer = (workspaceRoot: string) =>
  GatewayConfig.layer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown(
          Object.fromEntries(
            new Map([
              ["WORKER_SANDBOX_MODE", "native"],
              ["LINEAR_CLIENT_ID", "workspace-test-client"],
              ["LINEAR_CLIENT_SECRET", "workspace-test-client-secret"],
              ["LINEAR_WEBHOOK_SECRET", "workspace-test-webhook-secret"],
              ["TOKEN_ENCRYPTION_KEY", TEST_KEY_BASE64],
              ["PUBLIC_URL", "http://localhost:3000"],
              ["WORKSPACE_ROOT", workspaceRoot],
            ]),
          ),
          { preserveEmptyStrings: true },
        ),
      ),
    ),
  );

export const workspaceLayer = (workspaceRoot: string) =>
  Layer.mergeAll(WorkspaceRepo.layer, Workspace.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        SqliteClientLive(":memory:"),
        gatewayConfigLayer(workspaceRoot),
      ),
    ),
  );

export const withWorkspace = <A, E>(
  workspaceRoot: string,
  effect: Effect.Effect<A, E, Workspace | WorkspaceRepo>,
) => effect.pipe(Effect.provide(workspaceLayer(workspaceRoot)));

export const repositoryRecord = (input: {
  readonly id: string;
  readonly organization?: string;
  readonly url?: string;
  readonly ref?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly projectIds?: ReadonlyArray<string>;
  readonly teamIds?: ReadonlyArray<string>;
  readonly isDefault?: boolean;
}): RepositoryRecord => ({
  organizationId: organizationId(input.organization ?? "org"),
  id: workspaceId(input.id),
  url: input.url ?? "https://example.test/repository.git",
  ref: input.ref ?? "main",
  labels: [...(input.labels ?? [])],
  projectIds: (input.projectIds ?? []).map(projectId),
  teamIds: (input.teamIds ?? []).map(teamId),
  nixPackages: [],
  isDefault: input.isDefault ?? false,
  createdAt: 0,
  updatedAt: 0,
});

export const resolveWith = (
  repositories: ReadonlyArray<RepositoryRecord>,
  context: unknown,
) =>
  Effect.runSync(
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace({
        workspaceRoot: "/workspace-test",
        repo: { listRepositories: () => Effect.succeed(repositories) },
        githubApp: undefined,
      });
      return yield* workspace.resolve(context);
    }),
  );

export const expectWorkspaceFailure = <A>(
  result: Result.Result<A, WorkspaceError>,
  reason: WorkspaceError["reason"],
) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isSuccess(result)) {
    throw new Error("Expected WorkspaceError");
  }
  expect(result.failure._tag).toBe("@Gateway/WorkspaceError");
  expect(result.failure.reason).toBe(reason);
};

export const createRepository = (
  repo: WorkspaceRepo["Service"],
  fixture: GitFixture,
  id: string,
  overrides: Partial<{
    readonly labels: ReadonlyArray<string>;
    readonly projectIds: ReadonlyArray<string>;
    readonly teamIds: ReadonlyArray<string>;
    readonly isDefault: boolean;
    readonly ref: string;
  }> = {},
) =>
  repo.createRepository({
    organizationId: organizationId("org"),
    id: workspaceId(id),
    url: fixture.url,
    ref: overrides.ref ?? "main",
    labels: overrides.labels ?? [],
    projectIds: (overrides.projectIds ?? []).map(projectId),
    teamIds: (overrides.teamIds ?? []).map(teamId),
    isDefault: overrides.isDefault ?? false,
  });
