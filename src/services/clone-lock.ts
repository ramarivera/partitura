import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";

export interface CloneLock {
  readonly release: () => Promise<void>;
}

/** Kernel flock ownership survives PID reuse and works across PID namespaces.
 * The helper holds the lock until its private stdin closes, including on a
 * gateway crash. Lock files live outside worker-owned directories.
 */
export const acquireCloneLock = async (
  root: string,
  owner: string,
): Promise<CloneLock | undefined> => {
  if (!/^[a-f0-9]{32}$/u.test(owner)) throw new Error("Invalid clone owner");
  const directory = join(root, ".clone-locks");
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(directory)) !== directory ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Unsafe clone lock directory");
  const child = Bun.spawn(
    [
      "flock",
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      "73",
      join(directory, owner),
      "/bin/sh",
      "-c",
      "printf 'ready\\n'; cat >/dev/null",
    ],
    {
      cwd: directory,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const reader = child.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Clone lock helper timed out")),
          5_000,
        );
      }),
    ]);
    if (first.done) {
      if ((await child.exited) === 73) return undefined;
      throw new Error("Clone lock helper failed");
    }
    if (new TextDecoder().decode(first.value) !== "ready\n")
      throw new Error("Invalid clone lock handshake");
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        child.stdin.end();
        if ((await child.exited) !== 0)
          throw new Error("Clone lock helper failed");
      },
    };
  } catch (error) {
    child.kill();
    child.stdin.end();
    await child.exited;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
};
