import { it } from "@effect/vitest";
import * as fc from "fast-check";
import { describe, expect } from "vitest";
import { redactStringValues } from "../src/services/linear-helpers.js";
import {
  projectionBackoff,
  rpcEventActivityType,
} from "../src/services/projector.js";

describe("ActivityProjector", () => {
  describe("pure invariants", () => {
    it("redaction never leaks bearer token values", () =>
      fc.assert(
        fc.property(
          fc.record({
            token: fc.string({
              unit: fc.constantFrom(
                "A",
                "B",
                "C",
                "1",
                "2",
                "-",
                "_",
                ".",
                "~",
                "+",
                "/",
                "=",
              ),
              minLength: 1,
            }),
          }),
          ({ token }) => {
            const redacted = redactStringValues({
              body: `Authorization: Bearer ${token}`,
            }) as { body: string };
            expect(redacted.body).toContain("Bearer redacted");
            expect(redacted.body).not.toContain(`Bearer ${token}`);
          },
        ),
      ));

    it("redaction never leaks key-value token values", () =>
      fc.assert(
        fc.property(
          fc.record({
            kind: fc.constantFrom(
              "token",
              "key",
              "secret",
              "signature",
              "password",
            ),
            value: fc
              .string({ minLength: 1 })
              .filter((s) => !/[,"'\s}\]]/.test(s)),
          }),
          ({ kind, value }) => {
            const redacted = redactStringValues({
              body: `${kind}=${value}`,
            }) as {
              body: string;
            };
            expect(redacted.body).toBe(`${kind}=redacted`);
          },
        ),
      ));
    it("redaction never leaks query token values", () =>
      fc.assert(
        fc.property(
          fc.record({
            kind: fc.constantFrom(
              "token",
              "key",
              "secret",
              "signature",
              "password",
            ),
            value: fc
              .string({ minLength: 1 })
              .filter((s) => !/[&#\s"'<]/.test(s)),
          }),
          ({ kind, value }) => {
            const redacted = redactStringValues({
              body: `?${kind}=${value}`,
            }) as {
              body: string;
            };
            expect(redacted.body).toBe(`?${kind}=redacted`);
          },
        ),
      ));
    it("projection backoff is monotone non-decreasing and capped", () =>
      fc.assert(
        fc.property(
          fc.record({ attempts: fc.integer({ min: 1, max: 100 }) }),
          ({ attempts }) => {
            const base = 1_000;
            const max = 5 * 60_000;
            const values: number[] = [];
            for (let i = 1; i <= attempts; i++) {
              values.push(projectionBackoff(i, base, max));
            }
            for (let i = 1; i < values.length; i++) {
              const value = values[i];
              const previous = values[i - 1];
              if (value !== undefined && previous !== undefined) {
                expect(value).toBeGreaterThanOrEqual(previous);
              }
            }
            for (const v of values) {
              expect(v).toBeLessThanOrEqual(max);
            }
          },
        ),
      ));

    it("rpc event activity mapping is total over known kinds", () =>
      fc.assert(
        fc.property(
          fc.record({
            kind: fc.constantFrom(
              "agent_start",
              "turn_start",
              "tool_execution_start",
              "tool_execution_end",
              "message_end",
              "agent_end",
              "error",
              "extension_ui_request",
            ),
          }),
          ({ kind }) => {
            const result = rpcEventActivityType({ type: kind });
            expect([
              "thought",
              "action",
              "response",
              "error",
              "none",
            ]).toContain(result);
            if (kind === "agent_start" || kind === "turn_start")
              expect(result).toBe("thought");
            if (
              kind === "tool_execution_start" ||
              kind === "tool_execution_end"
            )
              expect(result).toBe("action");
            if (kind === "agent_end") expect(result).toBe("response");
            if (kind === "error") expect(result).toBe("error");
            if (kind === "message_end" || kind === "extension_ui_request")
              expect(result).toBe("none");
          },
        ),
      ));

    it("rpc event activity mapping returns none for unknown kinds", () =>
      fc.assert(
        fc.property(fc.record({ kind: fc.string() }), ({ kind }) => {
          const known = new Set([
            "agent_start",
            "turn_start",
            "tool_execution_start",
            "tool_execution_end",
            "message_end",
            "agent_end",
            "error",
            "extension_ui_request",
          ]);
          if (known.has(kind)) return;
          expect(rpcEventActivityType({ type: kind })).toBe("none");
        }),
      ));
  });
});
