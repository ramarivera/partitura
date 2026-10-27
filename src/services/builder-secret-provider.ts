import { Context, Effect, Layer, Schema } from "effect";
import { BuilderRegistryFiles } from "./builder-registry-files.js";
import {
  BuilderRegistryError,
  decodeBuilderJson,
} from "./builder-registry-json.js";
import {
  type BuilderEntry,
  sourceReference,
} from "./builder-registry-schema.js";
import { BuilderRegistryConfig } from "./config-native-build.js";
import {
  type NativeTransportMetadata,
  TransportMetadata,
} from "./native-build-models.js";
import { validateNativeTransport } from "./native-build-protocol.js";

const FileRecord = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  hostId: TransportMetadata.fields.hostId,
  hostname: TransportMetadata.fields.hostname,
  sshUser: TransportMetadata.fields.sshUser,
  port: Schema.Number,
  privateKeyB64: Schema.String,
  retiringPrivateKeyB64: Schema.String,
  hostKeys: TransportMetadata.fields.hostKeys,
});
export interface BuilderCredential {
  readonly transport: NativeTransportMetadata;
  readonly privateKey: string;
  readonly retiringPrivateKey?: string;
}
export const normalizeBuilderFileRecord = Effect.fn(
  "BuilderSecretProvider.normalizeFile",
)(function* (bytes: Uint8Array, source: string, suffix: string) {
  const input = yield* decodeBuilderJson(bytes, 65_536);
  const record = yield* Schema.decodeUnknownEffect(FileRecord)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) =>
      BuilderRegistryError.new("builder-record-invalid", cause),
    ),
  );
  return yield* Effect.try({
    try: (): BuilderCredential => {
      const key = (encoded: string) => {
        const bytes = Buffer.from(encoded, "base64");
        if (
          !encoded.length ||
          bytes.length > 32_768 ||
          bytes.toString("base64") !== encoded
        )
          throw BuilderRegistryError.new("builder-key-invalid");
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      };
      const privateKey = key(record.privateKeyB64);
      const retiringPrivateKey =
        record.retiringPrivateKeyB64 === ""
          ? undefined
          : key(record.retiringPrivateKeyB64);
      const transport = {
        source,
        hostId: record.hostId,
        hostname: record.hostname,
        sshUser: record.sshUser,
        port: record.port,
        hostKeys: record.hostKeys,
      };
      validateNativeTransport(transport, privateKey, suffix);
      if (retiringPrivateKey !== undefined)
        validateNativeTransport(transport, retiringPrivateKey, suffix);
      return {
        transport,
        privateKey,
        ...(retiringPrivateKey === undefined ? {} : { retiringPrivateKey }),
      };
    },
    catch: (cause) => BuilderRegistryError.new("builder-record-invalid", cause),
  });
});

export class BuilderSecretProvider extends Context.Service<BuilderSecretProvider>()(
  "BuilderSecretProvider",
  {
    make: Effect.gen(function* () {
      const settings = yield* BuilderRegistryConfig;
      const files = yield* BuilderRegistryFiles;
      return {
        resolve: Effect.fn("BuilderSecretProvider.resolve")(
          (entry: BuilderEntry) =>
            Effect.scoped(
              Effect.gen(function* () {
                if (entry.secretSource.type !== "file")
                  return yield* Effect.fail(
                    BuilderRegistryError.new("builder-provider-unavailable"),
                  );
                if (!settings.fileSecretRoot)
                  return yield* Effect.fail(
                    BuilderRegistryError.new("builder-file-provider-disabled"),
                  );
                const directory = yield* files.directory(
                  settings.fileSecretRoot,
                );
                const bytes = yield* directory.read(
                  entry.secretSource.name,
                  0o400,
                  65_536,
                );
                return yield* normalizeBuilderFileRecord(
                  bytes,
                  sourceReference(entry.secretSource),
                  settings.suffix,
                );
              }),
            ),
        ),
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(BuilderRegistryFiles.layer),
  );
}
