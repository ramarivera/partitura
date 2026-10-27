import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { Context, Effect, Exit, Layer, Schema, Semaphore } from "effect";
import { BuilderRegistryConfig } from "./config-native-build.js";
import { nativeFile, opaqueId } from "./native-build-file-io.js";
import {
  NativeSecretError,
  SecretFrames,
  type SecretRequest,
  SecretResponse,
  secretFrame,
} from "./native-build-secret-protocol.js";

export interface SecretHelperSettings {
  readonly node: string;
  readonly entrypoint: string;
  readonly cwd: string;
  readonly tokenFile?: string;
  readonly vaultId: string;
  readonly suffix: string;
  readonly qualified: boolean;
  readonly deadlineMs?: number;
  readonly reapMs?: number;
}
export class NativeSecretHelperConfig extends Context.Service<
  NativeSecretHelperConfig,
  SecretHelperSettings
>()("NativeSecretHelperConfig") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const settings = yield* BuilderRegistryConfig;
      return {
        node: "/opt/partitura/bin/node",
        entrypoint: "/app/dist/native-build-secret-helper.js",
        cwd: "/app",
        ...(settings.tokenFile ? { tokenFile: settings.tokenFile } : {}),
        vaultId: settings.vaultId ?? "",
        suffix: settings.suffix,
        qualified: settings.liveQualified ?? false,
      };
    }),
  );
}
const safeIO = <A>(action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: () => NativeSecretError.new("provider-unavailable"),
  });
