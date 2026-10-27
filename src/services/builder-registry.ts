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
  credentialRevision,
  parseBuilderRegistry,
  sourceReference,
} from "./builder-registry-schema.js";
import { makeBuilderRegistryState } from "./builder-registry-state.js";
import { BuilderSecretProvider } from "./builder-secret-provider.js";
import { BuilderRegistryConfig } from "./config-native-build.js";
import { NativeBuildSecretCache } from "./native-build-secret-cache.js";
import { neededNativeSources } from "./native-build-source-inventory.js";
import {
  NativeBuildStateService,
  unresolvedRecovery,
} from "./native-build-state.js";
import { NativeBuildTransport } from "./native-build-transport.js";

export * from "./builder-registry-schema.js";
export type { BuilderAdmission } from "./builder-registry-state.js";

/** Local file polling supplies correctness. Watch events only reduce latency.
 * Registry mode assembles this layer before tool and ingress consumers. */
export class BuilderRegistry extends Context.Service<BuilderRegistry>()(
  "BuilderRegistry",
  {
    make: Effect.gen(function* () {
      const settings = yield* BuilderRegistryConfig;
      const files = yield* BuilderRegistryFiles;
      const provider = yield* BuilderSecretProvider;
      const secretCache = yield* Effect.serviceOption(NativeBuildSecretCache);
      const nativeState = yield* Effect.serviceOption(NativeBuildStateService);
      let capacityError: string | undefined;
      const identity = yield* BuilderRegistryIdentity;
      const scope = yield* Scope.Scope;
      const state = yield* makeBuilderRegistryState(
        provider,
        identity,
        Date.now,
        (ids, captured) =>
          Option.isSome(secretCache)
            ? secretCache.value
                .supersede(ids, captured)
                .pipe(
                  Effect.mapError((error) =>
                    BuilderRegistryError.new(error.code),
                  ),
                )
            : Effect.void,
        Option.isSome(secretCache)
          ? secretCache.value.captureSupersede
          : undefined,
      );
      if (Option.isSome(secretCache))
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            secretCache.value.observeDesired(state.matchesSource),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
      const transport = yield* Effect.serviceOption(NativeBuildTransport);
      if (Option.isSome(transport))
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            transport.value.observeAuthentication(state.needsRefresh),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        );
      const revalidatePending = Effect.fn("BuilderRegistry.revalidatePending")(
        function* () {
          if (Option.isNone(secretCache)) return;
          const desired = state.snapshot().desired;
          if (!desired) return;
          yield* secretCache.value
            .retainNeeded(
              neededNativeSources(desired, Option.getOrUndefined(nativeState)),
            )
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Native provider retention unavailable", {
                  code: error.code,
                }),
              ),
            );
          yield* secretCache.value
            .revalidatePending(
              desired.builders
                .filter((entry) => entry.enabled)
                .map((entry) => ({
                  source: sourceReference(entry.secretSource),
                  revision: entry.secretRevision,
                  builderId: entry.id,
                  retained: false,
                })),
            )
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "Native provider pending validation unavailable",
                  { code: error.code },
                ),
              ),
            );
        },
      );
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
            if (
              digest === nextDigest &&
              state.snapshot().error === undefined &&
              !capacityError
            ) {
              yield* revalidatePending();
              return;
            }
            const snapshot = yield* parseBuilderRegistry(bytes, settings);
            const blocked = new Set<string>();
            if (Option.isSome(secretCache)) {
              const needed = snapshot.builders
                .filter((entry) => entry.enabled)
                .map((entry) => ({
                  source: sourceReference(entry.secretSource),
                  revision: entry.secretRevision,
                  builderId: entry.id,
                  retained: false,
                }));
              if (Option.isSome(nativeState)) {
                const saved = nativeState.value.snapshot();
                for (const job of saved.jobs.filter(unresolvedRecovery)) {
                  const generation = saved.generations.find(
                    (generation) => generation.id === job.generationId,
                  );
                  if (generation)
                    needed.push({
                      source: generation.transport.source,
                      revision: 0,
                      builderId: job.builderId,
                      retained: true,
                    });
                }
              }
              const capacity = yield* secretCache.value.capacity(needed);
              if (!capacity.sufficient) {
                capacityError = "budget-capacity";
                const previous = state.snapshot();
                for (const entry of snapshot.builders) {
                  const old = previous.desired?.builders.find(
                    (old) => old.id === entry.id,
                  );
                  if (
                    entry.enabled &&
                    entry.secretSource.type === "onepassword" &&
                    (!old?.enabled ||
                      credentialRevision(old) !== credentialRevision(entry) ||
                      previous.entries.find((old) => old.id === entry.id)
                        ?.reason === "budget-capacity")
                  )
                    blocked.add(entry.id);
                }
              } else capacityError = undefined;
            }
            yield* state.publish(
              snapshot,
              state.snapshot().desired ? "registry" : "startup",
              blocked,
            );
            yield* revalidatePending();
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
