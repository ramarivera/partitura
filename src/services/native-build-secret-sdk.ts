import type { Client } from "@1password/sdk";
import { Context, Effect, Layer } from "effect";
import {
  createBuilderItem,
  normalizeBuilderItem,
  secretFields,
  updateBuilderItem,
} from "./native-build-secret-item.js";
import {
  NativeSecretError,
  type ProviderCode,
  type SecretRequest,
  type SecretResponse,
} from "./native-build-secret-protocol.js";

type Vendor = Pick<
  typeof import("@1password/sdk"),
  | "createClient"
  | "DesktopAuth"
  | "RateLimitExceededError"
  | "AuthExpiredError"
  | "DesktopSessionExpiredError"
>;
/** This service is only provided by the Node entrypoint, never the Bun gateway. */
export class NativeSecretVendor extends Context.Service<
  NativeSecretVendor,
  Vendor
>()("NativeSecretVendor") {}
export class NativeSecretSdk extends Context.Service<NativeSecretSdk>()(
  "NativeSecretSdk",
  {
    make: Effect.gen(function* () {
      const vendor = yield* NativeSecretVendor;
      let client: Client | undefined;
      let vaultId = "",
        suffix = "",
        operator = false;
      const sdk = <A>(call: () => Promise<A>) =>
        Effect.tryPromise({
          try: call,
          catch: (cause) => {
            const code: ProviderCode =
              cause instanceof vendor.RateLimitExceededError
                ? "provider-rate-limited"
                : cause instanceof vendor.AuthExpiredError
                  ? "provider-auth-failed"
                  : cause instanceof vendor.DesktopSessionExpiredError
                    ? "provider-auth-mode-error"
                    : "provider-unavailable";
            return NativeSecretError.new(code);
          },
        });
      return {
        handle: Effect.fn("NativeSecretSdk.handle")(function* (
          request: SecretRequest,
        ): Effect.fn.Return<SecretResponse, NativeSecretError> {
          if (request.kind === "init") {
            if (
              client ||
              (request.access === "runtime" && request.auth.type !== "token")
            )
              return yield* Effect.fail(
                NativeSecretError.new("provider-auth-mode-error"),
              );
            client = yield* sdk(() =>
              vendor.createClient({
                integrationName: "Partitura",
                integrationVersion: "0.1.0",
                auth:
                  request.auth.type === "token"
                    ? request.auth.token
                    : new vendor.DesktopAuth(request.auth.account),
              }),
            );
            vaultId = request.vaultId;
            suffix = request.suffix;
            operator = request.access === "operator";
            return { id: request.id, kind: "ready" };
          }
          if (!client)
            return yield* Effect.fail(
              NativeSecretError.new("provider-auth-failed"),
            );
          const active = client;
          const get = (id: string) => sdk(() => active.items.get(vaultId, id));
          if (request.kind === "read" || request.kind === "validate") {
            if (request.kind === "validate" && !operator)
              return yield* Effect.fail(
                NativeSecretError.new("provider-auth-mode-error"),
              );
            const record = yield* normalizeBuilderItem(
              yield* get(request.itemId),
              vaultId,
              request.itemId,
              suffix,
            );
            return request.kind === "read"
              ? { id: request.id, kind: "record", record }
              : { id: request.id, kind: "written", itemId: request.itemId };
          }
          if (!operator)
            return yield* Effect.fail(
              NativeSecretError.new("provider-auth-mode-error"),
            );
          // Validate before writes as well as after. No blind retry of create/put.
          const draft = createBuilderItem(vaultId, request.record);
          yield* normalizeBuilderItem(
            { ...draft, id: "a".repeat(26) },
            vaultId,
            "a".repeat(26),
            suffix,
          );
          let id: string;
          if (request.kind === "create") {
            id = (yield* sdk(() => active.items.create(draft))).id;
          } else {
            const previous = yield* get(request.itemId);
            yield* normalizeBuilderItem(
              previous,
              vaultId,
              request.itemId,
              suffix,
            );
            yield* sdk(() =>
              active.items.put(updateBuilderItem(previous, request.record)),
            );
            id = request.itemId;
          }
          const readback = yield* normalizeBuilderItem(
            yield* get(id),
            vaultId,
            id,
            suffix,
          );
          if (
            !secretFields.every((field) =>
              field === "hostKeys"
                ? JSON.stringify(
                    readback.hostKeys.map((key) => [key.type, key.base64]),
                  ) ===
                  JSON.stringify(
                    request.record.hostKeys.map((key) => [
                      key.type,
                      key.base64,
                    ]),
                  )
                : readback[field] === request.record[field],
            )
          )
            return yield* Effect.fail(
              NativeSecretError.new("provider-readback-mismatch"),
            );
          return { id: request.id, kind: "written", itemId: id };
        }),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
