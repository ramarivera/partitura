import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { decodeBuilderJson } from "../src/services/builder-registry-json.js";
import {
  parseBuilderRegistry,
  registrySemanticKey,
} from "../src/services/builder-registry-schema.js";
import { bytes, document, entry } from "./fixtures/builder-registry.js";

for (const input of [
  '{"id":1,"\\u0069d":2}',
  '{"a":{"x":1,"x":2}}',
  '[{"a":0,"\\u0061":1}]',
])
  it.effect(`rejects decoded duplicate keys in ${input}`, () =>
    Effect.gen(function* () {
      expect(
        (yield* decodeBuilderJson(Buffer.from(input)).pipe(Effect.flip)).code,
      ).toBe("registry-duplicate-key");
    }),
  );

it.effect(
  "bounds raw bytes, nesting and UTF-8 without accepting invalid JSON tokens",
  () =>
    Effect.gen(function* () {
      expect(
        (yield* decodeBuilderJson(Buffer.alloc(262_145, 32)).pipe(Effect.flip))
          .code,
      ).toBe("registry-too-large");
      expect(
        (yield* decodeBuilderJson(
          Buffer.from(`${"[".repeat(17)}0${"]".repeat(17)}`),
        ).pipe(Effect.flip)).code,
      ).toBe("registry-too-deep");
      expect(
        yield* decodeBuilderJson(
          Buffer.from(`${"[".repeat(16)}0${"]".repeat(16)}`),
        ),
      ).toBeDefined();
      for (const invalid of [
        '{"a":1,}',
        "[01]",
        "true false",
        '"\\q"',
        '"\n"',
        "[1e]",
        "[.2]",
        "[+1]",
        '{"a":}',
        "",
        "[",
        "{",
        '"unterminated',
      ])
        expect(
          (yield* Effect.exit(decodeBuilderJson(Buffer.from(invalid))))._tag,
        ).toBe("Failure");
      expect(
        (yield* Effect.exit(decodeBuilderJson(Uint8Array.of(0xff))))._tag,
      ).toBe("Failure");
      expect(
        yield* decodeBuilderJson(
          Buffer.from('{"a\\"b":[true,false,null,-1.2e+3,"x\\\\y"]}'),
        ),
      ).toEqual({ 'a"b': [true, false, null, -1200, "x\\y"] });
    }),
);

it.effect(
  "normalizes defaults and ignores property/builder order semantically",
  () =>
    Effect.gen(function* () {
      const base = document([entry(), entry("backup")]);
      const parsed = yield* parseBuilderRegistry(
        bytes({
          ...base,
          builders: [
            {
              id: "primary",
              enabled: true,
              secretSource: { name: "primary.json", type: "file" },
            },
            entry("backup"),
          ],
        }),
      );
      expect(parsed.builders[0]?.secretRevision).toBe(1);
      expect(parsed.builders[0]?.minimumFreeBytes).toBe(53_687_091_200);
      expect(registrySemanticKey(parsed)).toBe(
        registrySemanticKey({
          ...base,
          builders: [...base.builders].reverse(),
        }),
      );
    }),
);

const invalidSnapshots: readonly unknown[] = [
  { ...document(), extra: true },
  { ...document(), version: 2 },
  { ...document(), selection: undefined },
  { ...document(), builders: [{ ...entry(), unknown: 1 }] },
  document([entry(), entry()]),
  document([
    entry(),
    { ...entry("backup"), secretSource: entry().secretSource },
  ]),
  document([{ ...entry(), secretRevision: 0 }]),
  document([{ ...entry(), secretRevision: Number.MAX_SAFE_INTEGER + 1 }]),
  document([{ ...entry(), minimumFreeBytes: 1_125_899_906_842_625 }]),
  document([{ ...entry(), id: "Upper" }]),
  document([
    {
      ...entry(),
      enabled: false,
      secretSource: { type: "file", name: "../key.json" },
    },
  ]),
  {
    ...document(),
    builders: [
      {
        ...entry(),
        secretSource: { type: "file", name: "key.json", path: "/secret" },
      },
    ],
  },
  { ...document(), defaultBuilder: "missing" },
  {
    ...document(),
    defaultBuilder: null,
    selection: { fallback: "before-submission", fallbackBuilders: [] },
  },
  {
    ...document(),
    selection: { fallback: "none", fallbackBuilders: ["primary"] },
  },
  {
    ...document([entry(), entry("backup")]),
    selection: {
      fallback: "before-submission",
      fallbackBuilders: ["backup", "backup"],
    },
  },
  {
    ...document(),
    selection: { fallback: "before-submission", fallbackBuilders: ["missing"] },
  },
  document(Array.from({ length: 65 }, (_, i) => entry(`builder-${i}`))),
];
for (const [index, snapshot] of invalidSnapshots.entries())
  it.effect(`rejects invalid closed schema/selection ${index}`, () =>
    Effect.gen(function* () {
      expect(
        (yield* Effect.exit(parseBuilderRegistry(bytes(snapshot))))._tag,
      ).toBe("Failure");
    }),
  );

it.effect(
  "accepts empty and disabled defaults, and only explicitly pinned 1Password IDs",
  () =>
    Effect.gen(function* () {
      expect(
        (yield* parseBuilderRegistry(bytes(document([])))).defaultBuilder,
      ).toBeNull();
      expect(
        (yield* parseBuilderRegistry(
          bytes(document([entry("primary", false)])),
        )).builders[0]?.enabled,
      ).toBe(false);
      const source = {
        type: "onepassword",
        vaultId: "a".repeat(26),
        itemId: "b".repeat(26),
      };
      const input = bytes(
        document([
          {
            ...entry(),
            secretSource: source as {
              type: "onepassword";
              vaultId: string;
              itemId: string;
            },
          },
        ]),
      );
      expect((yield* parseBuilderRegistry(input).pipe(Effect.flip)).code).toBe(
        "registry-vault-not-configured",
      );
      expect(
        (yield* parseBuilderRegistry(input, {
          vaultId: source.vaultId,
          tokenFile: "/run/token",
        })).builders,
      ).toHaveLength(1);
      expect(
        (yield* Effect.exit(
          parseBuilderRegistry(input, {
            vaultId: "c".repeat(26),
            tokenFile: "/run/token",
          }),
        ))._tag,
      ).toBe("Failure");
    }),
);
