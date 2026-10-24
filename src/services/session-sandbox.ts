import { createConnection, isIPv4 } from "node:net";
import { Effect, Schema } from "effect";

export class SandboxBrokerError extends Schema.TaggedError<SandboxBrokerError>()(
  "@Gateway/SandboxBrokerError",
  {
    message: Schema.String,
    operation: Schema.Literals([
      "provision",
      "destroy",
      "recover",
      "relay",
      "egress",
    ]),
  },
) {}

export interface SessionSandboxHandle {
  readonly sessionId: string;
  readonly container: string;
  readonly workspace: "/workspace";
  readonly workerAddress: string;
  readonly gatewayAddress: string;
  readonly relayAddress: string;
}

export type SandboxBrokerRequest =
  | {
      readonly operation: "provision";
      readonly sessionId: string;
      readonly workspacePath: string;
      readonly workerUid: string;
    }
  | { readonly operation: "destroy"; readonly sessionId: string }
  | {
      readonly operation: "recover";
      readonly sessionId: string;
      readonly workspacePath: string;
      readonly workerUid: string;
    };

const BROKER_REQUEST_TIMEOUT_MS = {
  provision: 15 * 60_000,
  destroy: 5 * 60_000,
  recover: 5 * 60_000,
} as const;

export const sandboxBrokerRequestTimeoutMs = (
  operation: SandboxBrokerRequest["operation"],
): number => BROKER_REQUEST_TIMEOUT_MS[operation];

interface BrokerResponse {
  readonly ok: boolean;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
}

const SESSION_ID = /^[a-zA-Z0-9_-]{1,96}$/u;

export const sandboxContainerName = (sessionId: string): string => {
  if (!SESSION_ID.test(sessionId))
    throw new Error("Invalid sandbox session id");
  return `partitura-session-${sessionId}`;
};

export const sandboxEnvironment = (
  workspacePath: string,
  input: Record<string, string>,
): Record<string, string> => {
  const normalizedWorkspace = workspacePath.endsWith("/")
    ? workspacePath.slice(0, -1)
    : workspacePath;
  const replaceWorkspace = (value: string) =>
    value === normalizedWorkspace || value.startsWith(`${normalizedWorkspace}/`)
      ? `/workspace${value.slice(normalizedWorkspace.length)}`
      : value;
  return {
    ...Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        replaceWorkspace(value),
      ]),
    ),
    // Gateway Nix and node_modules paths aren't mounted into the sandbox.
    // These directories belong to the image or this session's Mise volume.
    PATH: "/mise/shims:/mise/bin:/usr/local/bin:/opt/claude/bin:/opt/codex/bin:/opt/t3:/usr/bin:/bin",
    MISE_DATA_DIR: "/mise",
    MISE_CACHE_DIR: "/mise/cache",
    MISE_CONFIG_DIR: "/workspace/.omp-home/mise/config",
    MISE_TRUSTED_CONFIG_PATHS: "/workspace",
  };
};

export const sandboxWorkerLaunch = (
  sessionId: string,
  brokerSocketPath: string,
  workerUid: string,
  cwd: string,
  env: Record<string, string>,
  command: ReadonlyArray<string>,
): {
  readonly command: ReadonlyArray<string>;
  readonly env: Record<string, string>;
} => {
  if (!SESSION_ID.test(sessionId))
    throw new Error("Invalid sandbox session id");
  if (!/^[1-9][0-9]{0,4}$/u.test(workerUid))
    throw new Error("Sandbox worker uid must be a non-root numeric uid");
  if (command.length === 0)
    throw new Error("Sandbox worker command cannot be empty");
  if (!cwd.startsWith("/"))
    throw new Error("Sandbox worker cwd must be absolute");
  const wrapper = new URL("../session-sandbox-exec.js", import.meta.url)
    .pathname;
  const normalizedWorkspace = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  const mapWorkspace = (value: string) =>
    value === normalizedWorkspace || value.startsWith(`${normalizedWorkspace}/`)
      ? `/workspace${value.slice(normalizedWorkspace.length)}`
      : value;
  return {
    command: [process.execPath, wrapper, "--", ...command.map(mapWorkspace)],
    env: {
      PARTITURA_SANDBOX_BROKER_SOCKET: brokerSocketPath,
      PARTITURA_SANDBOX_SESSION_ID: sessionId,
      PARTITURA_SANDBOX_WORKER_UID: workerUid,
      PARTITURA_SANDBOX_CWD: "/workspace",
      PARTITURA_SANDBOX_ENV: JSON.stringify(sandboxEnvironment(cwd, env)),
    },
  };
};

