import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { sandboxWorkerLaunch } from "../src/services/session-sandbox.js";
import { testPaths } from "./fixtures/paths.js";

const paths = testPaths();

describe("sandbox exec wrapper", () => {
  it.live.each(["exit", "truncated"] as const)(
    "finishes on broker %s while gateway stdin stays open",
    (reply) =>
      Effect.promise(async () => {
        const socketPath = paths("e.sock");
        const workerCwd = paths("worker-cwd");
        const preloadMarker = join(workerCwd, "bunfig-preload-ran");
        await mkdir(workerCwd, { recursive: true });
        await writeFile(
          join(workerCwd, "bunfig.toml"),
          'preload = ["./preload.js"]\n',
        );
        await writeFile(
          join(workerCwd, "preload.js"),
          `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(preloadMarker)}, "loaded");\n`,
        );
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
        await new Promise<void>((resolve) =>
          server.listen(socketPath, resolve),
        );
        const launch = sandboxWorkerLaunch(
          "session-1",
          socketPath,
          "1001",
          workerCwd,
          {},
          ["omp", "--", "value"],
        );
        const executable = launch.command[0];
        if (executable === undefined)
          throw new Error("Sandbox launch has no executable");
        const args = launch.command.slice(1);
        const child = spawn(executable, args, {
          cwd: workerCwd,
          env: launch.env,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 3_000,
        });
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
          expect(existsSync(preloadMarker)).toBe(false);
          if (reply === "truncated")
            expect(errors).toContain("Sandbox broker closed the stream");
        } finally {
          child.kill();
          child.stdin.destroy();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      }),
  );
});
