import {
  type ChunkState,
  frameId,
  isString,
  makeRpcOutput,
  type PendingRequest,
  type RpcEvent,
  type RpcHostToolCall,
  type RpcHostToolDefinition,
  type RpcHostToolResult,
  type RpcWorkerHandle,
  record,
} from "./rpc-worker-output.js";

export type {
  RpcEvent,
  RpcHostToolCall,
  RpcHostToolDefinition,
  RpcHostToolResult,
  RpcWorkerHandle,
} from "./rpc-worker-output.js";

import type { Subprocess } from "bun";
import {
  Config,
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Semaphore,
} from "effect";
import {
  RpcProtocolError,
  RpcSpawnError,
  RpcTimeoutError,
} from "../domain/errors.js";
import { detachedProcessGroup, signalProcessTree } from "./process.js";
import { sandboxWorkerLaunch } from "./session-sandbox.js";
import {
  workerEnvironment,
  workerIdentityCommand,
  workerUidRange,
} from "./worker-security.js";

const GRACEFUL_STOP_TIMEOUT_MS = 2_000;
const FORCE_STOP_TIMEOUT_MS = 1_000;

function configWithDefault(
  name: string,
  fallback: string,
): Effect.Effect<string, never, never> {
  return Config.unwrap(
    Config.String(name).pipe(Config.withDefault(fallback)),
  ).pipe(Effect.catchTags({ ConfigError: () => Effect.succeed(fallback) }));
}

