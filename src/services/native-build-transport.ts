import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Schema } from "effect";
import {
  nativeDirectory,
  nativeFile,
  nativeId,
  writeNativeFile,
} from "./native-build-files.js";
import {
  type NativeBuildState,
  type NativeGeneration,
  type NativeRegistryJob,
  type NativeTransportMetadata,
  nativeLimits,
  TransportMetadata,
} from "./native-build-state.js";

export class NativeTransportError extends Error {
  constructor(
    readonly reason:
      | "unavailable"
      | "wrong-host"
      | "protocol-mismatch"
      | "missing-credentials"
      | "needs-refresh"
      | "host-key-mismatch",
  ) {
    super(reason);
  }
}
export type BrokerEnvelope = {
  protocolVersion: 2;
  hostId: string;
  kind: string;
  job?: string;
  commit?: string;
  action?: string;
  attempt?: string;
  state?: "receiving" | "running" | "succeeded" | "failed" | "cancelled";
  epoch?: string;
  nonce?: string;
  accepted?: boolean;
  code?: string;
  status?: "ready" | "busy" | "blocked";
  accepting?: boolean;
  profile?: string;
  capacity?: number;
  runner?: {
    job: string;
    attempt: string;
    stage: string;
    heartbeat: number;
  } | null;
  reasons?: string[];
  reconciledJobs?: string[];
  artifactBytes?: number;
  artifactSha256?: string;
  artifactExpired?: boolean;
  failureCode?: string;
  stage?: string;
};
const envelopeKeys: Record<string, readonly string[]> = {
  health: [
    "brokerRevision",
    "capabilities",
    "profile",
    "epoch",
    "status",
    "accepting",
    "capacity",
    "reasons",
    "jobRootFreeBytes",
    "tartRootFreeBytes",
    "hostFloorBytes",
    "housekeepingSkippedEntries",
    "keychainPolicy",
    "runner",
    "maintenanceJobId",
  ],
  known: [
    "job",
    "commit",
    "action",
    "attempt",
    "state",
    "stage",
    "failureCode",
    "artifactExpired",
    "artifactBytes",
    "artifactSha256",
    "bootExitCode",
    "workflowExitCode",
    "keychainPolicy",
    "preRelockState",
  ],
  "unknown-job": ["job", "tombstonePresent", "inconsistentDirectory"],
  refused: [
    "job",
    "commit",
    "action",
    "attempt",
    "accepted",
    "code",
    "state",
    "stage",
    "failureCode",
  ],
  "cancellation-requested": ["job"],
  busy: ["job", "runner"],
  "reconciled-terminal": ["job", "epoch", "nonce", "reconciledJobs"],
  "reconciled-unknown": ["job", "epoch", "nonce", "reconciledJobs"],
  "cleanup-required": ["job"],
  "keychain-relock-pending": ["job"],
  error: ["code"],
};
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validId = (value: unknown) =>
  typeof value === "string" && nativeId.test(value);
const safeCount = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const stages = new Set([
  "receiving",
  "capacity",
  "unlock",
  "keychain-policy",
  "clone",
  "boot",
  "workflow",
  "artifact",
  "cleanup",
  "disk-preflight",
  "disk-post-transfer",
]);

