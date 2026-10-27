import { Database } from "bun:sqlite";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Fiber, Layer, Result, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizationId } from "../src/domain/ids.js";
import { McpServerRecord } from "../src/domain/models.js";
import {
  rerunIssueGateCount,
  withRerunIssueGate,
} from "../src/services/admin.js";
import { writeOmpMcpConfig } from "../src/services/mcp-config.js";
import { materializeMcpAgentDb } from "../src/services/mcp-oauth.js";
import {
  SqliteClient,
  SqliteClientLive,
} from "../src/services/store/sqlite-client.js";
import { TokenCrypto } from "../src/services/token-crypto.js";
import {
  migrateTokenRows,
  tokenContext,
} from "../src/services/token-migration.js";
import { workerMcpCredential } from "../src/services/worker-security.js";
import { persistGitHubExtraHeader } from "../src/services/workspace.js";
import { workspaceProcess } from "../src/services/workspace-process.js";

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
const values = new Map([
  ["WORKER_SANDBOX_MODE", "native"],
  ["LINEAR_CLIENT_ID", "test"],
  ["LINEAR_CLIENT_SECRET", "test"],
  ["LINEAR_WEBHOOK_SECRET", "test"],
  ["TOKEN_ENCRYPTION_KEY", key],
  ["PUBLIC_URL", "http://localhost:3000"],
]);
const configLayer = (
  overrides: ReadonlyArray<readonly [string, string]> = [],
) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown(
      Object.fromEntries(new Map([...values, ...overrides])),
      { preserveEmptyStrings: true },
    ),
  );
const cryptoLayer = (
  overrides: ReadonlyArray<readonly [string, string]> = [],
) => TokenCrypto.layer.pipe(Layer.provide(configLayer(overrides)));
const legacyToken = (plaintext: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), iv);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([1]),
    iv,
    body,
    cipher.getAuthTag(),
  ]).toString("base64url");
};

