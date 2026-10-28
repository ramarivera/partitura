import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

/** These checks run after Bun startup. They cannot undo preloaded code; the
 * operator must use the documented clean launch and a trusted sealed checkout.
 */
export function validateRollbackLaunchContext(context: {
  readonly cwd: string;
  readonly execArgv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}) {
  if (
    context.cwd !== "/" ||
    context.execArgv.length !== 2 ||
    !context.execArgv.includes("--config=/dev/null") ||
    !context.execArgv.includes("--no-env-file") ||
    context.environment.PATH !== "/usr/bin:/bin" ||
    Object.keys(context.environment).some((key) => key !== "PATH")
  )
    throw new Error("unsafe-rollback-launch");
}

export async function protectedCodePath(path: string) {
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    throw new Error("unsafe-rollback-code");
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    if (info.uid !== 0 || (info.mode & 0o022) !== 0 || info.isSymbolicLink())
      throw new Error("unsafe-rollback-code");
    if (dirname(current) === current) break;
  }
}
