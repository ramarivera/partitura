import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { testPaths } from "./fixtures/paths.js";

const paths = testPaths();
const script = new URL("../src/session-sandbox-exec.ts", import.meta.url)
  .pathname;

describe("sandbox exec wrapper", () => {
  it.each(["exit", "truncated"] as const)(
    "finishes on broker %s while gateway stdin stays open",
    async (reply) => {
      const socketPath = paths("e.sock");
      let requestedArgv: unknown;
      const server = createServer((socket) => {
        socket.once("data", (data: Buffer) => {
          requestedArgv = (JSON.parse(data.toString()) as { argv: unknown })
            .argv;
          if (reply === "exit") {
            const frame = Buffer.alloc(5);
            frame.write("X");
            frame.writeUInt32BE(7, 1);
            socket.end(frame);
          } else {
            socket.end(Buffer.from("O\x00\x00"));
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const child = spawn(
        process.execPath,
        [script, "--", "omp", "--", "value"],
        {
          env: {
            PARTITURA_SANDBOX_BROKER_SOCKET: socketPath,
            PARTITURA_SANDBOX_SESSION_ID: "session-1",
            PARTITURA_SANDBOX_WORKER_UID: "1001",
            PARTITURA_SANDBOX_CWD: "/workspace",
            PARTITURA_SANDBOX_ENV: "{}",
          },
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 3_000,
        },
      );
      let errors = "";
      child.stderr.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      try {
        const result = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        expect(result.signal).toBeNull();
        expect(requestedArgv).toEqual(["omp", "--", "value"]);
        expect(result.code).toBe(reply === "exit" ? 7 : 1);
        if (reply === "truncated")
          expect(errors).toContain("Sandbox broker closed the stream");
      } finally {
        child.kill();
        child.stdin.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
