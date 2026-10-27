import { Context, Effect, Exit, Layer, Option, Scope } from "effect";
import { type BuilderAdmission, BuilderRegistry } from "./builder-registry.js";
import { NativeOperationError } from "./native-build-errors.js";
import {
  createRegistryNativeBuildClient,
  type NativeEngineOptions,
  type RegistryBuildRequest,
} from "./native-build-registry-client.js";
import {
  NativeBuildStateService,
  terminalNativeJob,
  unresolvedRecovery,
} from "./native-build-state.js";
import { NativeBuildTransport } from "./native-build-transport.js";

/** The sole registry-mode job boundary. Selection is once, before ownership is persisted. */
export class NativeBuildJobs extends Context.Service<NativeBuildJobs>()(
  "NativeBuildJobs",
  {
    make: Effect.gen(function* () {
      const registry = yield* BuilderRegistry;
      const state = yield* NativeBuildStateService;
      const transport = yield* NativeBuildTransport;
      const scope = yield* Scope.Scope;
      const admissions = new Map<string, BuilderAdmission>();
      const engine = yield* createRegistryNativeBuildClient(state, transport, {
        metadataRecovered: true,
        preparationSignal: (job) => admissions.get(job.generationId)?.signal,
        canSubmit: (job) => {
          const admission = admissions.get(job.generationId);
          return (
            !!admission &&
            !admission.signal.aborted &&
            registry.current(job.builderId)?.entry.enabled === true
          );
        },
        submit: (job, persist) => {
          const admission = admissions.get(job.generationId);
          return admission
            ? registry
                .submit(admission, () => persist)
                .pipe(
                  Effect.mapError((cause) =>
                    NativeOperationError.new("native-submission-closed", cause),
                  ),
                )
            : Effect.fail(NativeOperationError.new("native-submission-closed"));
        },
        ...Option.getOrElse(
          yield* Effect.serviceOption(NativeJobPreparation),
          () => ({}),
        ),
      });
      const start = Effect.fn("NativeBuildJobs.start")(function* (
        request: Omit<RegistryBuildRequest, "generationId"> & {
          readonly builder?: string;
        },
      ) {
        const hold = yield* Scope.fork(scope);
        let generationId: string | undefined;
        const admitted = registry
          .admit(request.builder)
          .pipe(Effect.provideService(Scope.Scope, hold));
        return yield* Effect.gen(function* () {
          const admission = yield* admitted;
          generationId = admission.generationId;
          admissions.set(admission.generationId, admission);
          const job = yield* engine.start({
            ...request,
            generationId: admission.generationId,
          });
          yield* engine.wait(job.jobId).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                if (admissions.get(admission.generationId) === admission)
                  admissions.delete(admission.generationId);
                yield* Scope.close(hold, Exit.void);
              }),
            ),
            Effect.forkIn(scope),
          );
          return job;
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.gen(function* () {
                  if (generationId) admissions.delete(generationId);
                  yield* Scope.close(hold, exit);
                })
              : Effect.void,
          ),
        );
      });
      yield* Effect.addFinalizer(() =>
        engine.close().pipe(
          Effect.catch((error) =>
            Effect.logWarning("Native engine shutdown recovery incomplete", {
              code: error.reason,
            }),
          ),
        ),
      );
      // Recovery is cache-only and never a build/refresh trigger. Remote outages do not hold boot.
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* () {
            yield* Effect.forEach(
              state.snapshot().jobs.filter(unresolvedRecovery),
              (job) => engine.recovery.tick(job.jobId),
              { concurrency: 4, discard: true },
            );
            yield* Effect.sleep(5000);
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Native recovery unavailable", {
                code: error.reason,
              }).pipe(Effect.andThen(Effect.sleep(5000))),
            ),
          ),
        ),
      );
      const checkHealth = Effect.fn("NativeBuildJobs.checkHealth")(
        function* () {
          for (const entry of registry.snapshot().desired?.builders ?? [])
            if (entry.enabled) yield* registry.refreshHealth(entry.id, true);
        },
      );
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep(10_000).pipe(Effect.andThen(checkHealth())),
        ),
      );
      return {
        ...engine,
        checkHealth,
        start,
        availability: () =>
          registry.snapshot().entries.map((entry) => ({
            id: entry.id,
            available: entry.available,
          })),
        cancelSession: Effect.fn("NativeBuildJobs.cancelSession")(function* (
          organization: string,
          session: string,
        ) {
          for (const job of state.snapshot().jobs)
            if (
              job.organizationId === organization &&
              job.sessionId === session &&
              (!terminalNativeJob(job) || unresolvedRecovery(job))
            )
              yield* engine.cancel(organization, session, job.jobId).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Native session cleanup incomplete", {
                    code: error.reason,
                  }),
                ),
              );
        }),
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies;
}
/** Hermetic bundle adapter; absent in production. */
export class NativeJobPreparation extends Context.Service<
  NativeJobPreparation,
  Pick<NativeEngineOptions, "prepareBundle">
>()("NativeJobPreparation") {}
