import type { Item, ItemCreateParams, ItemField } from "@1password/sdk";
import { Effect, Schema } from "effect";
import { decodeBuilderJson } from "./builder-registry-json.js";
import {
  BuilderFileRecord,
  normalizeBuilderFileRecord,
} from "./builder-secret-record.js";
import { NativeSecretError } from "./native-build-secret-protocol.js";

export const secretFields = [
  "schemaVersion",
  "hostId",
  "hostname",
  "sshUser",
  "port",
  "privateKeyB64",
  "retiringPrivateKeyB64",
  "hostKeys",
] as const;
const Field = Schema.Struct({
  id: Schema.String,
  sectionId: Schema.optionalKey(Schema.String),
  fieldType: Schema.String,
  value: Schema.String,
});
const ItemShape = Schema.Struct({
  id: Schema.String,
  vaultId: Schema.String,
  category: Schema.Literal("SecureNote"),
  sections: Schema.Array(Schema.Struct({ id: Schema.String })),
  fields: Schema.Array(Field),
});
export const normalizeBuilderItem = Effect.fn("NativeSecretItem.decode")(
  function* (input: unknown, vaultId: string, itemId: string, suffix: string) {
    const item = yield* Schema.decodeUnknownEffect(ItemShape)(input).pipe(
      Effect.mapError(() => NativeSecretError.new("builder-record-invalid")),
    );
    if (
      item.id !== itemId ||
      item.vaultId !== vaultId ||
      item.sections.filter((section) => section.id === "partitura").length !== 1
    )
      return yield* Effect.fail(
        NativeSecretError.new("builder-record-invalid"),
      );
    const values: Record<string, string> = {};
    for (const id of secretFields) {
      const matches = item.fields.filter((field) => field.id === id);
      if (!matches.length)
        return yield* Effect.fail(NativeSecretError.new("field-id-missing"));
      const field = matches[0];
      if (
        matches.length !== 1 ||
        !field ||
        field.sectionId !== "partitura" ||
        field.fieldType !== (id.endsWith("KeyB64") ? "Concealed" : "Text")
      )
        return yield* Effect.fail(
          NativeSecretError.new("builder-record-invalid"),
        );
      values[id] = field.value;
    }
    if (
      values.schemaVersion !== "1" ||
      !/^[1-9][0-9]{0,4}$/u.test(values.port ?? "")
    )
      return yield* Effect.fail(
        NativeSecretError.new("builder-record-invalid"),
      );
    const hostKeys = yield* decodeBuilderJson(
      Buffer.from(values.hostKeys ?? ""),
      16384,
    ).pipe(
      Effect.mapError(() => NativeSecretError.new("builder-record-invalid")),
    );
    const record = yield* Schema.decodeUnknownEffect(BuilderFileRecord)({
      ...values,
      schemaVersion: 1,
      port: Number(values.port),
      hostKeys,
    }).pipe(
      Effect.mapError(() => NativeSecretError.new("builder-record-invalid")),
    );
    yield* normalizeBuilderFileRecord(
      Buffer.from(JSON.stringify(record)),
      `onepassword:${vaultId}:${itemId}`,
      suffix,
    ).pipe(
      Effect.mapError(() => NativeSecretError.new("builder-record-invalid")),
    );
    return record;
  },
);
export function builderItemFields(
  record: typeof BuilderFileRecord.Type,
): ItemField[] {
  return secretFields.map((id) => ({
    id,
    title: id,
    sectionId: "partitura",
    fieldType: (id.endsWith("KeyB64")
      ? "Concealed"
      : "Text") as ItemField["fieldType"],
    value:
      id === "hostKeys" ? JSON.stringify(record.hostKeys) : String(record[id]),
  }));
}
export function createBuilderItem(
  vaultId: string,
  record: typeof BuilderFileRecord.Type,
): ItemCreateParams {
  return {
    vaultId,
    title: "Partitura builder",
    category: "SecureNote" as Item["category"],
    sections: [{ id: "partitura", title: "Partitura" }],
    fields: builderItemFields(record),
  };
}
export function updateBuilderItem(
  item: Item,
  record: typeof BuilderFileRecord.Type,
): Item {
  // Preserve SDK version/concurrency metadata and unrelated presentation fields.
  return {
    ...item,
    fields: [
      ...item.fields.filter(
        (field) => !secretFields.some((id) => id === field.id),
      ),
      ...builderItemFields(record),
    ],
  };
}
