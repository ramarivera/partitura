import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { hashNativeArtifact as hash } from "./native-build-artifact-io.js";
import {
  NativeOperationError,
  nativeIO,
  nativeTry,
} from "./native-build-errors.js";
import { missingNativeFile } from "./native-build-files.js";
import {
  type NativeBuildState,
  NativeBuildStateService,
  type NativeGeneration,
  type NativeRegistryJob,
  nativeLimits,
} from "./native-build-state.js";
import {
  type NativeBrokerTransport,
  NativeBuildTransport,
} from "./native-build-transport.js";
export const hashNativeArtifact = Effect.fn("NativeBuildArtifact.hash")(
  (path: string) => nativeIO(() => hash(path)),
);

/** The reservation remains charged across rename. Consumer leases are scoped. */
export const publishNativeArtifact = Effect.fn("NativeBuildArtifact.publish")(
  function* (
    state: NativeBuildState,
    transport: NativeBrokerTransport,
    generation: NativeGeneration,
    job: NativeRegistryJob,
  ) {
    if (
      job.artifactBytes === undefined ||
      job.artifactBytes > nativeLimits.artifact ||
      !job.artifactSha256 ||
      job.artifactExpired
    )
      return yield* Effect.fail(
        NativeOperationError.new("native-artifact-unavailable"),
      );
    const path = join(state.jobPath(job), "artifact.tar");
    const leases = yield* Effect.acquireRelease(
      nativeTry(() => ({
        generation: state.retainGeneration(generation.id),
        job: state.retainJob(job.jobId),
        file: state.retainFile(path),
      })),
      (leases) =>
        Effect.sync(() => {
          leases.file();
          leases.job();
          leases.generation();
        }),
    );
    return yield* Effect.gen(function* () {
      const cached = yield* hashNativeArtifact(path).pipe(
        Effect.map(
          (actual) =>
            actual.sha256 === job.artifactSha256 &&
            actual.bytes === job.artifactBytes,
        ),
        Effect.catch((error) =>
          missingNativeFile(error.cause)
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      );
      if (!cached) {
        if (state.fileLeaseCount(path) !== 1)
          return yield* Effect.fail(
            NativeOperationError.new("native-artifact-in-use"),
          );
        leases.file();
        if (!(yield* state.remove(path)))
          return yield* Effect.fail(
            NativeOperationError.new("native-artifact-in-use"),
          );
        leases.file = state.retainFile(path);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* state.prune();
            const reservation = yield* Effect.acquireRelease(
              state.reserve(job, "artifact.partial", job.artifactBytes ?? 0),
              (reservation) => reservation.release().pipe(Effect.orDie),
            );
            yield* transport.artifact(generation, job, reservation.path);
            const fetched = yield* hashNativeArtifact(reservation.path);
            if (
              fetched.sha256 !== job.artifactSha256 ||
              fetched.bytes !== job.artifactBytes
            )
              return yield* Effect.fail(
                NativeOperationError.new("native-artifact-mismatch"),
              );
            yield* reservation.commit(path);
          }),
        );
      }
      let released = false;
      return {
        path,
        bytes: job.artifactBytes,
        sha256: job.artifactSha256,
        release: () => {
          if (!released) {
            released = true;
            leases.file();
            leases.job();
            leases.generation();
          }
        },
      };
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure"
          ? Effect.sync(() => {
              leases.file();
              leases.job();
              leases.generation();
            })
          : Effect.void,
      ),
    );
  },
);
export class NativeBuildArtifact extends Context.Service<NativeBuildArtifact>()(
  "NativeBuildArtifact",
  {
    make: Effect.gen(function* () {
      const state = yield* NativeBuildStateService,
        transport = yield* NativeBuildTransport;
      return {
        publish: Effect.fn("NativeBuildArtifact.publishOwned")(
          (job: NativeRegistryJob, generation: NativeGeneration) =>
            publishNativeArtifact(state, transport, generation, job),
        ),
        hash: hashNativeArtifact,
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
