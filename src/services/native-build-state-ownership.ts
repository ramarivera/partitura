import { Context, Effect, Layer } from "effect";
import { nativeIO } from "./native-build-errors.js";
import { lockNativeState, nativeDirectory } from "./native-build-file-io.js";
import type { NativeStateOptions } from "./native-build-models.js";

export class NativeStateConfig extends Context.Service<
  NativeStateConfig,
  NativeStateOptions
>()("NativeStateConfig") {}
/** Shared by engine metadata and provider journal; one kernel owner, one scope. */
export class NativeStateOwnership extends Context.Service<NativeStateOwnership>()(
  "NativeStateOwnership",
  {
    make: Effect.gen(function* () {
      const { stateRoot } = yield* NativeStateConfig;
      yield* nativeIO(async () => {
        try {
          await nativeDirectory(stateRoot, true);
        } catch (cause) {
          if (
            !(
              cause instanceof Error &&
              "code" in cause &&
              cause.code === "EEXIST"
            )
          )
            throw cause;
          await nativeDirectory(stateRoot);
        }
      });
      yield* Effect.acquireRelease(
        nativeIO(() => lockNativeState(stateRoot)),
        (release) => nativeIO(release).pipe(Effect.orDie),
      );
      return { stateRoot };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
