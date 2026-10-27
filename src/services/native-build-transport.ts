import { constants } from "node:fs";
import { open, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Context, Deferred, Effect, Layer } from "effect";
import {
  cleanupNative,
  NativeOperationError,
  nativeIO,
  nativeResult,
  nativeTry,
} from "./native-build-errors.js";
import {
  missingNativeFile,
  NativeBuildFiles,
  nativeId,
} from "./native-build-files.js";
import { NativeBuildProcesses } from "./native-build-process.js";
import {
  type BrokerEnvelope,
  classifyNativeSsh,
  decodeBrokerEnvelope,
  type NativeBrokerBinding,
  NativeTransportError,
  renderNativeSsh,
  validateNativeTransport,
} from "./native-build-protocol.js";
import {
  type NativeBuildState,
  NativeBuildStateService,
  type NativeGeneration,
  type NativeRegistryJob,
} from "./native-build-state.js";

export {
  hashNativeArtifact,
  publishNativeArtifact,
} from "./native-build-artifact.js";
export * from "./native-build-protocol.js";

export interface NativeTransportSettings {
  readonly signal?: AbortSignal;
  readonly timeout?: number;
  readonly input?: AsyncIterable<Uint8Array>;
}
export interface NativeBrokerTransport {
  envelope(
    generation: NativeGeneration,
    command: string,
    job?: NativeBrokerBinding,
    options?: NativeTransportSettings,
  ): Effect.Effect<BrokerEnvelope, NativeOperationError | NativeTransportError>;
  artifact(
    generation: NativeGeneration,
    job: NativeRegistryJob,
    path: string,
    signal?: AbortSignal,
  ): Effect.Effect<void, NativeOperationError | NativeTransportError>;
  hasCredential(id: string): boolean;
  credentialState?(id: string): "pending" | "available" | "missing" | "failed";
}
export interface NativeTransportOptions {
  readonly suffix: string;
  readonly executable?: string;
  readonly needsRefresh?: (builderId: string) => void;
}

