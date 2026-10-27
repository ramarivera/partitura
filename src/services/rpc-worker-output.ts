import type { Subprocess } from "bun";
import { Deferred, Effect, Option, Ref } from "effect";
import {
  RpcProtocolError,
  RpcSpawnError,
  type RpcTimeoutError,
} from "../domain/errors.js";
export interface RpcEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}
export interface RpcHostToolDefinition {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly hidden?: boolean;
  readonly loadMode?: string;
}

export interface RpcHostToolCall {
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

export interface RpcHostToolResult {
  readonly content: ReadonlyArray<Record<string, unknown>>;
  readonly details?: unknown;
  readonly isError?: boolean;
}

export interface RpcWorkerHandle {
  readonly driverSession?: import("../drivers/driver.js").AgentSession;
  readonly sessionId: Effect.Effect<Option.Option<string>, never, never>;
  readonly sessionFile: Effect.Effect<Option.Option<string>, never, never>;
  readonly isStreaming: Effect.Effect<boolean, never, never>;
  readonly start: () => Effect.Effect<
    void,
    RpcSpawnError | RpcTimeoutError | RpcProtocolError,
    never
  >;
  readonly stop: () => Effect.Effect<void, never, never>;
  readonly prompt: (
    message: string,
    clientRequestId?: string,
  ) => Effect.Effect<boolean, RpcProtocolError | RpcTimeoutError, never>;
  readonly steer: (
    message: string,
    clientRequestId?: string,
  ) => Effect.Effect<void, RpcProtocolError | RpcTimeoutError, never>;
  readonly followUp: (
    message: string,
    clientRequestId?: string,
  ) => Effect.Effect<void, RpcProtocolError | RpcTimeoutError, never>;
  readonly setHostTools: (
    tools: ReadonlyArray<RpcHostToolDefinition>,
  ) => Effect.Effect<void, RpcProtocolError | RpcTimeoutError, never>;
  /** Registers the sole host-tool handler, replacing any previous handler. */
  readonly onHostToolCall: (
    handler: (
      request: RpcHostToolCall,
    ) => Effect.Effect<RpcHostToolResult, never, never>,
  ) => Effect.Effect<() => Effect.Effect<void, never, never>, never, never>;
  readonly abort: () => Effect.Effect<
    void,
    RpcProtocolError | RpcTimeoutError,
    never
  >;
  readonly getState: () => Effect.Effect<
    Record<string, unknown>,
    RpcProtocolError | RpcTimeoutError,
    never
  >;
  readonly respondToUi: (
    requestId: string,
    response:
      | { readonly value: string }
      | { readonly confirmed: boolean }
      | { readonly cancelled: true },
  ) => Effect.Effect<void, RpcProtocolError, never>;
  readonly onEvent: (
    listener: (event: RpcEvent) => void,
  ) => Effect.Effect<() => Effect.Effect<void, never, never>, never, never>;
}

export interface PendingRequest {
  readonly command: string;
  readonly deferred: Deferred.Deferred<
    Record<string, unknown>,
    RpcProtocolError
  >;
}

export interface ChunkState {
  readonly id: string;
  readonly count: number;
  readonly byteLength: number;
  readonly parts: Uint8Array[];
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function frameId(
  frame: Record<string, unknown>,
): string | number | null {
  if (typeof frame.id === "string" || typeof frame.id === "number") {
    return frame.id;
  }
  if (typeof frame.requestId === "string") return frame.requestId;
  if (typeof frame.correlationId === "string") return frame.correlationId;
  return null;
}

const MAX_CHUNK_SIZE = 67_108_864;
const MAX_PROMPT_REQUEST_IDS = 256;

export const makeRpcOutput = ({
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
  forkHostToolResult,
}: {
  stderrTailRef: Ref.Ref<string>;
  bestEffort: <A, E>(
    description: string,
    effect: Effect.Effect<A, E, never>,
  ) => Effect.Effect<void>;
  chunkRef: Ref.Ref<Option.Option<ChunkState>>;
  hostToolListenerRef: Ref.Ref<
    Option.Option<
      (request: RpcHostToolCall) => Effect.Effect<RpcHostToolResult>
    >
  >;
  pendingRef: Ref.Ref<Map<string, PendingRequest>>;
  promptRequestIdsRef: Ref.Ref<Set<string>>;
  sessionIdRef: Ref.Ref<Option.Option<string>>;
  sessionFileRef: Ref.Ref<Option.Option<string>>;
  isStreamingRef: Ref.Ref<boolean>;
  supportsV2Ref: Ref.Ref<boolean>;
  ready: Deferred.Deferred<void, RpcSpawnError>;
  fail: (error: unknown) => Effect.Effect<void>;
  emit: (event: RpcEvent) => Effect.Effect<void>;
  forkHostToolResult: (
    id: string,
    result: Effect.Effect<RpcHostToolResult>,
  ) => Effect.Effect<void>;
}) => {
  const decodeFrame = (
    frame: Record<string, unknown>,
  ): Effect.Effect<
    Option.Option<Record<string, unknown>>,
    RpcProtocolError,
    never
  > =>
    Effect.gen(function* () {
      if (frame.type !== "rpc_chunk") {
        const existing = yield* Ref.get(chunkRef);
        if (Option.isSome(existing)) {
          return yield* Effect.fail(
            new RpcProtocolError({
              method: "decodeFrame",
              message: "RPC chunk sequence was interrupted",
            }),
          );
        }
        return Option.some(frame);
      }

      const { chunkId, index, count, byteLength, data } = frame;
      if (
        !isString(chunkId) ||
        typeof index !== "number" ||
        typeof count !== "number" ||
        typeof byteLength !== "number" ||
        !isString(data) ||
        !Number.isSafeInteger(index) ||
        !Number.isSafeInteger(count) ||
        !Number.isSafeInteger(byteLength)
      ) {
        return yield* Effect.fail(
          new RpcProtocolError({
            method: "decodeFrame",
            message: "Invalid RPC chunk metadata",
          }),
        );
      }

      if (
        index < 0 ||
        count <= 0 ||
        index >= count ||
        byteLength <= 0 ||
        byteLength > MAX_CHUNK_SIZE
      ) {
        return yield* Effect.fail(
          new RpcProtocolError({
            method: "decodeFrame",
            message: "RPC chunk bounds are invalid",
          }),
        );
      }

      if (index === 0) {
        yield* Ref.set(
          chunkRef,
          Option.some({
            id: chunkId,
            count,
            byteLength,
            parts: [],
          }),
        );
      }

      const state = yield* Ref.get(chunkRef);
      if (
        Option.isNone(state) ||
        state.value.id !== chunkId ||
        state.value.count !== count ||
        state.value.parts.length !== index
      ) {
        return yield* Effect.fail(
          new RpcProtocolError({
            method: "decodeFrame",
            message: "RPC chunks are interleaved or out of order",
          }),
        );
      }

      const decoded = yield* Effect.try({
        try: () => Uint8Array.from(Buffer.from(data, "base64")),
        catch: () =>
          new RpcProtocolError({
            method: "decodeFrame",
            message: "Invalid RPC chunk data",
          }),
      });

      state.value.parts.push(decoded);

      if (state.value.parts.length !== state.value.count) {
        return Option.none();
      }

      yield* Ref.set(chunkRef, Option.none());

      const merged = yield* Effect.sync(() =>
        Buffer.concat(state.value.parts.map((part) => Buffer.from(part))),
      );

      if (merged.byteLength !== state.value.byteLength) {
        return yield* Effect.fail(
          new RpcProtocolError({
            method: "decodeFrame",
            message: "RPC chunk byte length mismatch",
          }),
        );
      }

      const reassembled: unknown = yield* Effect.try({
        try: () =>
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged)),
        catch: (error) =>
          new RpcProtocolError({
            method: "decodeFrame",
            message: `Failed to reassemble RPC frame: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });

      if (!record(reassembled)) {
        return yield* Effect.fail(
          new RpcProtocolError({
            method: "decodeFrame",
            message: "Reassembled RPC frame must be an object",
          }),
        );
      }

      return Option.some(reassembled);
    });

  const dispatch = (
    frame: Record<string, unknown>,
  ): Effect.Effect<void, RpcProtocolError, never> =>
    Effect.gen(function* () {
      const id = frame.id;
      if (frame.type === "host_tool_call") {
        const callId = frame.id;
        const toolCallId = frame.toolCallId;
        const toolName = frame.toolName;
        if (!isString(callId)) {
          return yield* Effect.fail(
            new RpcProtocolError({
              method: "host_tool_call",
              message: "Invalid host tool call frame: missing string id",
            }),
          );
        }
        if (
          !isString(toolCallId) ||
          !isString(toolName) ||
          !record(frame.arguments)
        ) {
          yield* forkHostToolResult(
            callId,
            Effect.succeed({
              content: [
                {
                  type: "text",
                  text: "Invalid host tool call frame",
                },
              ],
              isError: true,
            }),
          );
          return;
        }
        const listener = yield* Ref.get(hostToolListenerRef);
        const result: Effect.Effect<RpcHostToolResult, never, never> =
          Option.isNone(listener)
            ? Effect.succeed({
                content: [
                  {
                    type: "text",
                    text: `Host tool "${toolName}" is not available`,
                  },
                ],
                isError: true,
              })
            : listener.value({
                id: callId,
                toolCallId,
                toolName,
                arguments: frame.arguments,
              });
        yield* forkHostToolResult(callId, result);
        return;
      }

      if (frame.type === "response" && isString(id)) {
        const pending = yield* Ref.get(pendingRef);
        const request = pending.get(id);

        if (request === undefined) {
          const promptRequestIds = yield* Ref.get(promptRequestIdsRef);
          if (frame.success === false && promptRequestIds.has(id)) {
            yield* Ref.update(promptRequestIdsRef, (set) => {
              set.delete(id);
              return set;
            });
            yield* emit({
              type: "error",
              message:
                typeof frame.error === "string"
                  ? frame.error
                  : "RPC prompt scheduling failed",
              command: frame.command,
            });
          }
          return;
        }

        yield* Ref.update(pendingRef, (map) => {
          map.delete(id);
          return map;
        });

        if (frame.success === false) {
          yield* Deferred.fail(
            request.deferred,
            new RpcProtocolError({
              method: request.command,
              message:
                typeof frame.error === "string"
                  ? frame.error
                  : "RPC command failed",
            }),
          );
        } else {
          if (request.command === "prompt") {
            yield* Ref.update(promptRequestIdsRef, (set) => {
              set.add(id);
              if (set.size > MAX_PROMPT_REQUEST_IDS) {
                const oldest = set.values().next().value;
                if (typeof oldest === "string") set.delete(oldest);
              }
              return set;
            });
          }
          yield* Deferred.succeed(request.deferred, frame);
        }

        return;
      }

      if (frame.type === "prompt_result" && isString(id)) {
        yield* Ref.update(promptRequestIdsRef, (set) => {
          set.delete(id);
          return set;
        });
      }

      if (
        frame.type === "session_info_update" ||
        frame.type === "config_update" ||
        frame.type === "agent_start"
      ) {
        if (isString(frame.sessionId)) {
          yield* Ref.set(sessionIdRef, Option.some(frame.sessionId));
        }
        if (isString(frame.sessionFile)) {
          yield* Ref.set(sessionFileRef, Option.some(frame.sessionFile));
        }
      }

      if (frame.type === "agent_start") {
        yield* Ref.set(promptRequestIdsRef, new Set());
        yield* Ref.set(isStreamingRef, true);
      }

      if (frame.type === "agent_end" && frame.willContinue !== true) {
        yield* Ref.set(isStreamingRef, false);
      }

      if (isString(frame.type)) {
        yield* emit({ ...frame, type: frame.type } as RpcEvent);
      }
    });
  const readOutput = (
    process: Subprocess<"pipe", "pipe", "pipe">,
  ): Effect.Effect<void, never, never> =>
    Effect.gen(function* () {
      const reader = process.stdout.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let buffer = "";
      let readySeen = false;

      while (true) {
        const result = yield* Effect.tryPromise({
          try: () => reader.read(),
          catch: (error) =>
            new RpcProtocolError({
              method: "readOutput",
              message: error instanceof Error ? error.message : String(error),
            }),
        });

        if (result.done) {
          if (!readySeen) {
            const done = yield* Deferred.isDone(ready);
            if (!done) {
              yield* Deferred.fail(
                ready,
                new RpcSpawnError({
                  message: "OhMyPi output ended before ready",
                }),
              );
            }
          }
          yield* fail(new Error("OhMyPi RPC output ended"));
          return;
        }

        buffer += yield* Effect.try({
          try: () => decoder.decode(result.value, { stream: true }),
          catch: (error) =>
            new RpcProtocolError({
              method: "readOutput",
              message: error instanceof Error ? error.message : String(error),
            }),
        });

        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);

          if (line.length > 0) {
            const parsed: unknown = yield* Effect.try({
              try: () => JSON.parse(line),
              catch: (error) =>
                new RpcProtocolError({
                  method: "readOutput",
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
            });

            if (!record(parsed)) {
              yield* fail(new Error("RPC frame must be an object"));
              return;
            }

            yield* Effect.logTrace("rpc.frame").pipe(
              Effect.annotateLogs({
                event: "rpc.frame",
                component: "omp-rpc",
                direction: "inbound",
                workerPid: process.pid,
                correlationId: frameId(parsed),
                frame: parsed,
              }),
            );

            if (!readySeen && parsed.type === "ready") {
              readySeen = true;
              const supportsV2 =
                Array.isArray(parsed.supportedProtocolVersions) &&
                parsed.supportedProtocolVersions.includes(2);
              yield* Ref.set(supportsV2Ref, supportsV2);
              yield* Deferred.succeed(ready, undefined);
            } else {
              const decoded = yield* decodeFrame(parsed);
              if (Option.isSome(decoded)) {
                yield* dispatch(decoded.value);
              }
            }
          }

          newline = buffer.indexOf("\n");
        }
      }
    }).pipe(
      Effect.catchTags({
        "@Gateway/RpcProtocolError": (error) => fail(error),
      }),
    );

  const readStderr = (
    process: Subprocess<"pipe", "pipe", "pipe">,
  ): Effect.Effect<void, never, never> =>
    bestEffort(
      "capture worker stderr",
      Effect.gen(function* () {
        const reader = process.stderr.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const result = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (error) =>
              new RpcProtocolError({
                method: "readStderr",
                message: error instanceof Error ? error.message : String(error),
              }),
          }).pipe(
            Effect.catchTags({
              "@Gateway/RpcProtocolError": () => Effect.succeed(undefined),
            }),
          );

          if (result === undefined || result.done) break;

          const text = yield* Effect.try({
            try: () => decoder.decode(result.value, { stream: true }),
            catch: () => "",
          });

          yield* Ref.update(stderrTailRef, (tail) =>
            `${tail}${text}`.slice(-16_384),
          );
        }
      }),
    );

  return { readOutput, readStderr };
};
