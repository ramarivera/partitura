import { constants, watch } from "node:fs";
import { lstat, open, realpath, statfs } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import { BuilderRegistryError } from "./builder-registry-json.js";
import {
  type BuilderRegistrySettings,
  nativePathsOverlap,
} from "./config-native-build.js";
import { nativeDirectory } from "./native-build-file-io.js";

export const registryIO = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof BuilderRegistryError
        ? cause
        : BuilderRegistryError.new("registry-file-unavailable", cause),
  });

export class BuilderRegistryFiles extends Context.Service<BuilderRegistryFiles>()(
  "BuilderRegistryFiles",
  {
    make: Effect.sync(() => ({
      validateRoots: Effect.fn("BuilderRegistryFiles.validateRoots")(
        (settings: BuilderRegistrySettings) =>
          registryIO(async () => {
            const roots = [
              settings.stateRoot,
              settings.cacheRoot,
              settings.fileSecretRoot,
              ...(settings.otherRoots ?? []),
            ].filter((root): root is string => root !== undefined);
            await nativeDirectory(settings.scratchRoot);
            const scratch = await lstat(settings.scratchRoot);
            for (const root of roots) {
              if ((await realpath(root)) !== root)
                throw BuilderRegistryError.new("registry-path-invalid");
              const info = await lstat(root);
              if (
                nativePathsOverlap(settings.scratchRoot, root) ||
                (info.dev === scratch.dev && info.ino === scratch.ino)
              )
                throw BuilderRegistryError.new("registry-roots-overlap");
            }
            for (const root of [
              settings.stateRoot,
              settings.cacheRoot,
              settings.fileSecretRoot,
            ])
              if (root !== undefined) await nativeDirectory(root);
            const fs = await statfs(settings.scratchRoot);
            const usable = (fs.blocks - (fs.bfree - fs.bavail)) * fs.bsize;
            if (settings.totalBytes > usable - 2 * 1024 ** 3)
              throw BuilderRegistryError.new("registry-scratch-capacity");
          }),
      ),
      directory: Effect.fn("BuilderRegistryFiles.directory")(function* (
        path: string,
      ) {
        if (resolve(path) !== path)
          return yield* Effect.fail(
            BuilderRegistryError.new("registry-path-invalid"),
          );
        const directory = yield* Effect.acquireRelease(
          registryIO(async () => {
            await nativeDirectory(path);
            return open(
              path,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
          }),
          (handle) => registryIO(() => handle.close()).pipe(Effect.orDie),
        );
        const original = yield* registryIO(() => directory.stat());
        const check = Effect.fn("BuilderRegistryFiles.check")(function* () {
          yield* registryIO(async () => {
            const current = await directory.stat();
            const named = await lstat(path).catch((cause: unknown) => {
              throw BuilderRegistryError.new("registry-mount-stale", cause);
            });
            if (
              current.nlink === 0 ||
              current.dev !== original.dev ||
              current.ino !== original.ino ||
              named.dev !== original.dev ||
              named.ino !== original.ino
            )
              throw BuilderRegistryError.new("registry-mount-stale");
            if (
              !current.isDirectory() ||
              current.uid !== process.getuid?.() ||
              (current.mode & 0o7777) !== 0o700
            )
              throw BuilderRegistryError.new("registry-directory-insecure");
          });
        });
        yield* check();
        return {
          check,
          read: Effect.fn("BuilderRegistryFiles.read")(function* (
            name: string,
            mode: number,
            maximum: number,
          ) {
            if (basename(name) !== name || name === "." || name === "..")
              return yield* Effect.fail(
                BuilderRegistryError.new("registry-path-invalid"),
              );
            yield* check();
            return yield* Effect.scoped(
              Effect.gen(function* () {
                // Linux descriptor-relative access remains pinned across directory renames.
                const handle = yield* Effect.acquireRelease(
                  registryIO(() =>
                    open(
                      `/proc/self/fd/${directory.fd}/${name}`,
                      constants.O_RDONLY |
                        constants.O_NOFOLLOW |
                        constants.O_NONBLOCK,
                    ),
                  ),
                  (file) => registryIO(() => file.close()).pipe(Effect.orDie),
                );
                const bytes = yield* registryIO(async () => {
                  const before = await handle.stat();
                  if (
                    !before.isFile() ||
                    before.uid !== process.getuid?.() ||
                    before.nlink !== 1 ||
                    (before.mode & 0o7777) !== mode ||
                    before.size > maximum
                  )
                    throw BuilderRegistryError.new("registry-file-insecure");
                  const buffer = Buffer.alloc(
                    Math.min(before.size + 1, maximum + 1),
                  );
                  const { bytesRead } = await handle.read(
                    buffer,
                    0,
                    buffer.length,
                    0,
                  );
                  const after = await handle.stat();
                  if (
                    bytesRead !== before.size ||
                    before.size !== after.size ||
                    before.mtimeMs !== after.mtimeMs ||
                    before.ctimeMs !== after.ctimeMs ||
                    after.nlink !== 1
                  )
                    throw BuilderRegistryError.new("registry-file-changed");
                  return buffer.subarray(0, bytesRead);
                });
                yield* check();
                return bytes;
              }),
            );
          }),
        };
      }),
      watch: Effect.fn("BuilderRegistryFiles.watch")(
        (path: string, changed: () => void, failed: (cause: unknown) => void) =>
          Effect.acquireRelease(
            Effect.try({
              try: () => {
                const watcher = watch(dirname(path), changed);
                watcher.on("error", failed);
                return watcher;
              },
              catch: (cause) =>
                BuilderRegistryError.new("registry-watch-degraded", cause),
            }),
            (watcher) => Effect.sync(() => watcher.close()),
          ),
      ),
    })),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
