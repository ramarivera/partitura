import { Context, Effect, Layer } from "effect";
import { nativeIO } from "./native-build-errors.js";
import { NativeBuildFiles } from "./native-build-files.js";
import type { NativeStateOptions } from "./native-build-models.js";
import { openNativeStorage } from "./native-build-storage.js";

export * from "./native-build-models.js";

export class NativeStateConfig extends Context.Service<
  NativeStateConfig,
  NativeStateOptions
>()("NativeStateConfig") {}
export const openNativeBuildState = Effect.fn("NativeBuildState.open")(
  function* (options: NativeStateOptions) {
    const storage = yield* Effect.acquireRelease(
      // Opening/committing storage cannot be interrupted between its rename and
      // publication. close waits for the serialization tail before unlocking.
      nativeIO(() => openNativeStorage(options)).pipe(Effect.uninterruptible),
      (storage) => nativeIO(() => storage.close()).pipe(Effect.orDie),
    );
    return {
      ...storage,
      transaction: Effect.fn("NativeBuildState.transaction")(
        <A>(operation: Parameters<typeof storage.transaction<A>>[0]) =>
          nativeIO(() => storage.transaction(operation)).pipe(
            Effect.uninterruptible,
          ),
      ),
      addGeneration: Effect.fn("NativeBuildState.addGeneration")(
        (...args: Parameters<typeof storage.addGeneration>) =>
          nativeIO(() => storage.addGeneration(...args)).pipe(
            Effect.uninterruptible,
          ),
      ),
      prune: Effect.fn("NativeBuildState.prune")(
        (...args: Parameters<typeof storage.prune>) =>
          nativeIO(() => storage.prune(...args)).pipe(Effect.uninterruptible),
      ),
      reserve: Effect.fn("NativeBuildState.reserve")(function* (
        ...args: Parameters<typeof storage.reserve>
      ) {
        const reservation = yield* Effect.acquireRelease(
          nativeIO(() => storage.reserve(...args)).pipe(Effect.uninterruptible),
          (reservation) =>
            nativeIO(() => reservation.release()).pipe(Effect.orDie),
        );
        return {
          ...reservation,
          commit: Effect.fn("NativeBuildState.commit")((path?: string) =>
            nativeIO(() => reservation.commit(path)).pipe(
              Effect.uninterruptible,
            ),
          ),
          release: Effect.fn("NativeBuildState.release")(() =>
            nativeIO(() => reservation.release()).pipe(Effect.uninterruptible),
          ),
        };
      }),
      remove: Effect.fn("NativeBuildState.remove")((path: string) =>
        nativeIO(() => storage.remove(path)).pipe(Effect.uninterruptible),
      ),
      close: Effect.fn("NativeBuildState.close")(() =>
        nativeIO(() => storage.close()).pipe(Effect.uninterruptible),
      ),
    };
  },
);
export type NativeBuildState = Effect.Success<
  ReturnType<typeof openNativeBuildState>
>;
export class NativeBuildStateService extends Context.Service<NativeBuildStateService>()(
  "NativeBuildState",
  {
    make: Effect.gen(function* () {
      yield* NativeBuildFiles;
      return yield* openNativeBuildState(yield* NativeStateConfig);
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(NativeBuildFiles.layer),
  );
}
