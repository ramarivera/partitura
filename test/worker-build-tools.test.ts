import { mkdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { seedWorkerBuildTools } from "../src/services/worker-build-tools.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();

it.live(
  "shares immutable runtimes through independent worker install indexes",
  () =>
    Effect.promise(async () => {
      const cache = path("tool-cache");
      const cachedNode = join(cache, "node", "26.8.1");
      const cachedPython = join(cache, "python", "3.13.7");
      await mkdir(cachedNode, { recursive: true });
      await mkdir(cachedPython, { recursive: true });
      const first = path("tools-first");
      const second = path("tools-second");
      await seedWorkerBuildTools(first, cache);
      await seedWorkerBuildTools(second, cache);
      const installs = (workspace: string) =>
        join(workspace, ".omp-home", ".local", "share", "mise", "installs");
      expect(await readlink(join(installs(first), "node", "26.8.1"))).toBe(
        cachedNode,
      );
      expect(await readlink(join(installs(second), "python", "3.13.7"))).toBe(
        cachedPython,
      );
      const custom = join(installs(first), "node", "custom");
      await mkdir(custom);
      await writeFile(join(custom, "version"), "repository owned");
      await seedWorkerBuildTools(first, cache);
      await expect(
        readlink(join(installs(second), "node", "custom")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await seedWorkerBuildTools(path("native-tools"), path("missing-cache"));
    }),
);
