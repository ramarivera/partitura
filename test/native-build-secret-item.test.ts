import type { Client, Item } from "@1password/sdk";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  createBuilderItem,
  normalizeBuilderItem,
} from "../src/services/native-build-secret-item.js";
import { NativeSecretError } from "../src/services/native-build-secret-protocol.js";
import {
  NativeSecretSdk,
  NativeSecretVendor,
} from "../src/services/native-build-secret-sdk.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
class RateLimit extends Error {}
class AuthExpired extends Error {}
class DesktopExpired extends Error {}
const errors = {
  RateLimitExceededError: RateLimit,
  AuthExpiredError: AuthExpired,
  DesktopSessionExpiredError: DesktopExpired,
  DesktopAuth: class {
    constructor(readonly accountName: string) {}
  },
};
const item = (f: Effect.Success<ReturnType<typeof secretFixture>>): Item => ({
  category: "SecureNote" as Item["category"],
  title: "Presentation only",
  vaultId: f.settings.vaultId,
  id: "b".repeat(26),
  fields: createBuilderItem(f.settings.vaultId, f.record).fields ?? [],
  sections: [{ id: "partitura", title: "Presentation only" }],
  notes: "",
  tags: [],
  websites: [],
  files: [],
  version: 7,
  createdAt: new Date(0),
  updatedAt: new Date(1),
});

it.effect(
  "fixed IDs/types decode exact current/retiring key bytes, preserving final newlines",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("roundtrip"));
        const withRetiring = {
          ...f.record,
          retiringPrivateKeyB64: f.record.privateKeyB64,
        };
        const draft = {
          ...createBuilderItem(f.settings.vaultId, withRetiring),
          id: "b".repeat(26),
          ignoredPresentation: "not-a-field",
        };
        const decoded = yield* normalizeBuilderItem(
          draft,
          f.settings.vaultId,
          "b".repeat(26),
          "example.test",
        );
        expect(Buffer.from(decoded.privateKeyB64, "base64").toString()).toBe(
          f.native.key,
        );
        expect(
          Buffer.from(decoded.retiringPrivateKeyB64, "base64").toString(),
        ).toBe(f.native.key);
        expect(f.native.key.endsWith("\n")).toBe(true);
      }),
    ),
);

for (const bad of [
  "generated-id",
  "missing",
  "duplicate",
  "section",
  "type",
  "category",
  "hostKeys",
  "port",
  "retiring",
] as const)
  it.effect(
    `item adapter refuses ${bad} without serializing field values`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* secretFixture(path(bad));
          const value = item(f);
          const field = value.fields.find(
            (field) => field.id === "privateKeyB64",
          );
          if (!field) return yield* Effect.die("fixture field missing");
          if (bad === "generated-id") {
            field.id = "ui-generated";
            field.title = "privateKeyB64";
          }
          if (bad === "missing")
            value.fields = value.fields.filter(
              (field) => field.id !== "privateKeyB64",
            );
          if (bad === "duplicate") value.fields.push({ ...field });
          if (bad === "section") field.sectionId = "wrong";
          if (bad === "type")
            field.fieldType = "Text" as typeof field.fieldType;
          if (bad === "category")
            value.category = "Login" as typeof value.category;
          if (bad === "hostKeys") {
            const keys = value.fields.find((field) => field.id === "hostKeys");
            if (keys) keys.value = '"DUMMY-KEY-SENTINEL"';
          }
          if (bad === "port") {
            const port = value.fields.find((field) => field.id === "port");
            if (port) port.value = "022";
          }
          if (bad === "retiring") {
            const retiring = value.fields.find(
              (field) => field.id === "retiringPrivateKeyB64",
            );
            if (retiring)
              retiring.value =
                Buffer.from("DUMMY-KEY-SENTINEL").toString("base64");
          }
          const error = yield* normalizeBuilderItem(
            value,
            f.settings.vaultId,
            "b".repeat(26),
            "example.test",
          ).pipe(Effect.flip);
          expect(error.code).toBe(
            bad === "generated-id" || bad === "missing"
              ? "field-id-missing"
              : "builder-record-invalid",
          );
          expect(JSON.stringify(error)).not.toContain("DUMMY-KEY-SENTINEL");
          expect(JSON.stringify(error)).not.toContain(f.record.privateKeyB64);
        }),
      ),
  );

it.effect(
  "operator update preserves version metadata, puts once and compares readback",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("update"));
        let saved = item(f),
          puts = 0,
          gets = 0;
        const client = {
          items: {
            get: async () => {
              gets++;
              return saved;
            },
            put: async (value: Item) => {
              puts++;
              expect(value.version).toBe(7);
              saved = { ...value, version: 8 };
              return saved;
            },
          },
        } as unknown as Client;
        const handler = yield* NativeSecretSdk.make.pipe(
          Effect.provideService(NativeSecretVendor, {
            ...errors,
            createClient: async () => client,
          }),
        );
        yield* handler.handle({
          id: "1".repeat(32),
          kind: "init",
          access: "operator",
          auth: { type: "desktop", account: "dummy" },
          vaultId: f.settings.vaultId,
          suffix: "example.test",
        });
        const response = yield* handler.handle({
          id: "2".repeat(32),
          kind: "update",
          itemId: saved.id,
          record: {
            ...f.record,
            retiringPrivateKeyB64: f.record.privateKeyB64,
          },
        });
        expect(response.kind).toBe("written");
        expect(puts).toBe(1);
        expect(gets).toBe(2);
        expect(
          saved.fields.find((field) => field.id === "retiringPrivateKeyB64")
            ?.value,
        ).toBe(f.record.privateKeyB64);
      }),
    ),
);

