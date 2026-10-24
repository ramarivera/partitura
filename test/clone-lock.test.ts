import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { acquireCloneLock } from "../src/services/clone-lock.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const owner = "a".repeat(32);

it.live(
  "excludes another gateway and releases ownership without PID inference",
  () =>
    Effect.promise(async () => {
      const root = path("root");
      const first = await acquireCloneLock(root, owner);
      if (first === undefined) throw new Error("Initial ownership missing");
      try {
        expect(await acquireCloneLock(root, owner)).toBeUndefined();
      } finally {
        await first.release();
      }
      const next = await acquireCloneLock(root, owner);
      if (next === undefined) throw new Error("Ownership wasn't released");
      await next.release();
    }),
);

it.live("releases kernel ownership when the owning gateway is killed", () =>
  Effect.promise(async () => {
    const root = path("root");
    const module = new URL("../src/services/clone-lock.ts", import.meta.url)
      .pathname;
    const code = `import {acquireCloneLock} from ${JSON.stringify(module)};
const lock=await acquireCloneLock(${JSON.stringify(root)},${JSON.stringify(owner)});
if(!lock)process.exit(1); console.log('ready');setInterval(()=>{},1000);`;
    const child = Bun.spawn([process.execPath, "-e", code], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      try {
        const ready = await reader.read();
        expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
      } finally {
        reader.releaseLock();
      }
      expect(await acquireCloneLock(root, owner)).toBeUndefined();
      child.kill("SIGKILL");
      await child.exited;
      let recovered = await acquireCloneLock(root, owner);
      for (
        let attempt = 0;
        recovered === undefined && attempt < 20;
        attempt++
      ) {
        await Bun.sleep(10);
        recovered = await acquireCloneLock(root, owner);
      }
      if (recovered === undefined)
        throw new Error("Dead gateway retained ownership");
      await recovered.release();
    } finally {
      child.kill();
      await child.exited;
    }
  }),
);

it.live("rejects a lock directory writable by workers", () =>
  Effect.promise(async () => {
    const root = path("root");
    await mkdir(join(root, ".clone-locks"), { mode: 0o777 });
    await expect(acquireCloneLock(root, owner)).rejects.toThrow(
      "Unsafe clone lock directory",
    );
    expect(await readdir(join(root, ".clone-locks"))).toEqual([]);
  }),
);
