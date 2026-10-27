import { Context, Effect, Layer, Option } from "effect";
import { BuilderRegistry } from "./builder-registry.js";
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
import { retainedStartup } from "./native-build-source-lifecycle.js";
import {
  NativeBuildStateService,
  type NativeStateOptions,
} from "./native-build-state.js";
import {
  NativeStateConfig,
  NativeStateOwnership,
} from "./native-build-state-ownership.js";
import {
  NativeBuildTransport,
  NativeTransportConfig,
} from "./native-build-transport.js";

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

/** Optional infrastructure adapters for hermetic assembly tests. No environment setting enables these. */
export class NativeBuildRuntimeAdapters extends Context.Service<
  NativeBuildRuntimeAdapters,
  {
    readonly filesystem?: NativeStateOptions["filesystem"];
    readonly executable?: string;
  }
>()("NativeBuildRuntimeAdapters") {}
/** Static selection. Unset means no registry ownership, mounts, journal or helper. */
export const NativeBuildServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    const { nativeBuildRegistry: settings } = yield* GatewayConfig;
    if (!settings?.registryFile) return Layer.empty;
    const adapters = Option.getOrElse(
      yield* Effect.serviceOption(NativeBuildRuntimeAdapters),
      (): NativeBuildRuntimeAdapters["Service"] => ({}),
    );
    return RegistryNativeBuildServices.pipe(
      Layer.provide(Layer.succeed(BuilderRegistryConfig, settings)),
      Layer.provide(
        Layer.succeed(NativeStateConfig, {
          stateRoot: settings.stateRoot,
          scratchRoot: settings.scratchRoot,
          cacheRoot: settings.cacheRoot,
          bytesPerBuilder: settings.perBuilderBytes,
          bytesTotal: settings.totalBytes,
          ...(adapters.filesystem ? { filesystem: adapters.filesystem } : {}),
          otherRoots: [
            ...(settings.otherRoots ?? []),
            ...(settings.fileSecretRoot ? [settings.fileSecretRoot] : []),
          ],
        }),
      ),
      Layer.provide(
        Layer.succeed(NativeTransportConfig, {
          suffix: settings.suffix,
          ...(adapters.executable ? { executable: adapters.executable } : {}),
        }),
      ),
    );
  }),
);
