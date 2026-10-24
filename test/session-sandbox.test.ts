import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeSessionSandboxRuntime,
  sandboxBrokerRequestTimeoutMs,
  sandboxContainerName,
  sandboxEnvironment,
  sandboxWorkerLaunch,
} from "../src/services/session-sandbox.js";
import { writeAgeIdentityFile } from "../src/services/worker-security.js";
import { testPaths } from "./fixtures/paths.js";

const paths = testPaths();

describe("session sandbox", () => {
  it("allows bounded Docker lifecycle operations to finish", () => {
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
      PATH: "/mise/shims:/mise/bin:/usr/local/bin:/opt/claude/bin:/opt/codex/bin:/opt/t3:/usr/bin:/bin",
      MISE_DATA_DIR: "/mise",
      MISE_CACHE_DIR: "/mise/cache",
      MISE_CONFIG_DIR: "/workspace/.omp-home/mise/config",
      MISE_TRUSTED_CONFIG_PATHS: "/workspace",
    });
  });

  it("builds a stream-wrapper launch without putting secret values in argv", () => {
    const launch = sandboxWorkerLaunch(
      "session_1",
      "/run/partitura-sandbox/broker.sock",
      "1001",
      "/app/workspaces/session_1",
      {
        HOME: "/app/workspaces/session_1/.omp-home",
        FNOX_AGE_KEY_FILE: "/app/workspaces/session_1/.omp-home/keys.txt",
      },
      [
        "omp",
        "--session",
        "/app/workspaces/session_1/.omp-home/omp.jsonl",
        "--mode",
        "rpc",
      ],
    );
    expect(launch.command.at(-1)).toBe("rpc");
    expect(launch.command).toContain("/workspace/.omp-home/omp.jsonl");
    expect(launch.env.PARTITURA_SANDBOX_CWD).toBe("/workspace");
    expect(launch.env.PARTITURA_SANDBOX_ENV).toContain("/workspace/.omp-home");
    expect(launch.command).not.toContain("age-secret-material");
    expect(sandboxContainerName("session_1")).toBe(
      "partitura-session-session_1",
    );
    expect(() => sandboxContainerName("../other")).toThrow(
      "Invalid sandbox session id",
    );
  });

  it("writes age identities to a private mode-0400 session file", async () => {
    const workspace = paths("age-workspace");
    const path = await writeAgeIdentityFile(
      workspace,
      "AGE-SECRET-KEY-1EXAMPLE",
    );
    expect(path).toBe(`${workspace}/.omp-home/.config/sops/age/keys.txt`);
    expect(await readFile(path, "utf8")).toBe("AGE-SECRET-KEY-1EXAMPLE");
    expect((await stat(path)).mode & 0o777).toBe(0o400);
  });

  it("sends bounded control requests through the Unix broker socket", async () => {
    const socketPath = paths("sandbox-broker.sock");
    await mkdir(dirname(socketPath), { recursive: true });
    const server = createServer((socket) => {
      let request = "";
      socket.on("data", (chunk) => {
        request += chunk.toString();
        if (!request.includes("\n")) return;
        const parsed = JSON.parse(request) as { sessionId: string };
        socket.end(
          `${JSON.stringify({
            ok: true,
            result: {
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
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const handle = await Effect.runPromise(
        makeSessionSandboxRuntime(socketPath).provision(
          "session-2",
          "/app/workspaces/session-2",
          "1002",
        ),
      );
      expect(handle).toEqual({
        sessionId: "session-2",
        container: "partitura-session-session-2",
        workspace: "/workspace",
        workerAddress: "172.20.0.2",
        gatewayAddress: "172.18.0.3",
        relayAddress: "172.20.0.1",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await unlink(socketPath).catch(() => undefined);
    }
  });

  it("keeps a broker relay alive until its control handle is stopped", async () => {
    const socketPath = paths("sandbox-relay.sock");
    await mkdir(dirname(socketPath), { recursive: true });
    let request: { operation?: string; target?: string; targetPort?: number } =
      {};
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
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
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
  });

  it("fails immediately when the broker closes before replying", async () => {
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
  });
});
