import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import {
  NativeBuildJobSchema,
  validateNativeBuildDiagnostics,
} from "../../src/services/native-build-client.js";
import {
  disjointNativeRoots,
  nativeFile,
  opaqueId,
  writeNativeStream,
} from "../../src/services/native-build-files.js";
import {
  type NativeBuildState,
  type NativeRegistryJob,
  type NativeTransportMetadata,
  newRecovery,
} from "../../src/services/native-build-state.js";
import {
  type createNativeBuildTransport,
  hashNativeArtifact,
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
  if (!lines.length || lines.length > 4) throw new Error("invalid-import-pins");
  const pins = lines.map((line) => {
    const fields = line.split(" ");
    if (fields.length !== 3 || fields[0] !== lookup || !fields[1] || !fields[2])
      throw new Error("invalid-import-pins");
    return { type: fields[1], base64: fields[2] };
  });
  if (
    new Set(pins.map((pin) => `${pin.type} ${pin.base64}`)).size !== pins.length
  )
    throw new Error("invalid-import-pins");
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
  /** Must consult the durable run repository, never an untrusted import field. */
  readonly resolveOwner: (
    sessionId: string,
  ) => Promise<{ organizationId: string; pullRequest: number } | undefined>;
}

/** Offline library entry point. Deployment assembly supplies the durable owner
 * lookup; exposing a CLI without that lookup would invent ownership. Originals
 * are read through no-follow descriptors and never modified or removed. */
export async function importLegacyNativeSlot(
  state: NativeBuildState,
  transport: Awaited<ReturnType<typeof createNativeBuildTransport>>,
  input: LegacyNativeImport,
) {
  if (
    input.acknowledgeQuiesced !== true ||
    Boolean(input.knownHostsPath) === Boolean(input.pins)
  )
    throw new Error("invalid-native-import");
  await disjointNativeRoots([
    input.scratchRoot,
    state.options.stateRoot,
    state.options.scratchRoot,
    state.options.cacheRoot,
    ...(state.options.otherRoots ?? []),
  ]);
  const key = (
    await nativeFile(input.privateKeyPath, [0o400, 0o600], 32768)
  ).toString();
  const pins =
    input.pins ??
    importNativeKnownHosts(
      (
        await nativeFile(input.knownHostsPath ?? "", [0o400, 0o600], 65_536)
      ).toString(),
      input.hostname,
      input.port,
    );
  const metadata: NativeTransportMetadata = {
    source: input.source,
    hostId: input.hostId,
    hostname: input.hostname,
    sshUser: input.sshUser,
    port: input.port,
    hostKeys: pins,
  };
  validateNativeTransport(metadata, key, input.suffix);
  const records: {
    legacy: typeof NativeBuildJobSchema.Type;
    owner: { organizationId: string; pullRequest: number };
    artifact?: string;
  }[] = [];
  for (const name of await readdir(input.scratchRoot)) {
    // All other files, including SSH config, are ignored rather than evaluated.
    if (!name.endsWith(".json")) continue;
    if (!/^[a-f0-9]{32}\.json$/u.test(name))
      throw new Error("invalid-import-job-path");
    const legacy = Schema.decodeUnknownSync(NativeBuildJobSchema)(
      JSON.parse(
        (
          await nativeFile(join(input.scratchRoot, name), 0o600, 65_536)
        ).toString(),
      ),
      { onExcessProperty: "error" },
    );
    if (legacy.job !== name.slice(0, 32))
      throw new Error("invalid-import-job-identity");
    if (legacy.state === "failed") validateNativeBuildDiagnostics(legacy);
    const owner = await input.resolveOwner(legacy.sessionId);
    // Fail the entire import, retaining original records, instead of assigning
    // unknown jobs to an invented tenant. Admission stays offline.
    if (!owner) throw new Error("import-owner-quarantined");
    const artifact =
      legacy.artifactBytes === undefined
        ? undefined
        : join(input.scratchRoot, `${legacy.job}.tar`);
    if (artifact) {
      const actual = await hashNativeArtifact(artifact);
      if (
        actual.bytes !== legacy.artifactBytes ||
        actual.sha256 !== legacy.artifactSha256
      )
        throw new Error("invalid-import-artifact");
    }
    records.push({ legacy, owner, ...(artifact ? { artifact } : {}) });
  }
  const generation = await state.addGeneration(input.builderId, metadata, key);
  await transport.materialize(generation, key);
  const now = Date.now();
  const jobs = await state.transaction((draft) => {
    const jobs: NativeRegistryJob[] = [];
    for (const { legacy, owner } of records) {
      if (draft.jobs.some((job) => job.jobId === legacy.job))
        throw new Error("duplicate-import-job");
      const unfinished = ["starting", "running"].includes(legacy.state);
      const recovery = newRecovery();
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
      throw new Error("invalid-native-import");
    const reservation = await state.reserve(
      job,
      "artifact.partial",
      job.artifactBytes,
    );
    try {
      const source = await open(
        record.artifact,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await source.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o777) !== 0o600 ||
          info.size !== job.artifactBytes
        )
          throw new Error("invalid-import-artifact");
        await writeNativeStream(
          reservation.path,
          source.createReadStream({ autoClose: false }),
          job.artifactBytes,
        );
      } finally {
        await source.close();
      }
      const actual = await hashNativeArtifact(reservation.path);
      if (
        actual.bytes !== job.artifactBytes ||
        actual.sha256 !== job.artifactSha256
      )
        throw new Error("invalid-import-artifact");
      const finalPath = join(state.jobPath(job), "artifact.tar");
      await reservation.commit(finalPath);
    } finally {
      await reservation.release();
    }
  }
  return {
    generationId: generation.id,
    importedJobs: jobs.map((job) => job.jobId),
  };
}
