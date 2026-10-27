import { Context, Effect, Layer, Scope } from "effect";
import { BuilderRegistryError } from "./builder-registry-json.js";
import type { BuilderEntry } from "./builder-registry-schema.js";
import type { BuilderCredential } from "./builder-secret-provider.js";
import { nativeTry } from "./native-build-errors.js";
import {
  NativeBuildStateService,
  type NativeGeneration,
  terminalNativeJob,
  unresolvedRecovery,
} from "./native-build-state.js";
import {
  type BrokerEnvelope,
  NativeBuildTransport,
} from "./native-build-transport.js";

export interface BuilderIdentityResult {
  readonly generation: NativeGeneration;
  readonly health: BrokerEnvelope;
}
/** Cache-only health and immutable generation construction. No provider access. */
export class BuilderRegistryIdentity extends Context.Service<BuilderRegistryIdentity>()(
  "BuilderRegistryIdentity",
  {
    make: Effect.gen(function* () {
      const state = yield* NativeBuildStateService;
      const transport = yield* NativeBuildTransport;
      const retain = Effect.fn("BuilderRegistryIdentity.retain")((id: string) =>
        Effect.acquireRelease(
          nativeTry(() => state.retainGeneration(id)),
          (release) => Effect.sync(release),
        ).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            BuilderRegistryError.new("builder-generation-unavailable", cause),
          ),
        ),
      );
      return {
        retain,
        verify: Effect.fn("BuilderRegistryIdentity.verify")(
          (
            entry: BuilderEntry,
            credential: BuilderCredential,
            // A caller-owned hold keeps the generation pinned after verify returns.
            hold?: Scope.Scope,
          ) =>
            Effect.scoped(
              Effect.gen(function* () {
                const generation = yield* state.addGeneration(
                  entry.id,
                  credential.transport,
                  credential.privateKey,
                );
                yield* hold === undefined
                  ? retain(generation.id)
                  : retain(generation.id).pipe(
                      Effect.provideService(Scope.Scope, hold),
                    );
                yield* transport.materialize(generation, credential.privateKey);
                const health = yield* transport.envelope(generation, "health");
                return { generation, health } satisfies BuilderIdentityResult;
              }),
            ).pipe(
              Effect.mapError((cause) =>
                BuilderRegistryError.new("builder-health-unavailable", cause),
              ),
            ),
        ),
        reserved: (hostId: string) =>
          state
            .snapshot()
            .jobs.some(
              (job) =>
                job.verifiedHostId === hostId &&
                (!terminalNativeJob(job) || unresolvedRecovery(job)),
            ),
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  // The assembly must provide the same state/transport instances to both services.
  static readonly layer = this.layerWithoutDependencies;
}
