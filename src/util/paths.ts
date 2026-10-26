import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export const isWithin = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== "..")
  );
};

export const canonicalReference = (path: string): string | undefined => {
  // Resolve existing ancestors as well: a not-yet-created child under an alias
  // still references the canonical parent's workspace.
  const suffix: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...suffix);
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) ||
        dirname(current) === current
      )
        return undefined;
      suffix.unshift(basename(current));
      current = dirname(current);
    }
  }
};
