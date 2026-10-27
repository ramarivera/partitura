import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "@effect/vitest";

// Biome's style/noExcessiveLinesPerFile enforces the same 800-line cap, but it
// doesn't count lines inside a template literal, so a file holding one large
// HTML or CSS string passes it. This guard counts raw lines.
const MAX_LINES = 800;
const ROOT = join(import.meta.dirname, "..");
const DIRECTORIES = ["src", "test", "deploy"];
const EXTENSIONS = /\.(?:[cm]?[jt]sx?|css)$/;

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(path);
    }
    return entry.isFile() && EXTENSIONS.test(entry.name) ? [path] : [];
  });

const lineCount = (path: string): number => {
  const text = readFileSync(path, "utf8");
  if (text.length === 0) return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
};

describe("file size limit", () => {
  it(`keeps every source and test file at or under ${MAX_LINES} lines`, () => {
    const oversized = DIRECTORIES.flatMap((directory) =>
      sourceFiles(join(ROOT, directory)),
    )
      .map((path) => ({ path: relative(ROOT, path), lines: lineCount(path) }))
      .filter(({ lines }) => lines > MAX_LINES)
      .map(({ path, lines }) => `${path}: ${lines}`);
    expect(oversized).toEqual([]);
  });
});