/** Closed bounded wire decoder for the protocol actually merged in slice 2. */
export function decodeBrokerEnvelope(
  bytes: string,
  generation: NativeGeneration,
  job?: NativeRegistryJob,
): BrokerEnvelope {
  const invalid = () => {
    throw new NativeTransportError("protocol-mismatch");
  };
  if (
    Buffer.byteLength(bytes) > 4096 ||
    !bytes.endsWith("\n") ||
    bytes.trim().includes("\n")
  )
    invalid();
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    invalid();
  }
  if (
    !object(value) ||
    value.protocolVersion !== 2 ||
    typeof value.hostId !== "string" ||
    typeof value.kind !== "string"
  )
    return invalid();
  if (value.hostId !== generation.transport.hostId)
    throw new NativeTransportError("wrong-host");
  const keys = envelopeKeys[value.kind];
  if (
    !keys ||
    Object.keys(value).some(
      (key) => !["protocolVersion", "hostId", "kind", ...keys].includes(key),
    )
  )
    invalid();
  if (value.kind === "health") {
    if (
      !validId(value.epoch) ||
      !["ready", "busy", "blocked"].includes(String(value.status)) ||
      typeof value.accepting !== "boolean" ||
      ![0, 1].includes(Number(value.capacity)) ||
      !["legacy", "registry-only"].includes(String(value.profile)) ||
      !Array.isArray(value.reasons) ||
      value.reasons.length > 16 ||
      value.reasons.some(
        (reason) => typeof reason !== "string" || reason.length > 64,
      ) ||
      (value.accepting &&
        (value.status !== "ready" ||
          value.profile !== "registry-only" ||
          value.capacity !== 1 ||
          value.reasons.length !== 0))
    )
      invalid();
    for (const name of [
      "jobRootFreeBytes",
      "tartRootFreeBytes",
      "hostFloorBytes",
    ])
      if (value[name] !== null && !safeCount(value[name])) invalid();
    if (
      !Array.isArray(value.capabilities) ||
      !["health", "status", "reconcile", "run-v2"].every((capability) =>
        (value.capabilities as unknown[]).includes(capability),
      )
    )
      invalid();
  } else if (value.kind !== "error") {
    if (!job || value.job !== job.jobId) invalid();
  }
  if (value.runner !== undefined && value.runner !== null) {
    const runner = value.runner;
    if (
      !object(runner) ||
      Object.keys(runner).sort().join(",") !== "attempt,heartbeat,job,stage" ||
      !validId(runner.job) ||
      !validId(runner.attempt) ||
      !stages.has(String(runner.stage)) ||
      typeof runner.heartbeat !== "number" ||
      !Number.isFinite(runner.heartbeat) ||
      runner.heartbeat <= 0
    )
      invalid();
  }
  if (value.kind === "known" || value.kind === "refused") {
    if (
      !job ||
      value.commit !== job.commit ||
      value.action !== job.action ||
      (value.attempt !== job.attempt &&
        !(job.imported && value.attempt === undefined))
    )
      invalid();
    if (
      value.kind === "known" &&
      !["receiving", "running", "succeeded", "failed", "cancelled"].includes(
        String(value.state),
      )
    )
      invalid();
    if (
      value.kind === "refused" &&
      (value.accepted !== false ||
        ![
          "host-busy",
          "host-reconciled",
          "cleanup-required",
          "keychain-relock-pending",
          "submission-expired",
          "stale-epoch",
          "duplicate-job",
          "duplicate-attempt",
          "cancelled",
          "host-maintenance",
          "legacy-profile",
        ].includes(String(value.code)))
    )
      invalid();
    if (value.stage !== undefined && !stages.has(String(value.stage)))
      invalid();
    if (
      (value.artifactBytes === undefined) !==
        (value.artifactSha256 === undefined) ||
      (value.artifactBytes !== undefined &&
        (!safeCount(value.artifactBytes) ||
          Number(value.artifactBytes) > nativeLimits.artifact ||
          typeof value.artifactSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(value.artifactSha256)))
    )
      invalid();
    if (
      value.artifactExpired !== undefined &&
      typeof value.artifactExpired !== "boolean"
    )
      invalid();
    if (
      (value.failureCode === "host-disk-space-unavailable") !==
      ["disk-preflight", "disk-post-transfer"].includes(String(value.stage))
    )
      invalid();
  }
  if (
    value.kind === "unknown-job" &&
    (typeof value.tombstonePresent !== "boolean" ||
      typeof value.inconsistentDirectory !== "boolean")
  )
    invalid();
  if (value.kind.startsWith("reconciled-")) {
    if (
      !validId(value.epoch) ||
      !validId(value.nonce) ||
      !Array.isArray(value.reconciledJobs) ||
      value.reconciledJobs.length > 64 ||
      !value.reconciledJobs.every(validId) ||
      !value.reconciledJobs.includes(job?.jobId)
    )
      invalid();
  }
  return value as BrokerEnvelope;
}