describe("security boundaries", () => {
  it("binds v2 tokens to table, org, row and field; decrypts v1; rotates keys", async () => {
    const context = tokenContext(
      "installation",
      "org-a",
      "org-a",
      "access_token",
    );
    const token = await Effect.runPromise(
      Effect.gen(function* () {
        const cipher = yield* TokenCrypto;
        expect(yield* cipher.decrypt(legacyToken("old"), context)).toBe("old");
        const encrypted = yield* cipher.encrypt("secret", context);
        expect([...Buffer.from(encrypted, "base64url").subarray(0, 2)]).toEqual(
          [2, 1],
        );
        for (const wrong of [
          tokenContext("other", "org-a", "org-a", "access_token"),
          tokenContext("installation", "org-b", "org-a", "access_token"),
          tokenContext("installation", "org-a", "other", "access_token"),
          tokenContext("installation", "org-a", "org-a", "refresh_token"),
        ])
          expect(
            Result.isFailure(
              yield* Effect.result(cipher.decrypt(encrypted, wrong)),
            ),
          ).toBe(true);
        return encrypted;
      }).pipe(Effect.provide(cryptoLayer())),
    );
    const next = Buffer.alloc(32, 0x43).toString("base64");
    await Effect.runPromise(
      Effect.gen(function* () {
        const cipher = yield* TokenCrypto;
        expect(yield* cipher.decrypt(token, context)).toBe("secret");
        const encrypted = yield* cipher.encrypt("new", context);
        expect(Buffer.from(encrypted, "base64url")[1]).toBe(2);
      }).pipe(
        Effect.provide(
          cryptoLayer([
            ["TOKEN_ENCRYPTION_KEY", next],
            ["TOKEN_ENCRYPTION_KEY_ID", "2"],
            [
              "TOKEN_ENCRYPTION_PREVIOUS_KEYS_JSON",
              JSON.stringify({ "1": key }),
            ],
          ]),
        ),
      ),
    );
  });

  it("migrates stored v1 rows atomically and loads TOKEN_ENCRYPTION_KEY_FILE", async () => {
    const dir = await temporary();
    const keyFile = join(dir, "key");
    await writeFile(keyFile, key, { mode: 0o600 });
    const fileValues = new Map(values);
    fileValues.delete("TOKEN_ENCRYPTION_KEY");
    fileValues.set("TOKEN_ENCRYPTION_KEY_FILE", keyFile);
    const sqlite = SqliteClientLive(":memory:");
    const cipher = TokenCrypto.layer.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown(Object.fromEntries(fileValues), {
            preserveEmptyStrings: true,
          }),
        ),
      ),
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { db } = yield* SqliteClient;
          const crypto = yield* TokenCrypto;
          db.query(
            "INSERT INTO executor_instance (organization_id, endpoint, token, updated_at) VALUES (?, ?, ?, ?)",
          ).run(
            "org-a",
            "https://executor.example",
            `mcpenc:v1:${legacyToken("legacy")}`,
            1,
          );
          yield* migrateTokenRows(db, {
            ...crypto,
            needsReencrypt: (value) => Buffer.from(value, "base64url")[0] === 1,
          });
          const row = db
            .query<{ token: string }, []>("SELECT token FROM executor_instance")
            .get();
          if (!row) throw new Error("Missing migrated token");
          const payload = row.token.slice("mcpenc:v1:".length);
          expect(Buffer.from(payload, "base64url")[0]).toBe(2);
          expect(
            yield* crypto.decrypt(
              payload,
              tokenContext("executor_instance", "org-a", "org-a", "token"),
            ),
          ).toBe("legacy");
        }).pipe(Effect.provide(Layer.mergeAll(sqlite, cipher))),
      ),
    );
  });

  it("rejects expired and long-lived worker access tokens", () => {
    for (const expiresAt of [
      0,
      Number.MAX_SAFE_INTEGER,
      Number.POSITIVE_INFINITY,
      Date.now() + 2 * 60 * 60_000,
    ])
      expect(() =>
        workerMcpCredential({ accessToken: "access", expiresAt }),
      ).toThrow();
    const token = {
      accessToken: "access",
      expiresAt: Date.now() + 600_000,
      refreshToken: "private",
      clientSecret: "private",
    };
    expect(workerMcpCredential(token)).toEqual({
      accessToken: "access",
      expiresAt: token.expiresAt,
    });
  });

  it("writes no refresh token or client secret to the worker agent database", async () => {
    const dir = await temporary();
    const agent = await materializeMcpAgentDb(dir, [
      {
        serverUrl: "https://mcp.example",
        accessToken: "access",
        expiresAt: Date.now() + 600_000,
        refreshToken: "refresh-secret",
        clientSecret: "client-secret",
        clientId: "client",
      },
    ]);
    const db = new Database(join(agent, "agent.db"));
    try {
      const row = db
        .query<{ data: string }, []>("SELECT data FROM auth_credentials")
        .get();
      expect(JSON.parse(row?.data ?? "null")).toEqual({
        access: "access",
        expires: expect.any(Number),
      });
    } finally {
      db.close();
    }
  });

  it("projects MCP configuration before serializing helper stdin", async () => {
    const dir = await temporary();
    const record = {
      ...Schema.decodeUnknownSync(McpServerRecord)({
        id: "mcp",
        organizationId: "org",
        name: "remote",
        transport: "http",
        command: null,
        args: [],
        url: "https://mcp.example",
        env: {},
        headers: { Authorization: "Bearer worker-access" },
        oauthClient: {
          clientId: "client",
          clientSecret: "gateway-client-secret",
        },
        repositoryId: null,
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      }),
      refreshToken: "gateway-refresh-token",
      tokenEndpoint: "https://issuer.example/token",
    };
    vi.stubEnv("WORKER_UID", String((process.getuid?.() ?? 1000) + 1));
    const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("Worker payload intercepted");
    });
    await expect(
      Effect.runPromise(writeOmpMcpConfig(dir, [record])),
    ).rejects.toThrow("Worker payload intercepted");
    expect(spawn).toHaveBeenCalledOnce();
    const [command, options] = spawn.mock.calls[0] ?? [];
    expect(command).toEqual(
      expect.arrayContaining([
        "--config=/dev/null",
        "--no-env-file",
        "--no-install",
        "mcp-config",
        dir,
      ]),
    );
    expect(options?.cwd).not.toBe(dir);
    if (!(options?.stdin instanceof Response))
      throw new Error("Missing serialized worker input");
    const serialized = await options.stdin.text();
    expect(serialized).not.toMatch(
      /clientSecret|refresh|oauthClient|tokenEndpoint/iu,
    );
    expect(JSON.parse(serialized)).toEqual({
      mcpServers: {
        remote: {
          type: "http",
          url: "https://mcp.example",
          headers: { Authorization: "Bearer worker-access" },
        },
      },
    });
  });

  it("sends only the Git header on helper stdin, never argv", async () => {
    const dir = await temporary();
    const handle = await open(dir, "r");
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    vi.spyOn(prototype, "chown").mockResolvedValue(undefined);
    vi.stubEnv("WORKER_UID", String((process.getuid?.() ?? 1000) + 1));
    const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("Worker payload intercepted");
    });
    const header = `AUTHORIZATION: basic ${Buffer.from("x-access-token:synthetic-token").toString("base64")}`;
    const result = await Effect.runPromise(
      Effect.result(persistGitHubExtraHeader(dir, "test", header)),
    );
    expect(Result.isFailure(result)).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    const [command, options] = spawn.mock.calls[0] ?? [];
    expect(JSON.stringify(command)).not.toContain(header);
    if (!(options?.stdin instanceof Response))
      throw new Error("Missing serialized worker input");
    expect(await options.stdin.json()).toBe(header);
  });

  it("strips all renewal material before serializing the agent-db worker payload", async () => {
    const dir = await temporary();
    vi.stubEnv("WORKER_UID", String((process.getuid?.() ?? 1000) + 1));
    const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("Worker payload intercepted");
    });
    const credential = {
      serverUrl: "https://mcp.example",
      accessToken: "access",
      expiresAt: Date.now() + 600_000,
      refreshToken: "refresh-secret",
      tokenEndpoint: "https://issuer.example/token",
      clientId: "client",
      clientSecret: "client-secret",
    };
    await expect(materializeMcpAgentDb(dir, [credential])).rejects.toThrow(
      "Worker payload intercepted",
    );
    expect(spawn).toHaveBeenCalledOnce();
    const options = spawn.mock.calls[0]?.[1];
    if (!(options?.stdin instanceof Response))
      throw new Error("Missing serialized worker input");
    expect(await options.stdin.json()).toEqual([
      {
        serverUrl: credential.serverUrl,
        accessToken: credential.accessToken,
        expiresAt: credential.expiresAt,
      },
    ]);
  });

  it("defensively filters credentials received by the real workspace worker", async () => {
    const dir = await temporary();
    vi.stubEnv("WORKER_UID", "");
    const credential = {
      serverUrl: "https://mcp.example",
      accessToken: "access",
      expiresAt: Date.now() + 600_000,
      refreshToken: "refresh-secret",
      tokenEndpoint: "https://issuer.example/token",
      clientId: "client",
      clientSecret: "client-secret",
    };
    const agent = await workspaceProcess(dir, "agent-db", [credential]);
    const db = new Database(join(agent, "agent.db"));
    try {
      const rows = db
        .query<{ data: string }, []>("SELECT data FROM auth_credentials")
        .all();
      expect(rows.map((row) => JSON.parse(row.data))).toEqual([
        { access: credential.accessToken, expires: credential.expiresAt },
      ]);
    } finally {
      db.close();
    }
    // Bypass the gateway and prove the worker enforces workerMcpCredential too.
    await expect(
      workspaceProcess(dir, "agent-db", [{ ...credential, expiresAt: 0 }]),
    ).rejects.toThrow("MCP worker access token must expire within one hour");
  });

  it("evicts rerun gates after success, failure, and interruption", async () => {
    const org = Schema.decodeUnknownSync(OrganizationId)("org");
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* withRerunIssueGate(org, "success", Effect.void);
        yield* Effect.result(
          withRerunIssueGate(org, "failure", Effect.fail("failed")),
        );
        const holder = yield* Effect.forkChild(
          withRerunIssueGate(org, "interrupt", Effect.never),
        );
        yield* Effect.yieldNow;
        const waiter = yield* Effect.forkChild(
          withRerunIssueGate(org, "interrupt", Effect.never),
        );
        yield* Effect.yieldNow;
        expect(rerunIssueGateCount()).toBe(1);
        yield* Fiber.interrupt(waiter);
        expect(rerunIssueGateCount()).toBe(1);
        yield* Fiber.interrupt(holder);
        expect(rerunIssueGateCount()).toBe(0);
      }),
    );
  });
});
it("upgrades v1 rows automatically when TokenCrypto starts with the gateway database", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        db.query(
          "INSERT INTO executor_instance (organization_id, endpoint, token, updated_at) VALUES (?, ?, ?, ?)",
        ).run(
          "org",
          "https://executor.example",
          `mcpenc:v1:${legacyToken("legacy")}`,
          1,
        );
        const layer = TokenCrypto.layer.pipe(
          Layer.provide(
            Layer.mergeAll(Layer.succeed(SqliteClient, { db }), configLayer()),
          ),
        );
        yield* Effect.gen(function* () {
          yield* TokenCrypto;
        }).pipe(Effect.provide(layer));
        const row = db
          .query<{ token: string }, []>("SELECT token FROM executor_instance")
          .get();
        expect(
          Buffer.from(
            row?.token.slice("mcpenc:v1:".length) ?? "",
            "base64url",
          )[0],
        ).toBe(2);
      }).pipe(Effect.provide(SqliteClientLive(":memory:"))),
    ),
  );
});
