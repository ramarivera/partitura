import { Context, Effect, Layer, Option } from "effect";
import { BuilderRegistryFiles } from "./builder-registry-files.js";
import { BuilderRegistryError } from "./builder-registry-json.js";
import {
  type BuilderEntry,
  sourceReference,
} from "./builder-registry-schema.js";
import { normalizeBuilderFileRecord } from "./builder-secret-record.js";
import { BuilderRegistryConfig } from "./config-native-build.js";
import { NativeBuildSecretCache } from "./native-build-secret-cache.js";

export {
  type BuilderCredential,
  normalizeBuilderFileRecord,
} from "./builder-secret-record.js";

export class BuilderSecretProvider extends Context.Service<BuilderSecretProvider>()(
  "BuilderSecretProvider",
  {
    make: Effect.gen(function* () {
      const settings = yield* BuilderRegistryConfig;
      const files = yield* BuilderRegistryFiles;
      const cache = yield* Effect.serviceOption(NativeBuildSecretCache);
      return {
        resolve: Effect.fn("BuilderSecretProvider.resolve")(
          (entry: BuilderEntry, trigger: "startup" | "registry" = "registry") =>
            Effect.scoped(
              Effect.gen(function* () {
                if (entry.secretSource.type !== "file") {
                  if (Option.isNone(cache))
                    return yield* Effect.fail(
                      BuilderRegistryError.new("builder-provider-unavailable"),
                    );
                  return yield* cache.value
                    .resolve(
                      {
                        source: sourceReference(entry.secretSource),
                        revision: entry.secretRevision,
                        builderId: entry.id,
                        retained: false,
                      },
                      trigger,
                    )
                    .pipe(
                      Effect.mapError((error) =>
                        BuilderRegistryError.new(error.code),
                      ),
                    );
                }
                if (!settings.fileSecretRoot)
                  return yield* Effect.fail(
                    BuilderRegistryError.new("builder-file-provider-disabled"),
                  );
                const directory = yield* files.directory(
                  settings.fileSecretRoot,
                );
                const bytes = yield* directory.read(
                  entry.secretSource.name,
                  0o400,
                  65_536,
                );
                return yield* normalizeBuilderFileRecord(
                  bytes,
                  sourceReference(entry.secretSource),
                  settings.suffix,
                );
              }),
            ),
        ),
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(BuilderRegistryFiles.layer),
  );
}