function base64(value: string) {
  const bytes = Buffer.from(value, "base64");
  if (!value || bytes.toString("base64") !== value)
    throw new Error("invalid-native-key");
  return bytes;
}
export function validateNativeTransport(
  transport: NativeTransportMetadata,
  key: string,
  suffix: string,
) {
  Schema.decodeUnknownSync(TransportMetadata)(transport, {
    onExcessProperty: "error",
  });
  const hostname = transport.hostname;
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(
      hostname,
    ) ||
    !/^[a-z0-9.-]+$/u.test(suffix) ||
    !hostname.endsWith(`.${suffix}`) ||
    hostname.length > 253 ||
    hostname.split(".").some((label) => label.length > 63) ||
    !/^[a-z][a-z0-9_-]{0,30}$/u.test(transport.sshUser) ||
    transport.sshUser === "root" ||
    !Number.isSafeInteger(transport.port) ||
    transport.port < 1 ||
    transport.port > 65535
  )
    throw new Error("invalid-native-transport");
  if (
    new Set(transport.hostKeys.map((pin) => `${pin.type} ${pin.base64}`))
      .size !== transport.hostKeys.length
  )
    throw new Error("invalid-native-pin");
  for (const pin of transport.hostKeys) {
    if (
      ![
        "ssh-ed25519",
        "ssh-rsa",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
      ].includes(pin.type)
    )
      throw new Error("invalid-native-pin");
    const blob = base64(pin.base64);
    let offset = 0;
    const read = () => {
      if (offset + 4 > blob.length) throw new Error("invalid-native-pin");
      const length = blob.readUInt32BE(offset);
      offset += 4;
      if (offset + length > blob.length) throw new Error("invalid-native-pin");
      const bytes = blob.subarray(offset, offset + length);
      offset += length;
      return bytes;
    };
    if (read().toString() !== pin.type) throw new Error("invalid-native-pin");
    if (pin.type === "ssh-ed25519") {
      if (read().length !== 32) throw new Error("invalid-native-pin");
    } else if (pin.type === "ssh-rsa") {
      for (const number of [read(), read()])
        if (
          !number.length ||
          number.length > 1025 ||
          (number[0] ?? 128) >= 128 ||
          (number[0] === 0 && (number.length < 2 || (number[1] ?? 0) < 128))
        )
          throw new Error("invalid-native-pin");
    } else {
      const curve = pin.type.slice("ecdsa-sha2-".length),
        point = read();
      if (point.toString() !== curve) throw new Error("invalid-native-pin");
      const bytes = read();
      const length = { nistp256: 65, nistp384: 97, nistp521: 133 }[curve];
      if (bytes.length !== length || bytes[0] !== 4)
        throw new Error("invalid-native-pin");
    }
    if (offset !== blob.length) throw new Error("invalid-native-pin");
  }
  if (Buffer.byteLength(key) > 32768) throw new Error("invalid-native-key");
  const match =
    /^-----BEGIN OPENSSH PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)-----END OPENSSH PRIVATE KEY-----\n$/u.exec(
      key,
    );
  if (!match?.[1]) throw new Error("invalid-native-key");
  const blob = base64(match[1].replaceAll("\n", ""));
  const magic = Buffer.from("openssh-key-v1\0");
  let offset = magic.length;
  if (!blob.subarray(0, offset).equals(magic))
    throw new Error("invalid-native-key");
  const field = () => {
    if (offset + 4 > blob.length) throw new Error("invalid-native-key");
    const size = blob.readUInt32BE(offset);
    offset += 4;
    if (offset + size > blob.length) throw new Error("invalid-native-key");
    const bytes = blob.subarray(offset, offset + size);
    offset += size;
    return bytes;
  };
  if (
    field().toString() !== "none" ||
    field().toString() !== "none" ||
    field().length !== 0 ||
    offset + 4 > blob.length ||
    blob.readUInt32BE(offset) !== 1
  )
    throw new Error("invalid-native-key");
  offset += 4;
  field();
  const privateBlob = field();
  if (
    offset !== blob.length ||
    privateBlob.length < 8 ||
    privateBlob.readUInt32BE(0) !== privateBlob.readUInt32BE(4)
  )
    throw new Error("invalid-native-key");
}

