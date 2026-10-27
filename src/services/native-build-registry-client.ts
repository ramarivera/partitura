import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Cause, Context, Effect, Fiber, Layer, Scope } from "effect";
import { nativeGitBundle } from "./native-build-bundle.js";
import {
  NativeOperationError,
  nativeFailureCode,
  nativeIO,
  nativeTry,
} from "./native-build-errors.js";
import { NativeBuildFiles, opaqueId } from "./native-build-files.js";
import {
  applyNativeReceipt,
  cleanNativeHealth,
  createNativeBuildRecovery,
  recoverNativeMetadata,
} from "./native-build-recovery.js";
import {
  type NativeBuildState,
  NativeBuildStateService,
  type NativeRegistryJob,
  nativeLimits,
  newRecovery,
  terminalNativeJob,
  unresolvedRecovery,
} from "./native-build-state.js";
import {
  type NativeBrokerTransport,
  NativeBuildTransport,
  publishNativeArtifact,
} from "./native-build-transport.js";

export { nativeGitBundle } from "./native-build-bundle.js";
export interface RegistryBuildRequest {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly workspacePath: string;
  readonly workerUid?: string;
  readonly commit: string;
  readonly pullRequest: number;
  readonly action: string;
  /** Selected by the gateway, never model arguments. */
  readonly secretFiles?: Readonly<Record<string, string>>;
}
export interface NativeEngineOptions {
  readonly now?: () => number;
  readonly prepareBundle?: (
    request: RegistryBuildRequest,
    job: NativeRegistryJob,
  ) => Effect.Effect<
    AsyncIterable<Uint8Array>,
    NativeOperationError,
    Scope.Scope
  >;
  /** Future registry admission checks, immediately before dispatch. */
  readonly canSubmit: (job: NativeRegistryJob) => boolean;
}

