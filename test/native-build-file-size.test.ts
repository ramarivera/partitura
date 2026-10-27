import { readFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { nativeIO } from "../src/services/native-build-errors.js";

// Slice 4's complete source/test/fixture set. Raw counts include template bodies.
const files = [
  "deploy/mac-build/native-build-import.ts",
  "src/services/native-build-artifact-io.ts",
  "src/services/native-build-artifact.ts",
  "src/services/native-build-bundle.ts",
  "src/services/native-build-errors.ts",
  "src/services/native-build-file-io.ts",
  "src/services/native-build-files.ts",
  "src/services/native-build-models.ts",
  "src/services/native-build-process.ts",
  "src/services/native-build-protocol.ts",
  "src/services/native-build-receipt.ts",
  "src/services/native-build-recovery.ts",
  "src/services/native-build-registry-client.ts",
  "src/services/native-build-state.ts",
  "src/services/native-build-storage.ts",
  "src/services/native-build-transport.ts",
  "test/fixtures/native-build-broker.ts",
  "test/fixtures/native-build-effects.ts",
  "test/fixtures/native-build-import-crash.ts",
  "test/fixtures/native-build-import.ts",
  "test/fixtures/native-build-registry.ts",
  "test/native-build-engine-resilience.test.ts",
  "test/native-build-file-size.test.ts",
  "test/native-build-import-resilience.test.ts",
  "test/native-build-recovery-resilience.test.ts",
  "test/native-build-recovery.test.ts",
  "test/native-build-state.test.ts",
  "test/native-build-transport-resilience.test.ts",
];
it.live("all slice 4 files stay within 800 raw lines", () =>
  Effect.gen(function* () {
    for (const path of files) {
      const content = yield* nativeIO(() => readFile(path, "utf8"));
      const lines = content.split("\n").length - Number(content.endsWith("\n"));
      expect(lines, path).toBeLessThanOrEqual(800);
    }
  }),
);
