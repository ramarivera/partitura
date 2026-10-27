import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { BuilderRegistry } from "../src/services/builder-registry.js";
import {
  BuilderRegistryFiles,
  registryIO,
} from "../src/services/builder-registry-files.js";
import { BuilderRegistryIdentity } from "../src/services/builder-registry-identity.js";
import { BuilderSecretProvider } from "../src/services/builder-secret-provider.js";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import { NativeBuildStateService } from "../src/services/native-build-state.js";
import { NativeBuildTransport } from "../src/services/native-build-transport.js";
import {
  builderFilesFixture,
  bytes,
  document,
  entry,
} from "./fixtures/builder-registry.js";
import { registryFixture } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.live(
  "real file resolution and generated transport use only fake broker health, preserving immutable generations",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = yield* registryFixture(path("broker"));
        const fixture = yield* builderFilesFixture(path("registry"));
        const record = {
          schemaVersion: 1,
          hostId: native.metadata.hostId,
          hostname: native.metadata.hostname,
          sshUser: native.metadata.sshUser,
          port: native.metadata.port,
          hostKeys: native.metadata.hostKeys,
          privateKeyB64: Buffer.from(native.key).toString("base64"),
          retiringPrivateKeyB64: "",
        };
        const secretPath = join(
          fixture.settings.fileSecretRoot ?? "",
          "primary.json",
        );
        yield* registryIO(() =>
          writeFile(secretPath, bytes(record), { mode: 0o400 }),
        );
        yield* fixture.write(document());
        const identity = yield* BuilderRegistryIdentity.make.pipe(
          Effect.provideService(NativeBuildStateService, native.state),
          Effect.provideService(NativeBuildTransport, native.transport),
        );
        const provider = yield* BuilderSecretProvider.make.pipe(
          Effect.provideService(BuilderRegistryConfig, fixture.settings),
          Effect.provide(BuilderRegistryFiles.layer),
        );
        const registry = yield* BuilderRegistry.make.pipe(
          Effect.provideService(BuilderRegistryConfig, fixture.settings),
          Effect.provideService(BuilderSecretProvider, provider),
          Effect.provideService(BuilderRegistryIdentity, identity),
          Effect.provide(BuilderRegistryFiles.layer),
        );
        yield* registry.awaitIdle();
        expect(registry.snapshot().entries[0]?.available).toBe(true);
        const original = registry.snapshot().entries[0]?.generationId;
        expect(native.state.generationInUse(original ?? "")).toBe(true);
        const preparationScope = yield* Scope.fork(yield* Scope.Scope);
        const owner = yield* registry
          .admit()
          .pipe(Effect.provideService(Scope.Scope, preparationScope));
        yield* registryIO(() =>
          writeFile(`${secretPath}.new`, bytes({ ...record, port: 2223 }), {
            mode: 0o400,
          }).then(() => rename(`${secretPath}.new`, secretPath)),
        );
        yield* fixture.write(document([entry("primary", true, 2)]));
        yield* registry.reload();
        yield* registry.awaitIdle();
        expect(registry.snapshot().error).toBeUndefined();
        expect(registry.snapshot().desired?.builders[0]?.secretRevision).toBe(
          2,
        );
        expect(
          native.state
            .snapshot()
            .generations.map((generation) => generation.transport.port),
        ).toContain(2223);
        expect(registry.snapshot().entries[0]?.generationId).not.toBe(original);
        const replacement = registry.snapshot().entries[0]?.generationId;
        expect(owner.generationId).toBe(original);
        yield* registry.submit(owner, () => Effect.void);
        yield* fixture.write(document([entry("primary", false, 2)]));
        yield* registry.reload();
        expect(registry.snapshot().entries[0]?.available).toBe(false);
        yield* fixture.write(document([]));
        yield* registry.reload();
        expect(registry.snapshot().entries).toEqual([]);
        expect(native.state.generationInUse(replacement ?? "")).toBe(false);
        expect(native.state.generationInUse(original ?? "")).toBe(true);
        yield* Scope.close(preparationScope, Exit.void);
        expect(native.state.generationInUse(original ?? "")).toBe(false);
        expect(
          (yield* registryIO(() => native.trace())).map((item) => item.command),
        ).toEqual(["health", "health"]);
        expect(JSON.stringify(native.state.snapshot())).not.toContain(
          record.privateKeyB64,
        );
        expect(JSON.stringify(registry.snapshot())).not.toContain(
          record.privateKeyB64,
        );
      }),
    ),
);
