import { spawn } from "node:child_process";
import { mkdir, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const seedScript = join(
  process.cwd(),
  "deploy/session-sandbox/seed-mise-installs.sh",
);

const seed = (dataDir: string, sharedInstalls: string) =>
  new Promise<{ readonly code: number | null; readonly stderr: string }>(
    (resolve, reject) => {
      const child = spawn("sh", [seedScript, dataDir, sharedInstalls], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 3_000,
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    },
  );

it.live("seeds shared Mise runtimes without following worker-owned links", () =>
  Effect.promise(async () => {
    const shared = path("shared/installs");
    const data = path("session/mise");
    const node = join(shared, "node", "24.22.1");
    const python = join(shared, "python", "3.13.17");
    await mkdir(node, { recursive: true });
    await mkdir(python, { recursive: true });

    expect(await seed(data, shared)).toMatchObject({ code: 0 });
    expect(await seed(data, shared)).toMatchObject({ code: 0 });
    expect(await readlink(join(data, "installs/node/24.22.1"))).toBe(node);
    expect(await readlink(join(data, "installs/python/3.13.17"))).toBe(python);

    const outside = path("outside");
    const hostileData = path("hostile/mise");
    await mkdir(join(outside, "node"), { recursive: true });
    await mkdir(join(hostileData, "installs"), { recursive: true });
    await symlink(outside, join(hostileData, "installs/node"));
    const failure = await seed(hostileData, shared);
    expect(failure.code).not.toBe(0);
    expect(failure.stderr).toContain("unsafe Mise install path");
    await expect(readlink(join(outside, "node/24.22.1"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  }),
);
