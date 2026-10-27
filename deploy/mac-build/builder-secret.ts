import { Effect, Schema } from "effect";
import { decodeBuilderJson } from "../../src/services/builder-registry-json.js";
import {
  BuilderFileRecord,
  normalizeBuilderFileRecord,
} from "../../src/services/builder-secret-record.js";
import {
  nativeFile,
  opaqueId,
} from "../../src/services/native-build-file-io.js";
import {
  NativeSecretHelperConfig,
  NativeSecretPipe,
} from "../../src/services/native-build-secret-helper.js";
import {
  NativeSecretError,
  type SecretResponse,
} from "../../src/services/native-build-secret-protocol.js";

/** Operator-only. No runtime gateway identity, agent registration or write retry. */
export const runBuilderSecret = Effect.fn("BuilderSecret.run")(
  function* (input: {
    action: "create" | "update" | "validate";
    vaultId: string;
    itemId?: string;
    inputFile?: string;
    tokenFile?: string;
    desktopAccount?: string;
    suffix: string;
  }) {
    if (
      !/^[a-z0-9]{26}$/u.test(input.vaultId) ||
      (input.action !== "create" &&
        !/^[a-z0-9]{26}$/u.test(input.itemId ?? "")) ||
      Boolean(input.tokenFile) === Boolean(input.desktopAccount)
    )
      return yield* Effect.fail(
        NativeSecretError.new("provider-operation-invalid"),
      );
    const record =
      input.action === "validate"
        ? undefined
        : yield* Effect.gen(function* () {
            if (!input.inputFile)
              return yield* Effect.fail(
                NativeSecretError.new("provider-operation-invalid"),
              );
            const bytes = yield* Effect.tryPromise({
              try: () =>
                nativeFile(input.inputFile ?? "", [0o400, 0o600], 65536),
              catch: () => NativeSecretError.new("builder-record-invalid"),
            });
            const value = yield* Schema.decodeUnknownEffect(BuilderFileRecord)(
              yield* decodeBuilderJson(bytes, 65536).pipe(
                Effect.mapError(() =>
                  NativeSecretError.new("builder-record-invalid"),
                ),
              ),
              { onExcessProperty: "error" },
            ).pipe(
              Effect.mapError(() =>
                NativeSecretError.new("builder-record-invalid"),
              ),
            );
            yield* normalizeBuilderFileRecord(
              bytes,
              "operator-input",
              input.suffix,
            ).pipe(
              Effect.mapError(() =>
                NativeSecretError.new("builder-record-invalid"),
              ),
            );

            return value;
          });
    const pipe = yield* NativeSecretPipe;
    return yield* pipe.session((request) =>
      Effect.gen(function* () {
        const auth = input.tokenFile
          ? {
              type: "token" as const,
              token: (yield* Effect.tryPromise({
                try: () => nativeFile(input.tokenFile ?? "", 0o400, 16384),
                catch: () => NativeSecretError.new("provider-auth-failed"),
              }))
                .toString()
                .trim(),
            }
          : { type: "desktop" as const, account: input.desktopAccount ?? "" };
        yield* request({
          id: opaqueId(),
          kind: "init",
          access: "operator",
          auth,
          vaultId: input.vaultId,
          suffix: input.suffix,
        });
        let response: SecretResponse;
        if (input.action === "validate")
          response = yield* request({
            id: opaqueId(),
            kind: "validate",
            itemId: input.itemId ?? "",
          });
        else {
          if (!record)
            return yield* Effect.fail(
              NativeSecretError.new("builder-record-invalid"),
            );
          response = yield* request(
            input.action === "create"
              ? { id: opaqueId(), kind: "create", record }
              : {
                  id: opaqueId(),
                  kind: "update",
                  itemId: input.itemId ?? "",
                  record,
                },
          );
        }
        if (response.kind !== "written")
          return yield* Effect.fail(
            NativeSecretError.new("provider-protocol-invalid"),
          );
        return {
          success: true,
          itemId: response.itemId,
          ...(input.action === "update"
            ? {
                next: "Use the admin Refresh button or bump this builder's secretRevision. No refresh was invoked.",
              }
            : {}),
        };
      }),
    );
  },
);

if (import.meta.main) {
  const main = Effect.scoped(
    Effect.gen(function* () {
      const [action, ...args] = process.argv.slice(2);
      const allowed = new Set([
        "--vault-id",
        "--item-id",
        "--input-file",
        "--token-file",
        "--desktop-account",
        "--suffix",
        "--qualification-approved",
      ]);
      const values = new Map<string, string>();
      for (let index = 0; index < args.length; index++) {
        const key = args[index];
        if (!key || !allowed.has(key) || values.has(key))
          return yield* Effect.fail(
            NativeSecretError.new("provider-operation-invalid"),
          );
        if (key === "--qualification-approved") values.set(key, "true");
        else {
          const value = args[++index];
          if (!value || value.startsWith("--"))
            return yield* Effect.fail(
              NativeSecretError.new("provider-operation-invalid"),
            );
          values.set(key, value);
        }
      }
      if (action !== "create" && action !== "update" && action !== "validate")
        return yield* Effect.fail(
          NativeSecretError.new("provider-operation-invalid"),
        );
      const result = yield* runBuilderSecret({
        action,
        vaultId: values.get("--vault-id") ?? "",
        suffix: values.get("--suffix") ?? "xalda-procyon.ts.net",
        ...(values.has("--item-id")
          ? { itemId: values.get("--item-id") ?? "" }
          : {}),
        ...(values.has("--input-file")
          ? { inputFile: values.get("--input-file") ?? "" }
          : {}),
        ...(values.has("--token-file")
          ? { tokenFile: values.get("--token-file") ?? "" }
          : {}),
        ...(values.has("--desktop-account")
          ? { desktopAccount: values.get("--desktop-account") ?? "" }
          : {}),
      }).pipe(
        Effect.provide(NativeSecretPipe.layer),
        Effect.provideService(NativeSecretHelperConfig, {
          node: "/opt/partitura/bin/node",
          entrypoint: "/app/dist/native-build-secret-helper.js",
          cwd: "/app",
          vaultId: values.get("--vault-id") ?? "",
          suffix: values.get("--suffix") ?? "xalda-procyon.ts.net",
          qualified: values.has("--qualification-approved"),
        }),
      );
      console.log(JSON.stringify(result));
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        console.error(error.code);
        process.exitCode = 1;
      }),
    ),
  );
  Effect.runPromise(main).catch(() => {
    console.error("provider-unavailable");
    process.exitCode = 1;
  });
}