/** Credentials and subprocesses belong to the caller's Effect scope. */
export const createNativeBuildTransport = Effect.fn(
  "NativeBuildTransport.make",
)(function* (state: NativeBuildState, options: NativeTransportOptions) {
  const files = yield* NativeBuildFiles;
  const processes = yield* NativeBuildProcesses;
  const authentication = new Set<
    (builder: string, generation: string) => void
  >();
  const materialized = new Set<string>();
  const missing = new Set<string>();
  const failed = new Set<string>();
  const loading = new Map<
    string,
    Deferred.Deferred<void, NativeOperationError>
  >();
  const removeMaterial = async (id: string) => {
    const directory = state.generationPath(id);
    await cleanupNative([
      ...["identity", "known_hosts", "config"].map((name) => async () => {
        try {
          // Descriptor checks prevent cleanup from unlinking foreign material.
          const { nativeFile } = await import("./native-build-file-io.js");
          await nativeFile(
            join(directory, name),
            name === "identity" ? 0o600 : 0o400,
            65_536,
          );
          await unlink(join(directory, name));
        } catch (error) {
          if (!missingNativeFile(error)) throw error;
        }
      }),
      async () => {
        await rmdir(directory).catch((error: unknown) => {
          if (!missingNativeFile(error)) throw error;
        });
      },
      () => {
        materialized.delete(id);
        missing.delete(id);
        failed.delete(id);
      },
    ]);
  };
  state.registerGenerationCleanup(removeMaterial);
  // State close is also safe for callers explicitly closing before their scope.
  state.registerCredentialCleanup(() =>
    cleanupNative([...materialized].map((id) => () => removeMaterial(id))),
  );
  yield* Effect.addFinalizer(() =>
    nativeIO(() =>
      cleanupNative([...materialized].map((id) => () => removeMaterial(id))),
    ).pipe(Effect.orDie),
  );
  const load = Effect.fn("NativeBuildTransport.load")(function* (
    generation: NativeGeneration,
    key: string,
  ) {
    const directory = state.generationPath(generation.id);
    const operation = Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(files.directory(directory, true), () =>
          materialized.has(generation.id)
            ? Effect.void
            : nativeIO(() => removeMaterial(generation.id)).pipe(Effect.orDie),
        );
        const rendered = yield* nativeTry(() =>
          renderNativeSsh(generation.transport, directory),
        );
        yield* files.write(join(directory, "identity"), key, 0o600);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* processes.acquire(
              [
                "/usr/bin/ssh-keygen",
                "-y",
                "-P",
                "",
                "-f",
                join(directory, "identity"),
              ],
              { timeout: 5_000 },
            );
            owner.child.stdin.end();
            owner.child.stdout.resume();
            owner.child.stderr.resume();
            yield* nativeIO(() => owner.check());
          }),
        );
        yield* files.write(
          join(directory, "known_hosts"),
          rendered.knownHosts,
          0o400,
        );
        yield* files.write(join(directory, "config"), rendered.config, 0o400);
        materialized.add(generation.id);
        missing.delete(generation.id);
        failed.delete(generation.id);
      }),
    );
    yield* operation;
  });
  const materialize = Effect.fn("NativeBuildTransport.materialize")(function* (
    generation: NativeGeneration,
    key: string,
  ) {
    yield* nativeTry(() => {
      const saved = state
        .snapshot()
        .generations.find((candidate) => candidate.id === generation.id);
      if (
        !nativeId.test(generation.id) ||
        !saved ||
        saved.builderId !== generation.builderId ||
        saved.equalityTag !== generation.equalityTag ||
        state.equalityTag(generation.transport, key) !== generation.equalityTag
      )
        throw NativeOperationError.new("native-generation-mismatch");
      validateNativeTransport(generation.transport, key, options.suffix);
    });
    if (materialized.has(generation.id)) return;
    const existing = loading.get(generation.id);
    if (existing) return yield* Deferred.await(existing);
    const deferred = yield* Deferred.make<void, NativeOperationError>();
    loading.set(generation.id, deferred);
    yield* load(generation, key).pipe(
      Effect.ensuring(Effect.sync(() => loading.delete(generation.id))),
      Effect.onExit((exit) => Deferred.done(deferred, exit)),
    );
  });
  const run = Effect.fn("NativeBuildTransport.run")(
    (
      generation: NativeGeneration,
      command: string,
      settings: NativeTransportSettings & {
        output?: string;
        maximum?: number;
      } = {},
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (!materialized.has(generation.id))
            return yield* Effect.fail(
              NativeTransportError.new("missing-credentials"),
            );
          if (
            !/^(?:health|(?:status|cancel|artifact|reconcile) [a-f0-9]{32}|run-v2 [a-f0-9]{32} [a-f0-9]{40} [1-9][0-9]{0,7} [a-z][a-z0-9-]{0,63} [1-9][0-9]{0,9} (?:0|[1-9][0-9]{0,4}) [a-f0-9]{32} [a-f0-9]{32} [1-9][0-9]{0,9})$/u.test(
              command,
            )
          )
            return yield* Effect.fail(
              NativeOperationError.new("invalid-native-command"),
            );
          const config = join(state.generationPath(generation.id), "config");
          yield* files.file(config, 0o400, 65_536);
          yield* Effect.acquireRelease(
            nativeTry(() => state.retainGeneration(generation.id)),
            (release) => Effect.sync(release),
          );
          const owner = yield* processes.acquire(
            [
              options.executable ?? "/usr/bin/ssh",
              "-F",
              config,
              "partitura-native",
              command,
            ],
            {
              timeout: settings.timeout ?? 30_000,
              ...(settings.signal ? { signal: settings.signal } : {}),
            },
          );
          const child = owner.child;
          const output = settings.output
            ? yield* nativeIO(() =>
                open(
                  settings.output ?? "",
                  constants.O_WRONLY |
                    constants.O_CREAT |
                    constants.O_EXCL |
                    constants.O_NOFOLLOW,
                  0o600,
                ),
              )
            : undefined;
          const diagnostic: Buffer[] = [],
            chunks: Buffer[] = [];
          let diagnosticBytes = 0,
            truncated = false,
            size = 0;
          const drain = nativeResult(
            (async () => {
              for await (const chunk of child.stderr) {
                const bytes = Buffer.from(chunk);
                if (diagnosticBytes < 32768)
                  diagnostic.push(bytes.subarray(0, 32768 - diagnosticBytes));
                diagnosticBytes += bytes.length;
                truncated ||= diagnosticBytes > 32768;
              }
            })(),
          );
          const transferAbort = new AbortController();
          const transfer = nativeResult(
            (async () => {
              const destination = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  if (output)
                    output.writeFile(chunk).then(
                      () => callback(),
                      (error: unknown) =>
                        callback(
                          NativeOperationError.new(
                            "native-output-failed",
                            error,
                          ),
                        ),
                    );
                  else {
                    chunks.push(chunk);
                    callback();
                  }
                },
              });
              const limiter = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                  size += chunk.length;
                  callback(
                    size > (settings.maximum ?? 4096)
                      ? NativeOperationError.new(
                          "native-transfer-exceeds-limit",
                        )
                      : null,
                    chunk,
                  );
                },
              });
              const upload = nativeResult(
                settings.input
                  ? pipeline(Readable.from(settings.input), child.stdin, {
                      signal: transferAbort.signal,
                    })
                  : Promise.resolve(child.stdin.end()).then(() => undefined),
              );
              const [uploaded, downloaded, exited, diagnosticResult] =
                await Promise.all([
                  upload,
                  nativeResult(
                    pipeline(child.stdout, limiter, destination, {
                      signal: transferAbort.signal,
                    }),
                  ),
                  owner.completion,
                  drain,
                ]);
              if (!diagnosticResult.ok) throw diagnosticResult.error;
              if (output && downloaded.ok) await output.sync();
              return { uploaded, downloaded, exited };
            })(),
          );
          // Registered after the process owner, so interruption kills/reaps, drains
          // outstanding IO, then closes the output descriptor before lease release.
          yield* Effect.addFinalizer(() =>
            nativeIO(() =>
              cleanupNative([
                () => transferAbort.abort(),
                () => owner.finish(),
                async () => {
                  await transfer;
                },
                async () => {
                  await output?.close();
                },
              ]),
            ).pipe(Effect.orDie),
          );
          const result = yield* nativeIO(() => transfer);
          if (!result.ok)
            return yield* Effect.fail(
              NativeTransportError.new("unavailable", result.error),
            );
          const { uploaded, downloaded, exited } = result.value;
          if (!downloaded.ok)
            return yield* Effect.fail(
              NativeTransportError.new(
                downloaded.error instanceof NativeOperationError &&
                  downloaded.error.reason === "native-transfer-exceeds-limit" &&
                  exited.error === undefined &&
                  (exited.code === 0 || exited.code === 1) &&
                  !settings.signal?.aborted
                  ? "protocol-mismatch"
                  : "unavailable",
                downloaded.error,
              ),
            );
          if (
            exited.error !== undefined ||
            (exited.code !== 0 && exited.code !== 1) ||
            settings.signal?.aborted
          ) {
            const reason = classifyNativeSsh(
              Buffer.concat(diagnostic).toString(),
              truncated,
            );
            if (reason === "needs-refresh") {
              options.needsRefresh?.(generation.builderId);
              for (const notify of authentication)
                notify(generation.builderId, generation.id);
            }
            return yield* Effect.fail(
              NativeTransportError.new(reason, exited.error),
            );
          }
          return {
            output: Buffer.concat(chunks).toString(),
            code: exited.code,
            inputBroken: !uploaded.ok,
            uploadError: uploaded.ok ? undefined : uploaded.error,
            size,
          };
        }),
      ),
  );
  const envelope = Effect.fn("NativeBuildTransport.envelope")(function* (
    generation: NativeGeneration,
    command: string,
    job?: NativeBrokerBinding,
    settings?: NativeTransportSettings,
  ) {
    const result = yield* run(generation, command, settings);
    const value = yield* Effect.try({
      try: () => decodeBrokerEnvelope(result.output, generation, job),
      catch: (error) =>
        error instanceof NativeTransportError
          ? error
          : NativeTransportError.new("protocol-mismatch", error),
    });
    if (
      command.startsWith("run-v2 ") &&
      (!["known", "refused"].includes(value.kind) ||
        (result.inputBroken &&
          !(
            (value.kind === "refused" && value.accepted === false) ||
            (value.kind === "known" &&
              value.state === "failed" &&
              value.stage === "disk-preflight")
          )) ||
        (value.kind === "refused" && result.code !== 1) ||
        (value.kind === "known" &&
          result.code !== (value.state === "succeeded" ? 0 : 1)))
    )
      return yield* Effect.fail(
        NativeTransportError.new("protocol-mismatch", result.uploadError),
      );
    return value;
  });
  return {
    observeAuthentication: (
      notify: (builder: string, generation: string) => void,
    ) => {
      authentication.add(notify);
      return () => {
        authentication.delete(notify);
      };
    },
    materialize,
    restore: Effect.fn("NativeBuildTransport.restore")(function* (
      source: string,
      keys: readonly string[],
    ) {
      if (keys.length > 2)
        return yield* Effect.fail(
          NativeOperationError.new("too-many-native-keys"),
        );
      const failures: { generationId: string; error: NativeOperationError }[] =
        [];
      for (const generation of state
        .snapshot()
        .generations.filter((g) => g.transport.source === source)) {
        const key = keys.find(
          (candidate) =>
            state.equalityTag(generation.transport, candidate) ===
            generation.equalityTag,
        );
        if (!key) {
          failed.delete(generation.id);
          missing.add(generation.id);
          continue;
        }
        yield* materialize(generation, key).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              failures.push({ generationId: generation.id, error });
              failed.add(generation.id);
            }),
          ),
        );
      }
      return { failures };
    }),
    hasCredential: (id: string) => materialized.has(id),
    credentialState: (
      id: string,
    ): "pending" | "available" | "missing" | "failed" =>
      materialized.has(id)
        ? "available"
        : failed.has(id)
          ? "failed"
          : missing.has(id)
            ? "missing"
            : "pending",
    envelope,
    artifact: Effect.fn("NativeBuildTransport.artifact")(function* (
      generation: NativeGeneration,
      job: NativeRegistryJob,
      path: string,
      signal?: AbortSignal,
    ) {
      const result = yield* run(generation, `artifact ${job.jobId}`, {
        output: path,
        maximum: job.artifactBytes ?? 0,
        timeout: 180_000,
        ...(signal ? { signal } : {}),
      });
      if (result.code !== 0 || result.size !== job.artifactBytes)
        return yield* Effect.fail(
          NativeOperationError.new("native-artifact-size-mismatch"),
        );
    }),
    dispose: Effect.fn("NativeBuildTransport.dispose")(function* (id: string) {
      if (!materialized.has(id))
        return yield* Effect.fail(
          NativeOperationError.new("native-generation-not-found"),
        );
      if (state.generationInUse(id))
        return yield* Effect.fail(
          NativeOperationError.new("native-generation-in-use"),
        );
      yield* nativeIO(() => removeMaterial(id));
    }),
  };
});
export class NativeTransportConfig extends Context.Service<
  NativeTransportConfig,
  NativeTransportOptions
>()("NativeTransportConfig") {}
export class NativeBuildTransport extends Context.Service<NativeBuildTransport>()(
  "NativeBuildTransport",
  {
    make: Effect.gen(function* () {
      return yield* createNativeBuildTransport(
        yield* NativeBuildStateService,
        yield* NativeTransportConfig,
      );
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(NativeBuildFiles.layer, NativeBuildProcesses.layer),
    ),
  );
}
