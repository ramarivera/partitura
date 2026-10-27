import { Effect, Layer } from "effect";
import { BuilderRegistry } from "./builder-registry.js";
import { sourceReference } from "./builder-registry-schema.js";
import { normalizeBuilderFileRecord } from "./builder-secret-record.js";
import { GatewayConfig } from "./config.js";
import { BuilderRegistryConfig } from "./config-native-build.js";
import { NativeBuildFiles } from "./native-build-files.js";
import { NativeBuildFleet } from "./native-build-fleet.js";
import { NativeBuildFleetRecovery } from "./native-build-fleet-recovery.js";
import { NativeBuildJobs } from "./native-build-jobs.js";
import { recoverNativeMetadata } from "./native-build-recovery.js";
import { NativeBuildSecretCache } from "./native-build-secret-cache.js";
import { NativeSecretJournal } from "./native-build-secret-journal.js";
import { emptySecretJournal } from "./native-build-secret-models.js";
import { NativeSecretError } from "./native-build-secret-protocol.js";
import { NativeSecretSourceReader } from "./native-build-secret-reader.js";
import {
  NativeBuildStateService,
  unresolvedRecovery,
} from "./native-build-state.js";
import {
  NativeStateConfig,
  NativeStateOwnership,
} from "./native-build-state-ownership.js";
import {
  NativeBuildTransport,
  NativeTransportConfig,
} from "./native-build-transport.js";

/** Restore removed sources independently of the current admission pool. No build triggers reads. */
const retainedStartup = Effect.gen(function* () {
  const registry = yield* BuilderRegistry;
  const state = yield* NativeBuildStateService;
  const cache = yield* NativeBuildSecretCache;
  const reader = yield* NativeSecretSourceReader;
  const transport = yield* NativeBuildTransport;
  const settings = yield* BuilderRegistryConfig;
  const enabled = new Set(
    registry
      .snapshot()
      .desired?.builders.filter(
        (entry) =>
          entry.enabled &&
          registry.current(entry.id)?.error !== "budget-capacity",
      )
      .map((entry) => sourceReference(entry.secretSource)),
  );
  const sources = new Map<
    string,
    { source: string; builderId: string; revision: number; retained: boolean }
  >();
  const snapshot = state.snapshot();
  for (const job of snapshot.jobs.filter(unresolvedRecovery)) {
    const generation = snapshot.generations.find(
      (entry) => entry.id === job.generationId,
    );
    if (generation && !enabled.has(generation.transport.source))
      sources.set(generation.transport.source, {
        source: generation.transport.source,
        builderId: job.builderId,
        revision: 0,
        retained: true,
      });
  }
  for (const source of sources.values())
    yield* Effect.gen(function* () {
      const credential = source.source.startsWith("file:")
        ? yield* reader
            .read(source.source, () =>
              Effect.fail(NativeSecretError.new("provider-budget-invalid")),
            )
            .pipe(
              Effect.flatMap((record) =>
                normalizeBuilderFileRecord(
                  Buffer.from(JSON.stringify(record)),
                  source.source,
                  settings.suffix,
                ),
              ),
            )
        : yield* cache.resolve(source, "startup");
      yield* transport.restore(source.source, [
        credential.privateKey,
        ...(credential.retiringPrivateKey
          ? [credential.retiringPrivateKey]
          : []),
      ]);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Native retained startup source unavailable", {
          builderId: source.builderId,
          code: "code" in error ? error.code : error.reason,
        }),
      ),
      Effect.forkScoped,
    );
});

// Read failure never manufactures a writable fresh allowance. File builds and
// local recovery remain usable while provider reads report repair-required.
const journal = Layer.effect(
  NativeSecretJournal,
  NativeSecretJournal.make.pipe(
    Effect.catch((error) =>
      Effect.logError("Native provider journal requires operator repair", {
        code: error.code,
      }).pipe(
        Effect.as({
          snapshot: () => emptySecretJournal(Date.now()),
          transaction: <A>(): Effect.Effect<A, NativeSecretError> =>
            Effect.fail(NativeSecretError.new("journal-repair-required")),
        }),
      ),
    ),
  ),
);
const localState = NativeBuildStateService.layerWithoutDependencies.pipe(
  Layer.provideMerge(NativeStateOwnership.layer),
  Layer.provide(NativeBuildFiles.layer),
);
const recoveredState = Layer.effectDiscard(
  NativeBuildStateService.use((state) => recoverNativeMetadata(state)),
).pipe(Layer.provideMerge(localState));
const transport = NativeBuildTransport.layer.pipe(
  Layer.provideMerge(recoveredState),
);
const cache = NativeBuildSecretCache.layer.pipe(
  Layer.provideMerge(journal),
  Layer.provideMerge(NativeSecretSourceReader.layer),
);
const registry = BuilderRegistry.layer.pipe(
  Layer.provideMerge(cache),
  Layer.provideMerge(transport),
);
const fleetRecovery = NativeBuildFleetRecovery.layer.pipe(
  Layer.provideMerge(registry),
);
export const RegistryNativeBuildServices = Layer.mergeAll(
  NativeBuildFleet.layer,
  NativeBuildJobs.layer,
  Layer.effectDiscard(retainedStartup),
).pipe(Layer.provideMerge(fleetRecovery));

/** Static selection. Unset means no registry ownership, mounts, journal or helper. */
export const NativeBuildServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    const { nativeBuildRegistry: settings } = yield* GatewayConfig;
    if (!settings?.registryFile) return Layer.empty;
    return RegistryNativeBuildServices.pipe(
      Layer.provide(Layer.succeed(BuilderRegistryConfig, settings)),
      Layer.provide(
        Layer.succeed(NativeStateConfig, {
          stateRoot: settings.stateRoot,
          scratchRoot: settings.scratchRoot,
          cacheRoot: settings.cacheRoot,
          bytesPerBuilder: settings.perBuilderBytes,
          bytesTotal: settings.totalBytes,
          otherRoots: [
            ...(settings.otherRoots ?? []),
            ...(settings.fileSecretRoot ? [settings.fileSecretRoot] : []),
          ],
        }),
      ),
      Layer.provide(
        Layer.succeed(NativeTransportConfig, { suffix: settings.suffix }),
      ),
    );
  }),
);
