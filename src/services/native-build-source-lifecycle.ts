import { Effect } from "effect";
import { BuilderRegistry } from "./builder-registry.js";
import { sourceReference } from "./builder-registry-schema.js";
import { normalizeBuilderFileRecord } from "./builder-secret-record.js";
import { BuilderRegistryConfig } from "./config-native-build.js";
import { NativeBuildSecretCache } from "./native-build-secret-cache.js";
import { NativeSecretError } from "./native-build-secret-protocol.js";
import { NativeSecretSourceReader } from "./native-build-secret-reader.js";
import { neededNativeSources } from "./native-build-source-inventory.js";
import {
  NativeBuildStateService,
  unresolvedRecovery,
} from "./native-build-state.js";
import { NativeBuildTransport } from "./native-build-transport.js";
/** Restore removed sources independently of the current admission pool. No build triggers reads. */
export const retainedStartup = Effect.gen(function* () {
  const registry = yield* BuilderRegistry;
  const state = yield* NativeBuildStateService;
  const cache = yield* NativeBuildSecretCache;
  const reader = yield* NativeSecretSourceReader;
  const transport = yield* NativeBuildTransport;
  const settings = yield* BuilderRegistryConfig;
  const attempted = new Set<string>();
  const sweep = Effect.fn("NativeBuildSources.sweep")(function* () {
    const view = registry.snapshot();
    if (!view.desired || view.error) return;
    yield* cache.retainNeeded(neededNativeSources(view.desired, state));
    const enabled = new Set(
      view.desired.builders
        .filter(
          (entry) =>
            entry.enabled &&
            view.entries.find((current) => current.id === entry.id)?.reason !==
              "budget-capacity",
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
    for (const source of sources.values()) {
      const key = `${source.source}:${snapshot.jobs
        .filter(unresolvedRecovery)
        .filter(
          (job) =>
            snapshot.generations.find((g) => g.id === job.generationId)
              ?.transport.source === source.source,
        )
        .map((job) => job.generationId)
        .sort()
        .join(",")}`;
      if (attempted.has(key)) continue;
      attempted.add(key);
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
    }
  });
  yield* sweep().pipe(
    Effect.catch((error) =>
      Effect.logWarning("Native source inventory unavailable", {
        code: error.code,
      }),
    ),
  );
  yield* Effect.forever(
    Effect.sleep(1000).pipe(
      Effect.andThen(sweep()),
      Effect.catch((error) =>
        Effect.logWarning("Native source inventory unavailable", {
          code: error.code,
        }),
      ),
    ),
  ).pipe(Effect.forkScoped);
});
