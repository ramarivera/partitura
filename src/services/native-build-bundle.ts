import { Effect } from "effect";
import { nativeIO } from "./native-build-errors.js";
import { NativeBuildProcesses } from "./native-build-process.js";
import type { RegistryBuildRequest } from "./native-build-registry-client.js";
import type { NativeRegistryJob } from "./native-build-state.js";
import { workerIdentityCommand } from "./worker-security.js";

/** Worker git hooks are disabled. Both ref operations and their process groups
 * are bounded, including the deletion finalizer after interruption. */
export const nativeGitBundle = Effect.fn("NativeBuildBundle.prepare")(
  function* (
    request: RegistryBuildRequest,
    job: NativeRegistryJob,
    options: {
      readonly executable?: string;
      readonly referenceTimeout?: number;
    } = {},
  ) {
    const processes = yield* NativeBuildProcesses.make;
    const ref = `refs/partitura/native-build/${job.jobId}`;
    const run = (args: string[], timeout: number) =>
      processes.acquire(
        workerIdentityCommand(
          [
            options.executable ?? "/usr/bin/git",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            request.workspacePath,
            ...args,
          ],
          request.workerUid,
        ),
        {
          timeout,
          environment: {
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
      );
    const reference = (args: string[]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* run(args, options.referenceTimeout ?? 30_000);
          owner.child.stdin.end();
          owner.child.stdout.resume();
          owner.child.stderr.resume();
          yield* nativeIO(() => owner.check());
        }),
      );
    yield* Effect.addFinalizer(() =>
      reference(["update-ref", "-d", ref]).pipe(Effect.orDie),
    );
    yield* reference(["update-ref", ref, request.commit]);
    const owner = yield* run(["bundle", "create", "-", ref], 120_000);
    owner.child.stdin.end();
    owner.child.stderr.resume();
    return (async function* () {
      for await (const bytes of owner.child.stdout) yield Buffer.from(bytes);
      await owner.check();
    })();
  },
);
