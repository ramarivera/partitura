import { dirname, join } from "node:path";
import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { decodeBuilderJson } from "./builder-registry-json.js";
import {
  BuilderRegistryConfig,
  nativePathsOverlap,
} from "./config-native-build.js";
import { nativeFile, writeNativeFile } from "./native-build-file-io.js";
import {
  pruneSecretJournal,
  SecretJournalData,
} from "./native-build-secret-models.js";
import { NativeSecretError } from "./native-build-secret-protocol.js";
import { NativeStateOwnership } from "./native-build-state-ownership.js";

export const journalFile = (root: string) =>
  join(root, "provider-journal.json");
export const markerFile = (root: string) =>
  join(dirname(root), "native-build-provider.initialized");
const io = <A>(action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: () => NativeSecretError.new("journal-repair-required"),
  });
export class NativeSecretJournal extends Context.Service<NativeSecretJournal>()(
  "NativeSecretJournal",
  {
    make: Effect.gen(function* () {
      const settings = yield* BuilderRegistryConfig;
      const owner = yield* NativeStateOwnership;
      if (
        settings.stateRoot !== owner.stateRoot ||
        nativePathsOverlap(settings.stateRoot, markerFile(settings.stateRoot))
      )
        return yield* Effect.fail(
          NativeSecretError.new("journal-repair-required"),
        );
      const marker = yield* io(() =>
        nativeFile(markerFile(settings.stateRoot), 0o600, 1024),
      );
      if (marker.toString() !== "partitura-native-provider-v1\n")
        return yield* Effect.fail(
          NativeSecretError.new("journal-repair-required"),
        );
      const bytes = yield* io(() =>
        nativeFile(journalFile(settings.stateRoot), 0o600, 16 * 1024 ** 2),
      );
      const input = yield* decodeBuilderJson(bytes, 16 * 1024 ** 2).pipe(
        Effect.mapError(() => NativeSecretError.new("journal-repair-required")),
      );
      let data = yield* Effect.try({
        try: () =>
          structuredClone(
            Schema.decodeUnknownSync(SecretJournalData)(input, {
              onExcessProperty: "error",
            }),
          ) as SecretJournalData,
        catch: () => NativeSecretError.new("journal-repair-required"),
      });
      const gate = yield* Semaphore.make(1);
      return {
        snapshot: () => structuredClone(data),
        transaction: Effect.fn("NativeSecretJournal.transaction")(
          <A>(
            operation: (draft: SecretJournalData, at: number) => A,
            now = Date.now(),
          ) =>
            gate
              .withPermit(
                Effect.gen(function* () {
                  const draft = structuredClone(data);
                  const value = yield* Effect.try({
                    try: () => operation(draft, pruneSecretJournal(draft, now)),
                    catch: (cause) =>
                      cause instanceof NativeSecretError
                        ? cause
                        : NativeSecretError.new("journal-repair-required"),
                  });
                  const serialized = yield* Effect.try({
                    try: () => {
                      Schema.decodeUnknownSync(SecretJournalData)(draft, {
                        onExcessProperty: "error",
                      });
                      if (
                        Object.keys(draft.successes).length > 320 ||
                        Object.keys(draft.startupStops).length > 320 ||
                        Object.keys(draft.cooldowns).length > 320
                      )
                        throw NativeSecretError.new("provider-queue-full");
                      const text = JSON.stringify(draft);
                      if (Buffer.byteLength(text) > 16 * 1024 ** 2)
                        throw NativeSecretError.new("provider-queue-full");
                      return text;
                    },
                    catch: () => NativeSecretError.new("provider-queue-full"),
                  });
                  yield* io(() =>
                    writeNativeFile(
                      journalFile(settings.stateRoot),
                      serialized,
                      0o600,
                      true,
                    ),
                  );
                  data = draft;
                  return value;
                }),
              )
              .pipe(Effect.uninterruptible),
        ),
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(NativeStateOwnership.layer),
  );
}
