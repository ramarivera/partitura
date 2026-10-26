import { mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";

const TOOL_CACHE = "/opt/partitura/mise/installs";

/** Run only as the session worker. Cached runtimes stay immutable in the image;
 * each worker owns its install index and can add repository-specific versions. */
export async function seedWorkerBuildTools(
  workspace: string,
  source = TOOL_CACHE,
): Promise<void> {
  let tools: string[];
  try {
    tools = await readdir(source);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return; // Native development doesn't require the container's tool cache.
    throw error;
  }
  for (const tool of tools) {
    if (tool !== "node" && tool !== "python") continue;
    for (const version of await readdir(join(source, tool), {
      withFileTypes: true,
    })) {
      if (!version.isDirectory() || !/^\d+\.\d+\.\d+$/u.test(version.name))
        continue;
      const directory = join(
        workspace,
        ".omp-home",
        ".local",
        "share",
        "mise",
        "installs",
        tool,
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        await symlink(
          join(source, tool, version.name),
          join(directory, version.name),
        );
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      }
    }
  }
}
