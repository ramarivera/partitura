import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const runner = fileURLToPath(
  new URL("../deploy/mac-build/guest-run.sh", import.meta.url),
);

it.live(
  "runs a repository-owned action through its isolated Mise environment",
  () =>
    Effect.sync(() => {
      const root = path("generic-guest");
      const repository = path("generic-guest/repository");
      const mise = join(path("generic-guest/bin"), "mise");
      writeFileSync(
        mise,
        '#!/bin/bash\n[ "$1" = exec ] && [ "$2" = -- ] || exit 64\nshift 2\n[ "$MISE_TRUSTED_CONFIG_PATHS" = "$PWD" ] || exit 65\nexec "$@"\n',
      );
      chmodSync(mise, 0o700);
      const environment = {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        HOME: root,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      };
      const git = (...args: string[]) => {
        const result = spawnSync("/usr/bin/git", ["-C", repository, ...args], {
          env: environment,
          encoding: "utf8",
        });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout.trim();
      };
      git("init", "--quiet");
      const script = path(
        "generic-guest/repository/.partitura/native-build.sh",
      );
      writeFileSync(
        script,
        'set -euo pipefail\n[ "$1" = check ] || exit 2\nprintf "%s\\n" "$PARTITURA_COMMIT" > "$PARTITURA_ARTIFACT_DIR/commit.txt"\n',
      );
      git("add", ".partitura/native-build.sh");
      git("commit", "--quiet", "-m", "generic task");
      writeFileSync(join(repository, "another.txt"), "second commit");
      git("add", "another.txt");
      git("commit", "--quiet", "-m", "second commit");
      const commit = git("rev-parse", "HEAD");
      const bundle = join(root, "source.bundle");
      git("bundle", "create", bundle, "HEAD");
      const execute = (action: string) => {
        const destination = join(root, action);
        const result = spawnSync(
          "/bin/bash",
          [
            "-euc",
            'source "$1"; run_repository_workflow "$2" "$3" "$4" 12 "$5"',
            "native-guest-test",
            runner,
            destination,
            "a".repeat(32),
            commit,
            action,
          ],
          { env: environment, input: readFileSync(bundle) },
        );
        return { result, destination };
      };
      const { result, destination } = execute("check");
      expect(result.status, result.stderr.toString()).toBe(0);
      expect(
        readFileSync(join(destination, "artifacts/commit.txt"), "utf8"),
      ).toBe(`${commit}\n`);
      expect(
        JSON.parse(
          readFileSync(join(destination, "artifacts/result.json"), "utf8"),
        ),
      ).toMatchObject({ commit, action: "check", taskExit: 0 });
      const imported = spawnSync(
        "/usr/bin/git",
        ["-C", join(destination, "source"), "rev-parse", "HEAD"],
        { env: environment, encoding: "utf8" },
      );
      expect(imported.stdout.trim()).toBe(commit);
      expect(execute("unsupported").result.status).toBe(2);
    }),
);
