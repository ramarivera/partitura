import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  rename,
  rmdir,
  statfs,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { cleanupNative, NativeOperationError } from "./native-build-errors.js";
import {
  builderId,
  disjointNativeRoots,
  lockNativeState,
  missingNativeFile,
  nativeDirectory,
  nativeFile,
  opaqueId,
  writeNativeFile,
} from "./native-build-file-io.js";

import {
  Metadata,
  type MetadataValue,
  type NativeRegistryJob,
  type NativeStateOptions,
  type NativeTransportMetadata,
  nativeLimits,
  terminalNativeJob,
  unresolvedRecovery,
} from "./native-build-models.js";
/** Internal, exclusively owned state. Not assembled into the production layer. */
export async function openNativeStorage(
  options: NativeStateOptions,
  ownedRoot?: string,
) {
  const { stateRoot, scratchRoot, cacheRoot } = options;
  for (const root of [stateRoot, scratchRoot, cacheRoot]) {
    try {
      await nativeDirectory(root, true);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
      await nativeDirectory(root);
    }
  }
  await disjointNativeRoots(
    [stateRoot, scratchRoot, cacheRoot],
    options.otherRoots,
  );
  const filesystem = options.filesystem ?? statfs;
  if ((await filesystem(cacheRoot)).type !== 0x01021994)
    throw NativeOperationError.new("native-cache-requires-tmpfs");
  const freeMargin = options.freeMargin ?? 2 * 1024 ** 3;
  for (const amount of [
    options.bytesPerBuilder,
    options.bytesTotal,
    freeMargin,
  ])
    if (!Number.isSafeInteger(amount) || amount < 0)
      throw NativeOperationError.new("invalid-scratch-quota");
  if (ownedRoot !== undefined && ownedRoot !== stateRoot)
    throw NativeOperationError.new("native-state-owner-mismatch");
  const unlock =
    ownedRoot === stateRoot ? async () => {} : await lockNativeState(stateRoot);
  try {
    let key: Buffer;
    try {
      key = await nativeFile(join(stateRoot, "matching.key"), 0o400, 32);
    } catch (error) {
      if (!missingNativeFile(error)) throw error;
      // A lost key must never silently mint unrelated equality tags over old metadata.
      try {
        await lstat(join(stateRoot, "metadata.json"));
        throw NativeOperationError.new("native-matching-key-missing");
      } catch (missing) {
        if (!missingNativeFile(missing)) throw missing;
      }
      key = randomBytes(32);
      await writeNativeFile(join(stateRoot, "matching.key"), key, 0o400);
    }
    if (key.length !== 32)
      throw NativeOperationError.new("invalid-native-matching-key");
    let data: MetadataValue = { version: 1, generations: [], jobs: [] };
    try {
      data = structuredClone(
        Schema.decodeUnknownSync(Metadata)(
          JSON.parse(
            (
              await nativeFile(
                join(stateRoot, "metadata.json"),
                0o600,
                16 * 1024 ** 2,
              )
            ).toString(),
          ),
          { onExcessProperty: "error" },
        ),
      ) as MetadataValue;
    } catch (error) {
      if (!missingNativeFile(error))
        throw NativeOperationError.new("native-state-corrupt", error);
    }
    const validate = (value: MetadataValue) => {
      Schema.decodeUnknownSync(Metadata)(value, { onExcessProperty: "error" });
      if (
        value.generations.length > 256 ||
        new Set(value.generations.map((g) => g.id)).size !==
          value.generations.length ||
        new Set(value.jobs.map((j) => j.jobId)).size !== value.jobs.length
      )
        throw NativeOperationError.new("native-state-corrupt");
      for (const job of value.jobs) {
        const generation = value.generations.find(
          (g) => g.id === job.generationId,
        );
        if (
          !generation ||
          generation.builderId !== job.builderId ||
          generation.transport.hostId !== job.verifiedHostId ||
          (job.artifactBytes !== undefined &&
            job.artifactBytes > nativeLimits.artifact) ||
          (job.artifactBytes === undefined) !==
            (job.artifactSha256 === undefined) ||
          (job.state === "starting" && job.submissionExpiresAt !== 0)
        )
          throw NativeOperationError.new("native-state-corrupt");
      }
    };
    validate(data);
    let tail = Promise.resolve();
    let closed = false;
    const credentialCleanup = new Set<() => Promise<void>>();
    const generationCleanup = new Set<(id: string) => Promise<void>>();
    const serial = <A>(operation: () => Promise<A>): Promise<A> => {
      const pending = tail.then(() => {
        if (closed) throw NativeOperationError.new("native-state-closed");
        return operation();
      });
      tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    };
    const transaction = <A>(operation: (draft: MetadataValue) => A) =>
      serial(async () => {
        const draft = structuredClone(data);
        const result = operation(draft);
        validate(draft);
        const bytes = JSON.stringify(draft);
        if (Buffer.byteLength(bytes) > 16 * 1024 ** 2)
          throw NativeOperationError.new("native-state-capacity");
        await writeNativeFile(
          join(stateRoot, "metadata.json"),
          bytes,
          0o600,
          true,
        );
        const removed = data.generations.filter(
          (g) => !draft.generations.some((next) => next.id === g.id),
        );
        data = structuredClone(draft);
        await cleanupNative(
          removed.flatMap((g) =>
            [...generationCleanup].map((cleanup) => () => cleanup(g.id)),
          ),
        );
        return structuredClone(result);
      });
    const recoveryHosts = new Set<string>();
    const generationLeases = new Map<string, number>();
    const jobLeases = new Map<string, number>();
    const fileLeases = new Map<string, number>();
    const reservations = new Map<string, { builder: string; bytes: number }>();
    const usage = new Map<string, { builder: string; bytes: number }>();
    const jobPath = (job: NativeRegistryJob) =>
      join(scratchRoot, job.generationId, "jobs", job.jobId);
    const generationPath = (id: string) => join(cacheRoot, "generations", id);
    const retain = (map: Map<string, number>, id: string) => {
      map.set(id, (map.get(id) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = map.get(id) ?? 1;
        if (count === 1) map.delete(id);
        else map.set(id, count - 1);
      };
    };
    const removeFile = async (path: string) => {
      await unlink(path);
      usage.delete(path);
    };
    // Reconstruct actual bytes, including partials. Unexpected content closes
    // native admission instead of guessing ownership or deleting foreign files.
    for (const id of await readdir(scratchRoot)) {
      const generation = data.generations.find((g) => g.id === id);
      if (!generation) throw NativeOperationError.new("unowned-native-scratch");
      await nativeDirectory(join(scratchRoot, id));
      const children = await readdir(join(scratchRoot, id));
      if (children.some((child) => child !== "jobs"))
        throw NativeOperationError.new("unowned-native-scratch");
      if (!children.length) continue;
      await nativeDirectory(join(scratchRoot, id, "jobs"));
      for (const jobId of await readdir(join(scratchRoot, id, "jobs"))) {
        const job = data.jobs.find(
          (j) => j.jobId === jobId && j.generationId === id,
        );
        if (!job) throw NativeOperationError.new("unowned-native-scratch");
        await nativeDirectory(jobPath(job));
        for (const name of await readdir(jobPath(job))) {
          if (
            !["source.bundle", "artifact.tar", "artifact.partial"].includes(
              name,
            )
          )
            throw NativeOperationError.new("unowned-native-scratch");
          const path = join(jobPath(job), name);
          const file = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const info = await file.stat();
            if (
              !info.isFile() ||
              info.nlink !== 1 ||
              info.uid !== process.getuid?.() ||
              (info.mode & 0o777) !== 0o600
            )
              throw NativeOperationError.new("unsafe-native-scratch");
            usage.set(path, {
              builder: generation.builderId,
              bytes: info.size,
            });
          } finally {
            await file.close();
          }
        }
      }
    }
    // Only delete recognized stale credential files after acquiring state lock.
    const generationsRoot = join(cacheRoot, "generations");
    try {
      await nativeDirectory(generationsRoot, true);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
      await nativeDirectory(generationsRoot);
    }
    for (const id of await readdir(generationsRoot)) {
      if (!/^[a-f0-9]{32}$/u.test(id))
        throw NativeOperationError.new("unsafe-native-cache");
      const directory = generationPath(id);
      await nativeDirectory(directory);
      for (const name of await readdir(directory)) {
        if (!["identity", "config", "known_hosts"].includes(name))
          throw NativeOperationError.new("unsafe-native-cache");
        await nativeFile(
          join(directory, name),
          name === "identity" ? 0o600 : 0o400,
          65_536,
        );
        await unlink(join(directory, name));
      }
      const { rmdir } = await import("node:fs/promises");
      await rmdir(directory);
    }
    const equalityTag = (
      transport: NativeTransportMetadata,
      privateKey: string,
    ) =>
      createHmac("sha256", key)
        .update(
          JSON.stringify([
            transport.source,
            transport.hostId,
            transport.hostname,
            transport.sshUser,
            transport.port,
            transport.hostKeys.map((pin) => [pin.type, pin.base64]),
            privateKey,
          ]),
        )
        .digest("hex");
    const prune = async (now = Date.now()) =>
      serial(async () => {
        const draft = structuredClone(data);
        const expired = new Set<string>();
        for (const job of data.jobs) {
          if (
            !terminalNativeJob(job) ||
            unresolvedRecovery(job) ||
            now - job.updatedAt < nativeLimits.retention ||
            jobLeases.has(job.jobId)
          )
            continue;
          const prefix = `${jobPath(job)}/`;
          if (
            [...fileLeases.keys(), ...reservations.keys()].some((path) =>
              path.startsWith(prefix),
            )
          )
            continue;
          for (const [path] of usage)
            if (path.startsWith(prefix)) await removeFile(path);
          await rmdir(jobPath(job)).catch((error: unknown) => {
            if (!missingNativeFile(error)) throw error;
          });
          expired.add(job.jobId);
        }
        draft.jobs = draft.jobs.filter((job) => !expired.has(job.jobId));
        for (const generation of draft.generations) {
          if (
            draft.jobs.some((job) => job.generationId === generation.id) ||
            generationLeases.has(generation.id)
          )
            continue;
          for (const directory of [
            join(scratchRoot, generation.id, "jobs"),
            join(scratchRoot, generation.id),
          ])
            await rmdir(directory).catch((error: unknown) => {
              if (!missingNativeFile(error)) throw error;
            });
        }
        // Keep unreferenced public generations for exact restart reuse until
        // capacity pressure. Empty scratch directories have already been removed.
        if (expired.size) {
          await writeNativeFile(
            join(stateRoot, "metadata.json"),
            JSON.stringify(draft),
            0o600,
            true,
          );
          data = draft;
        }
      });
    const reserve = (
      job: NativeRegistryJob,
      name: "source.bundle" | "artifact.partial",
      bytes: number,
    ) =>
      serial(async () => {
        const persisted = data.jobs.find(
          (j) =>
            j.jobId === job.jobId &&
            j.generationId === job.generationId &&
            j.builderId === job.builderId,
        );
        if (
          !persisted ||
          !Number.isSafeInteger(bytes) ||
          bytes < 0 ||
          bytes >
            (name === "source.bundle"
              ? nativeLimits.bundle
              : nativeLimits.artifact)
        )
          throw NativeOperationError.new("invalid-native-reservation");
        const path = join(jobPath(job), name);
        if (reservations.has(path) || usage.has(path))
          throw NativeOperationError.new("native-file-busy");
        const entries = [...usage.values(), ...reservations.values()];
        const charged = bytes + nativeLimits.overhead;
        const disk = await filesystem(scratchRoot);
        if (
          entries.reduce((sum, item) => sum + item.bytes, 0) + charged >
            options.bytesTotal ||
          entries
            .filter((item) => item.builder === job.builderId)
            .reduce((sum, item) => sum + item.bytes, 0) +
            charged >
            options.bytesPerBuilder ||
          disk.bavail * disk.bsize <
            charged +
              freeMargin +
              [...reservations.values()].reduce(
                (sum, item) => sum + item.bytes,
                0,
              )
        )
          throw NativeOperationError.new("scratch-quota-exceeded");
        for (const directory of [
          join(scratchRoot, job.generationId),
          join(scratchRoot, job.generationId, "jobs"),
          jobPath(job),
        ]) {
          try {
            await nativeDirectory(directory, true);
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "EEXIST"
              )
            )
              throw error;
            await nativeDirectory(directory);
          }
        }
        reservations.set(path, { builder: job.builderId, bytes: charged });
        let released = false;
        return {
          path,
          maximum: bytes,
          commit: (finalPath = path) =>
            serial(async () => {
              if (released)
                throw NativeOperationError.new("native-reservation-released");
              if (
                finalPath !== path &&
                !(
                  name === "artifact.partial" &&
                  finalPath === join(jobPath(job), "artifact.tar")
                )
              )
                throw NativeOperationError.new("invalid-native-reservation");
              const descriptor = await open(
                path,
                constants.O_RDONLY |
                  constants.O_NOFOLLOW |
                  constants.O_NONBLOCK,
              );
              const info = await descriptor
                .stat()
                .finally(() => descriptor.close());
              if (
                !info.isFile() ||
                info.isSymbolicLink() ||
                info.nlink !== 1 ||
                info.uid !== process.getuid?.() ||
                (info.mode & 0o777) !== 0o600 ||
                info.size > bytes
              )
                throw NativeOperationError.new("native-transfer-exceeds-limit");
              if (finalPath !== path) await rename(path, finalPath);
              usage.set(finalPath, {
                builder: job.builderId,
                bytes: info.size,
              });
              reservations.delete(path);
              released = true;
            }),
          release: () =>
            released
              ? Promise.resolve()
              : serial(async () => {
                  if (released) return;
                  await unlink(path).catch((error: unknown) => {
                    if (!missingNativeFile(error)) throw error;
                  });
                  reservations.delete(path);
                  released = true;
                }),
        };
      });
    return {
      options,
      claimRecovery: (hostId: string) => {
        if (recoveryHosts.has(hostId)) return undefined;
        recoveryHosts.add(hostId);
        return () => {
          recoveryHosts.delete(hostId);
        };
      },
      registerCredentialCleanup: (cleanup: () => Promise<void>) => {
        credentialCleanup.add(cleanup);
      },
      registerGenerationCleanup: (cleanup: (id: string) => Promise<void>) => {
        generationCleanup.add(cleanup);
      },
      retainJob: (id: string) => retain(jobLeases, id),
      fileLeaseCount: (path: string) => fileLeases.get(path) ?? 0,
      generationInUse: (id: string) =>
        generationLeases.has(id) ||
        data.jobs.some((job) => job.generationId === id),
      transaction,
      equalityTag,
      generationPath,
      jobPath,
      snapshot: () => structuredClone(data),
      accounting: () => ({
        usedBytes: [...usage.values()].reduce(
          (sum, item) => sum + item.bytes,
          0,
        ),
        reservedBytes: [...reservations.values()].reduce(
          (sum, item) => sum + item.bytes,
          0,
        ),
        limitBytes: options.bytesTotal,
        builders: [
          ...new Set(
            [...usage.values(), ...reservations.values()].map(
              (item) => item.builder,
            ),
          ),
        ].map((id) => ({
          id,
          usedBytes: [...usage.values()]
            .filter((item) => item.builder === id)
            .reduce((sum, item) => sum + item.bytes, 0),
          reservedBytes: [...reservations.values()]
            .filter((item) => item.builder === id)
            .reduce((sum, item) => sum + item.bytes, 0),
          limitBytes: options.bytesPerBuilder,
        })),
      }),
      addGeneration: (
        builder: string,
        transport: NativeTransportMetadata,
        privateKey: string,
        now = Date.now(),
      ) =>
        transaction((draft) => {
          if (!builderId.test(builder))
            throw NativeOperationError.new("invalid-builder-id");
          const tag = equalityTag(transport, privateKey);
          const existing = draft.generations.find(
            (g) => g.builderId === builder && g.equalityTag === tag,
          );
          if (existing) return existing;
          // Jobs are durable references. Unresolved obligations never age out.
          if (draft.generations.length >= 256)
            draft.generations = draft.generations.filter(
              (g) =>
                draft.jobs.some((j) => j.generationId === g.id) ||
                generationLeases.has(g.id),
            );
          if (draft.generations.length >= 256)
            throw NativeOperationError.new("generation-capacity");
          const generation = {
            id: opaqueId(),
            builderId: builder,
            transport,
            equalityTag: tag,
            createdAt: now,
          };
          draft.generations.push(generation);
          return generation;
        }),
      owned: (
        organizationId: string,
        sessionId: string,
        jobId: string,
        builder?: string,
      ) => {
        const job = data.jobs.find(
          (j) =>
            j.jobId === jobId &&
            j.organizationId === organizationId &&
            j.sessionId === sessionId &&
            (builder === undefined || j.builderId === builder),
        );
        if (!job) throw NativeOperationError.new("native-job-not-found");
        return structuredClone(job);
      },
      retainGeneration: (id: string) => {
        if (!data.generations.some((g) => g.id === id))
          throw NativeOperationError.new("native-generation-not-found");
        return retain(generationLeases, id);
      },
      retainFile: (path: string) => retain(fileLeases, path),
      quarantined: (hostId: string) =>
        data.fleet?.retiredHosts.includes(hostId) === true ||
        data.fleet?.maintenance.some(
          (item) => item.hostId === hostId && item.state === "pending",
        ) === true ||
        data.jobs.some(
          (j) =>
            j.verifiedHostId === hostId &&
            (!terminalNativeJob(j) || unresolvedRecovery(j)),
        ),
      reserve,
      prune,
      remove: (path: string) =>
        serial(async () => {
          if (fileLeases.has(path) || reservations.has(path)) return false;
          if (!usage.has(path)) return true;
          await removeFile(path);
          return true;
        }),
      close: async () => {
        await tail;
        if (closed) return;
        closed = true;
        await cleanupNative([...credentialCleanup, unlock]);
      },
    };
  } catch (error) {
    await cleanupNative([unlock], error);
    throw error;
  }
}
