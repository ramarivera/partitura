import { createHash } from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import { ADMIN_BODY, ADMIN_SCRIPT } from "../src/admin-ui/dashboard.js";
import { PAGE_STYLES } from "../src/admin-ui/styles.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

describe("admin UI composition", () => {
  it("preserves the original body, script, and stylesheet bytes", () => {
    expect(hash(ADMIN_BODY)).toBe(
      "90030bc3b401076ad36ee7ab0f42e5180814cf97b7c5b27816b7e0b61577ec4b",
    );
    expect(hash(ADMIN_SCRIPT)).toBe(
      "96201fd4423a836eb1a9aee5bd6617c57d34d267f9cd11ec707e2d12eaf5160b",
    );
    expect(hash(PAGE_STYLES)).toBe(
      "8acd0c0f24d44c2ba196c73e56ed6b7976e166b28390a826decb6ab52ff5ae1d",
    );
  });
});
