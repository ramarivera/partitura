import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Effect, Schema } from "effect";
import {
  FailedReceiptSchema,
  type NativeBuildJob as Job,
  NativeBuildJobSchema,
  validateNativeBuildDiagnostics,
} from "./native-build-legacy-receipt.js";

export {
  NativeBuildJobSchema,
  validateNativeBuildDiagnostics,
} from "./native-build-legacy-receipt.js";

import { legacyReceiptRefresh } from "./native-build-legacy-status.js";
import { workerIdentityCommand } from "./worker-security.js";

export interface NativeBuildConfig {
  readonly sshConfigFile: string;
  readonly scratchRoot: string;
  readonly sshExecutable?: string;
  readonly terminalRetentionMs?: number;
}
export interface NativeBuildRequest {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly workerUid?: string;
  readonly commit: string;
  readonly pullRequest: number;
  readonly action: string;
  /** Gateway-selected job inputs. Never accepted from model tool arguments. */
  readonly secretFiles?: Readonly<Record<string, string>>;
}

const MAX_BUNDLE = 1024 * 1024 * 1024;
const MAX_ARTIFACT = 2 * MAX_BUNDLE;
const DEFAULT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const JOB_ID = /^[a-f0-9]{32}$/u;
const safeEnvironment = () => ({ PATH: "/usr/bin:/bin" });
const limit = (maximum: number, hash?: ReturnType<typeof createHash>) => {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maximum)
        callback(new Error("Native build transfer exceeds limit"));
      else {
        hash?.update(chunk);
        callback(null, chunk);
      }
    },
  });
};

async function privatePath(path: string, directory: boolean) {
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    throw new Error("Native build path must be absolute and canonical");
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (directory ? !info.isDirectory() : !info.isFile())
  )
    throw new Error("Unsafe native build configuration or scratch path");
}

