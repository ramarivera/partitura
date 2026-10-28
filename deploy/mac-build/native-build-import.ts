import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import {
  NativeBuildJobSchema,
  validateNativeBuildDiagnostics,
} from "../../src/services/native-build-client.js";
import {
  NativeOperationError,
  nativeIO,
  nativeTry,
} from "../../src/services/native-build-errors.js";
import {
  missingNativeFile,
  NativeBuildFiles,
  opaqueId,
} from "../../src/services/native-build-files.js";
import {
  type NativeBuildState,
  NativeBuildStateService,
  type NativeRegistryJob,
  type NativeTransportMetadata,
  newRecovery,
} from "../../src/services/native-build-state.js";
import {
  type createNativeBuildTransport,
  hashNativeArtifact,
  NativeBuildTransport,
  validateNativeTransport,
} from "../../src/services/native-build-transport.js";
/** No SSH config parser, ssh -G, network probe, or arbitrary SSH option exists
 * in this importer. Exact independently verified pins are the only input. */
export function importNativeKnownHosts(
  bytes: string,
  hostname: string,
  port: number,
) {
  const lookup = port === 22 ? hostname : `[${hostname}]:${port}`;
  const lines = bytes.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length || lines.length > 4)
    throw NativeOperationError.new("invalid-import-pins");
  const pins = lines.map((line) => {
    const fields = line.split(" ");
    if (fields.length !== 3 || fields[0] !== lookup || !fields[1] || !fields[2])
      throw NativeOperationError.new("invalid-import-pins");
    return { type: fields[1], base64: fields[2] };
  });
  if (
    new Set(pins.map((pin) => `${pin.type} ${pin.base64}`)).size !== pins.length
  )
    throw NativeOperationError.new("invalid-import-pins");
  return pins;
}

export interface LegacyNativeImport {
  readonly scratchRoot: string;
  readonly privateKeyPath: string;
  readonly knownHostsPath?: string;
  readonly pins?: NativeTransportMetadata["hostKeys"];
  readonly builderId: string;
  readonly source: string;
  readonly hostId: string;
  readonly hostname: string;
  readonly sshUser: string;
  readonly port: number;
  readonly suffix: string;
  /** Operator must quiesce legacy starts before opening the original store. */
  readonly acknowledgeQuiesced: true;
  /** Quiesced original durable owner snapshot, keyed by job. The legacy JSON
   * has no tenant; the current session mapping alone cannot establish ownership. */
  readonly originalOwners: Readonly<
    Record<
      string,
      { sessionId: string; organizationId: string; pullRequest: number }
    >
  >;
  /** Must consult the durable run repository, never an untrusted import field. */
  readonly resolveOwner: (
    sessionId: string,
  ) => Promise<{ organizationId: string; pullRequest: number } | undefined>;
}

/** Offline only. Quiesced source records and the original owner snapshot are
 * immutable. Each imported job is its own durable, resumable copy checkpoint. */