/** Internal engine only. Neither legacy production slot routes through here. */
export const createRegistryNativeBuildClient = Effect.fn(
  "RegistryNativeBuildClient.make",
)(function* (
  state: NativeBuildState,
  transport: NativeBrokerTransport,
  options: NativeEngineOptions,
) {
  const now = options.now ?? Date.now;
  const scope = yield* Scope.Scope;
  const files = yield* NativeBuildFiles.make;
  yield* recoverNativeMetadata(state, now());
  const recovery = createNativeBuildRecovery(state, transport, { now });
  const active = new Map<string, Fiber.Fiber<void, never>>();
  const failures = new Map<string, NativeOperationError>();
  let closing = false;
  const generationOf = (id: string) =>
    nativeTry(() => {
      const generation = state.snapshot().generations.find((g) => g.id === id);
      if (!generation)
        throw NativeOperationError.new("native-generation-not-found");
      return generation;
    });
  const recordFailure = (
    id: string,
    error: NativeOperationError,
    interrupted: boolean,
  ) =>
    state.transaction((draft) => {
      failures.set(id, error);
      const current = draft.jobs.find((j) => j.jobId === id);
      if (!current) throw NativeOperationError.new("native-job-not-found");
      if (current.state === "starting") {
        current.state = interrupted ? "interrupted" : "failed";
        current.updatedAt = now();
        current.failureCode = nativeFailureCode(error);
      } else if (current.recovery.state === "not-required") {
        current.recovery.state = "pending";
        current.recovery.deadline = now() + 900_000;
        current.recovery.nextAt = now();
      }
    });
  const stop = Effect.fn("RegistryNativeBuildClient.stop")(function* () {
    closing = true;
    for (const fiber of [...active.values()]) yield* Fiber.interrupt(fiber);
  });
  yield* Effect.addFinalizer(() => stop());
  return {
    recovery,
    failure: (id: string) => failures.get(id),
    start: Effect.fn("RegistryNativeBuildClient.start")(function* (
      request: RegistryBuildRequest,
    ) {
      if (closing)
        return yield* Effect.fail(
          NativeOperationError.new("native-engine-closed"),
        );
      const secret = yield* nativeTry(() => {
        const entries = Object.entries(request.secretFiles ?? {});
        if (
          entries.length > 16 ||
          entries.some(
            ([key, value]) =>
              !/^[a-z][a-z0-9-]{0,63}$/u.test(key) || typeof value !== "string",
          )
        )
          throw NativeOperationError.new("invalid-native-secrets");
        const bytes = entries.length
          ? Buffer.from(JSON.stringify(Object.fromEntries(entries)))
          : Buffer.alloc(0);
        if (bytes.length > 65_536)
          throw NativeOperationError.new("native-secrets-too-large");
        return bytes;
      });
      const generation = yield* generationOf(request.generationId);
      if (!transport.hasCredential(generation.id))
        return yield* Effect.fail(
          NativeOperationError.new("missing-credentials"),
        );
      const health = yield* transport.envelope(generation, "health");
      if (
        health.kind !== "health" ||
        health.hostId !== generation.transport.hostId ||
        !health.accepting ||
        health.status !== "ready" ||
        !health.epoch
      )
        return yield* Effect.fail(
          NativeOperationError.new("native-builder-unavailable"),
        );
      const job = yield* state.transaction((draft) => {
        if (
          closing ||
          draft.jobs.some(
            (j) =>
              (j.verifiedHostId === generation.transport.hostId ||
                (j.organizationId === request.organizationId &&
                  j.sessionId === request.sessionId)) &&
              (!terminalNativeJob(j) || unresolvedRecovery(j)),
          )
        )
          throw NativeOperationError.new("native-builder-reserved");
        const job: NativeRegistryJob = {
          version: 1,
          jobId: opaqueId(),
          organizationId: request.organizationId,
          sessionId: request.sessionId,
          builderId: generation.builderId,
          generationId: generation.id,
          verifiedHostId: generation.transport.hostId,
          commit: request.commit,
          pullRequest: request.pullRequest,
          action: request.action,
          attempt: opaqueId(),
          epoch: health.epoch ?? "",
          submissionExpiresAt: 0,
          state: "starting",
          recovery: newRecovery(),
          createdAt: now(),
          updatedAt: now(),
        };
        if (!options.canSubmit(job))
          throw NativeOperationError.new("native-admission-closed");
        draft.jobs.push(job);
        return job;
      });
      const task = Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            nativeTry(() => [
              state.retainGeneration(generation.id),
              state.retainJob(job.jobId),
            ]),
            (releases) =>
              Effect.sync(() => {
                for (const release of releases) release();
              }),
          );
          yield* state.prune();
          const bundlePath = yield* Effect.scoped(
            Effect.gen(function* () {
              const reservation = yield* Effect.acquireRelease(
                state.reserve(job, "source.bundle", nativeLimits.bundle),
                (reservation) => reservation.release().pipe(Effect.orDie),
              );
              const input = yield* (options.prepareBundle ?? nativeGitBundle)(
                request,
                job,
              );
              const size = yield* files.stream(
                reservation.path,
                input,
                nativeLimits.bundle,
              );
              if (!size)
                return yield* Effect.fail(
                  NativeOperationError.new("native-bundle-empty"),
                );
              yield* reservation.commit();
              return reservation.path;
            }),
          );
          yield* Effect.addFinalizer(() =>
            state.remove(bundlePath).pipe(Effect.orDie, Effect.asVoid),
          );
          const submitted = yield* state.transaction((draft) => {
            const current = draft.jobs.find((j) => j.jobId === job.jobId);
            if (
              current?.state !== "starting" ||
              closing ||
              !options.canSubmit(current)
            )
              throw NativeOperationError.new("native-submission-closed");
            current.state = "submitting";
            current.submissionExpiresAt = Math.floor(now() / 1000) + 120;
            current.updatedAt = now();
            return current;
          });
          const file = yield* Effect.acquireRelease(
            nativeIO(() =>
              open(bundlePath, constants.O_RDONLY | constants.O_NOFOLLOW),
            ),
            (file) => nativeIO(() => file.close()).pipe(Effect.orDie),
          );
          const info = yield* nativeIO(() => file.stat());
          const input = (async function* () {
            if (secret.length) yield secret;
            for await (const bytes of file.createReadStream({
              autoClose: false,
            }))
              yield Buffer.from(bytes);
          })();
          const receipt = yield* transport.envelope(
            generation,
            `run-v2 ${job.jobId} ${job.commit} ${job.pullRequest} ${job.action} ${info.size} ${secret.length} ${job.epoch} ${job.attempt} ${submitted.submissionExpiresAt}`,
            submitted,
            { input, timeout: 3_600_000 },
          );
          let cleanTerminal = false;
          if (receipt.kind === "known" && receipt.state === "succeeded") {
            const finalHealth = yield* transport.envelope(
              generation,
              "health",
              undefined,
              { timeout: 30_000 },
            );
            cleanTerminal =
              finalHealth.hostId === job.verifiedHostId &&
              finalHealth.epoch === job.epoch &&
              cleanNativeHealth(finalHealth) === true;
          }
          yield* state.transaction((draft) => {
            const current = draft.jobs.find((j) => j.jobId === job.jobId);
            if (!current)
              throw NativeOperationError.new("native-job-not-found");
            if (receipt.kind === "known") applyNativeReceipt(current, receipt);
            else if (receipt.kind === "refused" && receipt.accepted === false) {
              current.state = "failed";
              current.failureCode = receipt.code ?? "refused";
            } else
              throw NativeOperationError.new("invalid-native-run-response");
            current.updatedAt = now();
            if (cleanTerminal) {
              current.recovery.state = "resolved-terminal";
              current.recovery.resolvedEpoch = job.epoch;
            } else if (
              !(receipt.kind === "refused" && receipt.code === "host-busy")
            ) {
              current.recovery.state = "pending";
              current.recovery.deadline = now() + 900_000;
              current.recovery.nextAt = now();
            }
          });
        }),
      ).pipe(
        Effect.catchCause((cause) => {
          const interrupted = Cause.hasInterrupts(cause);
          const error = NativeOperationError.new(
            interrupted
              ? "native-job-interrupted"
              : "native-job-operation-failed",
            cause,
          );
          return recordFailure(job.jobId, error, interrupted).pipe(
            Effect.catch((writeError) =>
              Effect.sync(() => {
                failures.set(
                  job.jobId,
                  NativeOperationError.new("native-job-finalization-failed", {
                    operation: error,
                    persistence: writeError,
                  }),
                );
              }),
            ),
          );
        }),
        Effect.ensuring(Effect.sync(() => active.delete(job.jobId))),
      );
      const fiber = yield* Effect.forkIn(task, scope);
      active.set(job.jobId, fiber);
      return job;
    }),
    status: Effect.fn("RegistryNativeBuildClient.status")(
      (organization: string, session: string, id: string, builder?: string) =>
        nativeTry(() => state.owned(organization, session, id, builder)),
    ),
    artifact: Effect.fn("RegistryNativeBuildClient.artifact")(function* (
      organization: string,
      session: string,
      id: string,
      builder?: string,
    ) {
      const job = yield* nativeTry(() =>
        state.owned(organization, session, id, builder),
      );
      if (
        !(
          job.state === "succeeded" ||
          (job.state === "failed" && job.failureCode === "workflow-failed")
        )
      )
        return yield* Effect.fail(
          NativeOperationError.new("native-artifact-unavailable"),
        );
      return yield* publishNativeArtifact(
        state,
        transport,
        yield* generationOf(job.generationId),
        job,
      );
    }),
    cancel: Effect.fn("RegistryNativeBuildClient.cancel")(function* (
      organization: string,
      session: string,
      id: string,
      builder?: string,
    ) {
      yield* nativeTry(() => state.owned(organization, session, id, builder));
      const fiber = active.get(id);
      if (fiber) yield* Fiber.interrupt(fiber);
      yield* recovery.request(id);
      yield* recovery.tick(id);
    }),
    wait: Effect.fn("RegistryNativeBuildClient.wait")(function* (id: string) {
      const fiber = active.get(id);
      if (fiber) yield* Fiber.join(fiber);
    }),
    close: Effect.fn("RegistryNativeBuildClient.close")(function* () {
      yield* stop();
      // All jobs are attempted even if a recovery write fails.
      const exits = yield* Effect.all(
        state
          .snapshot()
          .jobs.filter(
            (job) => !terminalNativeJob(job) || unresolvedRecovery(job),
          )
          .map((job) =>
            Effect.exit(
              recovery
                .request(job.jobId)
                .pipe(Effect.andThen(recovery.tick(job.jobId))),
            ),
          ),
      );
      const failed = exits.filter((exit) => exit._tag === "Failure");
      if (failed.length)
        return yield* Effect.fail(
          NativeOperationError.new("native-engine-close-failed", failed),
        );
    }),
  };
});
export class NativeEngineConfig extends Context.Service<
  NativeEngineConfig,
  NativeEngineOptions
>()("NativeEngineConfig") {}
export class RegistryNativeBuildClient extends Context.Service<RegistryNativeBuildClient>()(
  "RegistryNativeBuildClient",
  {
    make: Effect.gen(function* () {
      return yield* createRegistryNativeBuildClient(
        yield* NativeBuildStateService,
        yield* NativeBuildTransport,
        yield* NativeEngineConfig,
      );
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
