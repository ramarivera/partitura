import { spawn } from "node:child_process";
import { Context, Effect, Layer } from "effect";
import {
  cleanupNative,
  NativeOperationError,
  nativeIO,
  nativeTry,
} from "./native-build-errors.js";

/** Own the entire process group, including hooks/children retaining stdout.
 * Completion never rejects without a consumer. finish always reaps the child. */
export function nativeProcess(
  argv: readonly string[],
  options: {
    readonly timeout: number;
    readonly signal?: AbortSignal;
    readonly cwd?: string;
    readonly environment?: NodeJS.ProcessEnv;
  },
) {
  const [executable, ...args] = argv;
  if (!executable) throw NativeOperationError.new("native-command-missing");
  const child = spawn(executable, args, {
    cwd: options.cwd ?? "/",
    env: options.environment ?? {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
    },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let failure: unknown;
  let closed = false;
  const completion = new Promise<{ code: number | null; error: unknown }>(
    (resolve) => {
      child.once("error", (error) => {
        failure = NativeOperationError.new("native-process-unavailable", error);
      });
      child.once("close", (code) => {
        closed = true;
        resolve({ code, error: failure });
      });
    },
  );
  const kill = () => {
    if (closed || !child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ESRCH")
      )
        failure = NativeOperationError.new("native-process-kill-failed", error);
    }
  };
  const abort = () => {
    failure = NativeOperationError.new("native-process-aborted", failure);
    kill();
  };
  const timer = setTimeout(() => {
    failure = NativeOperationError.new("native-process-timeout", failure);
    kill();
  }, options.timeout);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    child,
    completion,
    finish: async () => {
      await cleanupNative([
        () => clearTimeout(timer),
        () => options.signal?.removeEventListener("abort", abort),
        kill,
        async () => {
          await completion;
        },
      ]);
    },
    check: async (allowed = [0]) => {
      const result = await completion;
      if (result.error !== undefined) throw result.error;
      if (result.code === null || !allowed.includes(result.code))
        throw NativeOperationError.new("native-process-failed");
      return result.code;
    },
  };
}

export class NativeBuildProcesses extends Context.Service<NativeBuildProcesses>()(
  "NativeBuildProcesses",
  {
    make: Effect.sync(() => ({
      acquire: Effect.fn("NativeBuildProcesses.acquire")(
        (...args: Parameters<typeof nativeProcess>) =>
          Effect.acquireRelease(
            nativeTry(() => nativeProcess(...args)),
            (owner) => nativeIO(() => owner.finish()).pipe(Effect.orDie),
          ),
      ),
    })),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
