import { Effect, Schema } from "effect";
import {
  BuilderRegistryError,
  decodeBuilderJson,
} from "./builder-registry-json.js";
import {
  type NativeTransportMetadata,
  TransportMetadata,
} from "./native-build-models.js";
import { validateNativeTransport } from "./native-build-protocol.js";

export const BuilderFileRecord = Schema.Struct({
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
  const record = yield* Schema.decodeUnknownEffect(BuilderFileRecord)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) =>
      BuilderRegistryError.new("builder-record-invalid", cause),
    ),
  );
  return yield* normalizeBuilderRecord(record, source, suffix);
});

/** Validate an already schema-decoded record without serializing and decoding it again. */
export const normalizeBuilderRecord = Effect.fn(
  "BuilderSecretProvider.normalizeRecord",
)(function* (
  record: typeof BuilderFileRecord.Type,
  source: string,
  suffix: string,
) {
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
