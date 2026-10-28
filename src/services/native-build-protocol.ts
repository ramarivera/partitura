import { join } from "node:path";
import { Schema } from "effect";
import { NativeOperationError } from "./native-build-errors.js";
import { nativeId } from "./native-build-file-io.js";
import {
  type NativeGeneration,
  type NativeRegistryJob,
  type NativeTransportMetadata,
  nativeLimits,
  TransportMetadata,
} from "./native-build-models.js";
export class NativeTransportError extends Schema.TaggedError<NativeTransportError>()(
  "@Gateway/NativeTransportError",
  {
    reason: Schema.Literals([
      "unavailable",
      "wrong-host",
      "protocol-mismatch",
      "missing-credentials",
      "needs-refresh",
      "host-key-mismatch",
    ]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {
  static new(
    reason:
      | "unavailable"
      | "wrong-host"
      | "protocol-mismatch"
      | "missing-credentials"
      | "needs-refresh"
      | "host-key-mismatch",
    cause?: unknown,
  ) {
    return new NativeTransportError({
      reason,
      message: reason,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
export type NativeBrokerBinding = Pick<NativeRegistryJob, "jobId"> &
  Partial<
    Pick<NativeRegistryJob, "commit" | "action" | "attempt" | "imported">
  >;

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
  jobRootFreeBytes?: number;
  tartRootFreeBytes?: number;
  hostFloorBytes?: number;
  runner?: {
    job: string;
    attempt: string;
    stage: string;
    heartbeat: number;
  } | null;
  reasons?: string[];
  reconciledJobs?: string[];
  maintenanceJobId?: string;
  storageAccessHint?: string;
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
    "storageAccessHint",
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
  job?: NativeBrokerBinding,
): BrokerEnvelope {
  const invalid = () => {
    throw NativeTransportError.new("protocol-mismatch");
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
  } catch (error) {
    throw NativeTransportError.new("protocol-mismatch", error);
  }
  if (
    !object(value) ||
    value.protocolVersion !== 2 ||
    typeof value.hostId !== "string" ||
    typeof value.kind !== "string"
  )
    return invalid();
  if (value.hostId !== generation.transport.hostId)
    throw NativeTransportError.new("wrong-host");
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
      value.storageAccessHint !== undefined &&
      (value.storageAccessHint !==
        "Verify Remote Login > Allow full disk access for remote users is enabled on this host." ||
        !Array.isArray(value.reasons) ||
        !value.reasons.includes("storage-access-denied"))
    )
      invalid();
    if (
      (value.maintenanceJobId !== undefined &&
        !validId(value.maintenanceJobId)) ||
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
      typeof job.commit !== "string" ||
      typeof job.action !== "string" ||
      (!job.imported && typeof job.attempt !== "string") ||
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
    // Persisted as Text (1-256 chars); reject before it reaches storage.
    if (
      value.failureCode !== undefined &&
      (typeof value.failureCode !== "string" ||
        value.failureCode.length < 1 ||
        value.failureCode.length > 256)
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
    throw NativeOperationError.new("invalid-native-key");
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
    throw NativeOperationError.new("invalid-native-transport");
  if (
    new Set(transport.hostKeys.map((pin) => `${pin.type} ${pin.base64}`))
      .size !== transport.hostKeys.length
  )
    throw NativeOperationError.new("invalid-native-pin");
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
      throw NativeOperationError.new("invalid-native-pin");
    const blob = base64(pin.base64);
    let offset = 0;
    const read = () => {
      if (offset + 4 > blob.length)
        throw NativeOperationError.new("invalid-native-pin");
      const length = blob.readUInt32BE(offset);
      offset += 4;
      if (offset + length > blob.length)
        throw NativeOperationError.new("invalid-native-pin");
      const bytes = blob.subarray(offset, offset + length);
      offset += length;
      return bytes;
    };
    if (read().toString() !== pin.type)
      throw NativeOperationError.new("invalid-native-pin");
    if (pin.type === "ssh-ed25519") {
      if (read().length !== 32)
        throw NativeOperationError.new("invalid-native-pin");
    } else if (pin.type === "ssh-rsa") {
      for (const number of [read(), read()])
        if (
          !number.length ||
          number.length > 1025 ||
          (number[0] ?? 128) >= 128 ||
          (number[0] === 0 && (number.length < 2 || (number[1] ?? 0) < 128))
        )
          throw NativeOperationError.new("invalid-native-pin");
    } else {
      const curve = pin.type.slice("ecdsa-sha2-".length),
        point = read();
      if (point.toString() !== curve)
        throw NativeOperationError.new("invalid-native-pin");
      const bytes = read();
      const length = { nistp256: 65, nistp384: 97, nistp521: 133 }[curve];
      if (bytes.length !== length || bytes[0] !== 4)
        throw NativeOperationError.new("invalid-native-pin");
    }
    if (offset !== blob.length)
      throw NativeOperationError.new("invalid-native-pin");
  }
  if (Buffer.byteLength(key) > 32768)
    throw NativeOperationError.new("invalid-native-key");
  const match =
    /^-----BEGIN OPENSSH PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)-----END OPENSSH PRIVATE KEY-----\n$/u.exec(
      key,
    );
  if (!match?.[1]) throw NativeOperationError.new("invalid-native-key");
  const blob = base64(match[1].replaceAll("\n", ""));
  const magic = Buffer.from("openssh-key-v1\0");
  let offset = magic.length;
  if (!blob.subarray(0, offset).equals(magic))
    throw NativeOperationError.new("invalid-native-key");
  const field = () => {
    if (offset + 4 > blob.length)
      throw NativeOperationError.new("invalid-native-key");
    const size = blob.readUInt32BE(offset);
    offset += 4;
    if (offset + size > blob.length)
      throw NativeOperationError.new("invalid-native-key");
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
    throw NativeOperationError.new("invalid-native-key");
  offset += 4;
  field();
  const privateBlob = field();
  if (
    offset !== blob.length ||
    privateBlob.length < 8 ||
    privateBlob.readUInt32BE(0) !== privateBlob.readUInt32BE(4)
  )
    throw NativeOperationError.new("invalid-native-key");
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
    if (/[\r\n"\\%]/u.test(path))
      throw NativeOperationError.new("unsafe-native-ssh-path");
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