/** Gateway-owned SSH only. No worker receives the transport key or host target. */
export async function createNativeBuildClient(
  config: NativeBuildConfig,
  makeReceiptRefresh = legacyReceiptRefresh,
) {
  const terminalRetentionMs =
    config.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
  if (!Number.isSafeInteger(terminalRetentionMs) || terminalRetentionMs < 1)
    throw new Error("Native build terminal retention must be positive");
  await privatePath(config.sshConfigFile, false);
  await mkdir(config.scratchRoot, { recursive: true, mode: 0o700 });
  await privatePath(config.scratchRoot, true);
  const jobs = new Map<string, Job>();
  const active = new Map<
    string,
    { readonly task: Promise<void>; readonly abort: AbortController }
  >();
  const reservedSessions = new Set<string>();
  const reservedJobIds = new Set<string>();
  const artifactLeases = new Map<string, number>();
  const retiringJobs = new Set<string>();
  const sshArguments = (command: string) => [
    "-F",
    config.sshConfigFile,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=8",
    "partitura-native",
    command,
  ];
  const save = async (job: Job) => {
    const target = join(config.scratchRoot, `${job.job}.json`);
    await writeFile(`${target}.new`, JSON.stringify(job), { mode: 0o600 });
    await rename(`${target}.new`, target);
  };
  const ownedJob = (sessionId: string, jobId: string) => {
    const job = JOB_ID.test(jobId) ? jobs.get(jobId) : undefined;
    if (!job || job.sessionId !== sessionId)
      throw new Error("Native build job not found");
    return job;
  };
  const run = async (
    argv: [string, ...string[]],
    options: {
      readonly inputFile?: string;
      readonly inputPrefix?: Buffer;
      readonly outputFile?: string;
      readonly outputLimit?: number;
      readonly signal?: AbortSignal;
      readonly timeout?: number;
      readonly hash?: ReturnType<typeof createHash>;
      readonly acceptFailedReceipt?: boolean;
    } = {},
  ) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: config.scratchRoot,
      env: safeEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      signal: options.signal,
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", () =>
        reject(new Error("Native build process unavailable")),
      );
      child.once("exit", (code) =>
        code === 0 || (code === 1 && options.acceptFailedReceipt)
          ? resolve(code)
          : reject(new Error("Native build process failed")),
      );
    });
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeout ?? 30_000,
    );
    const chunks: Buffer[] = [];
    const output = options.outputFile
      ? createWriteStream(options.outputFile, { flags: "wx", mode: 0o600 })
      : new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
        });
    try {
      const inputFile = options.inputFile;
      const input = inputFile
        ? pipeline(
            (async function* () {
              if (options.inputPrefix) yield options.inputPrefix;
              yield* createReadStream(inputFile);
            })(),
            child.stdin,
          )
        : Promise.resolve(child.stdin.end());
      // A pre-input refusal can close stdin before the bundle finishes. Drain
      // bounded stdout and wait for exit before deciding whether EPIPE matters.
      // EPIPE is the qualified signal on the pinned Bun runtime. Other stream
      // errors stay failures unless separately reproduced and qualified.
      const [inputResult, , exitCode] = await Promise.all([
        input.then(
          () => ({ error: undefined }),
          (error: unknown) => {
            if (
              options.acceptFailedReceipt &&
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "EPIPE"
            )
              return { error };
            throw error;
          },
        ),
        pipeline(
          child.stdout,
          limit(options.outputLimit ?? 65_536, options.hash),
          output,
        ),
        exited,
      ]);
      if (inputResult.error !== undefined && exitCode !== 1)
        throw inputResult.error;
      return {
        output: Buffer.concat(chunks).toString("utf8"),
        exitCode,
        inputComplete: inputResult.error === undefined,
      };
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
  };
  const remote = (command: string, options: Parameters<typeof run>[1] = {}) =>
    run(
      [config.sshExecutable ?? "/usr/bin/ssh", ...sshArguments(command)],
      options,
    );
  const artifactHash = async (path: string) => {
    await privatePath(path, false);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  };
  const retainArtifact = (jobId: string) => {
    artifactLeases.set(jobId, (artifactLeases.get(jobId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const leases = artifactLeases.get(jobId) ?? 0;
      if (leases <= 1) artifactLeases.delete(jobId);
      else artifactLeases.set(jobId, leases - 1);
    };
  };
  const touchJob = async (jobId: string) => {
    const record = join(config.scratchRoot, `${jobId}.json`);
    await privatePath(record, false);
    const now = new Date();
    await utimes(record, now, now);
  };
  let pruneInFlight: Promise<void> | undefined;
  let pruneFailure: unknown;
  const pruneTerminalJobs = (now = Date.now()) => {
    if (pruneInFlight) return pruneInFlight;
    const pruning = (async () => {
      for (const [jobId, job] of jobs) {
        if (
          !["succeeded", "failed", "interrupted"].includes(job.state) ||
          active.has(jobId) ||
          reservedJobIds.has(jobId) ||
          (artifactLeases.get(jobId) ?? 0) > 0
        )
          continue;
        const record = join(config.scratchRoot, `${jobId}.json`);
        retiringJobs.add(jobId);
        try {
          let info: Awaited<ReturnType<typeof lstat>>;
          try {
            info = await lstat(record);
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            ) {
              jobs.delete(jobId);
              continue;
            }
            throw error;
          }
          if (now - info.mtimeMs < terminalRetentionMs) continue;
          const jobFiles = (await readdir(config.scratchRoot)).filter((file) =>
            new RegExp(
              `^${jobId}\\.(?:tar(?:\\..+)?|bundle(?:\\..+)?|json\\.new)$`,
              "u",
            ).test(file),
          );
          await Promise.all([
            rm(record, { force: true }),
            ...jobFiles.map((file) =>
              rm(join(config.scratchRoot, file), { force: true }),
            ),
          ]);
          jobs.delete(jobId);
        } finally {
          retiringJobs.delete(jobId);
        }
      }
      for (const file of await readdir(config.scratchRoot)) {
        const match =
          /^([a-f0-9]{32})\.(?:tar(?:\..+)?|bundle(?:\..+)?|json\.new)$/u.exec(
            file,
          );
        const jobId = match?.[1];
        if (
          jobId === undefined ||
          jobs.has(jobId) ||
          active.has(jobId) ||
          reservedJobIds.has(jobId) ||
          (artifactLeases.get(jobId) ?? 0) > 0
        )
          continue;
        const path = join(config.scratchRoot, file);
        const info = await lstat(path);
        if (now - info.mtimeMs >= terminalRetentionMs)
          await rm(path, { force: true });
      }
    })();
    pruneInFlight = pruning;
    void pruning.then(
      () => {
        if (pruneInFlight === pruning) pruneInFlight = undefined;
      },
      () => {
        if (pruneInFlight === pruning) pruneInFlight = undefined;
      },
    );
    return pruning;
  };
  const pruneBestEffort = async () => {
    try {
      await pruneTerminalJobs();
      pruneFailure = undefined;
    } catch (error) {
      pruneFailure = error;
    }
  };
  const receipts = makeReceiptRefresh({
    read: async (id, signal) =>
      (
        await remote(`status ${id}`, {
          timeout: 10_000,
          signal,
          acceptFailedReceipt: true,
        })
      ).output,
    save,
    retain: retainArtifact,
    current: (job) => jobs.get(job.job) === job && !retiringJobs.has(job.job),
  });
  // Durable ownership survives a gateway crash. Cancel old jobs before serving
  // new requests; never reassign another session's in-flight native build.
  for (const file of await readdir(config.scratchRoot)) {
    if (!/^[a-f0-9]{32}\.json$/u.test(file)) continue;
    await privatePath(join(config.scratchRoot, file), false);
    let job: Job;
    try {
      job = Schema.decodeUnknownSync(NativeBuildJobSchema)(
        JSON.parse(await readFile(join(config.scratchRoot, file), "utf8")),
      );
      if (job.state === "failed") validateNativeBuildDiagnostics(job);
      if (job.job !== file.slice(0, 32))
        throw new Error("Invalid persisted native build ownership");
    } catch {
      await rename(
        join(config.scratchRoot, file),
        join(config.scratchRoot, `${file}.invalid`),
      );
      await Effect.runPromise(
        Effect.logWarning("Invalid native build record quarantined", {
          code: "native-record-invalid",
        }),
      );
      continue;
    }
    if (job.state === "failed" && !job.failureCode) receipts.track(job.job);
    jobs.set(job.job, job);
    if (job.state === "starting" || job.state === "running") {
      await remote(`cancel ${job.job}`);
      job.state = "interrupted";
      await save(job);
    }
  }
  await pruneBestEffort();
  return {
    start: async (request: NativeBuildRequest) => {
      const entries = Object.entries(request.secretFiles ?? {});
      if (
        entries.length > 16 ||
        entries.some(
          ([name, value]) =>
            !/^[a-z][a-z0-9-]{0,63}$/u.test(name) || typeof value !== "string",
        )
      )
        throw new Error("Invalid native job secret files");
      const secretInput = entries.length
        ? Buffer.from(JSON.stringify(Object.fromEntries(entries)), "utf8")
        : undefined;
      if (secretInput !== undefined && secretInput.byteLength > 65_536)
        throw new Error("Native job secret files exceed limit");
      if (
        !/^[a-f0-9]{40}$/u.test(request.commit) ||
        !Number.isSafeInteger(request.pullRequest) ||
        request.pullRequest < 1 ||
        request.pullRequest > 99_999_999 ||
        !/^[a-z][a-z0-9-]{0,63}$/u.test(request.action)
      ) {
        throw new Error("Invalid native build request");
      }
      await pruneBestEffort();
      if (
        reservedSessions.has(request.sessionId) ||
        [...active.keys()].some(
          (id) => jobs.get(id)?.sessionId === request.sessionId,
        )
      )
        throw new Error("A native build is already active for this session");
      const job: Job = {
        job: randomUUID().replaceAll("-", ""),
        sessionId: request.sessionId,
        commit: request.commit,
        action: request.action,
        state: "starting",
      };
      jobs.set(job.job, job);
      reservedSessions.add(request.sessionId);
      reservedJobIds.add(job.job);
      try {
        await save(job);
      } catch (error) {
        reservedSessions.delete(request.sessionId);
        reservedJobIds.delete(job.job);
        jobs.delete(job.job);
        throw error;
      }
      const abort = new AbortController();
      const task = (async () => {
        const bundle = join(config.scratchRoot, `${job.job}.bundle`);
        const bundleRef = `refs/partitura/native-build/${job.job}`;
        try {
          const workerCommand = (...args: string[]): [string, ...string[]] => {
            const command = workerIdentityCommand(args, request.workerUid);
            const executable = command.shift();
            if (!executable) throw new Error("Native bundle command missing");
            return [executable, ...command];
          };
          await run(
            workerCommand(
              "/usr/bin/git",
              "-C",
              request.workspacePath,
              "update-ref",
              bundleRef,
              request.commit,
            ),
            { timeout: 30_000, signal: abort.signal },
          );
          try {
            await run(
              workerCommand(
                "/usr/bin/git",
                "-C",
                request.workspacePath,
                "bundle",
                "create",
                "-",
                bundleRef,
              ),
              {
                outputFile: bundle,
                outputLimit: MAX_BUNDLE,
                timeout: 120_000,
                signal: abort.signal,
              },
            );
          } finally {
            await run(
              workerCommand(
                "/usr/bin/git",
                "-C",
                request.workspacePath,
                "update-ref",
                "-d",
                bundleRef,
              ),
              { timeout: 30_000 },
            );
          }
          const info = await lstat(bundle);
          job.state = "running";
          await save(job);
          if (abort.signal.aborted) throw new Error("Native build cancelled");
          const result = await remote(
            `run ${job.job} ${job.commit} ${request.pullRequest} ${job.action} ${info.size}${secretInput === undefined ? "" : ` ${secretInput.byteLength}`}`,
            {
              inputFile: bundle,
              ...(secretInput === undefined
                ? {}
                : { inputPrefix: secretInput }),
              timeout: 3_600_000,
              signal: abort.signal,
              acceptFailedReceipt: true,
            },
          ).catch((error: unknown) => {
            receipts.track(job.job);
            throw error;
          });
          const response: unknown = JSON.parse(result.output);
          if (
            typeof response !== "object" ||
            response === null ||
            !("job" in response) ||
            response.job !== job.job ||
            !("commit" in response) ||
            response.commit !== request.commit ||
            !("action" in response) ||
            response.action !== request.action
          )
            throw new Error("Invalid native build receipt identity");
          if (result.exitCode === 1) {
            const failure =
              Schema.decodeUnknownSync(FailedReceiptSchema)(response);
            validateNativeBuildDiagnostics(failure);
            if (!result.inputComplete && failure.stage !== "disk-preflight")
              throw new Error("Invalid native pre-input refusal");
            Object.assign(job, failure);
            receipts.confirm(job.job);
            return;
          }
          if (
            !("state" in response) ||
            response.state !== "succeeded" ||
            !("artifactSha256" in response) ||
            typeof response.artifactSha256 !== "string" ||
            !/^[a-f0-9]{64}$/u.test(response.artifactSha256) ||
            !("artifactBytes" in response) ||
            typeof response.artifactBytes !== "number" ||
            !Number.isSafeInteger(response.artifactBytes) ||
            response.artifactBytes < 0 ||
            response.artifactBytes > MAX_ARTIFACT
          )
            throw new Error("Invalid native build receipt");
          job.state = "succeeded";
          job.artifactSha256 = response.artifactSha256;
          job.artifactBytes = response.artifactBytes;
        } catch {
          job.state = abort.signal.aborted ? "interrupted" : "failed";
        } finally {
          try {
            await rm(bundle, { force: true });
            await save(job);
          } catch {
            job.state = "failed";
          } finally {
            active.delete(job.job);
          }
        }
      })();
      active.set(job.job, { task, abort });
      reservedSessions.delete(request.sessionId);
      reservedJobIds.delete(job.job);
      return { ...job };
    },
    status: async (sessionId: string, jobId: string) => {
      await pruneBestEffort();
      const job = ownedJob(sessionId, jobId);
      if (job.state === "failed" && !job.failureCode) receipts.poll(job);
      return { ...job };
    },
    artifact: async (sessionId: string, jobId: string) => {
      if (retiringJobs.has(jobId)) await pruneTerminalJobs();
      const job = ownedJob(sessionId, jobId);
      const workflowLogs =
        job.state === "failed" &&
        job.failureCode === "workflow-failed" &&
        job.artifactSha256 !== undefined;
      if (job.state !== "succeeded" && !workflowLogs)
        throw new Error("Native build has no deliverable artifact");
      const path = join(config.scratchRoot, `${job.job}.tar`);
      const otherConsumers = artifactLeases.get(job.job) ?? 0;
      const release = retainArtifact(job.job);
      let leaseTransferred = false;
      try {
        await pruneTerminalJobs();
        try {
          const info = await lstat(path);
          if (
            info.size === job.artifactBytes &&
            (await artifactHash(path)) === job.artifactSha256
          ) {
            await touchJob(job.job);
            leaseTransferred = true;
            return {
              path,
              sha256: job.artifactSha256,
              bytes: job.artifactBytes,
              release,
            };
          }
          if (otherConsumers > 0)
            throw new Error("Invalid native artifact is still in use");
          await rm(path, { force: true });
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
          )
            throw error;
        }
        const temporary = `${path}.${randomUUID()}.partial`;
        try {
          const hash = createHash("sha256");
          await remote(`artifact ${job.job}`, {
            outputFile: temporary,
            outputLimit: MAX_ARTIFACT,
            hash,
            timeout: 180_000,
          });
          const info = await lstat(temporary);
          if (
            hash.digest("hex") !== job.artifactSha256 ||
            info.size !== job.artifactBytes
          )
            throw new Error("Native artifact differs from broker receipt");
          await rename(temporary, path);
          await touchJob(job.job);
          leaseTransferred = true;
          return {
            path,
            sha256: job.artifactSha256,
            bytes: job.artifactBytes,
            release,
          };
        } finally {
          await rm(temporary, { force: true });
        }
      } finally {
        if (!leaseTransferred) release();
      }
    },
    cancel: async (sessionId: string, jobId: string) => {
      await pruneBestEffort();
      const job = ownedJob(sessionId, jobId);
      if (receipts.confirmed(job))
        return { ...job, cancellationRequested: false };
      const pending = active.get(job.job);
      pending?.abort.abort();
      try {
        await remote(`cancel ${job.job}`);
      } finally {
        await pending?.task;
      }
      return { ...job, cancellationRequested: true };
    },
    close: async () => {
      await receipts.close();
      const pending = [...active.entries()];
      await Promise.all(
        pending.map(async ([id, handle]) => {
          handle.abort.abort();
          try {
            await remote(`cancel ${id}`);
          } finally {
            await handle.task;
          }
        }),
      );
      await pruneTerminalJobs();
      if (pruneFailure !== undefined) throw pruneFailure;
    },
  };
}

