import * as fs from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Logger, References, Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redact } from "../src/admin-ui/run-detail.js";
import { makeGitHubApp } from "../src/services/github-app.js";
import { removeMcpConfig } from "../src/services/mcp-config.js";
import { removeMcpAgentDb } from "../src/services/mcp-oauth.js";
import {
  isHttpsGitHubRepositoryUrl,
  persistGitHubExtraHeader,
  unsetGitHubExtraHeader,
} from "../src/services/workspace.js";
import {
  cleanupWorkspaceProcess,
  gitEnvironment,
  removeWorkerWorkspaceSync,
  workspaceProcess,
} from "../src/services/workspace-process.js";

const dnsLookup = vi.hoisted(() =>
  vi.fn<
    (
      hostname: string,
      options: { all: true; verbatim: true },
    ) => Promise<Array<{ address: string; family: number }>>
  >(async () => [{ address: "93.184.216.34", family: 4 }]),
);
vi.mock("node:dns/promises", () => ({ lookup: dnsLookup }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fchownSync: vi.fn(actual.fchownSync) };
});
const dirs: string[] = [];
// Scratch storage is mandated by the global AGENTS.md; /tmp can be shared tmpfs.
// Override the base for CI while keeping fixture paths canonical.
const temporary = async () => {
  const parent =
    process.env.SECURITY_TEST_TMPDIR ??
    join(homedir(), "dev/agentic-scratchpads/ohmypi-symphony/security/tests");
  await mkdir(parent, { recursive: true });
  const dir = await realpath(await mkdtemp(join(parent, "case-")));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const key = Buffer.alloc(32, 0x42).toString("base64");
const _values = new Map([
  ["WORKER_SANDBOX_MODE", "native"],
  ["LINEAR_CLIENT_ID", "test"],
  ["LINEAR_CLIENT_SECRET", "test"],
  ["LINEAR_WEBHOOK_SECRET", "test"],
  ["TOKEN_ENCRYPTION_KEY", key],
  ["PUBLIC_URL", "http://localhost:3000"],
]);

describe("security boundaries", () => {
  it("rejects retention paths outside the root and symlinked workspace paths before migration", async () => {
    const root = await temporary();
    const outside = await temporary();
    const alias = join(root, "linked");
    await symlink(outside, alias);
    vi.stubEnv("WORKER_UID", String((process.getuid?.() ?? 1000) + 1));
    const chown = vi.spyOn(fs, "fchownSync");
    const spawn = vi.spyOn(Bun, "spawnSync");
    for (const path of [root, outside, alias])
      expect(() => removeWorkerWorkspaceSync(path, root)).toThrow(
        "inside the workspace root",
      );
    expect(chown).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("runs the materializer entry point and excludes writable tool state", async () => {
    const dir = await temporary();
    const initialized = Bun.spawn(["git", "init", dir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await initialized.exited).toBe(0);
    const exclude = join(dir, ".git", "info", "exclude");
    const original = "# user exclusions\n/custom/\n/.omp-home/";
    await writeFile(exclude, original);
    await workspaceProcess(dir, "tool-directories", null);
    const first = await Bun.file(exclude).text();
    expect(first).toBe(`${original}\n/.omp-tmp/\n`);
    for (let attempt = 0; attempt < 3; attempt++)
      await workspaceProcess(dir, "tool-directories", null);
    expect(await Bun.file(exclude).text()).toBe(first);
    await writeFile(join(dir, ".omp-home", "private"), "secret");
    await writeFile(join(dir, ".omp-tmp", "temporary"), "temp");
    const status = Bun.spawn(["git", "status", "--porcelain"], {
      cwd: dir,
      stdout: "pipe",
    });
    expect(await new Response(status.stdout).text()).toBe("");
    expect(await status.exited).toBe(0);
    const agentDir = await workspaceProcess(dir, "agent-db", []);
    expect(agentDir).toBe(join(dir, ".omp-gateway"));
    await workspaceProcess(dir, "remove-agent-db", null);
    expect(await Bun.file(join(agentDir, "agent.db")).exists()).toBe(false);
  });

  it("refuses to append credentials when the previous config cannot be parsed", async () => {
    const dir = await temporary();
    await mkdir(join(dir, ".git"));
    const path = join(dir, ".git", "config");
    const malformed = "[unterminated\nextraheader = old\n";
    await writeFile(path, malformed);
    const result = await Effect.runPromise(
      Effect.result(
        persistGitHubExtraHeader(
          dir,
          "test",
          `AUTHORIZATION: basic ${Buffer.from("x-access-token:secret").toString("base64")}`,
        ),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(await Bun.file(path).text()).toBe(malformed);
  });

  it("retains a useful credential persistence failure cause without exposing tokens", async () => {
    const dir = await temporary();
    const outside = join(dir, "outside");
    await mkdir(outside);
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    await symlink(outside, join(workspace, ".git"));
    const result = await Effect.runPromise(
      Effect.result(
        persistGitHubExtraHeader(
          workspace,
          "test",
          `AUTHORIZATION: basic ${Buffer.from("x-access-token:secret").toString("base64")}`,
        ),
      ),
    );
    if (Result.isSuccess(result))
      throw new Error("Expected persistence to fail");
    expect(result.failure.message).toBe("Could not persist GitHub credential");
    expect(result.failure.cause).toContain(".git");
    expect(result.failure.cause).not.toContain("secret");
  });

  it("doesn't expose gateway or model secrets to Git or its helpers", () => {
    const environment = gitEnvironment({
      PATH: "/bin",
      HOME: "/home/git",
      GIT_CONFIG_GLOBAL: "/gitconfig",
      LINEAR_CLIENT_SECRET: "secret",
      TOKEN_ENCRYPTION_KEY_FILE: "/key",
      OPENAI_API_KEY: "model-secret",
      GITHUB_APP_PRIVATE_KEY: "private",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_VALUE_0: "stale",
      BUN_OPTIONS: "--preload=evil",
      BUN_INSPECT: "127.0.0.1:6499",
      BUN_CONFIG_VERBOSE_FETCH: "1",
      NODE_OPTIONS: "--import=evil",
    });
    expect(environment).toEqual({
      PATH: "/bin",
      HOME: "/home/git",
      GIT_CONFIG_GLOBAL: "/gitconfig",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ASKPASS: "",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it("fails Git authentication without launching a configured askpass helper", async () => {
    const dir = await temporary();
    const marker = join(dir, "askpass-invoked");
    const helper = join(dir, "askpass");
    const config = join(dir, "gitconfig");
    await writeFile(
      helper,
      `#!/bin/sh\necho invoked >> '${marker}'\necho credential\n`,
      { mode: 0o700 },
    );
    await writeFile(config, `[core]\naskPass = ${helper}\n`);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="test"' },
        }),
    });
    try {
      const child = Bun.spawn(
        [
          "git",
          "-c",
          "credential.helper=",
          "ls-remote",
          `http://127.0.0.1:${server.port}/repo`,
        ],
        {
          env: gitEnvironment({
            ...process.env,
            HOME: dir,
            GIT_CONFIG_GLOBAL: config,
            GIT_ASKPASS: helper,
          }),
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const stderr = await new Response(child.stderr).text();
      expect(await child.exited).not.toBe(0);
      expect(stderr).toContain("terminal prompts disabled");
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  it("warns with context when delegated credential cleanup fails, while preserving best effort", async () => {
    const dir = await temporary();
    // A missing cwd fails the real delegated spawn regardless of runner uid.
    const missing = join(dir, "missing");
    vi.stubEnv("WORKER_UID", String((process.getuid?.() ?? 1000) + 1));
    const logs: Array<{
      message: unknown;
      annotations: Record<string, unknown>;
    }> = [];
    const logger = Logger.make(({ message, fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      logs.push({ message, annotations: { ...annotations } });
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* unsetGitHubExtraHeader(missing, "cleanup-session");
        yield* removeMcpConfig(missing);
        yield* removeMcpAgentDb(missing);
      }).pipe(Effect.provide(Logger.layer([logger]))),
    );
    expect(logs.map((entry) => entry.message)).toEqual([
      ["workspace.github_cleanup_failed"],
      ["mcp.config.cleanup_failed"],
      ["mcp.agent_db.cleanup_failed"],
    ]);
    expect(logs[0]?.annotations.sessionId).toBe("cleanup-session");
    expect(logs.map((entry) => entry.annotations.action)).toEqual([
      "clear-git",
      "remove-mcp-config",
      "remove-agent-db",
    ]);
    for (const entry of logs) {
      expect(entry.annotations.cwd).toBe(missing);
      expect(entry.annotations.error).toEqual(expect.stringMatching(/.+/u));
    }
  });

  it("reports worker-side credential deletion failures over IPC and tolerates missing files", async () => {
    const dir = await temporary();
    vi.stubEnv("WORKER_UID", "");
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "config"), "[unterminated\n");
    await mkdir(join(dir, "mcp.json"));
    await mkdir(join(dir, ".omp-gateway", "agent.db"), { recursive: true });
    const logs: Array<{
      message: unknown;
      annotations: Record<string, unknown>;
    }> = [];
    const logger = Logger.make(({ message, fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      logs.push({ message, annotations: { ...annotations } });
    });
    for (const action of [
      "clear-git",
      "remove-mcp-config",
      "remove-agent-db",
    ]) {
      await expect(workspaceProcess(dir, action, null)).rejects.toThrow(
        `Workspace ${action} failed`,
      );
      await Effect.runPromise(
        cleanupWorkspaceProcess(dir, action, "cleanup.failed").pipe(
          Effect.provide(Logger.layer([logger])),
        ),
      );
    }
    expect(logs).toHaveLength(3);
    expect(logs[0]?.annotations.error).toContain("bad config line");
    expect(logs[1]?.annotations.error).toContain("mcp.json");
    expect(logs[2]?.annotations.error).toContain("agent.db");
    await rm(join(dir, "mcp.json"), { recursive: true });
    await rm(join(dir, ".omp-gateway"), { recursive: true });
    await expect(
      workspaceProcess(dir, "remove-mcp-config", null),
    ).resolves.toBe("");
    await expect(workspaceProcess(dir, "remove-agent-db", null)).resolves.toBe(
      "",
    );
  });

  it.each([
    "--upload-pack=touch /app/data/owned",
    "-repo",
    "file:///app/data",
    "/app/data",
    "git@github.com:org/repo",
    "https://github.com@evil.test/org/repo",
    "https://github.com/org/repo?x=y",
    "https://github.com/org/repo#x",
    "https://github.com/org/%2Frepo",
    "https://github.com/org/../repo",
    "https://github.com:443/org/repo",
    "https://github.com/org/repo/extra",
    "https://github.com/org/..",
  ])("rejects unsafe repository URL %s", (url) =>
    expect(isHttpsGitHubRepositoryUrl(url)).toBe(false),
  );
  it("accepts canonical HTTPS GitHub repository URLs", () => {
    expect(isHttpsGitHubRepositoryUrl("https://github.com/org/repo.git")).toBe(
      true,
    );
    expect(
      isHttpsGitHubRepositoryUrl("https://github.com/org/repo_name-1"),
    ).toBe(true);
  });

  it("denies cross-tenant GitHub token minting before making a network request", async () => {
    const fetchMock = vi.fn();
    const app = makeGitHubApp({
      appId: "1",
      privateKey: "unused",
      allowedOwners: { "org-a": ["alice"] },
      fetch: fetchMock,
    });
    const denied = await Effect.runPromise(
      Effect.result(app.getInstallationToken("alice", "repo", "org-b")),
    );
    expect(Result.isFailure(denied) && denied.failure.reason).toBe(
      "tenant_forbidden",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts GitHub, Basic, bearer and multiline PEM credentials", () => {
    const secrets = [
      "ghs_12345",
      "ghp_12345",
      "gho_12345",
      "github_pat_12345",
      "Basic dXNlcjpwYXNz",
      "bEaReR secret-value",
      "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----",
    ];
    const output = redact(`AUTHORIZATION: ${secrets.join("\n")}`);
    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(output).not.toContain("secret-material");
  });
});
