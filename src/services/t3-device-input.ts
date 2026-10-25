/** Input protocol from T3 044f07257 client-runtime/device/stream.ts. */
import { Effect, Redacted, Schema } from "effect";
import {
  fetchWebSocketTicket,
  T3RpcError,
  t3Endpoint,
} from "../drivers/t3/rpc-client.js";

const Key = Schema.Literals([
  "Enter",
  "Escape",
  "Backspace",
  "Tab",
  "Space",
  "ArrowRight",
  "ArrowLeft",
  "ArrowDown",
  "ArrowUp",
  "Delete",
]);
const Coordinate = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 1 }),
);
export const DeviceInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("tap"), x: Coordinate, y: Coordinate }),
  Schema.Struct({ type: Schema.Literal("key"), key: Key }),
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.NonEmptyString }),
]);
type Input = typeof DeviceInput.Type;
type Platform = "ios" | "android";

const iosKeys = {
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Space: 44,
  Delete: 76,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82,
};
const androidKeys = {
  Enter: 66,
  Escape: 111,
  Backspace: 67,
  Tab: 61,
  Space: 62,
  Delete: 112,
  ArrowRight: 22,
  ArrowLeft: 21,
  ArrowDown: 20,
  ArrowUp: 19,
};
const failure = (message: string, sent = false) =>
  new T3RpcError({
    reason: sent ? "lost" : "rejected",
    method: "device-input",
    sent,
    message,
  });
const tagged = (tag: number, body: unknown) =>
  Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(body))]);
const keyFrames = (usage: number, shift = false) => [
  ...(shift ? [tagged(6, { type: "down", usage: 225 })] : []),
  tagged(6, { type: "down", usage }),
  tagged(6, { type: "up", usage }),
  ...(shift ? [tagged(6, { type: "up", usage: 225 })] : []),
];
const iosCharacter = (character: string): ReadonlyArray<Buffer> => {
  const code = character.charCodeAt(0);
  if (/[a-z]/u.test(character)) return keyFrames(code - 97 + 4);
  if (/[A-Z]/u.test(character)) return keyFrames(code - 65 + 4, true);
  if (/[1-9]/u.test(character)) return keyFrames(code - 49 + 30);
  if (character === "0") return keyFrames(39);
  const plain = "\n\t -='[]\\;`,./";
  const usages = [40, 43, 44, 45, 46, 52, 47, 48, 49, 51, 53, 54, 55, 56];
  const index = plain.indexOf(character);
  const usage = usages[index];
  if (index >= 0 && usage !== undefined) return keyFrames(usage);
  const shifted = '!@#$%^&*()_+"{}|:~<>?';
  const shiftedUsages = [
    30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 45, 46, 52, 47, 48, 49, 51, 53, 54,
    55, 56,
  ];
  const shiftedUsage = shiftedUsages[shifted.indexOf(character)];
  if (shiftedUsage !== undefined) return keyFrames(shiftedUsage, true);
  throw failure(
    "iOS text input supports printable ASCII, newline and tab only",
  );
};
const framesFor = (
  platform: Platform,
  input: Input,
): ReadonlyArray<string | Buffer> => {
  if (input.type === "tap")
    return platform === "ios"
      ? [
          tagged(3, { type: "begin", x: input.x, y: input.y }),
          tagged(3, { type: "end", x: input.x, y: input.y }),
        ]
      : [
          JSON.stringify({
            type: "touch",
            action: "down",
            x: input.x,
            y: input.y,
          }),
          JSON.stringify({
            type: "touch",
            action: "up",
            x: input.x,
            y: input.y,
          }),
        ];
  if (input.type === "key")
    return platform === "ios"
      ? keyFrames(iosKeys[input.key])
      : [JSON.stringify({ type: "key", keycode: androidKeys[input.key] })];
  if (platform === "android") {
    if (Buffer.byteLength(input.text) > 300)
      throw failure("Android text input exceeds 300 UTF-8 bytes");
    return [JSON.stringify({ type: "text", text: input.text })];
  }
  if (input.text.length > 32)
    throw failure("iOS text input exceeds 32 characters");
  return Array.from(input.text).flatMap(iosCharacter);
};

