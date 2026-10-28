import { AsyncLocalStorage } from "node:async_hooks";
import { Context, Effect, Layer } from "effect";
import { NativeSecretError } from "./native-build-secret-protocol.js";

/** Node helper only. Async context fences retries that outlive their IPC call. */
export class NativeSecretHttp extends Context.Service<NativeSecretHttp>()(
  "NativeSecretHttp",
  {
    make: Effect.gen(function* () {
      const contexts = new AsyncLocalStorage<{
        left: number;
        expires: number;
        abort: AbortController;
        closed: boolean;
        fail: (code: string) => void;
      }>();
      let enabled = true;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const original = globalThis.fetch;
          globalThis.fetch = Object.assign(
            async (
              input: Parameters<typeof fetch>[0],
              init?: Parameters<typeof fetch>[1],
            ) => {
              const state = contexts.getStore();
              if (!enabled || !state || state.closed)
                throw NativeSecretError.new("provider-unavailable");
              if (performance.now() >= state.expires) {
                state.fail("provider-timeout");
                throw NativeSecretError.new("provider-timeout");
              }
              if (state.left <= 0) {
                state.fail("provider-unavailable");
                throw NativeSecretError.new("provider-unavailable");
              }
              state.left--;
              const signal =
                init?.signal ??
                (input instanceof Request ? input.signal : undefined);
              return original(input, {
                ...init,
                // Do not let one fetch invocation hide redirect requests.
                redirect: "error",
                signal: signal
                  ? AbortSignal.any([signal, state.abort.signal])
                  : state.abort.signal,
              });
            },
            {
              preconnect: () => {
                throw NativeSecretError.new("provider-unavailable");
              },
            },
          );
          return original;
        }),
        () =>
          Effect.sync(() => {
            // This process is dedicated to the helper. Never restore an unguarded
            // transport while abandoned SDK promises can still retry after EOF.
            enabled = false;
          }),
      );
      return {
        run: Effect.fn("NativeSecretHttp.run")(function* <A>(
          limit: number,
          call: () => Promise<A>,
          deadlineMs = 10_000,
        ): Effect.fn.Return<A, NativeSecretError> {
          return yield* Effect.tryPromise({
            try: async (signal) => {
              const abort = new AbortController();
              let reject!: (error: NativeSecretError) => void;
              const refused = new Promise<never>((_, fail) => {
                reject = fail;
              });
              const state = {
                left: limit,
                expires: performance.now() + deadlineMs,
                abort,
                closed: false,
                fail: (code: string) => {
                  state.closed = true;
                  abort.abort();
                  reject(NativeSecretError.new(code));
                },
              };
              const interrupt = () => state.fail("provider-unavailable");
              const timer = setTimeout(
                () => state.fail("provider-timeout"),
                deadlineMs,
              );
              signal.addEventListener("abort", interrupt, { once: true });
              try {
                if (signal.aborted) interrupt();
                return await contexts.run(state, () =>
                  Promise.race([Promise.resolve().then(call), refused]),
                );
              } finally {
                state.closed = true;
                abort.abort();
                clearTimeout(timer);
                signal.removeEventListener("abort", interrupt);
              }
            },
            catch: (error) =>
              error instanceof NativeSecretError
                ? error
                : NativeSecretError.new("provider-unavailable"),
          });
        }),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