const requestBroker = (
  socketPath: string,
  request: SandboxBrokerRequest,
): Promise<BrokerResponse> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > 16_384) {
        socket.destroy(new Error("Sandbox broker response exceeded limit"));
        return;
      }
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(data.slice(0, newline)) as BrokerResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (!data.includes("\n"))
        reject(new Error("Sandbox broker closed before replying"));
    });
    socket.setTimeout(sandboxBrokerRequestTimeoutMs(request.operation), () =>
      socket.destroy(new Error("Sandbox broker request timed out")),
    );
  });

export interface SessionSandboxRuntime {
  readonly provision: (
    sessionId: string,
    workspacePath: string,
    workerUid: string,
  ) => Effect.Effect<SessionSandboxHandle, SandboxBrokerError>;
  readonly destroy: (
    sessionId: string,
  ) => Effect.Effect<void, SandboxBrokerError>;
  readonly recover: (
    sessionId: string,
    workspacePath: string,
    workerUid: string,
  ) => Effect.Effect<
    {
      readonly exists: boolean;
      readonly running: boolean;
      readonly handle?: SessionSandboxHandle;
    },
    SandboxBrokerError
  >;
  readonly openRelay: (
    sessionId: string,
    target: "gateway" | "worker",
    targetPort: number,
  ) => Effect.Effect<SessionSandboxRelay, SandboxBrokerError>;
  readonly openEgressProxy: (
    sessionId: string,
  ) => Effect.Effect<SessionSandboxRelay, SandboxBrokerError>;
}

export interface SessionSandboxRelay {
  readonly baseUrl: string;
  readonly stop: () => void;
}

const openBrokerRelay = (
  socketPath: string,
  request:
    | {
        readonly operation: "relay";
        readonly sessionId: string;
        readonly target: "gateway" | "worker";
        readonly targetPort: number;
      }
    | { readonly operation: "egress"; readonly sessionId: string },
): Promise<SessionSandboxRelay> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let data = "";
    let settled = false;
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > 16_384) {
        socket.destroy(new Error("Sandbox relay response exceeded limit"));
        return;
      }
      const newline = data.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(data.slice(0, newline)) as BrokerResponse;
        const address = response.result?.address;
        const port = response.result?.port;
        if (
          !response.ok ||
          typeof address !== "string" ||
          !isIPv4(address) ||
          typeof port !== "number" ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535
        )
          throw new Error(
            response.error ?? "Sandbox broker returned an invalid relay",
          );
        settled = true;
        socket.setTimeout(0);
        resolve({
          baseUrl: `http://${address}:${port}`,
          stop: () => socket.end(),
        });
      } catch (error) {
        settled = true;
        socket.destroy();
        reject(error);
      }
    });
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.on("end", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Sandbox broker closed before replying"));
    });
    socket.on("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Sandbox broker closed before replying"));
    });
    socket.setTimeout(5_000, () => {
      if (settled) return;
      settled = true;
      socket.destroy(new Error("Sandbox broker relay request timed out"));
      reject(new Error("Sandbox broker relay request timed out"));
    });
  });

