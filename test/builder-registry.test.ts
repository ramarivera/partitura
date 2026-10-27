import {
  chmod,
  mkdir,
  open,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { BuilderRegistry } from "../src/services/builder-registry.js";
import {
  BuilderRegistryFiles,
  registryIO,
} from "../src/services/builder-registry-files.js";
import { BuilderRegistryIdentity } from "../src/services/builder-registry-identity.js";
import { BuilderRegistryError } from "../src/services/builder-registry-json.js";
import { BuilderSecretProvider } from "../src/services/builder-secret-provider.js";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import {
  builderFilesFixture,
  bytes,
  document,
  entry,
  fakeBuilderAdapters,
} from "./fixtures/builder-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const start = (
  fixture: Effect.Success<ReturnType<typeof builderFilesFixture>>,
  fake: ReturnType<typeof fakeBuilderAdapters>,
  files?: typeof BuilderRegistryFiles.Service,
) =>
  BuilderRegistry.make.pipe(
    Effect.provideService(BuilderRegistryConfig, fixture.settings),
    Effect.provideService(BuilderSecretProvider, fake.provider),
    Effect.provideService(BuilderRegistryIdentity, fake.identity),
    files
      ? Effect.provideService(BuilderRegistryFiles, files)
      : Effect.provide(BuilderRegistryFiles.layer),
  );
const observe = Effect.fn("RegistryTest.observe")(function* (
  predicate: () => boolean,
) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (predicate()) return;
    yield* Effect.sleep(20);
  }
  expect(predicate()).toBe(true);
});

it.live(
  "continuous watch hints still publish within the one-second ceiling",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path("debounce")),
          fake = fakeBuilderAdapters(),
          files = yield* BuilderRegistryFiles.make;
        let hint = () => {};
        yield* fixture.write(document());
        const registry = yield* start(fixture, fake, {
          ...files,
          watch: (file, changed, failed) => {
            hint = changed;
            return files.watch(file, () => {}, failed);
          },
        });
        yield* registry.awaitIdle();
        yield* fixture.write(document([entry(), entry("backup")]));
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            for (let index = 0; index < 12; index++) {
              hint();
              yield* Effect.sleep(100);
            }
          }),
        );
        yield* Effect.sleep(1150);
        expect(registry.snapshot().desired?.builders).toHaveLength(2);
        yield* registry.awaitIdle();
        expect(fake.reads).toEqual(["primary:1", "backup:1"]);
      }),
    ),
);

it.live(
  "each failed directory acquisition immediately closes its resource scope",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path("failed-open")),
          fake = fakeBuilderAdapters(),
          files = yield* BuilderRegistryFiles.make;
        let active = 0;
        const registry = yield* start(fixture, fake, {
          ...files,
          directory: (root) =>
            files.directory(root).pipe(
              Effect.tap(() =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    active++;
                  }),
                  () =>
                    Effect.sync(() => {
                      active--;
                    }),
                ),
              ),
              Effect.andThen(
                Effect.fail(
                  BuilderRegistryError.new("registry-directory-insecure"),
                ),
              ),
            ),
        });
        for (let retry = 0; retry < 5; retry++) {
          yield* registry.reload();
          expect(active).toBe(0);
        }
        expect(registry.snapshot().desired).toBeUndefined();
        expect(fake.reads).toEqual([]);
      }),
    ),
);

it.live(
  "atomic sibling rename hot-adds and edits without restarting or touching legacy data",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path("rename")),
          fake = fakeBuilderAdapters();
        const legacy = join(fixture.root, "legacy", "sentinel.json");
        yield* registryIO(() =>
          writeFile(legacy, "legacy bytes", { mode: 0o600 }),
        );
        yield* fixture.write(document());
        const registry = yield* start(fixture, fake);
        yield* registry.awaitIdle();
        const registryPath = fixture.settings.registryFile ?? "";
        const replace = Effect.fn("RegistryTest.replace")((value: unknown) =>
          registryIO(async () => {
            const sibling = `${registryPath}.new`;
            const file = await open(sibling, "wx", 0o600);
            try {
              await file.writeFile(bytes(value));
              await file.sync();
            } finally {
              await file.close();
            }
            await rename(sibling, registryPath);
            const parent = await open(dirname(registryPath), "r");
            try {
              await parent.sync();
            } finally {
              await parent.close();
            }
          }),
        );
        yield* replace(document([entry(), entry("backup")]));
        yield* observe(
          () => registry.snapshot().desired?.builders.length === 2,
        );
        yield* registry.awaitIdle();
        expect(
          registry.snapshot().entries.every((item) => item.available),
        ).toBe(true);
        yield* replace(document([entry("primary", false), entry("backup")]));
        yield* observe(
          () => registry.snapshot().entries[0]?.reason === "builder-disabled",
        );
        yield* replace(document([entry("backup")]));
        yield* observe(() => registry.snapshot().entries.length === 1);
        expect(fake.reads).toEqual(["primary:1", "backup:1"]);
        expect(yield* registryIO(() => Bun.file(legacy).text())).toBe(
          "legacy bytes",
        );
      }),
    ),
);

