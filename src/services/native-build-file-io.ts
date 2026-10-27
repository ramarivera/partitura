import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { cleanupNative, NativeOperationError } from "./native-build-errors.js";

export const opaqueId = () => randomUUID().replaceAll("-", "");
export const nativeId = /^[a-f0-9]{32}$/u;
export const builderId = /^[a-z][a-z0-9-]{0,62}$/u;

/** Ancestors must be trusted too. The root-owned sticky temporary directory is
 * allowed for hermetic fixtures; native roots themselves are always private. */
export async function nativeDirectory(path: string, create = false) {
  if (!isAbsolute(path))
    throw NativeOperationError.new("unsafe-native-directory");
  if (create) await mkdir(path, { mode: 0o700 });
  if ((await realpath(path)) !== path)
    throw NativeOperationError.new("unsafe-native-directory");
  for (let current = path; ; current = dirname(current)) {
    const file = await open(
      current,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      const sticky =
        current !== path && info.uid === 0 && (info.mode & 0o1000) !== 0;
      if (
        !info.isDirectory() ||
        info.nlink === 0 ||
        (info.uid !== 0 && info.uid !== process.getuid?.()) ||
        ((info.mode & (current === path ? 0o077 : 0o022)) !== 0 && !sticky) ||
        (current === path &&
          (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700))
      )
        throw NativeOperationError.new("unsafe-native-directory");
    } finally {
      await file.close();
    }
    if (dirname(current) === current) break;
  }
}

export async function nativeFile(
  path: string,
  mode: number | readonly number[],
  maximum: number,
) {
  await nativeDirectory(dirname(path));
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      !(typeof mode === "number" ? [mode] : mode).includes(info.mode & 0o777) ||
      info.size > maximum
    )
      throw NativeOperationError.new("unsafe-native-file");
    // Bound the read even if a concurrent writer grows the file after fstat.
    const bytes = Buffer.alloc(Math.min(info.size + 1, maximum + 1));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size)
      throw NativeOperationError.new("native-file-changed");
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

export async function syncNativeDirectory(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

/** FileHandle-backed streaming avoids a runtime-dependent close event from
 * createWriteStream(autoClose:false), while keeping the descriptor open for fsync. */
export async function writeNativeStream(
  path: string,
  input: AsyncIterable<Uint8Array>,
  maximum: number,
  signal?: AbortSignal,
) {
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let bytes = 0;
  try {
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        if (bytes > maximum) {
          callback(NativeOperationError.new("native-transfer-exceeds-limit"));
          return;
        }
        file.writeFile(chunk).then(
          () => callback(),
          (cause: unknown) =>
            callback(
              NativeOperationError.new("native-stream-write-failed", cause),
            ),
        );
      },
    });
    await pipeline(Readable.from(input), destination, {
      ...(signal ? { signal } : {}),
    });
    await file.sync();
    return bytes;
  } finally {
    await file.close();
  }
}

export async function writeNativeFile(
  path: string,
  bytes: string | Buffer,
  mode: number,
  replace = false,
) {
  await nativeDirectory(dirname(path));
  const target = replace ? join(dirname(path), `${opaqueId()}.new`) : path;
  const file = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  let committed = false;
  let failure: unknown;
  try {
    await file.chmod(mode);
    await file.writeFile(bytes);
    await file.sync();
    if (replace) await rename(target, path);
    committed = true;
    await syncNativeDirectory(dirname(path));
  } catch (error) {
    failure = error;
    throw NativeOperationError.new("native-file-write-failed", error);
  } finally {
    await cleanupNative(
      [
        () => file.close(),
        async () => {
          if (!committed)
            await unlink(target).catch((error: unknown) => {
              if (!missingNativeFile(error)) throw error;
            });
        },
      ],
      failure,
    );
  }
}

export function missingNativeFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function disjointNativeRoots(roots: readonly string[]) {
  const identities = [];
  for (const root of roots) {
    await nativeDirectory(root);
    identities.push(await lstat(root));
  }
  for (let a = 0; a < roots.length; a++)
    for (let b = a + 1; b < roots.length; b++) {
      const first = roots[a],
        second = roots[b],
        x = identities[a],
        y = identities[b];
      if (!first || !second || !x || !y)
        throw NativeOperationError.new("invalid-native-roots");
      const overlaps = (left: string, right: string) => {
        const path = relative(left, right);
        return path === "" || (path !== ".." && !path.startsWith("../"));
      };
      if (
        overlaps(first, second) ||
        overlaps(second, first) ||
        (x.dev === y.dev && x.ino === y.ino)
      )
        throw NativeOperationError.new("overlapping-native-roots");
    }
}

/** Hold the descriptor in the gateway, so process death releases the kernel
 * lock without trusting PID files or stale timestamps. No helper sees keys. */
export async function lockNativeState(root: string) {
  const { dlopen } = await import("bun:ffi");
  const library = dlopen(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    {
      flock: { args: ["i32", "i32"], returns: "i32" },
    },
  );
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      join(root, "owner.lock"),
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
  } catch (error) {
    library.close();
    throw NativeOperationError.new("native-lock-open-failed", error);
  }
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      library.symbols.flock(file.fd, 2 | 4) !== 0
    )
      throw NativeOperationError.new("native-state-locked-or-unsafe");
  } catch (error) {
    await cleanupNative([() => file.close(), () => library.close()], error);
    throw error;
  }
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await cleanupNative([() => file.close(), () => library.close()]);
  };
}
