import { Effect, Schema } from "effect";
import {
  BuilderRegistryError,
  decodeBuilderJson,
} from "./builder-registry-json.js";

export { BuilderRegistryError } from "./builder-registry-json.js";

const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/u));
// Explicit IDs only. SDK item round-trip qualification belongs to slice 6.
const ItemId = Schema.String.check(Schema.isPattern(/^[a-z0-9]{26}$/u));
const Positive = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const BuilderSecretSource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("file"),
    name: Schema.String.check(
      Schema.isPattern(/^[a-z][a-z0-9-]{0,62}\.json$/u),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("onepassword"),
    vaultId: ItemId,
    itemId: ItemId,
  }),
]);
const Entry = Schema.Struct({
  id: Name,
  enabled: Schema.Boolean,
  secretRevision: Schema.optionalKey(Positive),
  secretSource: BuilderSecretSource,
  minimumFreeBytes: Schema.optionalKey(
    Positive.check(Schema.isLessThanOrEqualTo(1_125_899_906_842_624)),
  ),
});
const Registry = Schema.Struct({
  version: Schema.Literal(1),
  defaultBuilder: Schema.NullOr(Name),
  selection: Schema.Struct({
    fallback: Schema.Literals(["none", "before-submission"]),
    fallbackBuilders: Schema.Array(Name),
  }),
  builders: Schema.Array(Entry).check(Schema.isMaxLength(64)),
});
export type BuilderSource = typeof BuilderSecretSource.Type;
export interface BuilderEntry
  extends Omit<typeof Entry.Type, "secretRevision" | "minimumFreeBytes"> {
  readonly secretRevision: number;
  readonly minimumFreeBytes: number;
}
export interface BuilderRegistrySnapshot
  extends Omit<typeof Registry.Type, "builders"> {
  readonly builders: readonly BuilderEntry[];
}
export const sourceReference = (source: BuilderSource) =>
  source.type === "file"
    ? `file:${source.name}`
    : `onepassword:${source.vaultId}:${source.itemId}`;
export const credentialRevision = (entry: BuilderEntry) =>
  `${sourceReference(entry.secretSource)}:${entry.secretRevision}`;

export const parseBuilderRegistry = Effect.fn("BuilderRegistry.parse")(
  function* (
    bytes: Uint8Array,
    settings: {
      readonly vaultId?: string | undefined;
      readonly tokenFile?: string | undefined;
    } = {},
  ) {
    const input = yield* decodeBuilderJson(bytes);
    if (typeof input === "object" && input !== null && !("selection" in input))
      return yield* Effect.fail(
        BuilderRegistryError.new("default-not-configured"),
      );
    const decoded = yield* Schema.decodeUnknownEffect(Registry)(input, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError((cause) =>
        BuilderRegistryError.new("registry-schema-invalid", cause),
      ),
    );
    const ids = new Set<string>(),
      sources = new Set<string>();
    for (const entry of decoded.builders) {
      const source = sourceReference(entry.secretSource);
      if (ids.has(entry.id) || sources.has(source))
        return yield* Effect.fail(
          BuilderRegistryError.new("registry-duplicate-entry"),
        );
      ids.add(entry.id);
      sources.add(source);
      if (
        entry.secretSource.type === "onepassword" &&
        (entry.secretSource.vaultId !== settings.vaultId || !settings.tokenFile)
      )
        return yield* Effect.fail(
          BuilderRegistryError.new("registry-vault-not-configured"),
        );
    }
    const { defaultBuilder, selection } = decoded;
    if (
      (defaultBuilder !== null && !ids.has(defaultBuilder)) ||
      (defaultBuilder === null && selection.fallback !== "none") ||
      (selection.fallback === "none" &&
        selection.fallbackBuilders.length !== 0) ||
      new Set(selection.fallbackBuilders).size !==
        selection.fallbackBuilders.length ||
      selection.fallbackBuilders.some(
        (id) => id === defaultBuilder || !ids.has(id),
      )
    )
      return yield* Effect.fail(
        BuilderRegistryError.new("default-not-configured"),
      );
    return {
      ...decoded,
      builders: decoded.builders.map((entry) => ({
        ...entry,
        secretRevision: entry.secretRevision ?? 1,
        minimumFreeBytes: entry.minimumFreeBytes ?? 53_687_091_200,
      })),
    } satisfies BuilderRegistrySnapshot;
  },
);

/** Stable semantic order, including source property order. Builder order is not selection order. */
export const registrySemanticKey = (snapshot: BuilderRegistrySnapshot) =>
  JSON.stringify([
    snapshot.defaultBuilder,
    snapshot.selection.fallback,
    snapshot.selection.fallbackBuilders,
    [...snapshot.builders]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry) => [
        entry.id,
        entry.enabled,
        credentialRevision(entry),
        entry.minimumFreeBytes,
      ]),
  ]);
