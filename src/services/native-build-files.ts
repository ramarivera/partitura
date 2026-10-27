import { Context, Effect, Layer } from "effect";
import { nativeError, nativeIO } from "./native-build-errors.js";
import * as io from "./native-build-file-io.js";

export {
  builderId,
  missingNativeFile,
  nativeId,
  opaqueId,
} from "./native-build-file-io.js";

/** Descriptor IO is isolated in the adapter; the service owns resource scopes. */
export class NativeBuildFiles extends Context.Service<NativeBuildFiles>()(
  "NativeBuildFiles",
  {
    make: Effect.sync(() => ({
      directory: Effect.fn("NativeBuildFiles.directory")(
        (...args: Parameters<typeof io.nativeDirectory>) =>
          nativeIO(() => io.nativeDirectory(...args)).pipe(
            Effect.uninterruptible,
          ),
      ),
      file: Effect.fn("NativeBuildFiles.file")(
        (...args: Parameters<typeof io.nativeFile>) =>
          nativeIO(() => io.nativeFile(...args)).pipe(Effect.uninterruptible),
      ),
      write: Effect.fn("NativeBuildFiles.write")(
        (...args: Parameters<typeof io.writeNativeFile>) =>
          nativeIO(() => io.writeNativeFile(...args)).pipe(
            Effect.uninterruptible,
          ),
      ),
      stream: Effect.fn("NativeBuildFiles.stream")(
        (path: string, input: AsyncIterable<Uint8Array>, maximum: number) =>
          Effect.callback<
            number,
            import("./native-build-errors.js").NativeOperationError
          >((resume, signal) => {
            const settled = io
              .writeNativeStream(path, input, maximum, signal)
              .then(
                (value) => resume(Effect.succeed(value)),
                (error) => resume(Effect.fail(nativeError(error))),
              );
            // Abort the pipeline and await its descriptor finalizer before releasing
            // reservations or process ownership in the surrounding scope.
            return Effect.promise(() => settled);
          }),
      ),
      disjointRoots: Effect.fn("NativeBuildFiles.disjointRoots")(
        (roots: readonly string[]) =>
          nativeIO(() => io.disjointNativeRoots(roots)),
      ),
      syncDirectory: Effect.fn("NativeBuildFiles.syncDirectory")(
        (path: string) =>
          nativeIO(() => io.syncNativeDirectory(path)).pipe(
            Effect.uninterruptible,
          ),
      ),
      lock: Effect.fn("NativeBuildFiles.lock")((root: string) =>
        Effect.acquireRelease(
          nativeIO(() => io.lockNativeState(root)),
          (release) => nativeIO(release).pipe(Effect.orDie),
        ),
      ),
    })),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}

// Preserve the original module's public names as Effect entry points.
export const nativeDirectory = Effect.fn("NativeBuildFiles.nativeDirectory")(
  (...args: Parameters<typeof io.nativeDirectory>) =>
    NativeBuildFiles.use((files) => files.directory(...args)),
);
export const nativeFile = Effect.fn("NativeBuildFiles.nativeFile")(
  (...args: Parameters<typeof io.nativeFile>) =>
    NativeBuildFiles.use((files) => files.file(...args)),
);
export const writeNativeFile = Effect.fn("NativeBuildFiles.writeNativeFile")(
  (...args: Parameters<typeof io.writeNativeFile>) =>
    NativeBuildFiles.use((files) => files.write(...args)),
);
export const writeNativeStream = Effect.fn(
  "NativeBuildFiles.writeNativeStream",
)((path: string, input: AsyncIterable<Uint8Array>, maximum: number) =>
  NativeBuildFiles.use((files) => files.stream(path, input, maximum)),
);
export const disjointNativeRoots = Effect.fn(
  "NativeBuildFiles.disjointNativeRoots",
)((roots: readonly string[]) =>
  NativeBuildFiles.use((files) => files.disjointRoots(roots)),
);
export const lockNativeState = Effect.fn("NativeBuildFiles.lockNativeState")(
  (root: string) => NativeBuildFiles.use((files) => files.lock(root)),
);
export const syncNativeDirectory = Effect.fn(
  "NativeBuildFiles.syncNativeDirectory",
)((path: string) => NativeBuildFiles.use((files) => files.syncDirectory(path)));
