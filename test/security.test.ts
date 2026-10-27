import * as fs from "node:fs";
import {
  type FileHandle,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareWorkerWorkspace,
  prepareWorkerWorkspaceSync,
  sessionWorkerEnvironment,
  workerEnvironment,
  workerIdentityCommand,
} from "../src/services/worker-security.js";
import {
  removeWorkerWorkspace,
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
const withWorkspaceIpc = async (
  kind: "FIFO" | "socket",
  use: (workspace: string, path: string) => Promise<void>,
) => {
  const workspace = await temporary();
  const path = join(workspace, "ipc");
  const server = createServer();
  if (kind === "FIFO") {
    const result = Bun.spawnSync(["mkfifo", path]);
    expect(result.exitCode).toBe(0);
  } else {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
  }
  try {
    await use(workspace, path);
  } finally {
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
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
  it("worker retention cleanup preserves its parent and external link targets", async () => {
    const dir = await temporary();
    const external = await temporary();
    const sentinel = join(external, "sentinel");
    await writeFile(sentinel, "keep");
    await symlink(external, join(dir, "directory-link"));
    await symlink(sentinel, join(dir, "file-link"));
    await link(sentinel, join(dir, "hardlink"));
    await workspaceProcess(dir, "remove-workspace-contents", null);
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect(await readdir(dir)).toEqual([]);
    await expect(Bun.file(sentinel).text()).resolves.toBe("keep");
  });

  it.each([
    "agent-db",
    "mcp-config",
    "remove-agent-db",
    "remove-mcp-config",
    "persist-git",
    "clear-git",
    "remove-workspace-contents",
    "tool-directories",
  ])(
    "ignores repository runtime injection for helper action %s",
    async (action) => {
      const parent = await temporary();
      const dir = join(parent, "workspace");
      await mkdir(dir);
      const initialized = Bun.spawnSync(["git", "init", "-q", dir]);
      expect(initialized.exitCode).toBe(0);
      const marker = join(parent, "preload-input.json");
      const preload = `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, readFileSync(0));
process.exit(0);`;
      for (const location of [parent, dir]) {
        await writeFile(
          join(location, "bunfig.toml"),
          'preload = ["./preload.ts"]\n',
        );
        await writeFile(join(location, "preload.ts"), preload);
        await writeFile(join(location, ".env"), "WORKER_UID=0\n");
        await writeFile(
          join(location, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              baseUrl: ".",
              paths: { effect: ["./preload.ts"] },
            },
          }),
        );
        await writeFile(
          join(location, "package.json"),
          JSON.stringify({
            type: "module",
            imports: { "#helper": "./preload.ts" },
            scripts: { prestart: "bun preload.ts" },
          }),
        );
        await mkdir(join(location, "node_modules", "effect"), {
          recursive: true,
        });
        await writeFile(
          join(location, "node_modules", "effect", "package.json"),
          JSON.stringify({ name: "effect", main: "../../preload.ts" }),
        );
      }
      vi.stubEnv("BUN_OPTIONS", `--preload=${join(dir, "preload.ts")}`);
      vi.stubEnv("BUN_INSPECT", "127.0.0.1:6499");
      vi.stubEnv("NODE_OPTIONS", `--require=${join(dir, "preload.ts")}`);
      const payload =
        action === "agent-db"
          ? []
          : action === "mcp-config"
            ? { mcpServers: {} }
            : action === "persist-git"
              ? `AUTHORIZATION: basic ${Buffer.from("x-access-token:synthetic").toString("base64")}`
              : null;
      const output = await workspaceProcess(dir, action, payload);
      expect(await Bun.file(marker).exists()).toBe(false);
      if (action === "agent-db") expect(output).toBe(join(dir, ".omp-gateway"));
      if (action === "mcp-config")
        expect(await Bun.file(join(dir, "mcp.json")).json()).toEqual(payload);
      if (action === "remove-workspace-contents")
        expect(await readdir(dir)).toEqual([]);
    },
  );

  it("does not autoload a workspace .env into the helper", async () => {
    const dir = await temporary();
    // Loading this value makes materialization try an invalid root identity.
    await writeFile(join(dir, ".env"), "WORKER_UID=0\n");
    expect(await workspaceProcess(dir, "agent-db", [])).toBe(
      join(dir, ".omp-gateway"),
    );
  });

  it("uses the hardened Bun launch for synchronous retention too", async () => {
    const root = await temporary();
    const dir = join(root, "workspace");
    await mkdir(dir);
    const marker = join(root, "preload-input.json");
    await writeFile(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await writeFile(
      join(dir, "preload.ts"),
      `await Bun.write(${JSON.stringify(marker)}, await Bun.stdin.text()); process.exit(0);`,
    );
    await writeFile(join(dir, ".env"), "WORKER_UID=0\n");
    const uid = process.getuid?.() ?? 1000;
    vi.stubEnv("WORKER_UID", String(uid));
    vi.stubEnv("BUN_OPTIONS", "--preload=evil");
    vi.stubEnv("NODE_OPTIONS", "--require=evil");
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    const spawnSync = Bun.spawnSync;
    const spawn = vi
      .spyOn(Bun, "spawnSync")
      .mockImplementation((command, options) => {
        if (!Array.isArray(command)) throw new Error("Expected helper command");
        // Exercise the real Bun helper as our uid; native tests can't setgroups.
        return spawnSync(command.slice(command.indexOf("--") + 1), options);
      });
    removeWorkerWorkspaceSync(dir, root);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await readdir(root)).toEqual([]);
    const [command, options] = spawn.mock.calls[0] ?? [];
    expect(command).toEqual(
      expect.arrayContaining([
        "/usr/bin/setpriv",
        "--config=/dev/null",
        "--no-env-file",
        "--no-install",
        "remove-workspace-contents",
        dir,
      ]),
    );
    expect(options?.cwd).not.toBe(dir);
    expect(options?.env).not.toHaveProperty("BUN_OPTIONS");
    expect(options?.env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("uses the hardened helper and worker identity for asynchronous clone cleanup", async () => {
    const root = await temporary();
    const dir = join(root, "workspace");
    await mkdir(dir);
    const marker = join(root, "preload-input.json");
    await writeFile(join(dir, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await writeFile(
      join(dir, "preload.ts"),
      `await Bun.write(${JSON.stringify(marker)}, await Bun.stdin.text()); process.exit(0);`,
    );
    await writeFile(join(dir, ".env"), "WORKER_UID=0\n");
    const uid = process.getuid?.() ?? 1000;
    vi.stubEnv("WORKER_UID", String(uid));
    vi.stubEnv("BUN_OPTIONS", "--preload=evil");
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    const originalSpawn = Bun.spawn;
    const spawn = vi
      .spyOn(Bun, "spawn")
      .mockImplementation((command, options) => {
        if (!Array.isArray(command)) throw new Error("Expected helper command");
        return originalSpawn(command.slice(command.indexOf("--") + 1), options);
      });
    await removeWorkerWorkspace(dir, root);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await readdir(root)).toEqual([]);
    const [command, options] = spawn.mock.calls[0] ?? [];
    expect(command).toEqual(
      expect.arrayContaining([
        "/usr/bin/setpriv",
        "--config=/dev/null",
        "--no-env-file",
        "--no-install",
        "remove-workspace-contents",
        dir,
      ]),
    );
    expect(options?.cwd).not.toBe(dir);
    expect(options?.env).not.toHaveProperty("BUN_OPTIONS");
  });

  it("excludes unlisted secrets, direct model-provider keys, secret files, database paths, and runtime injection variables from worker env", () => {
    const result = workerEnvironment({
      PATH: "/bin",
      HOME: "/worker",
      LANG: "C",
      TERM: "xterm",
      NIX_SSL_CERT_FILE: "/cert.pem",
      OPENAI_API_KEY: "direct-provider-key",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      ANTHROPIC_API_KEY: "direct-provider-key",
      ANTHROPIC_AUTH_TOKEN: "direct-provider-key",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      GOOGLE_API_KEY: "direct-provider-key",
      GEMINI_API_KEY: "direct-provider-key",
      OPENROUTER_API_KEY: "direct-provider-key",
      CLIPROXYAPI_API_KEY: "gateway-process-copy",
      CLIPROXYAPI_API_KEY_FILE: "/run/secrets/CLIPROXYAPI_API_KEY",
      PI_CLAUDE_AUTH: "api-key",
      PI_CODING_AGENT_DIR: "/workspace/.omp",
      GITHUB_APP_PRIVATE_KEY: "secret",
      GITHUB_APP_PRIVATE_KEY_FILE: "/run/secrets/key",
      TOKEN_ENCRYPTION_KEY_FILE: "/keys/crypto",
      LINEAR_CLIENT_SECRET: "secret",
      DATABASE_PATH: "/app/data/gateway.sqlite",
      FUTURE_GATEWAY_SECRET: "secret",
      BUN_OPTIONS: "--preload=evil",
      BUN_INSPECT: "127.0.0.1:6499",
      BUN_CONFIG_VERBOSE_FETCH: "1",
      NODE_OPTIONS: "--import=evil",
      LD_PRELOAD: "/evil",
      NIX_SECRET_FILE: "/keys/nix",
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        "HOME",
        "LANG",
        "NIX_SSL_CERT_FILE",
        "PATH",
        "PI_CODING_AGENT_DIR",
        "TERM",
      ].sort(),
    );
    expect(workerIdentityCommand(["omp", "--mode", "rpc"], "1001")).toEqual(
      expect.arrayContaining([
        "--reuid",
        "1001",
        "--no-new-privs",
        "--bounding-set=-all",
      ]),
    );
    expect(() => workerIdentityCommand(["omp"], "0")).toThrow();
  });

  it("revokes a materialized age identity when the next launch has no binding", async () => {
    const dir = await temporary();
    const keyPath = await workspaceProcess(dir, "age-identity", {
      identity: "scoped-fixture-key",
    });
    expect(await readFile(keyPath, "utf8")).toBe("scoped-fixture-key");
    await workspaceProcess(dir, "age-identity", { identity: null });
    await expect(readFile(keyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drops the gateway age-key pointer from new session environments", () => {
    const env = sessionWorkerEnvironment("/workspace", {
      PATH: "/bin",
      FNOX_AGE_KEY_FILE: "/private/gateway-age.key",
      FNOX_AGE_KEY: "gateway-secret",
    });
    expect(env).not.toHaveProperty("FNOX_AGE_KEY_FILE");
    expect(env).not.toHaveProperty("FNOX_AGE_KEY");
  });

  it("passes prepared package paths without inherited Nix store configuration", () => {
    const inherited = {
      PATH: "/nix/store/prepared-tool/bin:/opt/nix/bin:/bin",
      HOME: "/workspace/.omp-home",
      NIX_REMOTE: "daemon",
      NIX_CONFIG: "store = local?read-only=true",
      NIX_PATH: "nixpkgs=/gateway/nixpkgs",
      NIX_PROFILES: "/gateway/profile",
      TOKEN_ENCRYPTION_KEY: "gateway-only",
    };
    const prepared = workerEnvironment(inherited);
    expect(prepared).toEqual({
      PATH: inherited.PATH,
      HOME: inherited.HOME,
    });
    expect(workerEnvironment(prepared)).toEqual(prepared);
    expect(workerEnvironment({ PATH: "/bin" })).not.toHaveProperty(
      "NIX_REMOTE",
    );
    expect(inherited.NIX_REMOTE).toBe("daemon");
  });

  it("doesn't follow workspace symlinks when assigning worker ownership", async () => {
    const dir = await temporary();
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    const outside = join(dir, "outside");
    await writeFile(outside, "gateway");
    await symlink(outside, join(workspace, "key"));
    const before = await stat(outside);
    await prepareWorkerWorkspace(workspace, String(process.getuid?.()));
    expect((await stat(outside)).uid).toBe(before.uid);
    expect((await stat(outside)).mode).toBe(before.mode);
  });

  it("rejects hardlinks before assigning worker ownership", async () => {
    const dir = await temporary();
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    const outside = join(dir, "outside");
    await writeFile(outside, "gateway", { mode: 0o400 });
    await link(outside, join(workspace, "linked"));
    const before = await stat(outside);
    // A native unprivileged test can't chown the parent directory to a foreign
    // uid. Stub that syscall while retaining the real inode ownership/nlink.
    const handle = await open(workspace, "r");
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    const chown = vi.spyOn(prototype, "chown").mockResolvedValue(undefined);
    const foreignUid = (process.getuid?.() ?? 1000) + 1;
    await expect(
      prepareWorkerWorkspace(workspace, String(foreignUid)),
    ).rejects.toThrow("Multiply-linked");
    expect(chown).toHaveBeenCalledExactlyOnceWith(foreignUid, foreignUid);
    expect((await stat(outside)).uid).toBe(before.uid);
    expect(await Bun.file(outside).text()).toBe("gateway");
  });

  it("rejects hardlinks in the synchronous retention walk too", async () => {
    const dir = await temporary();
    const workspace = join(dir, "workspace");
    await mkdir(workspace);
    const outside = join(dir, "outside");
    await writeFile(outside, "gateway", { mode: 0o400 });
    await link(outside, join(workspace, "linked"));
    const before = await stat(outside);
    const chown = vi.spyOn(fs, "fchownSync").mockReturnValue(undefined);
    const foreignUid = (process.getuid?.() ?? 1000) + 1;
    expect(() =>
      prepareWorkerWorkspaceSync(workspace, String(foreignUid)),
    ).toThrow("Multiply-linked");
    expect(chown).toHaveBeenCalledExactlyOnceWith(
      expect.any(Number),
      foreignUid,
      foreignUid,
    );
    expect((await stat(outside)).uid).toBe(before.uid);
  });

  it("resumes with already-owned hardlinked tool state without changing ownership", async () => {
    const dir = await temporary();
    const workspace = join(dir, "workspace");
    await mkdir(join(workspace, ".omp-home"), { recursive: true });
    await writeFile(join(workspace, ".omp-home", "cache"), "tool-state");
    await link(
      join(workspace, ".omp-home", "cache"),
      join(workspace, "dependency"),
    );
    const handle = await open(workspace, "r");
    const prototype = Object.getPrototypeOf(handle) as FileHandle;
    await handle.close();
    vi.spyOn(prototype, "chown").mockRejectedValue(
      new Error("Unexpected ownership change"),
    );
    for (let attempt = 0; attempt < 2; attempt++)
      await prepareWorkerWorkspace(workspace, String(process.getuid?.()));
    expect(await Bun.file(join(workspace, "dependency")).text()).toBe(
      "tool-state",
    );
    expect((await stat(join(workspace, "dependency"))).nlink).toBe(2);
  });

  it.each(["FIFO", "socket"] as const)(
    "accepts a worker-owned %s in both ownership walks without chown",
    async (kind) => {
      await withWorkspaceIpc(kind, async (workspace, path) => {
        const handle = await open(workspace, "r");
        const prototype = Object.getPrototypeOf(handle) as FileHandle;
        await handle.close();
        const chown = vi.spyOn(prototype, "chown");
        const chownSync = vi.spyOn(fs, "fchownSync");
        const uid = String(process.getuid?.());
        await prepareWorkerWorkspace(workspace, uid);
        prepareWorkerWorkspaceSync(workspace, uid);
        expect(chown).not.toHaveBeenCalled();
        expect(chownSync).not.toHaveBeenCalled();
        const node = await stat(path);
        expect(kind === "FIFO" ? node.isFIFO() : node.isSocket()).toBe(true);
        expect(node.uid).toBe(process.getuid?.());
      });
    },
  );

  it.each(["FIFO", "socket"] as const)(
    "rejects a foreign-owned %s in both ownership walks without chowning it",
    async (kind) => {
      await withWorkspaceIpc(kind, async (workspace, path) => {
        const handle = await open(workspace, "r");
        const prototype = Object.getPrototypeOf(handle) as FileHandle;
        await handle.close();
        // Keep the real foreign inode metadata; only fake migrating the parent.
        const chown = vi.spyOn(prototype, "chown").mockResolvedValue(undefined);
        const chownSync = vi.spyOn(fs, "fchownSync").mockReturnValue(undefined);
        const uid = (process.getuid?.() ?? 1000) + 1;
        await expect(
          prepareWorkerWorkspace(workspace, String(uid)),
        ).rejects.toThrow("Foreign-owned workspace FIFO or socket");
        expect(() =>
          prepareWorkerWorkspaceSync(workspace, String(uid)),
        ).toThrow("Foreign-owned workspace FIFO or socket");
        expect(chown).toHaveBeenCalledExactlyOnceWith(uid, uid);
        expect(chownSync).toHaveBeenCalledExactlyOnceWith(
          expect.any(Number),
          uid,
          uid,
        );
        expect((await stat(path)).uid).toBe(process.getuid?.());
      });
    },
  );
});