/** Copy verified opaque bytes through the worker uid. The gateway never opens
 * a worker-controlled destination or extracts an archive from the guest. */
export async function deliverNativeArtifact(
  client: Pick<Awaited<ReturnType<typeof createNativeBuildClient>>, "artifact">,
  request: {
    readonly sessionId: string;
    readonly job: string;
    readonly workspacePath: string;
    readonly workerUid?: string;
  },
) {
  const artifact = await client.artifact(request.sessionId, request.job);
  try {
    const directory = join(request.workspacePath, ".omp-home", "native-build");
    const destination = join(directory, `${request.job}.tar`);
    const workerProcess = (command: string[]) => {
      const argv = workerIdentityCommand(command, request.workerUid);
      const executable = argv.shift();
      if (!executable) throw new Error("Native artifact command missing");
      return spawn(executable, argv, {
        cwd: "/",
        env: safeEnvironment(),
        stdio: ["pipe", "ignore", "ignore"],
      });
    };
    const waitFor = (child: ReturnType<typeof workerProcess>) =>
      new Promise<void>((resolve, reject) => {
        child.once("error", () =>
          reject(new Error("Native artifact delivery unavailable")),
        );
        child.once("exit", (code) =>
          code === 0
            ? resolve()
            : reject(new Error("Native artifact delivery failed")),
        );
      });
    const prepare = workerProcess(["/usr/bin/mkdir", "-p", "--", directory]);
    const prepared = waitFor(prepare);
    prepare.stdin.end();
    await prepared;
    const writer = workerProcess(["/usr/bin/tee", "--", destination]);
    const exited = waitFor(writer);
    const timer = setTimeout(() => writer.kill("SIGKILL"), 180_000);
    try {
      await Promise.all([
        pipeline(createReadStream(artifact.path), writer.stdin),
        exited,
      ]);
      return {
        path: destination,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      };
    } finally {
      clearTimeout(timer);
      if (writer.exitCode === null) writer.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
  } finally {
    artifact.release();
  }
}
