import { mkdir, writeFile } from "node:fs/promises";
import { Clock, Effect } from "effect";
import { registryIO } from "../../src/services/builder-registry-files.js";
import { BuilderRegistryConfig } from "../../src/services/config-native-build.js";
import { NativeSecretBudget } from "../../src/services/native-build-secret-budget.js";
import {
  NativeBuildSecretCache,
  NativeSecretScheduling,
} from "../../src/services/native-build-secret-cache.js";
import {
  journalFile,
  markerFile,
  NativeSecretJournal,
} from "../../src/services/native-build-secret-journal.js";
import { emptySecretJournal } from "../../src/services/native-build-secret-models.js";
import { NativeSecretSourceReader } from "../../src/services/native-build-secret-reader.js";
import {
  NativeStateConfig,
  NativeStateOwnership,
} from "../../src/services/native-build-state-ownership.js";
import { builderFilesFixture } from "./builder-registry.js";
import { registryFixture } from "./native-build-registry.js";

export const secretFixture = Effect.fn("SecretFixture.make")(function* (
  root: string,
) {
  const files = yield* builderFilesFixture(root);
  yield* registryIO(() => mkdir(`${root}/keys`, { mode: 0o700 }));
  const native = yield* registryFixture(`${root}/keys`);
  const at = yield* Clock.currentTimeMillis;
  const settings = {
    ...files.settings,
    vaultId: "a".repeat(26),
    tokenFile: `${root}/token`,
    liveQualified: false,
  };
  const record = {
    schemaVersion: 1 as const,
    hostId: native.metadata.hostId,
    hostname: native.metadata.hostname,
    sshUser: native.metadata.sshUser,
    port: native.metadata.port,
    hostKeys: native.metadata.hostKeys,
    privateKeyB64: Buffer.from(native.key).toString("base64"),
    retiringPrivateKeyB64: "",
  };
  yield* registryIO(async () => {
    await writeFile(
      markerFile(settings.stateRoot),
      "partitura-native-provider-v1\n",
      { mode: 0o600 },
    );
    await writeFile(
      journalFile(settings.stateRoot),
      JSON.stringify(emptySecretJournal(at)),
      { mode: 0o600 },
    );
    await writeFile(settings.tokenFile, "DUMMY-TOKEN-SENTINEL", {
      mode: 0o400,
    });
  });
  const owner = yield* NativeStateOwnership.make.pipe(
    Effect.provideService(NativeStateConfig, {
      stateRoot: settings.stateRoot,
      scratchRoot: settings.scratchRoot,
      cacheRoot: settings.cacheRoot,
      bytesPerBuilder: settings.perBuilderBytes,
      bytesTotal: settings.totalBytes,
    }),
  );
  const openJournal = NativeSecretJournal.make.pipe(
    Effect.provideService(BuilderRegistryConfig, settings),
    Effect.provideService(NativeStateOwnership, owner),
  );
  const journal = yield* openJournal;
  const budget = yield* NativeSecretBudget.make.pipe(
    Effect.provideService(BuilderRegistryConfig, settings),
    Effect.provideService(NativeSecretJournal, journal),
  );
  const openCache = (
    reader: typeof NativeSecretSourceReader.Service,
    nextJournal = journal,
    nextBudget = budget,
    automatic = false,
    readerHandlesStart = false,
  ) =>
    NativeBuildSecretCache.make.pipe(
      Effect.provideService(BuilderRegistryConfig, settings),
      Effect.provideService(NativeSecretJournal, nextJournal),
      Effect.provideService(NativeSecretBudget, nextBudget),
      Effect.provideService(
        NativeSecretSourceReader,
        readerHandlesStart
          ? reader
          : {
              // These dummy readers perform their get immediately after reservation; only the real helper has an initialization phase.
              read: (source, reserve, onReadStart = () => Effect.void) =>
                reader.read(source, (units) =>
                  reserve(units).pipe(Effect.andThen(onReadStart())),
                ),
            },
      ),
      Effect.provideService(NativeSecretScheduling, automatic),
    );
  const source = (number = 1) => ({
    source: `onepassword:${settings.vaultId}:${String(number).padStart(26, "b")}`,
    revision: 1,
    builderId: `builder-${number}`,
    retained: false,
  });
  return {
    settings,
    owner,
    native,
    record,
    journal,
    budget,
    openJournal,
    openCache,
    source,
    root,
  };
});