export const makeSessionSandboxRuntime = (
  socketPath: string,
): SessionSandboxRuntime => ({
  provision: Effect.fn("SessionSandbox.provision")(
    function* (sessionId, workspacePath, workerUid) {
      const operation = "provision" as const;
      const result = yield* Effect.tryPromise({
        try: () =>
          requestBroker(socketPath, {
            operation,
            sessionId,
            workspacePath,
            workerUid,
          }),
        catch: () =>
          new SandboxBrokerError({
            message: "Sandbox broker request failed",
            operation,
          }),
      });
      if (!result.ok)
        return yield* Effect.fail(
          new SandboxBrokerError({
            message: result.error ?? "Sandbox provisioning failed",
            operation,
          }),
        );
      const container = result.result?.container;
      if (container !== sandboxContainerName(sessionId))
        return yield* Effect.fail(
          new SandboxBrokerError({
            message: "Sandbox broker returned an invalid container",
            operation,
          }),
        );
      const workerAddress = result.result?.workerAddress;
      const gatewayAddress = result.result?.gatewayAddress;
      if (
        typeof workerAddress !== "string" ||
        typeof gatewayAddress !== "string" ||
        typeof result.result?.relayAddress !== "string" ||
        !isIPv4(workerAddress) ||
        !isIPv4(gatewayAddress) ||
        !isIPv4(result.result.relayAddress)
      )
        return yield* Effect.fail(
          new SandboxBrokerError({
            message: "Sandbox broker returned invalid network addresses",
            operation,
          }),
        );
      return {
        sessionId,
        container,
        workspace: "/workspace" as const,
        workerAddress,
        gatewayAddress,
        relayAddress: result.result.relayAddress,
      } satisfies SessionSandboxHandle;
    },
  ),
  destroy: Effect.fn("SessionSandbox.destroy")(function* (sessionId) {
    const operation = "destroy" as const;
    const result = yield* Effect.tryPromise({
      try: () => requestBroker(socketPath, { operation, sessionId }),
      catch: () =>
        new SandboxBrokerError({
          message: "Sandbox broker request failed",
          operation,
        }),
    });
    if (!result.ok)
      return yield* Effect.fail(
        new SandboxBrokerError({
          message: result.error ?? "Sandbox teardown failed",
          operation,
        }),
      );
  }),
  recover: Effect.fn("SessionSandbox.recover")(
    function* (sessionId, workspacePath, workerUid) {
      const operation = "recover" as const;
      const result = yield* Effect.tryPromise({
        try: () =>
          requestBroker(socketPath, {
            operation,
            sessionId,
            workspacePath,
            workerUid,
          }),
        catch: () =>
          new SandboxBrokerError({
            message: "Sandbox broker request failed",
            operation,
          }),
      });
      if (!result.ok)
        return yield* Effect.fail(
          new SandboxBrokerError({
            message: result.error ?? "Sandbox recovery check failed",
            operation,
          }),
        );
      const exists = result.result?.exists === true;
      const container = result.result?.container;
      const workerAddress = result.result?.workerAddress;
      const gatewayAddress = result.result?.gatewayAddress;
      const relayAddress = result.result?.relayAddress;
      const handle =
        exists &&
        container === sandboxContainerName(sessionId) &&
        typeof workerAddress === "string" &&
        isIPv4(workerAddress) &&
        typeof gatewayAddress === "string" &&
        isIPv4(gatewayAddress) &&
        typeof relayAddress === "string" &&
        isIPv4(relayAddress)
          ? {
              sessionId,
              container,
              workspace: "/workspace" as const,
              workerAddress,
              gatewayAddress,
              relayAddress,
            }
          : undefined;
      if (exists && handle === undefined)
        return yield* Effect.fail(
          new SandboxBrokerError({
            message: "Sandbox broker returned invalid recovery details",
            operation,
          }),
        );
      return {
        exists,
        running: result.result?.running === true,
        ...(handle === undefined ? {} : { handle }),
      };
    },
  ),
  openRelay: Effect.fn("SessionSandbox.openRelay")(
    function* (sessionId, target, targetPort) {
      const operation = "relay" as const;
      return yield* Effect.tryPromise({
        try: () =>
          openBrokerRelay(socketPath, {
            operation: "relay",
            sessionId,
            target,
            targetPort,
          }),
        catch: () =>
          new SandboxBrokerError({
            message: "Sandbox relay request failed",
            operation,
          }),
      });
    },
  ),
  openEgressProxy: Effect.fn("SessionSandbox.openEgressProxy")(
    function* (sessionId) {
      const operation = "egress" as const;
      return yield* Effect.tryPromise({
        try: () =>
          openBrokerRelay(socketPath, {
            operation,
            sessionId,
          }),
        catch: () =>
          new SandboxBrokerError({
            message: "Sandbox egress proxy request failed",
            operation,
          }),
      });
    },
  ),
});
