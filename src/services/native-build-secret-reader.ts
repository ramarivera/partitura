import { Context, Effect, Layer, Schema } from "effect";
import { BuilderRegistryFiles } from "./builder-registry-files.js";
import { decodeBuilderJson } from "./builder-registry-json.js";
import { BuilderFileRecord } from "./builder-secret-record.js";
import { BuilderRegistryConfig } from "./config-native-build.js";
import { NativeBuildSecretHelper } from "./native-build-secret-helper.js";
import { NativeSecretError } from "./native-build-secret-protocol.js";

/** Reads one whole source, only when the operation scheduler authorizes dispatch. */
export class NativeSecretSourceReader extends Context.Service<NativeSecretSourceReader>()(
  "NativeSecretSourceReader",
  {
    make: Effect.gen(function* () {
      const settings = yield* BuilderRegistryConfig;
      const files = yield* BuilderRegistryFiles;
      const helper = yield* NativeBuildSecretHelper;
      return {
        read: Effect.fn("NativeSecretSourceReader.read")(
          <E, R>(
            source: string,
            reserve: (units: number) => Effect.Effect<void, E, R>,
            onReadStart: () => Effect.Effect<void, E, R> = () => Effect.void,
          ) =>
            Effect.gen(function* () {
              const remote =
                /^onepassword:([a-z0-9]{26}):([a-z0-9]{26})$/u.exec(source);
              if (remote) {
                const [, vault, item] = remote;
                if (!item || vault !== settings.vaultId)
                  return yield* Effect.fail(
                    NativeSecretError.new("builder-record-invalid"),
                  );
                return yield* helper.read(item, reserve, onReadStart);
              }
              const local = /^file:([a-z][a-z0-9-]{0,62}\.json)$/u.exec(
                source,
              )?.[1];
              if (!local || !settings.fileSecretRoot)
                return yield* Effect.fail(
                  NativeSecretError.new("builder-record-invalid"),
                );
              return yield* Effect.scoped(
                Effect.gen(function* () {
                  const directory = yield* files.directory(
                    settings.fileSecretRoot ?? "",
                  );
                  const input = yield* decodeBuilderJson(
                    yield* directory.read(local, 0o400, 65536),
                    65536,
                  );
                  return yield* Schema.decodeUnknownEffect(BuilderFileRecord)(
                    input,
                    { onExcessProperty: "error" },
                  );
                }),
              ).pipe(
                Effect.mapError(() =>
                  NativeSecretError.new("builder-record-invalid"),
                ),
              );
            }),
        ),
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(BuilderRegistryFiles.layer, NativeBuildSecretHelper.layer),
    ),
  );
}
