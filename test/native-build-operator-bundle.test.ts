import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.live("the shipped importer bundle starts only its own CLI", () =>
  Effect.promise(async () => {
    const root = path("bundle");
    const built = await Bun.build({
      entrypoints: ["deploy/mac-build/native-build-import-operator.ts"],
      target: "bun",
      outdir: root,
      naming: "importer.js",
    });
    expect(built.success).toBe(true);
    const result = spawnSync(
      process.execPath,
      ["--config=/dev/null", "--no-env-file", join(root, "importer.js")],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "native-import-refused; check stopped gateway, protected config, durable owners, roots and pins\n",
    );
  }),
);

it.live(
  "the shipped admin bundle dispatches a budget command exactly once",
  () =>
    Effect.promise(async () => {
      const root = path("budget-bundle");
      const built = await Bun.build({
        entrypoints: ["deploy/mac-build/native-build-admin.ts"],
        target: "bun",
        outdir: root,
        naming: "admin.js",
      });
      expect(built.success).toBe(true);
      const result = spawnSync(
        process.execPath,
        [
          "--config=/dev/null",
          "--no-env-file",
          join(root, "admin.js"),
          "budget-invalid",
        ],
        {
          cwd: "/",
          env: { PATH: "/usr/bin:/bin" },
          encoding: "utf8",
          timeout: 5000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("provider-operation-invalid\n");
    }),
);
