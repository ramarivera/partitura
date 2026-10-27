import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { Schema } from "effect";
import {
  NativeBuildJobSchema,
  validateNativeBuildDiagnostics,
} from "../../src/services/native-build-client.js";

const MAX_RECORD = 65_536;
const JOB_FILE = /^[a-f0-9]{32}\.json$/u;

/** Offline projection only. Never manufacture a terminal state for a live job. */
export function projectLegacyDiskRecord(value: unknown) {
  const job = Schema.decodeUnknownSync(NativeBuildJobSchema)(value, {
    onExcessProperty: "error",
  });
  if (job.state === "starting" || job.state === "running")
    throw new Error("unfinished-native-job");
  const disk =
    job.failureCode === "host-disk-space-unavailable" ||
    job.stage === "disk-preflight" ||
    job.stage === "disk-post-transfer";
  if (job.state === "failed") validateNativeBuildDiagnostics(job);
  if (!disk) return job;
  if (job.state !== "failed") throw new Error("invalid-disk-terminal-state");
  return {
    ...job,
    failureCode: "host-capacity-unavailable" as const,
    stage: "capacity" as const,
  };
}

async function privateDirectory(path: string) {
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    throw new Error("unsafe-rollback-directory");
  // This is an offline root operation. No untrusted ancestor may replace a
  // checked directory while records are read or atomically replaced.
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.uid !== 0 && info.uid !== process.getuid?.()) ||
      (info.mode & (current === path ? 0o077 : 0o022)) !== 0
    )
      throw new Error("unsafe-rollback-directory");
    if (dirname(current) === current) break;
  }
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    return await descriptor.stat();
  } finally {
    await descriptor.close();
  }
}

async function syncDirectory(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writePrivate(path: string, bytes: Uint8Array) {
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

function overlaps(left: string, right: string) {
  const within = (a: string, b: string) => {
    const rel = relative(a, b);
    return (
      rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel))
    );
  };
  return within(left, right) || within(right, left);
}

/** Call only after stopping the gateway and all native tool consumers. The
 * acknowledgement is operational, not a claim to detect a running gateway.
 * The exclusive file fences other offline invocations, not gateway processes.
 */
export async function rollbackLegacyDiskRecords(options: {
  readonly legacyRoot: string;
  readonly backupRoot: string;
  readonly gatewayStopped: boolean;
}) {
  if (!options.gatewayStopped)
    throw new Error("gateway-stop-acknowledgement-required");
  const sourceInfo = await privateDirectory(options.legacyRoot);
  const backupInfo = await privateDirectory(options.backupRoot);
  if (
    overlaps(options.legacyRoot, options.backupRoot) ||
    sourceInfo.dev !== backupInfo.dev ||
    sourceInfo.ino === backupInfo.ino
  )
    throw new Error("rollback-backup-must-be-disjoint-on-same-filesystem");
  const lockPath = join(options.legacyRoot, ".native-build-admin.lock");
  const lock = await open(
    lockPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const records = [];
    for (const name of (await readdir(options.legacyRoot))
      .filter((entry) => JOB_FILE.test(entry))
      .sort()) {
      const path = join(options.legacyRoot, name);
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let bytes: Buffer;
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          info.nlink !== 1 ||
          (info.mode & 0o777) !== 0o600 ||
          info.size > MAX_RECORD
        )
          throw new Error(`unsafe-native-record:${name.slice(0, 32)}`);
        bytes = Buffer.alloc(MAX_RECORD + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > MAX_RECORD)
          throw new Error(`oversized-native-record:${name.slice(0, 32)}`);
        bytes = bytes.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
      let projected: ReturnType<typeof projectLegacyDiskRecord> | undefined;
      try {
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        // Even a damaged unfinished record must never be moved aside to make
        // an old gateway start. Reconcile it first with compatible software.
        if (
          typeof value === "object" &&
          value !== null &&
          "state" in value &&
          (value.state === "starting" || value.state === "running")
        )
          throw new Error("unfinished-native-job");
        projected = projectLegacyDiskRecord(value);
        if (projected.job !== name.slice(0, 32)) projected = undefined;
      } catch (error) {
        if (error instanceof Error && error.message === "unfinished-native-job")
          throw new Error(`unfinished-native-job:${name.slice(0, 32)}`);
        projected = undefined;
      }
      records.push({ name, path, bytes, projected });
    }
    // Preflight every record before any mutation. Backups include originals of
    // corrupt records, and become durable before replacing/quarantining input.
    const backup = await mkdtemp(join(options.backupRoot, "disk-rollback-"));
    await mkdir(join(backup, "originals"), { mode: 0o700 });
    await mkdir(join(backup, "quarantine"), { mode: 0o700 });
    await syncDirectory(options.backupRoot);
    const result = {
      backup,
      projected: [] as string[],
      unchanged: [] as string[],
      quarantined: [] as string[],
    };
    for (const record of records) {
      const jobId = record.name.slice(0, 32);
      const changed =
        record.projected?.failureCode === "host-capacity-unavailable" &&
        JSON.parse(record.bytes.toString("utf8")).failureCode ===
          "host-disk-space-unavailable";
      if (record.projected && !changed) {
        result.unchanged.push(jobId);
        continue;
      }
      await writePrivate(join(backup, "originals", record.name), record.bytes);
      await syncDirectory(join(backup, "originals"));
      await syncDirectory(backup);
      if (!record.projected) {
        await rename(record.path, join(backup, "quarantine", record.name));
        await syncDirectory(join(backup, "quarantine"));
        result.quarantined.push(jobId);
      } else {
        const pending = join(
          options.legacyRoot,
          `.${record.name}.${randomUUID()}.new`,
        );
        try {
          await writePrivate(
            pending,
            Buffer.from(JSON.stringify(record.projected)),
          );
          await rename(pending, record.path);
        } finally {
          await unlink(pending).catch((error: unknown) => {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
            )
              throw error;
          });
        }
        result.projected.push(jobId);
      }
      await syncDirectory(options.legacyRoot);
    }
    return result;
  } finally {
    await lock.close();
    await unlink(lockPath);
    await syncDirectory(options.legacyRoot);
  }
}

if (import.meta.main) {
  try {
    const [
      command,
      legacyFlag,
      legacyRoot,
      backupFlag,
      backupRoot,
      stoppedFlag,
      ...extra
    ] = process.argv.slice(2);
    if (
      process.getuid?.() !== 0 ||
      command !== "rollback-disk-diagnostics" ||
      legacyFlag !== "--legacy-root" ||
      !legacyRoot ||
      backupFlag !== "--backup-root" ||
      !backupRoot ||
      stoppedFlag !== "--gateway-stopped" ||
      extra.length
    )
      throw new Error(
        "root-required; usage: rollback-disk-diagnostics --legacy-root PATH --backup-root PATH --gateway-stopped",
      );
    const result = await rollbackLegacyDiskRecords({
      legacyRoot,
      backupRoot,
      gatewayStopped: true,
    });
    console.log(JSON.stringify(result));
    if (result.quarantined.length) process.exitCode = 2;
  } catch (error) {
    // No record contents, credentials or filesystem errors in command output.
    if (
      error instanceof Error &&
      /^(unfinished-native-job|unsafe-native-record|oversized-native-record):[a-f0-9]{32}$/u.test(
        error.message,
      )
    )
      console.error(error.message);
    console.error(
      "Native disk rollback refused. Check stopped-gateway acknowledgement, protected paths, offline lock and unfinished records.",
    );
    process.exitCode = 1;
  }
}