export function renderNativeSsh(
  transport: NativeTransportMetadata,
  directory: string,
) {
  const lookup =
    transport.port === 22
      ? transport.hostname
      : `[${transport.hostname}]:${transport.port}`;
  // All paths are generated from trusted canonical roots, quoted and bounded.
  const quote = (path: string) => {
    if (/[\r\n"\\%]/u.test(path)) throw new Error("unsafe-native-ssh-path");
    return `"${path}"`;
  };
  return {
    knownHosts: transport.hostKeys
      .map((pin) => `${lookup} ${pin.type} ${pin.base64}\n`)
      .join(""),
    config:
      `Host partitura-native\n  HostName ${transport.hostname}\n  User ${transport.sshUser}\n  Port ${transport.port}\n  IdentityFile ${quote(join(directory, "identity"))}\n  UserKnownHostsFile ${quote(join(directory, "known_hosts"))}\n` +
      Object.entries({
        StrictHostKeyChecking: "yes",
        UpdateHostKeys: "no",
        IdentitiesOnly: "yes",
        IdentityAgent: "none",
        ForwardAgent: "no",
        ClearAllForwardings: "yes",
        PermitLocalCommand: "no",
        GlobalKnownHostsFile: "/dev/null",
        ControlMaster: "no",
        ControlPath: "none",
        BatchMode: "yes",
        PreferredAuthentications: "publickey",
        PasswordAuthentication: "no",
        KbdInteractiveAuthentication: "no",
        ConnectTimeout: "8",
        ConnectionAttempts: "1",
        ServerAliveInterval: "15",
        ServerAliveCountMax: "3",
        LogLevel: "DEBUG1",
        Tunnel: "no",
        RequestTTY: "no",
        EscapeChar: "none",
        ForwardX11: "no",
      })
        .map(([name, value]) => `  ${name} ${value}\n`)
        .join(""),
  };
}

/** Qualified against the Debian OpenSSH 9.2p1 diagnostic vocabulary only.
 * Other versions/truncation remain generic; raw diagnostic text stays private. */
export function classifyNativeSsh(stderr: string, truncated: boolean) {
  if (truncated) return "unavailable" as const;
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed\./u.test(
      stderr,
    )
  )
    return "host-key-mismatch" as const;
  if (
    /^OpenSSH_9\.2p1[ ,]/u.test(stderr) &&
    /debug1: Host '[^'\n]+' is known and matches the [A-Z0-9]+ host key\./u.test(
      stderr,
    ) &&
    /debug1: Authentications that can continue: publickey\r?\n/u.test(stderr) &&
    /debug1: No more authentication methods to try\.\r?\n[^\n]+: Permission denied \(publickey\)\.\r?\n$/u.test(
      stderr,
    )
  )
    return "needs-refresh" as const;
  return "unavailable" as const;
}

export interface NativeBrokerTransport {
  envelope(
    generation: NativeGeneration,
    command: string,
    job?: NativeRegistryJob,
    options?: {
      signal?: AbortSignal;
      timeout?: number;
      input?: AsyncIterable<Uint8Array>;
    },
  ): Promise<BrokerEnvelope>;
  artifact(
    generation: NativeGeneration,
    job: NativeRegistryJob,
    path: string,
    signal?: AbortSignal,
  ): Promise<void>;
  hasCredential(id: string): boolean;
}

