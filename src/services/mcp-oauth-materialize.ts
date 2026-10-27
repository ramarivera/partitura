import { Database } from "bun:sqlite";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { Effect } from "effect";
import { MCP_OAUTH_PROVIDER_PREFIX } from "./mcp-oauth-protocol.js";
import { tryDb } from "./store/sqlite-client.js";
import { workerMcpCredential } from "./worker-security.js";
import {
  cleanupWorkspaceProcess,
  needsWorkspaceIdentity,
  workspaceProcess,
} from "./workspace-process.js";

const lstatIfExists = async (path: string): Promise<Stats | undefined> => {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
};

export const materializeMcpAgentDb = async (
  workspace: string,
  credentials: ReadonlyArray<{
    readonly serverUrl: string;
    readonly accessToken: string;
    readonly expiresAt: number;
    readonly refreshToken?: string | undefined;
    readonly tokenEndpoint?: string | undefined;
    readonly clientId?: string | undefined;
    readonly clientSecret?: string | undefined;
  }>,
): Promise<string> => {
  if (needsWorkspaceIdentity())
    return workspaceProcess(
      workspace,
      "agent-db",
      credentials.map((credential) => ({
        serverUrl: credential.serverUrl,
        ...workerMcpCredential(credential),
      })),
    );
  const providers = new Set<string>();
  for (const credential of credentials) {
    const provider = mcpProviderForServerUrl(credential.serverUrl);
    if (providers.has(provider)) {
      throw new Error(
        `Duplicate MCP OAuth provider key for ${credential.serverUrl}`,
      );
    }
    providers.add(provider);
  }
  const agentDir = join(workspace, ".omp-gateway");
  const path = join(agentDir, "agent.db");
  const existingDir = await lstatIfExists(agentDir);
  if (existingDir !== undefined && !existingDir.isDirectory()) {
    throw new Error("MCP OAuth agent directory must be a real directory");
  }
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await chmod(agentDir, 0o700);
  const existingPath = await lstatIfExists(path);
  if (existingPath?.isSymbolicLink()) {
    throw new Error("MCP OAuth agent database must not be a symlink");
  }
  if (existingPath !== undefined && !existingPath.isFile()) {
    throw new Error("MCP OAuth agent database must be a regular file");
  }
  await rm(path, { force: true });
  let db: Database | undefined;
  try {
    const database = new Database(path);
    db = database;
    await Effect.runPromise(
      tryDb(() => {
        database.exec(
          `CREATE TABLE IF NOT EXISTS auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, identity_key TEXT DEFAULT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())); CREATE INDEX IF NOT EXISTS idx_auth_provider ON auth_credentials(provider); CREATE INDEX IF NOT EXISTS idx_auth_provider_identity ON auth_credentials(provider, identity_key) WHERE identity_key IS NOT NULL;`,
        );
        const insert = database.query(
          "INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, 'oauth', ?, NULL)",
        );
        for (const credential of credentials) {
          insert.run(
            `${MCP_OAUTH_PROVIDER_PREFIX}${credential.serverUrl}`,
            JSON.stringify({
              access: credential.accessToken,
              expires: credential.expiresAt,
            }),
          );
        }
      }, "McpOAuth.materializeMcpAgentDb"),
    );
    await chmod(path, 0o600);
    const gitPath = join(workspace, ".git");
    let gitDir = gitPath;
    if (await Bun.file(gitPath).exists()) {
      const gitEntry = await Bun.file(gitPath).text();
      if (gitEntry.startsWith("gitdir:")) {
        const worktreeGitDir = gitEntry.slice("gitdir:".length).trim();
        gitDir = isAbsolute(worktreeGitDir)
          ? worktreeGitDir
          : resolvePath(workspace, worktreeGitDir);
        const commonDirFile = join(gitDir, "commondir");
        if (await Bun.file(commonDirFile).exists()) {
          const commonDir = (await Bun.file(commonDirFile).text()).trim();
          gitDir = isAbsolute(commonDir)
            ? commonDir
            : resolvePath(gitDir, commonDir);
        }
      }
    }
    if (await Bun.file(join(gitDir, "HEAD")).exists()) {
      const infoDir = join(gitDir, "info");
      await mkdir(infoDir, { recursive: true });
      const excludePath = join(infoDir, "exclude");
      const existing = (await Bun.file(excludePath).exists())
        ? await Bun.file(excludePath).text()
        : "";
      if (
        !existing.split("\n").some((line) => line.trim() === ".omp-gateway/")
      ) {
        const separator =
          existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        await writeFile(
          excludePath,
          `${existing}${separator}.omp-gateway/\n`,
          "utf8",
        );
      }
    }
    return agentDir;
  } catch (error) {
    try {
      await unlink(path);
    } catch {
      // Partial materialization cleanup is intentionally best effort.
    }
    throw error;
  } finally {
    db?.close();
  }
};

/** Strict worker-side removal lets the gateway observe failed cleanup over IPC. */
export const removeMcpAgentDbFile = async (
  workspace: string,
): Promise<void> => {
  try {
    await unlink(join(workspace, ".omp-gateway", "agent.db"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
};

export const removeMcpAgentDb = (
  workspace: string,
): Effect.Effect<void, never, never> =>
  needsWorkspaceIdentity()
    ? cleanupWorkspaceProcess(
        workspace,
        "remove-agent-db",
        "mcp.agent_db.cleanup_failed",
      )
    : Effect.tryPromise({
        try: () => removeMcpAgentDbFile(workspace),
        catch: (error) => String(error),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("mcp.agent_db.cleanup_failed").pipe(
            Effect.annotateLogs({ cwd: workspace, error }),
          ),
        ),
      );

export const mcpProviderForServerUrl = (serverUrl: string): string =>
  `${MCP_OAUTH_PROVIDER_PREFIX}${serverUrl}`;