/** No retries. Dispatch is distinct from observing the resulting UI. */
export const sendT3DeviceInput = Effect.fn("T3DeviceBackup.input")(
  function* (options: {
    readonly baseUrl: URL;
    readonly token: Effect.Effect<Redacted.Redacted<string>, T3RpcError>;
    readonly device: {
      readonly hostId: string;
      readonly id: string;
      readonly platform: Platform;
    };
    readonly input: Input;
  }) {
    const input = yield* Schema.decodeUnknownEffect(DeviceInput)(
      options.input,
    ).pipe(Effect.mapError(() => failure("Invalid device input")));
    const frames = yield* Effect.try({
      try: () => framesFor(options.device.platform, input),
      catch: () =>
        failure(
          options.device.platform === "ios"
            ? "iOS text input supports at most 32 ASCII characters"
            : "Android text input exceeds its limit",
        ),
    });
    const ticket = yield* fetchWebSocketTicket(options);
    const ios = options.device.platform === "ios";
    const url = t3Endpoint(
      options.baseUrl,
      `/api/device-hub/vendor/${ios ? "serve-sim/helper/ws" : "serve-emu/ws"}`,
    );
    url.protocol = options.baseUrl.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("hostId", options.device.hostId);
    url.searchParams.set("device", options.device.id);
    url.searchParams.set("wsTicket", Redacted.value(ticket));
    if (ios) {
      const credential = yield* options.token;
      const prime = t3Endpoint(
        options.baseUrl,
        `/api/device-hub/vendor/serve-sim/helper/${encodeURIComponent(options.device.id)}/stream.mjpeg`,
      );
      prime.searchParams.set("hostId", options.device.hostId);
      yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(prime, {
            headers: { authorization: `Bearer ${Redacted.value(credential)}` },
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw failure("Device input helper is unavailable");
          }
          const reader = response.body?.getReader();
          try {
            await reader?.read();
          } finally {
            await reader?.cancel();
          }
        },
        catch: () => failure("Device input helper is unavailable"),
      });
    }
    return yield* Effect.tryPromise({
      try: (signal) =>
        new Promise<{ readonly dispatched: true; readonly observed: false }>(
          (resolve, reject) => {
            const ws = new WebSocket(url);
            ws.binaryType = "arraybuffer";
            let settled = false;
            let sent = false;
            let admitted = !ios;
            let configured = !ios;
            const finish = (error?: T3RpcError) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              signal.removeEventListener("abort", aborted);
              ws.close();
              if (error) reject(error);
              else resolve({ dispatched: true, observed: false });
            };
            const aborted = () =>
              finish(
                failure(
                  sent
                    ? "Device input outcome is unknown; inspect before retrying"
                    : "Device input canceled",
                  sent,
                ),
              );
            const timer = setTimeout(
              () =>
                finish(
                  failure(
                    sent
                      ? "Device input outcome is unknown; inspect before retrying"
                      : "Device input admission timed out",
                    sent,
                  ),
                ),
              10_000,
            );
            const dispatch = () => {
              if (settled || !admitted || !configured) return;
              try {
                for (const frame of frames) {
                  sent = true;
                  ws.send(
                    typeof frame === "string" ? frame : Uint8Array.from(frame),
                  );
                }
                finish();
              } catch {
                finish(
                  failure(
                    "Device input outcome is unknown; inspect before retrying",
                    sent,
                  ),
                );
              }
            };
            signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) {
              aborted();
              return;
            }
            ws.onopen = dispatch;
            ws.onmessage = (event) => {
              if (!(event.data instanceof ArrayBuffer) || settled) return;
              const bytes = new Uint8Array(event.data);
              if (bytes.length > 16_384) {
                finish(failure("Device input response exceeded its limit"));
                return;
              }
              if (bytes[0] === 0x83) admitted = true;
              else if (bytes[0] === 0x82) {
                try {
                  const config: unknown = JSON.parse(
                    new TextDecoder().decode(bytes.subarray(1)),
                  );
                  if (
                    typeof config !== "object" ||
                    config === null ||
                    !("width" in config) ||
                    !("height" in config) ||
                    typeof config.width !== "number" ||
                    !Number.isFinite(config.width) ||
                    config.width <= 0 ||
                    typeof config.height !== "number" ||
                    !Number.isFinite(config.height) ||
                    config.height <= 0 ||
                    ("inputUnavailable" in config &&
                      config.inputUnavailable !== false)
                  ) {
                    finish(failure("Device input is unavailable"));
                    return;
                  }
                  configured = true;
                } catch {
                  finish(failure("Device input configuration is invalid"));
                  return;
                }
              }
              dispatch();
            };
            ws.onerror = () =>
              finish(failure("Device input connection failed", sent));
            ws.onclose = () =>
              finish(failure("Device input connection closed", sent));
          },
        ),
      catch: (error) =>
        error instanceof T3RpcError ? error : failure("Device input failed"),
    });
  },
);