it.effect(
  "five-second content polling repairs a completely missed watch event without secret polling",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path("missed")),
          fake = fakeBuilderAdapters();
        const files = yield* BuilderRegistryFiles.make;
        yield* fixture.write(document());
        const registry = yield* start(fixture, fake, {
          ...files,
          watch: (file, _changed, failed) =>
            files.watch(file, () => {}, failed),
        });
        yield* registry.awaitIdle();
        yield* fixture.write(document([entry(), entry("backup")]));
        yield* TestClock.adjust(5000);
        yield* observe(() => registry.snapshot().entries.length === 2).pipe(
          TestClock.withLive,
        );
        yield* registry.awaitIdle();
        expect(registry.snapshot().entries).toHaveLength(2);
        yield* TestClock.adjust(15_000);
        yield* registry.awaitIdle();
        expect(fake.reads).toEqual(["primary:1", "backup:1"]);
      }),
    ),
);

it.live(
  "invalid snapshots retain last desired state with admission closed and cold invalid input can be repaired locally",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path("repair")),
          fake = fakeBuilderAdapters();
        const registry = yield* start(fixture, fake);
        expect(registry.snapshot().desired).toBeUndefined();
        expect(registry.snapshot().error).toBe("registry-file-unavailable");
        expect((yield* registry.admit().pipe(Effect.flip)).code).toBe(
          "registry-admission-closed",
        );
        yield* fixture.write(document());
        yield* registry.reload();
        yield* registry.awaitIdle();
        expect(registry.snapshot().revision).toBe(1);
        yield* fixture.write({ bad: "sentinel must not be exposed" });
        yield* registry.reload();
        expect(registry.snapshot().desired).toEqual(document());
        expect(registry.snapshot().error).toBe("default-not-configured");
        expect(JSON.stringify(registry.snapshot())).not.toContain("sentinel");
        expect(registry.snapshot().entries[0]?.available).toBe(false);
        expect((yield* registry.admit().pipe(Effect.flip)).code).toBe(
          "registry-admission-closed",
        );
        yield* registryIO(() =>
          chmod(fixture.settings.registryFile ?? "", 0o644),
        );
        yield* registry.reload();
        expect(registry.snapshot().error).toBe("registry-file-insecure");
        yield* registryIO(() =>
          chmod(fixture.settings.registryFile ?? "", 0o600),
        );
        yield* fixture.write(document());
        yield* registry.reload();
        expect(registry.snapshot().error).toBeUndefined();
        expect(registry.snapshot().entries[0]?.available).toBe(true);
        expect(fake.reads).toEqual(["primary:1"]);
      }),
    ),
);

it.live(
  "an unlinked pinned directory closes admission and cannot heal by replacing the pathname",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path("stale")),
          fake = fakeBuilderAdapters(),
          files = yield* BuilderRegistryFiles.make;
        yield* fixture.write(document());
        const registry = yield* start(fixture, fake, {
          ...files,
          watch: (file, _changed, failed) =>
            files.watch(file, () => {}, failed),
        });
        yield* registry.awaitIdle();
        const admission = yield* registry.admit();
        const file = fixture.settings.registryFile ?? "";
        yield* registryIO(async () => {
          await unlink(file);
          await rmdir(dirname(file));
        });
        yield* registry.reload();
        expect(registry.snapshot().error).toBe("registry-mount-stale");
        expect(registry.snapshot().entries[0]?.available).toBe(false);
        expect(admission.signal.aborted).toBe(true);
        yield* registryIO(() => mkdir(dirname(file), { mode: 0o700 }));
        yield* fixture.write(document());
        yield* registry.reload();
        expect(registry.snapshot().error).toBe("registry-mount-stale");
        expect(fake.reads).toEqual(["primary:1"]);
      }),
    ),
);

it.effect(
  "watch failure exposes degradation while bounded polling continues",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path("watch-error")),
          fake = fakeBuilderAdapters(),
          files = yield* BuilderRegistryFiles.make;
        yield* fixture.write(document());
        const registry = yield* start(fixture, fake, {
          ...files,
          watch: (file, changed, failed) => {
            failed(new Error("private watch cause"));
            return files.watch(file, changed, failed);
          },
        });
        expect(registry.snapshot().watchDegraded).toBe(true);
        yield* fixture.write(document([entry("backup")]));
        yield* TestClock.adjust(5000);
        yield* observe(
          () => registry.snapshot().desired?.defaultBuilder === "backup",
        ).pipe(TestClock.withLive);
        yield* registry.awaitIdle();
        expect(registry.snapshot().desired?.defaultBuilder).toBe("backup");
        expect(JSON.stringify(registry.snapshot())).not.toContain(
          "private watch cause",
        );
      }),
    ),
);
