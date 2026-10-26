import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  makeSessionSandboxRuntime,
  type SandboxBrokerRequest,
  type SessionSandboxRelay,
  sandboxBrokerRequestTimeoutMs,
  sandboxContainerName,
  sandboxEnvironment,
  sandboxWorkerLaunch,
} from "../src/services/session-sandbox.js";
import { writeAgeIdentityFile } from "../src/services/worker-security.js";
import { testPaths } from "./fixtures/paths.js";

const paths = testPaths();

describe("session sandbox", () => {
  it("allows bounded sandbox lifecycle operations to finish", () => {
    expect(sandboxBrokerRequestTimeoutMs("provision")).toBe(15 * 60_000);
    expect(sandboxBrokerRequestTimeoutMs("recover")).toBe(5 * 60_000);
    expect(sandboxBrokerRequestTimeoutMs("destroy")).toBe(5 * 60_000);
  });

  it("maps only workspace paths into the container", () => {
    expect(
      sandboxEnvironment("/app/workspaces/session-1", {
        HOME: "/app/workspaces/session-1/.omp-home",
        PATH: "/app/nix/store/bin",
      }),
    ).toEqual({
      HOME: "/workspace/.omp-home",
      PATH: "/mise/shims:/mise/bin:/opt/partitura/bin:/usr/local/bin:/opt/claude/bin:/opt/codex/bin:/opt/t3:/usr/bin:/bin",
      MISE_DATA_DIR: "/mise",
      MISE_CACHE_DIR: "/mise/cache",
      MISE_CONFIG_DIR: "/workspace/.omp-home/mise/config",
      MISE_TRUSTED_CONFIG_PATHS: "/workspace",
      TMPDIR: "/tmp",
      XDG_CACHE_HOME: "/mise/cache",
      XDG_DATA_HOME: "/mise/user-data",
      BUN_INSTALL_CACHE_DIR: "/mise/cache/bun/install",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "/mise/cache/bun/transpiler",
    });
  });

  it("keeps default caches and transient IPC local while preserving scoped credentials", () => {
    const workspace = "/app/workspaces/session-1";
    const environment = sandboxEnvironment(workspace, {
      HOME: `${workspace}/.omp-home`,
      TMPDIR: `${workspace}/.omp-tmp`,
      XDG_CACHE_HOME: `${workspace}/.omp-home/.cache`,
      XDG_DATA_HOME: `${workspace}/.omp-home/.local/share`,
      XDG_CONFIG_HOME: `${workspace}/.omp-home/.config`,
      BUN_INSTALL_CACHE_DIR: `${workspace}/.omp-home/.cache/bun/install`,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: `${workspace}/.omp-home/.cache/bun/transpiler`,
      FNOX_AGE_KEY_FILE: `${workspace}/.omp-home/.config/sops/age/keys.txt`,
      T3CODE_HOME: `${workspace}/.omp-home/t3`,
    });
    for (const key of [
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "BUN_INSTALL_CACHE_DIR",
      "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
    ]) {
      expect(environment[key]).toMatch(/^\/mise\//u);
    }
    expect(environment.FNOX_AGE_KEY_FILE).toBe(
      "/workspace/.omp-home/.config/sops/age/keys.txt",
    );
    expect(environment.XDG_CONFIG_HOME).toBe("/workspace/.omp-home/.config");
    expect(environment.HOME).toBe("/workspace/.omp-home");
    expect(environment.TMPDIR).toBe("/tmp");
    expect(environment.T3CODE_HOME).toBe("/workspace/.omp-home/t3");
  });

  it("builds a stream-wrapper launch without putting secret values in argv", () => {
    const wrapper = fileURLToPath(
      new URL("../src/session-sandbox-exec.ts", import.meta.url),
    );
    const launch = sandboxWorkerLaunch(
      "session_1",
      "/run/partitura-sandbox/broker.sock",
      "1001",
      "/app/workspaces/session_1",
      {
        HOME: "/app/workspaces/session_1/.omp-home",
        FNOX_AGE_KEY_FILE: "/app/workspaces/session_1/.omp-home/keys.txt",
        CLIPROXYAPI_API_KEY: "sandbox-model-secret",
      },
      [
        "omp",
        "--session",
        "/app/workspaces/session_1/.omp-home/omp.jsonl",
        "--mode",
        "rpc",
      ],
    );
    expect(launch.command.slice(1, 6)).toEqual([
      `--cwd=${dirname(wrapper)}`,
      "--config=/dev/null",
      "--no-env-file",
      "--no-install",
      wrapper,
    ]);
    expect(launch.command.at(-1)).toBe("rpc");
    expect(launch.command).toContain("/workspace/.omp-home/omp.jsonl");
    expect(launch.env.PARTITURA_SANDBOX_CWD).toBe("/workspace");
    expect(launch.env.PARTITURA_SANDBOX_ENV).toContain("/workspace/.omp-home");
    expect(
      launch.command.some((argument) =>
        argument.includes("sandbox-model-secret"),
      ),
    ).toBe(false);
    expect(
      JSON.parse(launch.env.PARTITURA_SANDBOX_ENV ?? "{}").CLIPROXYAPI_API_KEY,
    ).toBe("sandbox-model-secret");
    expect(sandboxContainerName("session_1")).toBe(
      "partitura-session-session_1",
    );
    expect(() => sandboxContainerName("../other")).toThrow(
      "Invalid sandbox session id",
    );
  });

  it.live("writes age identities to a private mode-0400 session file", () =>
    Effect.promise(async () => {
      const workspace = paths("age-workspace");
      const path = await writeAgeIdentityFile(
        workspace,
        "AGE-SECRET-KEY-1EXAMPLE",
      );
      expect(path).toBe(`${workspace}/.omp-home/.config/sops/age/keys.txt`);
      expect(await readFile(path, "utf8")).toBe("AGE-SECRET-KEY-1EXAMPLE");
      expect((await stat(path)).mode & 0o777).toBe(0o400);
    }),
  );

  it.live.each([undefined, "firecracker", "sysbox"] as const)(
    "uses one broker lifecycle for runtime %s",
    (runtime) =>
      Effect.promise(async () => {
        const socketPath = paths("sandbox-broker.sock");
        await mkdir(dirname(socketPath), { recursive: true });
        const requests: SandboxBrokerRequest[] = [];
        const selectedRuntime = runtime ?? "firecracker";
        const server = createServer((socket) => {
          let request = "";
          socket.on("data", (chunk) => {
            request += chunk.toString();
            if (!request.includes("\n")) return;
            const parsed = JSON.parse(request) as SandboxBrokerRequest;
            requests.push(parsed);
            socket.end(
              `${JSON.stringify({
                ok: true,
                result: {
                  runtime: selectedRuntime,
                  exists: true,
                  running: true,
                  container: `partitura-session-${parsed.sessionId}`,
                  workspace: "/workspace",
                  workerAddress: "172.20.0.2",
                  gatewayAddress: "172.18.0.3",
                  relayAddress: "172.20.0.1",
                },
              })}\n`,
            );
          });
        });
        await new Promise<void>((resolve) =>
          server.listen(socketPath, resolve),
        );
        try {
          const sandbox = makeSessionSandboxRuntime(socketPath, runtime);
          const handle = await Effect.runPromise(
            sandbox.provision("session-2", "/app/workspaces/session-2", "1002"),
          );
          expect(handle).toEqual({
            sessionId: "session-2",
            container: "partitura-session-session-2",
            workspace: "/workspace",
            workerAddress: "172.20.0.2",
            gatewayAddress: "172.18.0.3",
            relayAddress: "172.20.0.1",
          });
          expect(
            await Effect.runPromise(
              sandbox.recover("session-2", "/app/workspaces/session-2", "1002"),
            ),
          ).toEqual({ exists: true, running: true, handle });
          await Effect.runPromise(sandbox.destroy("session-2"));
          expect(requests).toEqual([
            {
              operation: "provision",
              runtime: selectedRuntime,
              sessionId: "session-2",
              workspacePath: "/app/workspaces/session-2",
              workerUid: "1002",
            },
            {
              operation: "recover",
              runtime: selectedRuntime,
              sessionId: "session-2",
              workspacePath: "/app/workspaces/session-2",
              workerUid: "1002",
            },
            {
              operation: "destroy",
              runtime: selectedRuntime,
              sessionId: "session-2",
            },
          ]);
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          await unlink(socketPath).catch(() => undefined);
        }
      }),
  );

  it.live.each([
    ["firecracker", "sysbox"],
    ["sysbox", "firecracker"],
    ["firecracker", undefined],
    ["sysbox", undefined],
  ] as const)(
    "refuses requested %s when the broker reports %s",
    ([runtime, reportedRuntime]) =>
      Effect.promise(async () => {
        const socketPath = paths("runtime-mismatch.sock");
        const server = createServer((socket) => {
          socket.on("data", () =>
            socket.end(
              `${JSON.stringify({
                ok: true,
                result: {
                  runtime: reportedRuntime,
                  exists: false,
                  running: false,
                },
              })}\n`,
            ),
          );
        });
        await new Promise<void>((resolve) =>
          server.listen(socketPath, resolve),
        );
        try {
          const sandbox = makeSessionSandboxRuntime(socketPath, runtime);
          for (const operation of ["provision", "recover"] as const) {
            await expect(
              Effect.runPromise(
                operation === "provision"
                  ? sandbox
                      .provision(
                        "session-2",
                        "/app/workspaces/session-2",
                        "1002",
                      )
                      .pipe(Effect.asVoid)
                  : sandbox
                      .recover("session-2", "/app/workspaces/session-2", "1002")
                      .pipe(Effect.asVoid),
              ),
            ).rejects.toMatchObject({
              operation,
              message: "Sandbox broker returned an unexpected runtime",
            });
          }
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          await unlink(socketPath).catch(() => undefined);
        }
      }),
  );

  it.live(
    "keeps a broker relay alive until its control handle is stopped",
    () =>
      Effect.promise(async () => {
        const socketPath = paths("sandbox-relay.sock");
        await mkdir(dirname(socketPath), { recursive: true });
        let request: {
          operation?: string;
          target?: string;
          targetPort?: number;
        } = {};
        let controlClosed: (() => void) | undefined;
        const closed = new Promise<void>((resolve) => {
          controlClosed = resolve;
        });
        const server = createServer((socket) => {
          let payload = "";
          socket.on("data", (chunk) => {
            payload += chunk.toString();
            if (!payload.includes("\n")) return;
            request = JSON.parse(payload) as typeof request;
            socket.write(
              `${JSON.stringify({
                ok: true,
                result: { address: "172.20.0.1", port: 43123 },
              })}\n`,
            );
          });
          socket.on("end", () => {
            controlClosed?.();
            socket.end();
          });
        });
        await new Promise<void>((resolve) =>
          server.listen(socketPath, resolve),
        );
        try {
          const relay = await Effect.runPromise(
            makeSessionSandboxRuntime(socketPath).openRelay(
              "session-3",
              "gateway",
              41999,
            ),
          );
          expect(relay.baseUrl).toBe("http://172.20.0.1:43123");
          expect(request).toEqual({
            operation: "relay",
            sessionId: "session-3",
            target: "gateway",
            targetPort: 41999,
          });
          relay.stop();
          await closed;
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          await unlink(socketPath).catch(() => undefined);
        }
      }),
  );

  it.live(
    "restores a lost egress lease and stops retrying after session cleanup",
    () =>
      Effect.promise(async () => {
        const socketPath = paths("sandbox-egress-recovery.sock");
        await mkdir(dirname(socketPath), { recursive: true });
        const sockets: Socket[] = [];
        const requests: unknown[] = [];
        const server = createServer((socket) => {
          sockets.push(socket);
          socket.once("data", (data) => {
            requests.push(JSON.parse(data.toString()));
            socket.write(
              `${JSON.stringify({ ok: true, result: { address: "127.0.0.1", port: 3128 } })}\n`,
            );
          });
          socket.on("end", () => socket.end());
        });
        await new Promise<void>((resolve) =>
          server.listen(socketPath, resolve),
        );
        let relay: SessionSandboxRelay | undefined;
        try {
          relay = await Effect.runPromise(
            makeSessionSandboxRuntime(socketPath).openEgressProxy(
              "session-egress",
            ),
          );
          expect(relay.baseUrl).toBe("http://127.0.0.1:3128");
          const first = sockets[0];
          if (!first) throw new Error("Initial broker connection missing");
          first.destroy();
          for (let attempt = 0; requests.length < 2 && attempt < 100; attempt++)
            await delay(10);
          expect(requests).toEqual([
            { operation: "egress", sessionId: "session-egress" },
            { operation: "egress", sessionId: "session-egress" },
          ]);
          const recovered = sockets[1];
          if (!recovered)
            throw new Error("Recovered broker connection missing");
          recovered.destroy();
          relay.stop();
          await delay(250);
          expect(sockets).toHaveLength(2);
        } finally {
          relay?.stop();
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await unlink(socketPath).catch(() => undefined);
        }
      }),
  );

  it.live("fails immediately when the broker closes before replying", () =>
    Effect.promise(async () => {
      const socketPath = paths("sandbox-closed.sock");
      await mkdir(dirname(socketPath), { recursive: true });
      const server = createServer((socket) => socket.end());
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        await expect(
          Effect.runPromise(
            makeSessionSandboxRuntime(socketPath).openRelay(
              "session-closed",
              "gateway",
              41999,
            ),
          ),
        ).rejects.toMatchObject({
          operation: "relay",
          message: "Sandbox relay request failed",
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await unlink(socketPath).catch(() => undefined);
      }
    }),
  );
});