export class RpcWorker extends Context.Service<RpcWorker>()("RpcWorker", {
  make: Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const activeStops = new Set<() => Effect.Effect<void>>();
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...activeStops],
        (stop) =>
          Effect.logDebug("worker.scope_cleanup").pipe(Effect.andThen(stop())),
        { discard: true, concurrency: "unbounded" },
      ),
    );
    const spawn = Effect.fn("RpcWorker.spawn")(function* (input: {
      readonly command: ReadonlyArray<string>;
      readonly cwd: string;
      readonly env?: Record<string, string | undefined>;
      /** Values explicitly created by the caller for this run. Never pass process.env here. */
      readonly injectedEnv?: Record<string, string>;
      readonly startTimeoutMs?: number;
      readonly requestTimeoutMs?: number;
      readonly sessionId?: string;
      readonly workerUid?: string;
      readonly sandbox?: {
        readonly brokerSocketPath: string;
        readonly sessionId: string;
        readonly workerUid: string;
      };
    }): Effect.fn.Return<RpcWorkerHandle, RpcSpawnError> {
      if (input.command.length === 0) {
        return yield* Effect.fail(
          new RpcSpawnError({ message: "RPC command cannot be empty" }),
        );
      }
      const workerUid = input.workerUid;
      yield* Effect.try({
        try: () => {
          if (input.sandbox !== undefined) return;
          if (
            workerUidRange(process.env) !== undefined &&
            workerUid === undefined
          )
            throw new Error("Missing per-session worker uid");
          workerIdentityCommand([...input.command, "--mode", "rpc"], workerUid);
        },
        catch: () =>
          new RpcSpawnError({
            message: "Invalid worker identity configuration",
          }),
      });
      const cwd = input.cwd;
      const startTimeoutMs = input.startTimeoutMs ?? 30_000;
      const requestTimeoutMs = input.requestTimeoutMs ?? 30_000;
      const stoppingRef = yield* Ref.make(false);
      const stopGate = yield* Semaphore.make(1);
      const env = {
        ...workerEnvironment(
          input.env ?? {
            PATH: yield* configWithDefault("PATH", ""),
            HOME: yield* configWithDefault("HOME", ""),
            TMPDIR: yield* configWithDefault("TMPDIR", "/tmp"),
            XDG_CONFIG_HOME: yield* configWithDefault("XDG_CONFIG_HOME", ""),
          },
        ),
        ...input.injectedEnv,
      };
      const launch = yield* Effect.try({
        try: () =>
          input.sandbox === undefined
            ? {
                command: workerIdentityCommand(
                  [...input.command, "--mode", "rpc"],
                  workerUid,
                ),
                env,
              }
            : sandboxWorkerLaunch(
                input.sandbox.sessionId,
                input.sandbox.brokerSocketPath,
                input.sandbox.workerUid,
                cwd,
                env,
                [...input.command, "--mode", "rpc"],
              ),
        catch: () =>
          new RpcSpawnError({ message: "Invalid worker launch configuration" }),
      });
      const command = [...launch.command];
      const processRef = yield* Ref.make<
        Option.Option<Subprocess<"pipe", "pipe", "pipe">>
      >(Option.none());
      const sessionIdRef = yield* Ref.make<Option.Option<string>>(
        Option.none(),
      );
      const sessionFileRef = yield* Ref.make<Option.Option<string>>(
        Option.none(),
      );
      const isStreamingRef = yield* Ref.make(false);
      const supportsV2Ref = yield* Ref.make(false);
      const requestSeqRef = yield* Ref.make(0);
      const pendingRef = yield* Ref.make<Map<string, PendingRequest>>(
        new Map(),
      );
      const chunkRef = yield* Ref.make<Option.Option<ChunkState>>(
        Option.none(),
      );
      const stderrTailRef = yield* Ref.make("");
      const listenersRef = yield* Ref.make<Set<(event: RpcEvent) => void>>(
        new Set(),
      );
      const hostToolListenerRef = yield* Ref.make<
        Option.Option<
          (
            request: RpcHostToolCall,
          ) => Effect.Effect<RpcHostToolResult, never, never>
        >
      >(Option.none());
      const hostToolResultFibersRef = yield* Ref.make<
        Set<Fiber.Fiber<void, never>>
      >(new Set());
      const promptRequestIdsRef = yield* Ref.make<Set<string>>(new Set());
      const ready = yield* Deferred.make<void, RpcSpawnError>();
      const stdoutFiberRef = yield* Ref.make<
        Option.Option<Fiber.Fiber<void, never>>
      >(Option.none());
      const exitFiberRef = yield* Ref.make<
        Option.Option<Fiber.Fiber<void, never>>
      >(Option.none());
      const stderrFiberRef = yield* Ref.make<
        Option.Option<Fiber.Fiber<void, never>>
      >(Option.none());

      const getProcess = Ref.get(processRef).pipe(
        Effect.flatMap((option) =>
          Option.match(option, {
            onNone: () =>
              Effect.fail(
                new RpcProtocolError({
                  method: "worker",
                  message: "RPC worker is not running",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      /**
       * Process teardown and diagnostic streams are intentionally best effort:
       * their failures must not hide the typed worker failure being reported.
       */
      const bestEffort = <A, E>(
        description: string,
        effect: Effect.Effect<A, E, never>,
      ): Effect.Effect<void, never, never> =>
        effect.pipe(
          Effect.catch((error) =>
            Effect.logWarning("rpc-worker.best_effort_failed").pipe(
              Effect.annotateLogs({
                event: "rpc-worker.best_effort_failed",
                description,
                error: String(error),
              }),
            ),
          ),
          Effect.asVoid,
        );

      const rejectPending = (
        error: RpcProtocolError,
      ): Effect.Effect<void, never, never> =>
        Effect.gen(function* () {
          const pending = yield* Ref.get(pendingRef);
          for (const [, request] of pending) {
            yield* Deferred.fail(request.deferred, error);
          }
          yield* Ref.set(pendingRef, new Map());
        });

      const fail = (error: unknown): Effect.Effect<void, never, never> =>
        Effect.gen(function* () {
          const base = error instanceof Error ? error.message : String(error);
          const process = yield* Ref.getAndSet(processRef, Option.none());
          yield* Ref.set(isStreamingRef, false);

          if (Option.isSome(process) && !(yield* Ref.get(stoppingRef))) {
            const readyDone = yield* Deferred.isDone(ready);
            if (!readyDone) {
              yield* Deferred.fail(
                ready,
                new RpcSpawnError({
                  message: `OhMyPi RPC worker failed before ready: ${base}`,
                }),
              );
            }

            yield* bestEffort(
              "kill failed worker process",
              Effect.try(() => signalProcessTree(process.value, "SIGKILL")),
            );

            const stderr = (yield* Ref.get(stderrTailRef)).trim();
            const normalized = stderr ? `${base}: ${stderr}` : base;

            yield* Effect.logError("worker.failed").pipe(
              Effect.annotateLogs({
                event: "worker.failed",
                workerPid: process.value.pid,
                sessionId:
                  input.sessionId ??
                  Option.getOrNull(yield* Ref.get(sessionIdRef)),
                error: normalized,
              }),
            );

            yield* rejectPending(
              new RpcProtocolError({ method: "worker", message: normalized }),
            );
            yield* emit({ type: "worker_exited", message: normalized });
            yield* stop();
          } else {
            yield* rejectPending(
              new RpcProtocolError({
                method: "worker",
                message: base,
              }),
            );
          }
        });

      const emit = (event: RpcEvent): Effect.Effect<void, never, never> =>
        Effect.gen(function* () {
          const listeners = yield* Ref.get(listenersRef);
          for (const listener of listeners) {
            listener(event);
          }
        });

      const { readOutput, readStderr } = makeRpcOutput({
        stderrTailRef,
        bestEffort,
        chunkRef,
        hostToolListenerRef,
        pendingRef,
        promptRequestIdsRef,
        sessionIdRef,
        sessionFileRef,
        isStreamingRef,
        supportsV2Ref,
        ready,
        fail,
        emit,
        forkHostToolResult: (id, result) => forkHostToolResult(id, result),
      });
      const writeFrame = (
        frame: Record<string, unknown>,
      ): Effect.Effect<void, RpcProtocolError, never> =>
        Effect.gen(function* () {
          const process = yield* getProcess;

          yield* Effect.logTrace("rpc.frame").pipe(
            Effect.annotateLogs({
              event: "rpc.frame",
              component: "omp-rpc",
              direction: "outbound",
              workerPid: process.pid,
              correlationId: frameId(frame),
              frame,
            }),
          );

          const line = `${JSON.stringify(frame)}\n`;

          const written = yield* Effect.try({
            try: () => process.stdin.write(line),
            catch: (error) =>
              new RpcProtocolError({
                method: String(frame.type),
                message: error instanceof Error ? error.message : String(error),
              }),
          });

          if (written === 0) {
            return yield* Effect.fail(
              new RpcProtocolError({
                method: String(frame.type),
                message: "RPC worker stdin closed before write",
              }),
            );
          }

          yield* Effect.try({
            try: () => process.stdin.flush(),
            catch: (error) =>
              new RpcProtocolError({
                method: String(frame.type),
                message: error instanceof Error ? error.message : String(error),
              }),
          });
        }).pipe(
          Effect.catchTags({
            "@Gateway/RpcProtocolError": (error) =>
              fail(error).pipe(Effect.andThen(Effect.fail(error))),
          }),
        );
      const forkHostToolResult = (
        callId: string,
        result: Effect.Effect<RpcHostToolResult, never, never>,
      ): Effect.Effect<void, never, never> =>
        Effect.gen(function* () {
          const resultFiber = yield* Effect.forkIn(
            bestEffort(
              "write host-tool result",
              result.pipe(
                Effect.flatMap((toolResult) =>
                  writeFrame({
                    type: "host_tool_result",
                    id: callId,
                    result: toolResult,
                    ...(toolResult.isError === true ? { isError: true } : {}),
                  }),
                ),
              ),
            ),
            scope,
          );
          yield* Ref.update(hostToolResultFibersRef, (fibers) => {
            fibers.add(resultFiber);
            return fibers;
          });
          yield* Effect.forkIn(
            bestEffort(
              "track host-tool result fiber",
              Fiber.join(resultFiber).pipe(
                Effect.flatMap(() =>
                  Ref.update(hostToolResultFibersRef, (fibers) => {
                    fibers.delete(resultFiber);
                    return fibers;
                  }),
                ),
              ),
            ),
            scope,
          );
        });

      const send = Effect.fn("RpcWorker.send")(function* (
        type: string,
        body: Record<string, unknown> = {},
      ): Effect.fn.Return<
        Record<string, unknown>,
        RpcProtocolError | RpcTimeoutError
      > {
        yield* getProcess;
        const sequence = yield* Ref.modify(requestSeqRef, (n) => [
          n + 1,
          n + 1,
        ]);
        const id = `gateway-${sequence}`;
        const deferred = yield* Deferred.make<
          Record<string, unknown>,
          RpcProtocolError
        >();

        yield* Ref.update(pendingRef, (map) => {
          map.set(id, { command: type, deferred });
          return map;
        });

        const frame = { id, type, ...body };

        return yield* writeFrame(frame).pipe(
          Effect.andThen(Deferred.await(deferred)),
          Effect.timeoutOrElse({
            duration: requestTimeoutMs,
            orElse: () =>
              Effect.fail(
                new RpcTimeoutError({
                  method: type,
                  message: `RPC ${type} timed out after ${requestTimeoutMs}ms`,
                }),
              ),
          }),
          Effect.ensuring(
            Ref.update(pendingRef, (map) => {
              map.delete(id);
              return map;
            }),
          ),
        );
      });

      const start = Effect.fn("RpcWorker.start")(function* (): Effect.fn.Return<
        void,
        RpcSpawnError | RpcTimeoutError | RpcProtocolError
      > {
        const process = yield* Effect.gen(function* () {
          if (yield* Ref.get(stoppingRef)) {
            return yield* Effect.fail(
              new RpcProtocolError({
                method: "start",
                message: "RPC worker is stopping",
              }),
            );
          }
          if (Option.isSome(yield* Ref.get(processRef))) {
            return yield* Effect.fail(
              new RpcProtocolError({
                method: "start",
                message: "RPC worker already started",
              }),
            );
          }
          yield* Effect.logInfo("worker.starting").pipe(
            Effect.annotateLogs({ event: "worker.starting", command, cwd }),
          );
          const process = yield* Effect.try({
            try: () =>
              Bun.spawn(command, {
                cwd,
                env: launch.env,
                detached: detachedProcessGroup,
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
              }),
            catch: (error) =>
              new RpcSpawnError({
                message: error instanceof Error ? error.message : String(error),
              }),
          });

          yield* Ref.set(processRef, Option.some(process));

          const stdoutFiber = yield* Effect.forkIn(
            readOutput(process).pipe(Effect.interruptible),
            scope,
          );
          const stderrFiber = yield* Effect.forkIn(
            readStderr(process).pipe(Effect.interruptible),
            scope,
          );

          yield* Ref.set(stdoutFiberRef, Option.some(stdoutFiber));
          yield* Ref.set(stderrFiberRef, Option.some(stderrFiber));
          return process;
        }).pipe(stopGate.withPermits(1), Effect.uninterruptible);

        const timeout = Effect.sleep(startTimeoutMs).pipe(
          Effect.andThen(
            Effect.fail(
              new RpcTimeoutError({
                method: "start",
                message: "Timed out waiting for OhMyPi RPC ready frame",
              }),
            ),
          ),
        );

        const exited = Effect.promise(() => process.exited).pipe(
          Effect.flatMap((code) =>
            Effect.fail(
              new RpcSpawnError({
                message: `OhMyPi exited before ready with code ${code}`,
              }),
            ),
          ),
        );

        const result = yield* Effect.raceFirst(
          Deferred.await(ready),
          exited,
        ).pipe(Effect.raceFirst(timeout), Effect.result);

        if (result._tag === "Failure") {
          yield* stop();
          return yield* Effect.fail(result.failure);
        }

        const exitFiber = yield* Effect.forkIn(
          Effect.promise(() => process.exited).pipe(
            Effect.flatMap((code) =>
              fail(new Error(`OhMyPi exited with code ${code}`)),
            ),
          ),
          scope,
        );
        yield* Ref.set(exitFiberRef, Option.some(exitFiber));
        const supportsV2 = yield* Ref.get(supportsV2Ref);
        if (supportsV2) {
          const negotiated = yield* send("negotiate_protocol", {
            protocolVersion: 2,
          }).pipe(Effect.result);

          if (negotiated._tag === "Failure") {
            yield* stop();
            return yield* Effect.fail(negotiated.failure);
          }
        }

        yield* Effect.logInfo("worker.ready").pipe(
          Effect.annotateLogs({
            event: "worker.ready",
            workerPid: process.pid,
            protocolVersion: supportsV2 ? 2 : 1,
          }),
        );
      });

      const stop: () => Effect.Effect<void> = Effect.fn("RpcWorker.stop")(
        function* (): Effect.fn.Return<void, never> {
          yield* Ref.set(stoppingRef, true);
          const hostToolResultFibers = yield* Ref.get(hostToolResultFibersRef);
          for (const fiber of hostToolResultFibers) {
            yield* Fiber.interrupt(fiber).pipe(
              Effect.forkChild({ startImmediately: true }),
              Effect.asVoid,
            );
          }
          yield* Ref.set(hostToolResultFibersRef, new Set());

          const exitFiber = yield* Ref.get(exitFiberRef);
          if (Option.isSome(exitFiber))
            yield* Fiber.interrupt(exitFiber.value).pipe(
              Effect.forkChild({ startImmediately: true }),
              Effect.asVoid,
            );
          yield* Ref.set(exitFiberRef, Option.none());
          const stdoutFiber = yield* Ref.get(stdoutFiberRef);
          const stderrFiber = yield* Ref.get(stderrFiberRef);
          if (Option.isSome(stdoutFiber)) {
            yield* Fiber.interrupt(stdoutFiber.value).pipe(
              Effect.forkChild({ startImmediately: true }),
              Effect.asVoid,
            );
          }
          if (Option.isSome(stderrFiber)) {
            yield* Fiber.interrupt(stderrFiber.value).pipe(
              Effect.forkChild({ startImmediately: true }),
              Effect.asVoid,
            );
          }
          yield* Ref.set(stdoutFiberRef, Option.none());
          yield* Ref.set(stderrFiberRef, Option.none());

          yield* rejectPending(
            new RpcProtocolError({
              method: "stop",
              message: "OhMyPi RPC worker stopped",
            }),
          );

          const process = yield* Ref.get(processRef);
          if (Option.isNone(process)) {
            return;
          }
          yield* Effect.try(() => process.value.stdin.end()).pipe(
            Effect.matchEffect({
              onSuccess: () => Effect.void,
              onFailure: () =>
                bestEffort(
                  "force-kill after stdin close failure",
                  Effect.try(() => signalProcessTree(process.value)),
                ),
            }),
          );
          const exitedGracefully = yield* Effect.promise(() =>
            Promise.race([
              process.value.exited.then(() => true),
              new Promise<boolean>((resolve) =>
                setTimeout(() => resolve(false), GRACEFUL_STOP_TIMEOUT_MS),
              ),
            ]),
          );
          if (!exitedGracefully) {
            yield* bestEffort(
              "force-kill worker after graceful stop timeout",
              Effect.try(() => signalProcessTree(process.value)),
            );
            yield* Effect.promise(() =>
              Promise.race([
                process.value.exited.then(() => undefined),
                new Promise<void>((resolve) =>
                  setTimeout(() => resolve(), FORCE_STOP_TIMEOUT_MS),
                ),
              ]),
            );
          }
          yield* bestEffort(
            "kill remaining worker children",
            Effect.try(() => signalProcessTree(process.value, "SIGKILL")),
          );
          yield* Ref.set(processRef, Option.none());
          yield* Effect.logInfo("worker.stopped").pipe(
            Effect.annotateLogs({
              event: "worker.stopped",
              workerPid: process.value.pid,
            }),
          );
        },
        (effect) =>
          effect.pipe(
            stopGate.withPermits(1),
            Effect.uninterruptible,
            Effect.ensuring(Effect.sync(() => activeStops.delete(stop))),
          ),
      );

      const prompt = Effect.fn("RpcWorker.prompt")(function* (
        message: string,
      ): Effect.fn.Return<boolean, RpcProtocolError | RpcTimeoutError> {
        const response = yield* send("prompt", { message });
        const data = record(response.data) ? response.data : null;
        return data?.agentInvoked !== false;
      });

      const steer = Effect.fn("RpcWorker.steer")(function* (
        message: string,
      ): Effect.fn.Return<void, RpcProtocolError | RpcTimeoutError> {
        yield* send("steer", { message });
      });

      const followUp = Effect.fn("RpcWorker.followUp")(function* (
        message: string,
      ): Effect.fn.Return<void, RpcProtocolError | RpcTimeoutError> {
        yield* send("follow_up", { message });
      });
      const setHostTools = Effect.fn("RpcWorker.setHostTools")(function* (
        tools: ReadonlyArray<RpcHostToolDefinition>,
      ): Effect.fn.Return<void, RpcProtocolError | RpcTimeoutError> {
        yield* send("set_host_tools", { tools: [...tools] });
      });

      const onHostToolCall = Effect.fn("RpcWorker.onHostToolCall")(function* (
        handler: (
          request: RpcHostToolCall,
        ) => Effect.Effect<RpcHostToolResult, never, never>,
      ): Effect.fn.Return<() => Effect.Effect<void, never, never>, never> {
        yield* Ref.set(hostToolListenerRef, Option.some(handler));
        return () =>
          Ref.update(hostToolListenerRef, (current) =>
            Option.isSome(current) && current.value === handler
              ? Option.none()
              : current,
          );
      });

      const abort = Effect.fn("RpcWorker.abort")(function* (): Effect.fn.Return<
        void,
        RpcProtocolError | RpcTimeoutError
      > {
        yield* send("abort");
      });

      const getState = Effect.fn("RpcWorker.getState")(
        function* (): Effect.fn.Return<
          Record<string, unknown>,
          RpcProtocolError | RpcTimeoutError
        > {
          const response = yield* send("get_state");
          const state = record(response.data) ? response.data : {};

          if (isString(state.sessionId)) {
            yield* Ref.set(sessionIdRef, Option.some(state.sessionId));
          }
          if (isString(state.sessionFile)) {
            yield* Ref.set(sessionFileRef, Option.some(state.sessionFile));
          }

          return state;
        },
      );

      const respondToUi = Effect.fn("RpcWorker.respondToUi")(function* (
        requestId: string,
        response:
          | { readonly value: string }
          | { readonly confirmed: boolean }
          | { readonly cancelled: true },
      ): Effect.fn.Return<void, RpcProtocolError> {
        yield* writeFrame({
          type: "extension_ui_response",
          id: requestId,
          ...response,
        });
      });

      const onEvent = Effect.fn("RpcWorker.onEvent")(function* (
        listener: (event: RpcEvent) => void,
      ): Effect.fn.Return<() => Effect.Effect<void, never, never>, never> {
        yield* Ref.update(listenersRef, (set) => {
          set.add(listener);
          return set;
        });

        return () =>
          Ref.update(listenersRef, (set) => {
            set.delete(listener);
            return set;
          });
      });

      const sessionId = Ref.get(sessionIdRef);
      const sessionFile = Ref.get(sessionFileRef);
      const isStreaming = Ref.get(isStreamingRef);

      activeStops.add(stop);
      const handle: RpcWorkerHandle = {
        sessionId,
        sessionFile,
        isStreaming,
        start,
        stop,
        prompt,
        steer,
        followUp,
        setHostTools,
        onHostToolCall,
        abort,
        getState,
        respondToUi,
        onEvent,
      };

      return handle;
    });

    return { spawn };
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies;
}
