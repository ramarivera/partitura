/** Optional simulator control through an existing T3 server. No build or shell execution. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Effect, Redacted, Schema, Semaphore } from "effect";
import { ensureT3Project } from "../drivers/t3/projects.js";
import {
  connectT3,
  type T3RpcConnection,
  T3RpcError,
} from "../drivers/t3/rpc-client.js";
import type { RpcHostToolDefinition } from "./rpc-worker.js";

const ConfigSchema = Schema.Struct({
  baseUrl: Schema.String,
  tokenFile: Schema.String,
  workspaceRoot: Schema.String,
  organizationHosts: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  instanceId: Schema.String,
  model: Schema.String,
});
export type T3DeviceBackupConfig = typeof ConfigSchema.Type;
export const parseT3DeviceBackupConfig = (
  input: string,
): T3DeviceBackupConfig => {
  const config = Schema.decodeUnknownSync(ConfigSchema)(JSON.parse(input));
  const url = new URL(config.baseUrl);
  if (
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "T3 device backup requires HTTPS or loopback HTTP without URL credentials",
    );
  for (const path of [config.tokenFile, config.workspaceRoot])
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new Error("T3 device backup paths must be normalized and absolute");
  if (
    !config.instanceId.trim() ||
    !config.model.trim() ||
    Object.entries(config.organizationHosts).some(
      ([org, hosts]) =>
        !org.trim() || hosts.length === 0 || hosts.some((host) => !host.trim()),
    )
  )
    throw new Error(
      "T3 device backup requires explicit organization and host bindings",
    );
  return config;
};

const Device = Schema.Struct({
  hostId: Schema.String,
  id: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  name: Schema.String,
  version: Schema.String,
  booted: Schema.Boolean,
  physical: Schema.Boolean,
});
const Session = Schema.Struct({
  hostId: Schema.String,
  deviceId: Schema.String,
  threadId: Schema.String,
});
const State = Schema.Struct({
  hostStatus: Schema.String,
  agentAccessEnabled: Schema.Boolean,
  devices: Schema.Array(Device),
  sessions: Schema.Array(Session),
});
const Arguments = Schema.Struct({
  operation: Schema.Literals([
    "list",
    "open",
    "detail",
    "launch-app",
    "terminate-app",
    "close",
  ]),
  hostId: Schema.optional(Schema.String),
  deviceId: Schema.optional(Schema.String),
  appId: Schema.optional(Schema.String),
});

export const t3DeviceBackupTool: RpcHostToolDefinition = {
  name: "t3_device_backup",
  label: "T3: remote device backup",
  description:
    "Use an existing T3 server's simulators as a backup for native device checks. The primary disposable VM build route remains separate. List first; open only a stopped unclaimed simulator. Device actions and cleanup are bound to this run. This tool doesn't build, install apps, or execute shell commands.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: [
          "list",
          "open",
          "detail",
          "launch-app",
          "terminate-app",
          "close",
        ],
      },
      hostId: { type: "string", minLength: 1 },
      deviceId: { type: "string", minLength: 1 },
      appId: { type: "string", minLength: 1 },
    },
  },
};

const threadFor = (organizationId: string, sessionId: string) =>
  `partitura-device-${createHash("sha256")
    .update(JSON.stringify([organizationId, sessionId]))
    .digest("hex")}`;
const refused = (message: string) =>
  new T3RpcError({
    reason: "rejected",
    method: "device-backup",
    sent: false,
    message,
  });

type Request = T3RpcConnection["request"];
/** The optional transport seam lets tests exercise the same ownership and request contract. */
export const makeT3DeviceBackup = (
  config: T3DeviceBackupConfig,
  transport?: { readonly request: Request; readonly projectId: string },
) => {
  const gate = Semaphore.makeUnsafe(1);
  const baseUrl = new URL(config.baseUrl);
  const token = Effect.tryPromise({
    try: async () =>
      Redacted.make((await readFile(config.tokenFile, "utf8")).trim()),
    catch: () => refused("T3 device backup credential is unavailable"),
  });
  const connected = <A>(
    operation: (
      request: Request,
      project: Effect.Effect<string, T3RpcError>,
    ) => Effect.Effect<A, T3RpcError>,
  ) =>
    gate.withPermits(1)(
      Effect.scoped(
        Effect.gen(function* () {
          if (transport)
            return yield* operation(
              transport.request,
              Effect.succeed(transport.projectId),
            );
          const connection = yield* connectT3({ baseUrl, token });
          return yield* operation(
            connection.request,
            ensureT3Project({
              baseUrl,
              token,
              workspaceRoot: config.workspaceRoot,
              title: "Partitura device backup",
              idNamespace: "partitura-device",
            }),
          );
        }),
      ),
    );
  const hostsFor = (organizationId: string) =>
    new Set(config.organizationHosts[organizationId] ?? []);
  const state = (request: Request) =>
    request("device.list", { inspectOnly: true }).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(State)(value).pipe(
          Effect.mapError(() =>
            refused("T3 device backup returned invalid device state"),
          ),
        ),
      ),
    );
  const call = (
    organizationId: string,
    sessionId: string,
    raw: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      const hosts = hostsFor(organizationId);
      if (!hosts.size)
        return yield* refused(
          "T3 device backup isn't configured for this organization",
        );
      const args = yield* Schema.decodeUnknownEffect(Arguments)(raw).pipe(
        Effect.mapError(() => refused("Invalid T3 device backup arguments")),
      );
      const threadId = threadFor(organizationId, sessionId);
      return yield* connected((request, project) =>
        Effect.gen(function* () {
          const current = yield* state(request);
          const devices = current.devices.filter(
            (device) => hosts.has(device.hostId) && !device.physical,
          );
          if (args.operation === "list")
            return {
              hostStatus: current.hostStatus,
              agentAccessEnabled: current.agentAccessEnabled,
              devices: devices.map((device) => ({
                ...device,
                busy: current.sessions.some(
                  (session) =>
                    session.hostId === device.hostId &&
                    session.deviceId === device.id &&
                    session.threadId !== threadId,
                ),
              })),
            };
          if (!args.hostId || !args.deviceId || !hosts.has(args.hostId))
            return yield* refused(
              "Select a configured host and device from list",
            );
          const device = devices.find(
            (device) =>
              device.hostId === args.hostId && device.id === args.deviceId,
          );
          if (!device)
            return yield* refused(
              "Device isn't an available simulator on a configured host",
            );
          const sessions = current.sessions.filter(
            (session) =>
              session.hostId === device.hostId &&
              session.deviceId === device.id,
          );
          if (sessions.some((session) => session.threadId !== threadId))
            return yield* refused("Device is in use by another thread");
          const owned = sessions.some(
            (session) => session.threadId === threadId,
          );
          const target = { hostId: device.hostId, deviceId: device.id };
          if (args.operation === "open") {
            if (
              !current.agentAccessEnabled ||
              current.hostStatus === "disabled"
            )
              return yield* refused(
                "Enable device support and agent access in the existing T3 server",
              );
            if (owned) return { ...target, threadId, opened: true };
            if (device.booted)
              return yield* refused(
                "Select a stopped simulator so this run can own its lifecycle",
              );
            const projectId = yield* project;
            const launched = yield* request("orchestration.launchThread", {
              commandId: `${threadId}:launch`,
              threadId,
              reuseExistingThread: true,
              projectId,
              title: `Partitura device ${sessionId}`,
              modelSelection: {
                instanceId: config.instanceId,
                model: config.model,
              },
              runtimeMode: "approval-required",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              generateTitle: false,
            });
            if (
              typeof launched !== "object" ||
              launched === null ||
              !("threadId" in launched) ||
              launched.threadId !== threadId
            )
              return yield* refused("T3 returned a different device thread");
            const opened = yield* request("device.open", {
              ...target,
              threadId,
              platform: device.platform,
              boot: true,
            });
            const verified = yield* Schema.decodeUnknownEffect(Session)(
              opened,
            ).pipe(
              Effect.mapError(() =>
                refused("T3 returned invalid device ownership"),
              ),
            );
            if (
              verified.threadId !== threadId ||
              verified.hostId !== device.hostId ||
              verified.deviceId !== device.id
            )
              return yield* refused("T3 returned different device ownership");
            return { ...target, threadId, opened: true };
          }
          if (!owned)
            return yield* refused("Open this device for the current run first");
          if (args.operation === "close") {
            yield* request("device.close", {
              ...target,
              threadId,
              shutdown: true,
            });
            return { ...target, closed: true };
          }
          if (args.operation === "detail")
            return yield* request("device.detail", target);
          if (
            !args.appId ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(args.appId)
          )
            return yield* refused("Invalid app identifier");
          return yield* request("device.action", {
            ...target,
            type:
              args.operation === "launch-app" ? "launchApp" : "terminateApp",
            appId: args.appId,
          });
        }),
      );
    });
  return {
    call,
    release: (organizationId: string, sessionId: string) => {
      if (!hostsFor(organizationId).size) return Effect.void;
      const threadId = threadFor(organizationId, sessionId);
      return connected((request) =>
        Effect.gen(function* () {
          const current = yield* state(request);
          for (const session of current.sessions.filter(
            (session) =>
              session.threadId === threadId &&
              hostsFor(organizationId).has(session.hostId),
          ))
            yield* request("device.close", {
              threadId,
              hostId: session.hostId,
              deviceId: session.deviceId,
              // Another thread can attach after our open. Release our panel
              // without powering down the device they're now using.
              shutdown: !current.sessions.some(
                (other) =>
                  other.hostId === session.hostId &&
                  other.deviceId === session.deviceId &&
                  other.threadId !== threadId,
              ),
            });
        }),
      );
    },
  };
};