export async function createNativeBuildTransport(
  state: NativeBuildState,
  options: {
    readonly suffix: string;
    readonly executable?: string;
    readonly needsRefresh?: (builderId: string) => void;
  },
) {
  const materialized = new Set<string>();
  const removeMaterial = async (id: string) => {
    const directory = state.generationPath(id);
    for (const name of ["identity", "known_hosts", "config"]) {
      await nativeFile(
        join(directory, name),
        name === "identity" ? 0o600 : 0o400,
        65_536,
      );
      await unlink(join(directory, name));
    }
    const { rmdir } = await import("node:fs/promises");
    await rmdir(directory);
    materialized.delete(id);
  };
  state.registerCredentialCleanup(async () => {
    for (const id of [...materialized]) await removeMaterial(id);
  });

  const materialize = async (generation: NativeGeneration, key: string) => {
    const saved = state
      .snapshot()
      .generations.find((candidate) => candidate.id === generation.id);
    if (
      !nativeId.test(generation.id) ||
      !saved ||
      saved.builderId !== generation.builderId ||
      saved.equalityTag !== generation.equalityTag
    )
      throw new Error("native-generation-mismatch");
    validateNativeTransport(generation.transport, key, options.suffix);
    if (state.equalityTag(generation.transport, key) !== generation.equalityTag)
      throw new Error("native-generation-mismatch");
    if (materialized.has(generation.id)) return;
    const directory = state.generationPath(generation.id);
    await nativeDirectory(directory, true);
    const rendered = renderNativeSsh(generation.transport, directory);
    try {
      await writeNativeFile(join(directory, "identity"), key, 0o600);
      const validation = spawn(
        "/usr/bin/ssh-keygen",
        ["-y", "-P", "", "-f", join(directory, "identity")],
        {
          cwd: "/",
          env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
          stdio: "ignore",
        },
      );
      const validated = new Promise<void>((resolve, reject) => {
        validation.once("error", () =>
          reject(new Error("native-key-validation-unavailable")),
        );
        validation.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error("invalid-native-key")),
        );
      });
      const deadline = setTimeout(() => validation.kill("SIGKILL"), 5000);
      try {
        await validated;
      } finally {
        clearTimeout(deadline);
        validation.kill("SIGKILL");
      }

      await writeNativeFile(
        join(directory, "known_hosts"),
        rendered.knownHosts,
        0o400,
      );
      await writeNativeFile(join(directory, "config"), rendered.config, 0o400);
      materialized.add(generation.id);
    } catch (error) {
      for (const name of ["identity", "known_hosts", "config"])
        await unlink(join(directory, name)).catch(() => undefined);
      const { rmdir } = await import("node:fs/promises");
      await rmdir(directory);
      throw error;
    }
  };
  const run = async (
    generation: NativeGeneration,
    command: string,
    settings: {
      signal?: AbortSignal;
      timeout?: number;
      input?: AsyncIterable<Uint8Array>;
      output?: string;
      maximum?: number;
    } = {},
  ) => {
    if (!materialized.has(generation.id))
      throw new NativeTransportError("missing-credentials");
    if (
      !/^(?:health|(?:status|cancel|artifact|reconcile) [a-f0-9]{32}|run-v2 [a-f0-9]{32} [a-f0-9]{40} [1-9][0-9]{0,7} [a-z][a-z0-9-]{0,63} [1-9][0-9]{0,9} (?:0|[1-9][0-9]{0,4}) [a-f0-9]{32} [a-f0-9]{32} [1-9][0-9]{0,9})$/u.test(
        command,
      )
    )
      throw new Error("invalid-native-command");
    const config = join(state.generationPath(generation.id), "config");
    await nativeFile(config, 0o400, 65_536);
    const release = state.retainGeneration(generation.id);
    const child = spawn(
      options.executable ?? "/usr/bin/ssh",
      ["-F", config, "partitura-native", command],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", () =>
        reject(new NativeTransportError("unavailable")),
      );
      child.once("close", resolve);
    });
    const kill = () => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(kill, settings.timeout ?? 30_000);
    settings.signal?.addEventListener("abort", kill, { once: true });
    if (settings.signal?.aborted) kill();
    const diagnostic: Buffer[] = [];
    let diagnosticBytes = 0;
    let truncated = false;
    const drain = (async () => {
      for await (const chunk of child.stderr) {
        const bytes = Buffer.from(chunk);
        if (diagnosticBytes < 32768)
          diagnostic.push(bytes.subarray(0, 32768 - diagnosticBytes));
        diagnosticBytes += bytes.length;
        truncated ||= diagnosticBytes > 32768;
      }
    })();
    const chunks: Buffer[] = [];
    let size = 0;
    let output: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (settings.output)
        output = await open(
          settings.output,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      const destination = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (output)
            output.writeFile(chunk).then(
              () => callback(),
              () => callback(new Error("native-output-failed")),
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
              ? new Error("native-transfer-exceeds-limit")
              : null,
            chunk,
          );
        },
      });
      const upload = settings.input
        ? pipeline(Readable.from(settings.input), child.stdin).then(
            () => false,
            (error: unknown) => {
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "EPIPE"
              )
                return true;
              throw error;
            },
          )
        : Promise.resolve(child.stdin.end()).then(() => false);
      const [inputBroken, , code] = await Promise.all([
        upload,
        pipeline(child.stdout, limiter, destination),
        exited,
        drain,
      ]);
      if ((code !== 0 && code !== 1) || settings.signal?.aborted) {
        const reason = classifyNativeSsh(
          Buffer.concat(diagnostic).toString(),
          truncated,
        );
        if (reason === "needs-refresh")
          options.needsRefresh?.(generation.builderId);
        throw new NativeTransportError(reason);
      }
      if (output) await output.sync();
      return {
        output: Buffer.concat(chunks).toString(),
        code,
        inputBroken,
        size,
      };
    } catch (error) {
      if (error instanceof NativeTransportError) throw error;
      throw new NativeTransportError("unavailable");
    } finally {
      clearTimeout(timer);
      settings.signal?.removeEventListener("abort", kill);
      kill();
      await exited.catch(() => undefined);
      await drain.catch(() => undefined);
      await output?.close();
      release();
    }
  };
  const envelope: NativeBrokerTransport["envelope"] = async (
    generation,
    command,
    job,
    settings,
  ) => {
    const result = await run(generation, command, settings);
    const value = decodeBrokerEnvelope(result.output, generation, job);
    if (command.startsWith("run-v2 ")) {
      if (
        !["known", "refused"].includes(value.kind) ||
        (result.inputBroken &&
          !(
            (value.kind === "refused" && value.accepted === false) ||
            (value.kind === "known" &&
              value.state === "failed" &&
              value.stage === "disk-preflight")
          )) ||
        (value.kind === "refused" && result.code !== 1) ||
        (value.kind === "known" &&
          result.code !== (value.state === "succeeded" ? 0 : 1))
      )
        throw new NativeTransportError("protocol-mismatch");
    }
    return value;
  };
  return {
    materialize,
    restore: async (source: string, keys: readonly string[]) => {
      if (keys.length > 2) throw new Error("too-many-native-keys");
      for (const generation of state
        .snapshot()
        .generations.filter((g) => g.transport.source === source))
        for (const key of keys)
          if (
            state.equalityTag(generation.transport, key) ===
            generation.equalityTag
          ) {
            await materialize(generation, key);
            break;
          }
    },
    hasCredential: (id: string) => materialized.has(id),
    envelope,
    artifact: async (
      generation: NativeGeneration,
      job: NativeRegistryJob,
      path: string,
      signal?: AbortSignal,
    ) => {
      const result = await run(generation, `artifact ${job.jobId}`, {
        output: path,
        maximum: job.artifactBytes ?? 0,
        timeout: 180_000,
        ...(signal ? { signal } : {}),
      });
      if (result.code !== 0 || result.size !== job.artifactBytes)
        throw new Error("native-artifact-size-mismatch");
    },
    dispose: async (id: string) => {
      if (!materialized.has(id)) throw new Error("native-generation-not-found");
      if (state.generationInUse(id))
        throw new Error("native-generation-in-use");
      await removeMaterial(id);
    },
  };
}

