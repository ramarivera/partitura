/** Child process fixture: crash during a real import after writing a partial. */
import { open, readFile } from "node:fs/promises";
import { Effect } from "effect";
import {
  importLegacyNativeSlot,
  type LegacyNativeImport,
} from "../../deploy/mac-build/native-build-import.js";
import { nativeIO } from "../../src/services/native-build-errors.js";
import {
  type NativeStateOptions,
  openNativeBuildState,
} from "../../src/services/native-build-state.js";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("missing-fixture-input");
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const value = JSON.parse(
        yield* nativeIO(() => readFile(inputPath, "utf8")),
      ) as {
        state: NativeStateOptions;
        input: Omit<LegacyNativeImport, "resolveOwner">;
      };
      const state = yield* openNativeBuildState({
        ...value.state,
        filesystem: async () => ({
          type: 0x01021994,
          bavail: 1e9,
          bsize: 4096,
        }),
      });
      yield* importLegacyNativeSlot(
        state,
        { materialize: () => Effect.void },
        {
          ...value.input,
          resolveOwner: async (session) =>
            Object.values(value.input.originalOwners).find(
              (owner) => owner.sessionId === session,
            ),
        },
        {
          copy: (path, source) =>
            nativeIO(async () => {
              const file = await open(path, "wx", 0o600);
              for await (const chunk of source) {
                await file.writeFile(chunk.subarray(0, 3));
                await file.sync();
                break;
              }
              process.kill(process.pid, "SIGKILL");
              await new Promise<never>(() => {});
            }),
        },
      );
    }),
  ),
);
