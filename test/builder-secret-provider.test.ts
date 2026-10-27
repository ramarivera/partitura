import { chmod, link, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  BuilderRegistryFiles,
  registryIO,
} from "../src/services/builder-registry-files.js";
import {
  BuilderSecretProvider,
  normalizeBuilderFileRecord,
} from "../src/services/builder-secret-provider.js";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import {
  builderFilesFixture,
  bytes,
  entry,
} from "./fixtures/builder-registry.js";
import { registryFixture } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const record = (
  fixture: Effect.Success<ReturnType<typeof registryFixture>>,
) => ({
  schemaVersion: 1,
  hostId: fixture.metadata.hostId,
  hostname: fixture.metadata.hostname,
  port: fixture.metadata.port,
  sshUser: fixture.metadata.sshUser,
  hostKeys: fixture.metadata.hostKeys,
  privateKeyB64: Buffer.from(fixture.key).toString("base64"),
  retiringPrivateKeyB64: "",
});

it.live(
  "filesystem validation rejects protected-root overlap and insufficient provisioned capacity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path("roots")),
          files = yield* BuilderRegistryFiles;
        yield* files.validateRoots(fixture.settings);
        expect(
          (yield* files
            .validateRoots({
              ...fixture.settings,
              otherRoots: [fixture.settings.scratchRoot],
            })
            .pipe(Effect.flip)).code,
        ).toBe("registry-roots-overlap");
        expect(
          (yield* files
            .validateRoots({
              ...fixture.settings,
              totalBytes: Number.MAX_SAFE_INTEGER,
            })
            .pipe(Effect.flip)).code,
        ).toBe("registry-scratch-capacity");
      }),
    ).pipe(Effect.provide(BuilderRegistryFiles.layer)),
);

it.live(
  "the protected file provider emits the same normalized transport/current and retiring key bytes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = yield* registryFixture(path("native"));
        const fixture = yield* builderFilesFixture(path("builder"));
        yield* registryIO(() =>
          writeFile(
            join(fixture.settings.fileSecretRoot ?? "", "primary.json"),
            bytes({
              ...record(native),
              retiringPrivateKeyB64: Buffer.from(native.key).toString("base64"),
            }),
            { mode: 0o400 },
          ),
        );
        const provider = yield* BuilderSecretProvider.make.pipe(
          Effect.provideService(BuilderRegistryConfig, fixture.settings),
          Effect.provide(BuilderRegistryFiles.layer),
        );
        const normalized = yield* provider.resolve(entry());
        expect(normalized.transport).toEqual({
          ...native.metadata,
          source: "file:primary.json",
        });
        expect(normalized.privateKey).toBe(native.key);
        expect(normalized.retiringPrivateKey).toBe(native.key);
      }),
    ),
);

it.live(
  "file records use a strict eight-field schema and canonical unencrypted key encoding",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = yield* registryFixture(path("records")),
          valid = record(native);
        const invalid = [
          { ...valid, extra: "discard-me" },
          { ...valid, schemaVersion: "1" },
          { ...valid, port: "22" },
          { ...valid, privateKeyB64: `${valid.privateKeyB64}\n` },
          {
            ...valid,
            privateKeyB64: Buffer.from("not-a-key").toString("base64"),
          },
          { ...valid, hostname: "other.test" },
          { ...valid, hostname: "localhost" },
          { ...valid, sshUser: "root" },
          { ...valid, hostKeys: [{ type: "ssh-ed25519", base64: "AAAA" }] },
          { ...valid, retiringPrivateKeyB64: "not-canonical" },
          {
            ...valid,
            retiringPrivateKeyB64: Buffer.from("not-a-key").toString("base64"),
          },
        ];
        for (const value of invalid)
          expect(
            (yield* Effect.exit(
              normalizeBuilderFileRecord(
                bytes(value),
                "file:primary.json",
                "example.test",
              ),
            ))._tag,
          ).toBe("Failure");
        const duplicate = Buffer.from(
          JSON.stringify(valid).replace(
            '"schemaVersion":1',
            '"schemaVersion":1,"\\u0073chemaVersion":1',
          ),
        );
        expect(
          (yield* normalizeBuilderFileRecord(
            duplicate,
            "file:primary.json",
            "example.test",
          ).pipe(Effect.flip)).code,
        ).toBe("registry-duplicate-key");
      }),
    ),
);

for (const bad of ["mode", "hardlink", "symlink", "oversize"] as const)
  it.live(`descriptor file checks refuse ${bad}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path(bad));
        const name = join(
          fixture.settings.fileSecretRoot ?? "",
          "primary.json",
        );
        yield* registryIO(async () => {
          if (bad === "symlink") {
            const outside = join(fixture.root, "outside.json");
            await writeFile(outside, "{}", { mode: 0o400 });
            await symlink(outside, name);
          } else {
            await writeFile(
              name,
              bad === "oversize" ? Buffer.alloc(65_537) : "{}",
              { mode: 0o400 },
            );
            if (bad === "mode") await chmod(name, 0o600);
            if (bad === "hardlink")
              await link(name, join(fixture.root, "alias.json"));
          }
        });
        const files = yield* BuilderRegistryFiles;
        const directory = yield* files.directory(
          fixture.settings.fileSecretRoot ?? "",
        );
        expect(
          (yield* Effect.exit(directory.read("primary.json", 0o400, 65_536)))
            ._tag,
        ).toBe("Failure");
      }),
    ).pipe(Effect.provide(BuilderRegistryFiles.layer)),
  );

it.live(
  "disabled file provider and unimplemented 1Password never fall back or read arbitrary paths",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* builderFilesFixture(path("disabled"));
        const provider = yield* BuilderSecretProvider.make.pipe(
          Effect.provideService(BuilderRegistryConfig, {
            ...fixture.settings,
            fileSecretRoot: undefined,
          }),
          Effect.provide(BuilderRegistryFiles.layer),
        );
        expect((yield* provider.resolve(entry()).pipe(Effect.flip)).code).toBe(
          "builder-file-provider-disabled",
        );
        expect(
          (yield* provider
            .resolve({
              ...entry(),
              secretSource: {
                type: "onepassword",
                vaultId: "a".repeat(26),
                itemId: "b".repeat(26),
              },
            })
            .pipe(Effect.flip)).code,
        ).toBe("builder-provider-unavailable");
      }),
    ),
);