export async function hashNativeArtifact(path: string) {
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
      (info.mode & 0o777) !== 0o600 ||
      info.size > nativeLimits.artifact
    )
      throw new Error("unsafe-native-artifact");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return { sha256: hash.digest("hex"), bytes: info.size };
  } finally {
    await file.close();
  }
}

/** The state reservation remains charged across the atomic rename. */
export async function publishNativeArtifact(
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
    throw new Error("native-artifact-unavailable");
  const path = join(state.jobPath(job), "artifact.tar");
  const releaseGeneration = state.retainGeneration(generation.id);
  const releaseFile = state.retainFile(path);
  let transferred = false;
  try {
    try {
      const cached = await hashNativeArtifact(path);
      if (
        cached.sha256 !== job.artifactSha256 ||
        cached.bytes !== job.artifactBytes
      )
        throw new Error("native-artifact-mismatch");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
      await state.prune();
      const reservation = await state.reserve(
        job,
        "artifact.partial",
        job.artifactBytes,
      );
      try {
        await transport.artifact(generation, job, reservation.path);
        const fetched = await hashNativeArtifact(reservation.path);
        if (
          fetched.sha256 !== job.artifactSha256 ||
          fetched.bytes !== job.artifactBytes
        )
          throw new Error("native-artifact-mismatch");
        await reservation.commit(path);
      } finally {
        await reservation.release();
      }
    }
    transferred = true;
    let released = false;
    return {
      path,
      bytes: job.artifactBytes,
      sha256: job.artifactSha256,
      release: () => {
        if (released) return;
        released = true;
        releaseFile();
        releaseGeneration();
      },
    };
  } finally {
    if (!transferred) {
      releaseFile();
      releaseGeneration();
    }
  }
}