export const importLegacyNativeSlot = Effect.fn(
  "NativeBuildImporter.importSlot",
)(function* (
  state: NativeBuildState,
  transport: Pick<
    Effect.Success<ReturnType<typeof createNativeBuildTransport>>,
    "materialize"
  >,
  input: LegacyNativeImport,
  options: {
    readonly copy?: (
      path: string,
      source: AsyncIterable<Uint8Array>,
      maximum: number,
    ) => Effect.Effect<unknown, NativeOperationError>;
  } = {},
) {
  const files = yield* NativeBuildFiles.make;
  if (
    input.acknowledgeQuiesced !== true ||
    Boolean(input.knownHostsPath) === Boolean(input.pins)
  )
    return yield* Effect.fail(
      NativeOperationError.new("invalid-native-import"),
    );
  // The legacy root is normally also an excluded root from state assembly.
  // Dedupe that list only: equality with a registry-owned root must still refuse.
  yield* files.disjointRoots(
    [
      state.options.stateRoot,
      state.options.scratchRoot,
      state.options.cacheRoot,
      input.scratchRoot,
    ],
    [...new Set(state.options.otherRoots ?? [])].filter(
      (root) => root !== input.scratchRoot,
    ),
  );
  const key = (yield* files.file(
    input.privateKeyPath,
    [0o400, 0o600],
    32768,
  )).toString();
  const pinsBytes = input.pins
    ? ""
    : (yield* files.file(
        input.knownHostsPath ?? "",
        [0o400, 0o600],
        65_536,
      )).toString();
  const pins =
    input.pins ??
    (yield* nativeTry(() =>
      importNativeKnownHosts(pinsBytes, input.hostname, input.port),
    ));
  const metadata: NativeTransportMetadata = {
    source: input.source,
    hostId: input.hostId,
    hostname: input.hostname,
    sshUser: input.sshUser,
    port: input.port,
    hostKeys: pins,
  };
  yield* nativeTry(() => validateNativeTransport(metadata, key, input.suffix));
  const records: {
    legacy: typeof NativeBuildJobSchema.Type;
    owner: { organizationId: string; pullRequest: number };
    artifact?: string;
    recordSha256: string;
  }[] = [];
  for (const name of yield* nativeIO(() => readdir(input.scratchRoot))) {
    if (!name.endsWith(".json")) continue;
    if (!/^[a-f0-9]{32}\.json$/u.test(name))
      return yield* Effect.fail(
        NativeOperationError.new("invalid-import-job-path"),
      );
    const bytes = yield* files.file(
      join(input.scratchRoot, name),
      0o600,
      65_536,
    );
    const recordSha256 = createHash("sha256").update(bytes).digest("hex");
    const json = yield* nativeTry(
      () => JSON.parse(bytes.toString()) as unknown,
    );
    const legacy = yield* Schema.decodeUnknownEffect(NativeBuildJobSchema)(
      json,
      { onExcessProperty: "error" },
    ).pipe(
      Effect.mapError((cause) =>
        NativeOperationError.new("invalid-import-record", cause),
      ),
    );
    if (legacy.job !== name.slice(0, 32))
      return yield* Effect.fail(
        NativeOperationError.new("invalid-import-job-identity"),
      );
    if (legacy.state === "failed")
      yield* nativeTry(() => validateNativeBuildDiagnostics(legacy));
    const owner = yield* nativeIO(() => input.resolveOwner(legacy.sessionId));
    const original = input.originalOwners[legacy.job];
    if (
      !owner ||
      !original ||
      original.sessionId !== legacy.sessionId ||
      original.organizationId !== owner.organizationId ||
      original.pullRequest !== owner.pullRequest
    )
      return yield* Effect.fail(
        NativeOperationError.new("import-owner-quarantined"),
      );
    let artifact =
      legacy.artifactBytes === undefined
        ? undefined
        : join(input.scratchRoot, `${legacy.job}.tar`);
    if (artifact) {
      const actual = yield* hashNativeArtifact(artifact).pipe(
        Effect.catch((error) =>
          missingNativeFile(error.cause)
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
      if (!actual) artifact = undefined;
      else if (
        actual.bytes !== legacy.artifactBytes ||
        actual.sha256 !== legacy.artifactSha256
      )
        return yield* Effect.fail(
          NativeOperationError.new("invalid-import-artifact"),
        );
    }
    records.push({
      legacy,
      owner,
      recordSha256,
      ...(artifact ? { artifact } : {}),
    });
  }
  const generation = yield* state.addGeneration(input.builderId, metadata, key);
  yield* transport.materialize(generation, key);
  const now = Date.now();
  const jobs = yield* state.transaction((draft) => {
    const jobs: NativeRegistryJob[] = [];
    for (const { legacy, owner, artifact, recordSha256 } of records) {
      const existing = draft.jobs.find((job) => job.jobId === legacy.job);
      if (existing) {
        if (
          !existing.imported ||
          existing.organizationId !== owner.organizationId ||
          existing.sessionId !== legacy.sessionId ||
          existing.pullRequest !== owner.pullRequest ||
          existing.generationId !== generation.id ||
          existing.importBinding?.sourceRoot !== input.scratchRoot ||
          existing.importBinding.recordSha256 !== recordSha256
        )
          throw NativeOperationError.new("duplicate-import-job");
        jobs.push(existing);
        continue;
      }
      const unfinished = ["starting", "running"].includes(legacy.state),
        recovery = newRecovery();
      if (unfinished) {
        recovery.state = "pending";
        recovery.deadline = now + 900_000;
        recovery.nextAt = now;
      }
      const job: NativeRegistryJob = {
        version: 1,
        jobId: legacy.job,
        organizationId: owner.organizationId,
        sessionId: legacy.sessionId,
        builderId: input.builderId,
        generationId: generation.id,
        verifiedHostId: input.hostId,
        commit: legacy.commit,
        pullRequest: owner.pullRequest,
        action: legacy.action,
        attempt: opaqueId(),
        epoch: "0".repeat(32),
        submissionExpiresAt: 0,
        state: unfinished ? "submitting" : legacy.state,
        imported: true,
        importBinding: {
          sourceRoot: input.scratchRoot,
          recordSha256,
          artifact: artifact
            ? "copy-pending"
            : legacy.artifactBytes === undefined
              ? "none"
              : "remote-only",
        },
        recovery,
        createdAt: now,
        updatedAt: now,
        ...(legacy.artifactBytes !== undefined
          ? {
              artifactBytes: legacy.artifactBytes,
              artifactSha256: legacy.artifactSha256,
            }
          : {}),
        ...(legacy.failureCode ? { failureCode: legacy.failureCode } : {}),
        ...(legacy.stage ? { stage: legacy.stage } : {}),
      };
      draft.jobs.push(job);
      jobs.push(job);
    }
    return jobs;
  });
  for (const record of records) {
    if (!record.artifact) continue;
    const job = jobs.find((job) => job.jobId === record.legacy.job);
    if (!job || job.artifactBytes === undefined)
      return yield* Effect.fail(
        NativeOperationError.new("invalid-native-import"),
      );
    const finalPath = join(state.jobPath(job), "artifact.tar");
    const actual = yield* hashNativeArtifact(finalPath).pipe(
      Effect.catch((error) =>
        missingNativeFile(error.cause)
          ? Effect.succeed(undefined)
          : Effect.fail(error),
      ),
    );
    if (
      actual &&
      (actual.bytes !== job.artifactBytes ||
        actual.sha256 !== job.artifactSha256)
    )
      return yield* Effect.fail(
        NativeOperationError.new("invalid-import-artifact"),
      );
    if (!actual) {
      if (!(yield* state.remove(join(state.jobPath(job), "artifact.partial"))))
        return yield* Effect.fail(
          NativeOperationError.new("native-import-in-use"),
        );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const reservation = yield* Effect.acquireRelease(
            state.reserve(job, "artifact.partial", job.artifactBytes ?? 0),
            (reservation) => reservation.release().pipe(Effect.orDie),
          );
          const source = yield* Effect.acquireRelease(
            nativeIO(() =>
              open(
                record.artifact ?? "",
                constants.O_RDONLY |
                  constants.O_NOFOLLOW |
                  constants.O_NONBLOCK,
              ),
            ),
            (file) => nativeIO(() => file.close()).pipe(Effect.orDie),
          );
          const info = yield* nativeIO(() => source.stat());
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.uid !== process.getuid?.() ||
            (info.mode & 0o777) !== 0o600 ||
            info.size !== job.artifactBytes
          )
            return yield* Effect.fail(
              NativeOperationError.new("invalid-import-artifact"),
            );
          yield* (options.copy ?? files.stream)(
            reservation.path,
            source.createReadStream({ autoClose: false }),
            job.artifactBytes ?? 0,
          );
          const copied = yield* hashNativeArtifact(reservation.path);
          if (
            copied.bytes !== job.artifactBytes ||
            copied.sha256 !== job.artifactSha256
          )
            return yield* Effect.fail(
              NativeOperationError.new("invalid-import-artifact"),
            );
          yield* reservation.commit(finalPath);
        }),
      );
    }
    yield* state.transaction((draft) => {
      const current = draft.jobs.find(
        (candidate) => candidate.jobId === job.jobId,
      );
      if (!current?.importBinding)
        throw NativeOperationError.new("invalid-native-import");
      current.importBinding = { ...current.importBinding, artifact: "cached" };
    });
  }
  return {
    generationId: generation.id,
    importedJobs: jobs.map((job) => job.jobId),
  };
});
export class NativeBuildImporter extends Context.Service<NativeBuildImporter>()(
  "NativeBuildImporter",
  {
    make: Effect.gen(function* () {
      const state = yield* NativeBuildStateService,
        transport = yield* NativeBuildTransport;
      return {
        importSlot: Effect.fn("NativeBuildImporter.importSlotOwned")(
          (input: LegacyNativeImport) =>
            importLegacyNativeSlot(state, transport, input),
        ),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
