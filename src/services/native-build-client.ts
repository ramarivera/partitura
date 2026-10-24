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
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Schema } from "effect";
import { workerIdentityCommand } from "./worker-security.js";

export interface NativeBuildConfig {
  readonly sshConfigFile: string;
  readonly scratchRoot: string;
  readonly sshExecutable?: string;
}
export interface NativeBuildRequest {
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly workerUid?: string;
  readonly commit: string;
  readonly pullRequest: number;
  readonly action: "archive" | "native-smoke";
}
const JobSchema = Schema.Struct({
  job: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  sessionId: Schema.String,
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  action: Schema.Literals(["archive", "native-smoke"]),
  state: Schema.Literals([
    "starting",
    "running",
    "succeeded",
    "failed",
    "interrupted",
  ]),
  artifactSha256: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  ),
  artifactBytes: Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(2147483648),
    ),
  ),
});
type Job = {
  -readonly [K in keyof typeof JobSchema.Type]: (typeof JobSchema.Type)[K];
};

const MAX_BUNDLE = 1024 * 1024 * 1024;
const MAX_ARTIFACT = 2 * MAX_BUNDLE;
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
export async function createNativeBuildClient(config: NativeBuildConfig) {
  await privatePath(config.sshConfigFile, false);
  await mkdir(config.scratchRoot, { recursive: true, mode: 0o700 });
  await privatePath(config.scratchRoot, true);
  const jobs = new Map<string, Job>();
  const active = new Map<
    string,
    { readonly task: Promise<void>; readonly abort: AbortController }
  >();
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
      readonly outputFile?: string;
      readonly outputLimit?: number;
      readonly signal?: AbortSignal;
      readonly timeout?: number;
      readonly hash?: ReturnType<typeof createHash>;
    } = {},
  ) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: config.scratchRoot,
      env: safeEnvironment(),
      stdio: ["pipe", "pipe", "ignore"],
      signal: options.signal,
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", () =>
        reject(new Error("Native build process unavailable")),
      );
      child.once("exit", (code) =>
        code === 0
          ? resolve()
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
      const input = options.inputFile
        ? pipeline(createReadStream(options.inputFile), child.stdin)
        : Promise.resolve(child.stdin.end());
      await Promise.all([
        input,
        pipeline(
          child.stdout,
          limit(options.outputLimit ?? 65_536, options.hash),
          output,
        ),
        exited,
      ]);
      return Buffer.concat(chunks).toString("utf8");
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
  // Durable ownership survives a gateway crash. Cancel old jobs before serving
  // new requests; never reassign another session's in-flight native build.
  for (const file of await readdir(config.scratchRoot)) {
    if (!/^[a-f0-9]{32}\.json$/u.test(file)) continue;
    await privatePath(join(config.scratchRoot, file), false);
    const job: Job = Schema.decodeUnknownSync(JobSchema)(
      JSON.parse(await readFile(join(config.scratchRoot, file), "utf8")),
    );
    if (job.job !== file.slice(0, 32)) {
      throw new Error("Invalid persisted native build ownership");
    }
    jobs.set(job.job, job);
    if (job.state === "starting" || job.state === "running") {
      await remote(`cancel ${job.job}`);
      job.state = "interrupted";
      await save(job);
    }
  }
  return {
    start: async (request: NativeBuildRequest) => {
      if (
        !/^[a-f0-9]{40}$/u.test(request.commit) ||
        !Number.isSafeInteger(request.pullRequest) ||
        request.pullRequest < 1 ||
        request.pullRequest > 99_999_999 ||
        !["archive", "native-smoke"].includes(request.action)
      ) {
        throw new Error("Invalid native build request");
      }
      if (
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
      await save(job);
      const abort = new AbortController();
      const task = (async () => {
        const bundle = join(config.scratchRoot, `${job.job}.bundle`);
        try {
          const command = workerIdentityCommand(
            [
              "/usr/bin/git",
              "-C",
              request.workspacePath,
              "bundle",
              "create",
              "-",
              "HEAD",
            ],
            request.workerUid,
          );
          const executable = command.shift();
          if (!executable) throw new Error("Native bundle command missing");
          await run([executable, ...command], {
            outputFile: bundle,
            outputLimit: MAX_BUNDLE,
            timeout: 120_000,
            signal: abort.signal,
          });
          const info = await lstat(bundle);
          job.state = "running";
          await save(job);
          const response: unknown = JSON.parse(
            await remote(
              `run ${job.job} ${job.commit} ${request.pullRequest} ${job.action} ${info.size}`,
              { inputFile: bundle, timeout: 3_600_000, signal: abort.signal },
            ),
          );
          if (
            typeof response !== "object" ||
            response === null ||
            !("job" in response) ||
            response.job !== job.job ||
            !("commit" in response) ||
            response.commit !== request.commit ||
            !("action" in response) ||
            response.action !== request.action ||
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
      return { ...job };
    },
    status: async (sessionId: string, jobId: string) => ({
      ...ownedJob(sessionId, jobId),
    }),
    artifact: async (sessionId: string, jobId: string) => {
      const job = ownedJob(sessionId, jobId);
      if (job.state !== "succeeded")
        throw new Error("Native build has no successful artifact");
      const path = join(config.scratchRoot, `${job.job}.tar`);
      try {
        const info = await lstat(path);
        if (
          info.size === job.artifactBytes &&
          (await artifactHash(path)) === job.artifactSha256
        )
          return { path, sha256: job.artifactSha256, bytes: info.size };
        throw new Error("Cached native artifact differs from receipt");
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
        return { path, sha256: job.artifactSha256, bytes: info.size };
      } finally {
        await rm(temporary, { force: true });
      }
    },
    cancel: async (sessionId: string, jobId: string) => {
      const job = ownedJob(sessionId, jobId);
      const pending = active.get(job.job);
      pending?.abort.abort();
      try {
        await remote(`cancel ${job.job}`);
      } finally {
        await pending?.task;
      }
    },
    close: async () => {
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
    },
  };
}

/** Copy verified opaque bytes through the worker uid. The gateway never opens
 * a worker-controlled destination or extracts an archive from the guest. */
export async function deliverNativeArtifact(
  client: Awaited<ReturnType<typeof createNativeBuildClient>>,
  request: {
    readonly sessionId: string;
    readonly job: string;
    readonly workspacePath: string;
    readonly workerUid?: string;
  },
) {
  const artifact = await client.artifact(request.sessionId, request.job);
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
}
