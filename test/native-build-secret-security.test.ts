import { chmod, symlink, writeFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect, Logger } from "effect";
import { runBuilderSecret } from "../deploy/mac-build/builder-secret.js";
import { registryIO } from "../src/services/builder-registry-files.js";
import {
  NativeSecretHelperConfig,
  NativeSecretPipe,
} from "../src/services/native-build-secret-helper.js";
import { NativeSecretError } from "../src/services/native-build-secret-protocol.js";
import { workerEnvironment } from "../src/services/worker-security.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.effect(
  "provider attention logs, worker environment and journal contain no token or key sentinel",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("redaction"));
        const messages: unknown[] = [];
        const logger = Logger.make((event) => {
          messages.push(event.message);
        });
        const cache = yield* f.openCache({
          read: (_source, reserve) =>
            reserve(12).pipe(
              Effect.andThen(
                Effect.fail(NativeSecretError.new("provider-unavailable")),
              ),
            ),
        });
        yield* cache.accept("startup", [f.source()], "");
        yield* cache.tick().pipe(Effect.provide(Logger.layer([logger])));
        const worker = workerEnvironment({
          PATH: "/usr/bin",
          NATIVE_BUILD_OP_TOKEN: "DUMMY-TOKEN-SENTINEL",
          NATIVE_BUILD_OP_TOKEN_FILE: f.settings.tokenFile,
          OP_SERVICE_ACCOUNT_TOKEN: "DUMMY-TOKEN-SENTINEL",
          BUILDER_PRIVATE_KEY: f.native.key,
        });
        expect(worker).toEqual({ PATH: "/usr/bin" });
        const output = JSON.stringify({
          messages,
          worker,
          state: f.journal.snapshot(),
        });
        expect(messages).toHaveLength(1);
        expect(output).not.toContain("DUMMY-TOKEN-SENTINEL");
        expect(output).not.toContain(f.record.privateKeyB64);
        expect(output).not.toContain(f.native.key);
      }),
    ),
);

for (const invalid of ["mode", "symlink", "json", "missing-file"] as const)
  it.effect(
    `operator tool refuses ${invalid} input before helper initialization`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* secretFixture(path(invalid));
          const file = `${f.root}/input.json`;
          yield* registryIO(() =>
            writeFile(
              file,
              invalid === "json"
                ? "DUMMY-SECRET-SENTINEL"
                : JSON.stringify(f.record),
              { mode: 0o600 },
            ),
          );
          if (invalid === "mode") yield* registryIO(() => chmod(file, 0o644));
          if (invalid === "symlink")
            yield* registryIO(() => symlink(file, `${file}.link`));
          const error = yield* runBuilderSecret({
            action: "update",
            vaultId: f.settings.vaultId,
            itemId: "b".repeat(26),
            inputFile:
              invalid === "symlink"
                ? `${file}.link`
                : invalid === "missing-file"
                  ? `${file}.missing`
                  : file,
            tokenFile: "/must-not-read-token",
            suffix: f.settings.suffix,
          }).pipe(
            Effect.provide(NativeSecretPipe.layer),
            Effect.provideService(NativeSecretHelperConfig, {
              node: "/must-not-spawn",
              entrypoint: "/must-not-load",
              cwd: f.root,
              vaultId: f.settings.vaultId,
              suffix: f.settings.suffix,
              qualified: false,
            }),
            Effect.flip,
          );
          expect(error.code).toBe("builder-record-invalid");
          expect(JSON.stringify(error)).not.toContain("SENTINEL");
        }),
      ),
  );
