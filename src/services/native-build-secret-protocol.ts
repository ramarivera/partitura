import { Schema } from "effect";
import { BuilderFileRecord } from "./builder-secret-record.js";

export const providerCodes = [
  "provider-rate-limited",
  "provider-auth-failed",
  "provider-auth-mode-error",
  "provider-timeout",
  "provider-unavailable",
  "provider-protocol-invalid",
  "provider-live-disabled",
  "field-id-missing",
  "builder-record-invalid",
  "provider-readback-mismatch",
] as const;
export type ProviderCode = (typeof providerCodes)[number];
export class NativeSecretError extends Schema.TaggedError<NativeSecretError>()(
  "@Gateway/NativeSecretError",
  {
    code: Schema.String,
    nextFit: Schema.optionalKey(Schema.Number),
  },
) {
  // Never attach SDK/IPC causes, which can contain token or item bytes.
  static new(code: string, nextFit?: number) {
    return new NativeSecretError({
      code,
      ...(nextFit === undefined ? {} : { nextFit }),
    });
  }
}
const Id = Schema.String.check(Schema.isPattern(/^[a-z0-9]{26}$/u));
export const FrameId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
export const SecretRequest = Schema.Union([
  Schema.Struct({
    id: FrameId,
    kind: Schema.Literal("init"),
    access: Schema.Literals(["runtime", "operator"]),
    auth: Schema.Union([
      Schema.Struct({ type: Schema.Literal("token"), token: Schema.String }),
      Schema.Struct({
        type: Schema.Literal("desktop"),
        account: Schema.String,
      }),
    ]),
    vaultId: Id,
    suffix: Schema.String,
  }),
  Schema.Struct({ id: FrameId, kind: Schema.Literal("read"), itemId: Id }),
  Schema.Struct({
    id: FrameId,
    kind: Schema.Literal("create"),
    record: BuilderFileRecord,
  }),
  Schema.Struct({
    id: FrameId,
    kind: Schema.Literal("update"),
    itemId: Id,
    record: BuilderFileRecord,
  }),
  Schema.Struct({ id: FrameId, kind: Schema.Literal("validate"), itemId: Id }),
]);
export type SecretRequest = typeof SecretRequest.Type;
export const SecretResponse = Schema.Union([
  Schema.Struct({ id: FrameId, kind: Schema.Literal("ready") }),
  Schema.Struct({
    id: FrameId,
    kind: Schema.Literal("record"),
    record: BuilderFileRecord,
  }),
  Schema.Struct({ id: FrameId, kind: Schema.Literal("written"), itemId: Id }),
  Schema.Struct({
    id: FrameId,
    kind: Schema.Literal("error"),
    code: Schema.Literals(providerCodes),
  }),
]);
export type SecretResponse = typeof SecretResponse.Type;
export const secretFrameLimit = 131072;
export function secretFrame(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value));
  if (!payload.length || payload.length > secretFrameLimit)
    throw NativeSecretError.new("provider-protocol-invalid");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}
/** Bounds buffering before any untrusted length can allocate an item-sized buffer. */
export class SecretFrames {
  private buffer = Buffer.alloc(0);
  push(chunk: Uint8Array): unknown[] {
    if (this.buffer.length + chunk.length > secretFrameLimit + 4)
      throw NativeSecretError.new("provider-protocol-invalid");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE();
      if (!size || size > secretFrameLimit)
        throw NativeSecretError.new("provider-protocol-invalid");
      if (this.buffer.length < size + 4) break;
      frames.push(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            this.buffer.subarray(4, 4 + size),
          ),
        ) as unknown,
      );
      this.buffer = this.buffer.subarray(4 + size);
    }
    return frames;
  }
}
