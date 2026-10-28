import { Effect, Schema } from "effect";
import { NativeSecretHttp } from "./services/native-build-secret-http.js";
import {
  NativeSecretError,
  providerCodes,
  SecretFrames,
  SecretRequest,
  secretFrame,
} from "./services/native-build-secret-protocol.js";
import {
  NativeSecretSdk,
  NativeSecretVendor,
} from "./services/native-build-secret-sdk.js";

// SDK diagnostics must never share the private IPC descriptor or stderr.
console.log =
  console.info =
  console.warn =
  console.error =
  console.debug =
    () => {};
const main = Effect.scoped(
  Effect.gen(function* () {
    const http = yield* NativeSecretHttp;
    const vendor = yield* Effect.promise(() => import("@1password/sdk"));
    const service = yield* NativeSecretSdk.make.pipe(
      Effect.provideService(NativeSecretVendor, vendor),
    );
    const frames = new SecretFrames();
    const inputStream = process.stdin[Symbol.asyncIterator]();
    for (;;) {
      const next = yield* Effect.tryPromise({
        try: () => inputStream.next(),
        catch: () => NativeSecretError.new("provider-unavailable"),
      });
      if (next.done) break;
      for (const input of frames.push(next.value)) {
        const request = yield* Schema.decodeUnknownEffect(SecretRequest)(
          input,
          { onExcessProperty: "error" },
        ).pipe(
          Effect.mapError(() =>
            NativeSecretError.new("provider-protocol-invalid"),
          ),
        );
        const response = yield* http
          .run(
            request.kind === "init"
              ? 8
              : request.kind === "read" || request.kind === "validate"
                ? 4
                : 12,
            () => Effect.runPromise(service.handle(request)),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.succeed({
                id: request.id,
                kind: "error" as const,
                code:
                  providerCodes.find((code) => code === error.code) ??
                  "provider-unavailable",
              }),
            ),
          );
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              process.stdout.write(secretFrame(response), (error) =>
                error
                  ? reject(NativeSecretError.new("provider-unavailable"))
                  : resolve(),
              );
            }),
        );
      }
    }
  }).pipe(Effect.provide(NativeSecretHttp.layer)),
);
// The process boundary only emits fixed IPC failures. No exception serializers.
Effect.runPromise(main).catch(() => {
  process.exitCode = 1;
  process.stdin.destroy();
});
