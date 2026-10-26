import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";

export interface CloneLock {
  readonly release: () => Promise<void>;
}

// macOS has the kernel primitive but no flock executable. Keep the descriptor
// in this process so crashes release ownership without a PID/stale-file test.
const acquireDarwinLock = async (
  path: string,
): Promise<CloneLock | undefined> => {
  const { dlopen, read } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
  });
  const file = await open(path, "a", 0o600).catch((error: unknown) => {
    library.close();
    throw error;
  });
  let acquired = false;
  try {
    if (library.symbols.flock(file.fd, 2 | 4) !== 0) {
      const errno = library.symbols.__error();
      // Darwin EWOULDBLOCK. Other errors must never look like contention.
      if (errno === null || read.i32(errno) !== 35)
        throw new Error("Clone lock acquisition failed");
    } else acquired = true;
  } catch (error) {
    await file.close();
    library.close();
    throw error;
  }
  if (!acquired) {
    await file.close();
    library.close();
    return undefined;
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await file.close();
      } finally {
        library.close();
      }
    },
  };
};

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
  if (process.platform === "darwin")
    return acquireDarwinLock(join(directory, owner));
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
