import { chmod, open, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";
import {
  BuilderRegistryFiles,
  registryIO,
} from "../src/services/builder-registry-files.js";
import { builderFilesFixture } from "./fixtures/builder-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
for (const change of ["mode", "owner"] as const)
  it.live(`pinned directory rechecks ${change} after open`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path(change));
        const files = yield* BuilderRegistryFiles.make;
        const root = fixture.settings.fileSecretRoot ?? "";
        yield* registryIO(() =>
          writeFile(join(root, "primary.json"), "{}", { mode: 0o400 }),
        );
        const directory = yield* files.directory(root);
        if (change === "mode") {
          yield* registryIO(() => chmod(root, 0o750));
          expect(
            (yield* directory
              .read("primary.json", 0o400, 65536)
              .pipe(Effect.flip)).code,
          ).toBe("registry-directory-insecure");
        } else {
          // Inject a changed descriptor owner without requiring chown privileges.
          const probe = yield* Effect.acquireRelease(
            registryIO(() => open(root, "r")),
            (handle) => registryIO(() => handle.close()).pipe(Effect.orDie),
          );
          const prototype: typeof probe = Object.getPrototypeOf(probe);
          const original = prototype.stat;
          const spy = vi
            .spyOn(prototype, "stat")
            .mockImplementation(async function (
              this: typeof probe,
              ...args: Parameters<typeof original>
            ) {
              const info = await original.apply(this, args);
              if (info.isDirectory()) info.uid = Number(info.uid) + 1;
              return info;
            });
          yield* Effect.gen(function* () {
            expect(
              (yield* directory
                .read("primary.json", 0o400, 65536)
                .pipe(Effect.flip)).code,
            ).toBe("registry-directory-insecure");
          }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
        }
      }),
    ),
  );

it.live(
  "descriptor read detects a same-size in-place rewrite between file checks",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path("rewrite"));
        const root = fixture.settings.fileSecretRoot ?? "";
        const name = join(root, "primary.json");
        yield* registryIO(() => writeFile(name, "original", { mode: 0o400 }));
        const files = yield* BuilderRegistryFiles.make;
        const directory = yield* files.directory(root);
        const probe = yield* Effect.acquireRelease(
          registryIO(() => open(name, "r")),
          (handle) => registryIO(() => handle.close()).pipe(Effect.orDie),
        );
        const prototype: typeof probe = Object.getPrototypeOf(probe);
        const original = prototype.read;
        const spy = vi
          .spyOn(prototype, "read")
          .mockImplementation(async function (
            this: typeof probe,
            ...args: Parameters<typeof original>
          ) {
            const read = await original.apply(this, args);
            await chmod(name, 0o600);
            await writeFile(name, "replaced");
            await chmod(name, 0o400);
            // Deterministic even on filesystems with coarse timestamp resolution.
            await utimes(name, new Date(100000), new Date(100000));
            return read;
          });
        yield* Effect.gen(function* () {
          expect(
            (yield* directory
              .read("primary.json", 0o400, 65536)
              .pipe(Effect.flip)).code,
          ).toBe("registry-file-changed");
        }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
      }),
    ),
);