async function trusted(path: string) {
  const actual = await realpath(path);
  for (let current = actual; ; current = dirname(current)) {
    const info = await lstat(current);
    const stickyAncestor =
      current !== actual && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (
      (info.uid !== 0 && info.uid !== process.getuid?.()) ||
      ((info.mode & 0o022) !== 0 && !stickyAncestor)
    )
      throw NativeSecretError.new("provider-unavailable");
    if (dirname(current) === current) break;
  }
}
/** One private pipe, one outstanding call, one reaped process group before reuse. */
export class NativeSecretPipe extends Context.Service<NativeSecretPipe>()(
  "NativeSecretPipe",
  {
    make: Effect.gen(function* () {
      const settings = yield* NativeSecretHelperConfig;
      const gate = yield* Semaphore.make(1);
      let child: ChildProcessWithoutNullStreams | undefined;
      let closed: Promise<void> | undefined;
      let protocolFailure: NativeSecretError | undefined;
      let pending:
        | {
            id: string;
            reply: (value: SecretResponse) => void;
            fail: (code: string) => void;
          }
        | undefined;
      const stop = Effect.fn("NativeSecretPipe.stop")(function* () {
        const process = child,
          completion = closed;
        child = undefined;
        closed = undefined;
        protocolFailure = undefined;
        if (!process) return;
        yield* safeIO(async () => {
          const signal = (kind: NodeJS.Signals) => {
            if (!process.pid) return;
            try {
              globalThis.process.kill(-process.pid, kind);
            } catch (cause) {
              if (
                !(
                  cause instanceof Error &&
                  "code" in cause &&
                  cause.code === "ESRCH"
                )
              )
                throw NativeSecretError.new("provider-unavailable");
            }
          };
          let escalation: ReturnType<typeof setTimeout> | undefined;
          let failure: NativeSecretError | undefined;
          try {
            signal("SIGTERM");
            escalation = setTimeout(() => {
              try {
                signal("SIGKILL");
              } catch {
                failure = NativeSecretError.new("provider-unavailable");
              }
            }, settings.reapMs ?? 2000);
            await completion;
            // Also kill group members that kept running after their leader closed.
            signal("SIGKILL");
            if (failure) throw failure;
          } finally {
            clearTimeout(escalation);
            process.stdin.destroy();
            process.stdout.destroy();
            process.stderr.destroy();
          }
        }).pipe(Effect.uninterruptible);
      });
      yield* Effect.addFinalizer(() => stop().pipe(Effect.orDie));
      const start = Effect.fn("NativeSecretPipe.start")(function* () {
        yield* safeIO(async () => {
          await trusted(settings.node);
          await trusted(settings.entrypoint);
          await trusted(settings.cwd);
        });
        const spawned = yield* Effect.try({
          try: () =>
            spawn(settings.node, [settings.entrypoint], {
              cwd: settings.cwd,
              detached: true,
              env: {
                PATH: "/usr/bin:/bin",
                LANG: "C",
                LC_ALL: "C",
                HOME: settings.cwd,
              },
              stdio: ["pipe", "pipe", "pipe"],
            }),
          catch: () => NativeSecretError.new("provider-unavailable"),
        });
        protocolFailure = undefined;
        child = spawned;
        closed = new Promise<void>((resolve) =>
          spawned.once("close", () => {
            resolve();
            if (child === spawned) pending?.fail("provider-unavailable");
          }),
        );
        const frames = new SecretFrames();
        spawned.stderr.resume(); // Drain/discard; never capture SDK diagnostics.
        spawned.on("error", () => {
          if (child === spawned) pending?.fail("provider-unavailable");
        });
        spawned.stdin.on("error", () => {
          if (child === spawned) pending?.fail("provider-unavailable");
        });
        spawned.stdout.on("data", (chunk: Buffer) => {
          if (child !== spawned) return; // Ignore late frames from a terminated helper.
          try {
            for (const input of frames.push(chunk)) {
              const value = Schema.decodeUnknownSync(SecretResponse)(input, {
                onExcessProperty: "error",
              });
              if (!pending || pending.id !== value.id) {
                protocolFailure = NativeSecretError.new(
                  "provider-protocol-invalid",
                );
                pending?.fail(protocolFailure.code);
                continue;
              }
              pending.reply(value);
            }
          } catch {
            protocolFailure = NativeSecretError.new(
              "provider-protocol-invalid",
            );
            pending?.fail(protocolFailure.code);
          }
        });
      });
      const request = Effect.fn("NativeSecretPipe.request")(function* (
        value: SecretRequest,
      ) {
        if (protocolFailure) {
          const error = protocolFailure;
          yield* stop();
          protocolFailure = undefined;
          return yield* Effect.fail(error);
        }
        if (!child) yield* start();
        const response = yield* Effect.callback<
          SecretResponse,
          NativeSecretError
        >((resume) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (
            effect: Effect.Effect<SecretResponse, NativeSecretError>,
          ) => {
            if (pending?.id !== value.id) return;
            clearTimeout(timer);
            pending = undefined;
            resume(effect);
          };
          pending = {
            id: value.id,
            reply: (value) => finish(Effect.succeed(value)),
            fail: (code) => finish(Effect.fail(NativeSecretError.new(code))),
          };
          timer = setTimeout(() => {
            if (pending?.id === value.id) pending.fail("provider-timeout");
          }, settings.deadlineMs ?? 10000);
          child?.stdin.write(secretFrame(value), (error) => {
            if (error) pending?.fail("provider-unavailable");
          });
          return Effect.sync(() => {
            clearTimeout(timer);
            if (pending?.id === value.id) pending = undefined;
          });
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? stop().pipe(Effect.orDie) : Effect.void,
          ),
        );
        if (response.kind === "error")
          return yield* Effect.fail(NativeSecretError.new(response.code));
        const expected =
          value.kind === "init"
            ? "ready"
            : value.kind === "read"
              ? "record"
              : "written";
        if (response.kind !== expected) {
          yield* stop();
          return yield* Effect.fail(
            NativeSecretError.new("provider-protocol-invalid"),
          );
        }
        return response;
      });
      return {
        stop,
        alive: () =>
          !protocolFailure &&
          child !== undefined &&
          child.exitCode === null &&
          child.signalCode === null,
        session: Effect.fn("NativeSecretPipe.session")(
          <A, E, R>(action: (call: typeof request) => Effect.Effect<A, E, R>) =>
            gate.withPermit(
              Effect.gen(function* () {
                if (!settings.qualified)
                  return yield* Effect.fail(
                    NativeSecretError.new("provider-live-disabled"),
                  );
                return yield* action(request);
              }),
            ),
        ),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
export class NativeBuildSecretHelper extends Context.Service<NativeBuildSecretHelper>()(
  "NativeBuildSecretHelper",
  {
    make: Effect.gen(function* () {
      const settings = yield* NativeSecretHelperConfig;
      const pipe = yield* NativeSecretPipe;
      let tokenDigest: string | undefined;
      return {
        read: Effect.fn("NativeBuildSecretHelper.read")(
          <E, R>(
            itemId: string,
            reserve: (units: number) => Effect.Effect<void, E, R>,
            onReadStart: () => Effect.Effect<void, E, R> = () => Effect.void,
          ) =>
            pipe.session((request) =>
              Effect.gen(function* () {
                if (!settings.qualified)
                  return yield* Effect.fail(
                    NativeSecretError.new("provider-live-disabled"),
                  );
                if (!settings.tokenFile)
                  return yield* Effect.fail(
                    NativeSecretError.new("provider-auth-failed"),
                  );
                const token = yield* safeIO(() =>
                  nativeFile(settings.tokenFile ?? "", 0o400, 16384),
                );
                const digest = createHash("sha256").update(token).digest("hex");
                const initialize = !pipe.alive() || tokenDigest !== digest;
                yield* reserve(initialize ? 12 : 4);
                if (initialize) {
                  yield* pipe.stop();
                  yield* request({
                    id: opaqueId(),
                    kind: "init",
                    access: "runtime",
                    auth: {
                      type: "token",
                      token: token.toString("utf8").trim(),
                    },
                    vaultId: settings.vaultId,
                    suffix: settings.suffix,
                  });
                  tokenDigest = digest;
                }
                yield* onReadStart();
                const response = yield* request({
                  id: opaqueId(),
                  kind: "read",
                  itemId,
                });
                if (response.kind !== "record")
                  return yield* Effect.fail(
                    NativeSecretError.new("provider-protocol-invalid"),
                  );
                return response.record;
              }),
            ),
        ),
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(NativeSecretPipe.layer),
    Layer.provide(NativeSecretHelperConfig.layer),
  );
}
