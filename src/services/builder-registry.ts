import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Scope,
  Semaphore,
} from "effect";
import { BuilderRegistryFiles } from "./builder-registry-files.js";
import { BuilderRegistryIdentity } from "./builder-registry-identity.js";
import { BuilderRegistryError } from "./builder-registry-json.js";
import {
  parseBuilderRegistry,
  sourceReference,
} from "./builder-registry-schema.js";
import { makeBuilderRegistryState } from "./builder-registry-state.js";
import { BuilderSecretProvider } from "./builder-secret-provider.js";
import { BuilderRegistryConfig } from "./config-native-build.js";
import { NativeBuildSecretCache } from "./native-build-secret-cache.js";

export * from "./builder-registry-schema.js";
export type { BuilderAdmission } from "./builder-registry-state.js";

/** Local file polling supplies correctness. Watch events only reduce latency.
 * This layer is deliberately absent from GatewayServicesLive until slice 8. */
export class BuilderRegistry extends Context.Service<BuilderRegistry>()(
  "BuilderRegistry",
  {
    make: Effect.gen(function* () {
      const settings = yield* BuilderRegistryConfig;
      const files = yield* BuilderRegistryFiles;
      const provider = yield* BuilderSecretProvider;
      const secretCache = yield* Effect.serviceOption(NativeBuildSecretCache);
      let capacityError: string | undefined;
      const identity = yield* BuilderRegistryIdentity;
      const scope = yield* Scope.Scope;
      const state = yield* makeBuilderRegistryState(provider, identity);
      const reloadGate = yield* Semaphore.make(1);
      const hints = yield* Queue.dropping<void>(1);
      let directory:
        | Effect.Success<ReturnType<typeof files.directory>>
        | undefined;
      let digest: string | undefined;
      let watchDegraded = false;
      let watchFailure: unknown;
      const reload = Effect.fn("BuilderRegistry.reload")(() =>
        reloadGate.withPermit(
          Effect.gen(function* () {
            if (!settings.registryFile)
              return yield* Effect.fail(
                BuilderRegistryError.new("registry-not-configured"),
              );
            if (!directory) {
              yield* files.validateRoots(settings);
              const directoryScope = yield* Scope.fork(scope);
              directory = yield* files
                .directory(dirname(settings.registryFile))
                .pipe(
                  Effect.provideService(Scope.Scope, directoryScope),
                  Effect.onExit((exit) =>
                    Exit.isFailure(exit)
                      ? Scope.close(directoryScope, exit)
                      : Effect.void,
                  ),
                );
            }
            const bytes = yield* directory.read(
              basename(settings.registryFile),
              0o600,
              262_144,
            );
            const nextDigest = createHash("sha256").update(bytes).digest("hex");
            if (digest === nextDigest && state.snapshot().error === undefined)
              return;
            const snapshot = yield* parseBuilderRegistry(bytes, settings);
            if (Option.isSome(secretCache)) {
              const capacity = yield* secretCache.value
                .capacity(
                  snapshot.builders
                    .filter((entry) => entry.enabled)
                    .map((entry) => ({
                      source: sourceReference(entry.secretSource),
                      revision: entry.secretRevision,
                      builderId: entry.id,
                      retained: false,
                    })),
                )
                .pipe(
                  Effect.mapError((error) =>
                    BuilderRegistryError.new(error.code),
                  ),
                );
              if (!capacity.sufficient) {
                capacityError = "budget-capacity";
                return;
              }
              capacityError = undefined;
            }
            yield* state.publish(
              snapshot,
              state.snapshot().desired ? "registry" : "startup",
            );
            digest = nextDigest;
          }).pipe(Effect.catch((cause) => state.fault(cause))),
        ),
      );
      const timers = yield* Effect.acquireRelease(
        Effect.sync(() => ({
          debounce: undefined as ReturnType<typeof setTimeout> | undefined,
          ceiling: undefined as ReturnType<typeof setTimeout> | undefined,
        })),
        (timers) =>
          Effect.sync(() => {
            clearTimeout(timers.debounce);
            clearTimeout(timers.ceiling);
          }),
      );
      const flush = () => {
        clearTimeout(timers.debounce);
        clearTimeout(timers.ceiling);
        timers.debounce = undefined;
        timers.ceiling = undefined;
        Queue.offerUnsafe(hints, undefined);
      };
      if (settings.registryFile)
        yield* files
          .watch(
            settings.registryFile,
            () => {
              clearTimeout(timers.debounce);
              timers.debounce = setTimeout(flush, 250);
              timers.ceiling ??= setTimeout(flush, 1000);
            },
            (cause) => {
              watchDegraded = true;
              watchFailure = cause;
            },
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                watchDegraded = true;
                watchFailure = cause;
              }),
            ),
          );
      yield* reload();
      yield* Effect.forkScoped(
        Effect.forever(Queue.take(hints).pipe(Effect.andThen(reload()))),
      );
      yield* Effect.forkScoped(
        Effect.forever(Effect.sleep(5000).pipe(Effect.andThen(reload()))),
      );
      return {
        ...state,
        reload,
        snapshot: () => ({ ...state.snapshot(), watchDegraded, capacityError }),
        // Retain the cause privately without serializing it into admin/log output.
        watchFailure: () => watchFailure,
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        BuilderRegistryFiles.layer,
        BuilderSecretProvider.layer,
        BuilderRegistryIdentity.layer,
      ),
    ),
  );
}