for (const [failure, code] of [
  [new RateLimit("DUMMY-SECRET"), "provider-rate-limited"],
  [new AuthExpired("DUMMY-SECRET"), "provider-auth-failed"],
  [new DesktopExpired("DUMMY-SECRET"), "provider-auth-mode-error"],
  [new Error("DUMMY-SECRET"), "provider-unavailable"],
] as const)
  it.effect(`SDK maps ${code} by error type without retaining messages`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path(code));
        const handler = yield* NativeSecretSdk.make.pipe(
          Effect.provideService(NativeSecretVendor, {
            ...errors,
            createClient: async () => {
              throw failure;
            },
          }),
        );
        const error = yield* handler
          .handle({
            id: "1".repeat(32),
            kind: "init",
            access: "runtime",
            auth: { type: "token", token: "DUMMY-TOKEN" },
            vaultId: f.settings.vaultId,
            suffix: "example.test",
          })
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(NativeSecretError);
        expect(error.code).toBe(code);
        expect(JSON.stringify(error)).not.toContain("DUMMY");
      }),
    ),
  );

it.effect(
  "readback mismatch fails once without retrying a successful write",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("mismatch"));
        let saved = item(f),
          writes = 0;
        const client = {
          items: {
            get: async () => saved,
            put: async () => {
              writes++;
              saved = item(f);
              return saved;
            },
          },
        } as unknown as Client;
        const handler = yield* NativeSecretSdk.make.pipe(
          Effect.provideService(NativeSecretVendor, {
            ...errors,
            createClient: async () => client,
          }),
        );
        yield* handler.handle({
          id: "1".repeat(32),
          kind: "init",
          access: "operator",
          auth: { type: "token", token: "DUMMY-PROVISIONING-TOKEN" },
          vaultId: f.settings.vaultId,
          suffix: "example.test",
        });
        const failure = yield* handler
          .handle({
            id: "2".repeat(32),
            kind: "update",
            itemId: saved.id,
            record: {
              ...f.record,
              retiringPrivateKeyB64: f.record.privateKeyB64,
            },
          })
          .pipe(Effect.flip);
        expect(failure.code).toBe("provider-readback-mismatch");
        expect(writes).toBe(1);
      }),
    ),
);

it.effect(
  "create uses the fixed item contract and reads back exact key bytes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("create"));
        let creates = 0,
          gets = 0;
        const saved = item(f);
        const client = {
          items: {
            create: async (draft: unknown) => {
              creates++;
              expect(draft).toEqual(
                createBuilderItem(f.settings.vaultId, f.record),
              );
              return saved;
            },
            get: async () => {
              gets++;
              return saved;
            },
          },
        } as unknown as Client;
        const handler = yield* NativeSecretSdk.make.pipe(
          Effect.provideService(NativeSecretVendor, {
            ...errors,
            createClient: async () => client,
          }),
        );
        yield* handler.handle({
          id: "1".repeat(32),
          kind: "init",
          access: "operator",
          auth: { type: "desktop", account: "dummy" },
          vaultId: f.settings.vaultId,
          suffix: "example.test",
        });
        expect(
          yield* handler.handle({
            id: "2".repeat(32),
            kind: "create",
            record: f.record,
          }),
        ).toEqual({ id: "2".repeat(32), kind: "written", itemId: saved.id });
        expect(creates).toBe(1);
        expect(gets).toBe(1);
      }),
    ),
);

it.effect(
  "runtime identity refuses writes and desktop mode without provider contact",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("runtime"));
        let initializations = 0;
        const handler = yield* NativeSecretSdk.make.pipe(
          Effect.provideService(NativeSecretVendor, {
            ...errors,
            createClient: async () => {
              initializations++;
              return {} as Client;
            },
          }),
        );
        expect(
          (yield* handler
            .handle({
              id: "1".repeat(32),
              kind: "init",
              access: "runtime",
              auth: { type: "desktop", account: "dummy" },
              vaultId: f.settings.vaultId,
              suffix: "example.test",
            })
            .pipe(Effect.flip)).code,
        ).toBe("provider-auth-mode-error");
        expect(initializations).toBe(0);
        yield* handler.handle({
          id: "2".repeat(32),
          kind: "init",
          access: "runtime",
          auth: { type: "token", token: "DUMMY" },
          vaultId: f.settings.vaultId,
          suffix: "example.test",
        });
        expect(
          (yield* handler
            .handle({ id: "3".repeat(32), kind: "create", record: f.record })
            .pipe(Effect.flip)).code,
        ).toBe("provider-auth-mode-error");
        expect(
          (yield* handler
            .handle({
              id: "4".repeat(32),
              kind: "validate",
              itemId: "b".repeat(26),
            })
            .pipe(Effect.flip)).code,
        ).toBe("provider-auth-mode-error");
        expect(initializations).toBe(1);
      }),
    ),
);
