import { readFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { nativeIO } from "../src/services/native-build-errors.js";
import { NativeBuildProcesses } from "../src/services/native-build-process.js";

it.live("finish kills descendants after the group leader has closed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const processes = yield* NativeBuildProcesses;
      const owner = yield* processes.acquire(
        [
          process.execPath,
          "-e",
          `
      const {spawn} = require("node:child_process");
      const child = spawn("/bin/sleep", ["60"], {stdio:"ignore"});
      console.log(child.pid); child.unref();
    `,
        ],
        { timeout: 10_000 },
      );
      let output = "";
      owner.child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      yield* nativeIO(() => owner.check());
      const pid = Number(output.trim());
      expect(pid).toBeGreaterThan(0);
      process.kill(pid, 0);
      yield* nativeIO(() => owner.finish());
      // SIGKILL is delivered asynchronously, and Linux may briefly retain the
      // orphan as a zombie until init reaps it, so poll within a bound.
      const isAlive = nativeIO(() =>
        readFile(`/proc/${pid}/stat`, "utf8"),
      ).pipe(
        Effect.map((value) => !value.includes(") Z ")),
        Effect.catch(() => Effect.succeed(false)),
      );
      let alive = yield* isAlive;
      for (let attempt = 0; alive && attempt < 100; attempt++) {
        yield* Effect.sleep("20 millis");
        alive = yield* isAlive;
      }
      expect(alive).toBe(false);
    }),
  ).pipe(Effect.provide(NativeBuildProcesses.layer)),
);
