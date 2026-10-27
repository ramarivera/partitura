import { Effect, Option, Redacted } from "effect";
import { RpcSpawnError } from "../domain/errors.js";
import type { SessionId } from "../domain/ids.js";
import type { AgentRun } from "../domain/models.js";
import type { GatewayConfig } from "./config.js";
import type { NativeBuildConfig } from "./native-build-client.js";
import {
  makeSessionSandboxRuntime,
  type SessionSandboxHandle,
  type SessionSandboxRelay,
} from "./session-sandbox.js";

export const makeWorkerResources = ({
  config,
  sandboxMode,
  sandboxHandles,
  sandboxRelays,
  stopSandboxRelays,
}: {
  config: GatewayConfig["Service"];
  sandboxMode: NonNullable<GatewayConfig["Service"]["workerSandboxMode"]>;
  sandboxHandles: Map<SessionId, SessionSandboxHandle>;
  sandboxRelays: Map<SessionId, SessionSandboxRelay[]>;
  stopSandboxRelays: (id: SessionId) => void;
}) => {
  type NativeBuildClient = Awaited<
    ReturnType<
      typeof import("./native-build-client.js").createNativeBuildClient
    >
  >;
  type NativeBuilder = "primary" | "backup";
  const nativeBuildClients = new Map<
    NativeBuilder,
    Promise<NativeBuildClient>
  >();
  const nativeBuildJobs = new Map<
    SessionId,
    Map<string, { builder: NativeBuilder; job: string }>
  >();
  const repositoryAgeIdentity = (run: AgentRun) =>
    Option.isSome(run.repositoryId) &&
    config.workerRepositoryAgeKeys !== undefined
      ? Redacted.value(config.workerRepositoryAgeKeys)[run.organizationId]?.[
          run.repositoryId.value
        ]
      : undefined;
  const getNativeBuildClient = (builder: NativeBuilder) => {
    const nativeBuild: NativeBuildConfig | undefined =
      builder === "backup" ? config.nativeBuildBackup : config.nativeBuild;
    if (nativeBuild === undefined)
      return Promise.reject(new Error("Native builder is disabled"));
    const existing = nativeBuildClients.get(builder);
    if (existing) return existing;
    const initialized = import("./native-build-client.js")
      .then(({ createNativeBuildClient }) =>
        createNativeBuildClient(nativeBuild),
      )
      .catch((error: unknown) => {
        nativeBuildClients.delete(builder);
        throw error;
      });
    nativeBuildClients.set(builder, initialized);
    return initialized;
  };
  const sandboxRuntime =
    sandboxMode !== "native" &&
    config.sessionSandboxBrokerSocketPath !== undefined
      ? makeSessionSandboxRuntime(
          config.sessionSandboxBrokerSocketPath,
          sandboxMode,
        )
      : undefined;
  const rememberSandboxRelay = (
    sessionId: SessionId,
    relay: SessionSandboxRelay,
  ) => {
    const current = sandboxRelays.get(sessionId) ?? [];
    current.push(relay);
    sandboxRelays.set(sessionId, current);
    return relay;
  };
  const openSandboxRelay = Effect.fn("SessionAuthority.openSandboxRelay")(
    function* (
      sessionId: SessionId,
      target: "gateway" | "worker",
      targetPort: number,
    ) {
      if (sandboxRuntime === undefined)
        return yield* Effect.fail(
          new RpcSpawnError({ message: "Sandbox relay is unavailable" }),
        );
      const relay = yield* sandboxRuntime
        .openRelay(sessionId, target, targetPort)
        .pipe(
          Effect.mapError(
            () =>
              new RpcSpawnError({
                message: "Could not start the per-session sandbox relay",
              }),
          ),
        );
      return rememberSandboxRelay(sessionId, relay);
    },
  );
  const provisionSandbox = Effect.fn("SessionAuthority.provisionSandbox")(
    function* (
      sessionId: SessionId,
      cwd: string,
      workerUid: string | undefined,
    ) {
      if (sandboxRuntime === undefined) return undefined;
      if (workerUid === undefined)
        return yield* new RpcSpawnError({
          message: "Sysbox mode requires a per-session worker uid range",
        });
      const recovered = yield* sandboxRuntime
        .recover(sessionId, cwd, workerUid)
        .pipe(
          Effect.mapError(
            () =>
              new RpcSpawnError({
                message: "Could not recover the per-session sandbox",
              }),
          ),
        );
      const handle =
        recovered.handle ??
        (yield* sandboxRuntime.provision(sessionId, cwd, workerUid).pipe(
          Effect.mapError(
            () =>
              new RpcSpawnError({
                message: "Could not provision the per-session sandbox",
              }),
          ),
        ));
      sandboxHandles.set(sessionId, handle);
      const proxy = yield* sandboxRuntime.openEgressProxy(sessionId).pipe(
        Effect.mapError(
          () =>
            new RpcSpawnError({
              message: "Could not start the sandbox egress proxy",
            }),
        ),
        Effect.tapError(() =>
          sandboxRuntime
            .destroy(sessionId)
            .pipe(
              Effect.tap(Effect.sync(() => sandboxHandles.delete(sessionId))),
              Effect.ignore,
            ),
        ),
      );
      rememberSandboxRelay(sessionId, proxy);
      return { handle, egressProxyUrl: proxy.baseUrl };
    },
  );
  const destroySandbox = (sessionId: SessionId) =>
    Effect.gen(function* () {
      stopSandboxRelays(sessionId);
      if (sandboxRuntime === undefined) return;
      yield* sandboxRuntime.destroy(sessionId).pipe(
        Effect.mapError(
          () =>
            new RpcSpawnError({
              message: "Could not destroy the per-session sandbox",
            }),
        ),
        Effect.tap(() => Effect.sync(() => sandboxHandles.delete(sessionId))),
      );
    });

  const cancelSessionNativeBuilds = (sessionId: SessionId) =>
    Effect.promise(async () => {
      const jobs = nativeBuildJobs.get(sessionId);
      if (jobs === undefined) return;
      try {
        for (const { builder, job } of jobs.values()) {
          try {
            const client = await getNativeBuildClient(builder);
            const status = await client.status(sessionId, job);
            if (status.state === "starting" || status.state === "running")
              await client.cancel(sessionId, job);
          } catch {
            // Session cleanup must continue if the build host is down.
          }
        }
      } finally {
        nativeBuildJobs.delete(sessionId);
      }
    });
  return {
    nativeBuildClients,
    nativeBuildJobs,
    repositoryAgeIdentity,
    getNativeBuildClient,
    openSandboxRelay,
    provisionSandbox,
    destroySandbox,
    cancelSessionNativeBuilds,
  };
};
