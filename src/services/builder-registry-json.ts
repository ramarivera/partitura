import { Effect, Schema } from "effect";

/** Causes are private. Only the fixed code is suitable for an admin projection. */
export class BuilderRegistryError extends Schema.TaggedError<BuilderRegistryError>()(
  "@Gateway/BuilderRegistryError",
  { code: Schema.String, cause: Schema.optionalKey(Schema.Unknown) },
) {
  static new(code: string, cause?: unknown) {
    return new BuilderRegistryError({
      code,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

/** Scan JSON tokens before parsing, retaining decoded keys for every object.
 * JSON.parse alone (including a reviver) has already discarded duplicates. */
export const decodeBuilderJson = Effect.fn("BuilderRegistry.decodeJson")(
  (bytes: Uint8Array, maximum = 262_144) =>
    Effect.try({
      try: (): unknown => {
        if (bytes.byteLength > maximum)
          throw BuilderRegistryError.new("registry-too-large");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        let offset = 0;
        const whitespace = () => {
          while (/^[\t\n\r ]$/u.test(text[offset] ?? "")) offset++;
        };
        const fail = (code = "registry-json-invalid"): never => {
          throw BuilderRegistryError.new(code);
        };
        const string = (): string => {
          const start = offset++;
          while (offset < text.length) {
            const character = text[offset++];
            if (character === '"')
              return JSON.parse(text.slice(start, offset)) as string;
            if (character === "\\") offset++;
          }
          return fail();
        };
        const value = (depth: number): void => {
          whitespace();
          const character = text[offset];
          if (character === "{" || character === "[") {
            if (depth >= 16) fail("registry-too-deep");
            offset++;
            const object = character === "{",
              end = object ? "}" : "]";
            const keys = new Set<string>();
            whitespace();
            if (text[offset] === end) {
              offset++;
              return;
            }
            for (;;) {
              whitespace();
              if (object) {
                if (text[offset] !== '"') fail();
                const key = string();
                if (keys.has(key)) fail("registry-duplicate-key");
                keys.add(key);
                whitespace();
                if (text[offset++] !== ":") fail();
              }
              value(depth + 1);
              whitespace();
              if (text[offset] === end) {
                offset++;
                return;
              }
              if (text[offset++] !== ",") fail();
            }
          }
          if (character === '"') {
            string();
            return;
          }
          const token =
            /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
              text.slice(offset),
            );
          if (!token) fail();
          offset += token?.[0].length ?? 0;
        };
        value(0);
        whitespace();
        if (offset !== text.length) fail();
        return JSON.parse(text) as unknown;
      },
      catch: (cause) =>
        cause instanceof BuilderRegistryError
          ? cause
          : BuilderRegistryError.new("registry-json-invalid", cause),
    }),
);
