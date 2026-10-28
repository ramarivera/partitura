import { chmod, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { disjointNativeRoots } from "../src/services/native-build-file-io.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.live(
  "excluded worker parents can be traversable without relaxing native roots",
  () =>
    Effect.promise(async () => {
      const root = path("roots");
      await chmod(root, 0o700);
      const native = join(root, "native"),
        workers = join(root, "workers");
      await mkdir(native, { mode: 0o700 });
      await mkdir(workers, { mode: 0o755 });
      await expect(
        disjointNativeRoots([native], [workers]),
      ).resolves.toBeUndefined();
      await expect(disjointNativeRoots([native, workers])).rejects.toThrow(
        "unsafe-native-directory",
      );
      await expect(disjointNativeRoots([native], [root])).rejects.toThrow(
        "overlapping-native-roots",
      );
      for (const mode of [0o775, 0o777]) {
        await chmod(workers, mode);
        await expect(disjointNativeRoots([native], [workers])).rejects.toThrow(
          "unsafe-native-directory",
        );
      }
      await chmod(workers, 0o755);
      const link = join(root, "alias");
      await symlink(workers, link);
      await expect(disjointNativeRoots([native], [link])).rejects.toThrow(
        "unsafe-native-directory",
      );
    }),
);
