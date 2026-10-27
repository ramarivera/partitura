import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { opaqueId, writeNativeStream } from "./native-build-files.js";
import {
  applyNativeReceipt,
  createNativeBuildRecovery,
  recoverNativeMetadata,
} from "./native-build-recovery.js";
import {
  type NativeBuildState,
  type NativeRegistryJob,
  nativeLimits,
  newRecovery,
  terminalNativeJob,
  unresolvedRecovery,
} from "./native-build-state.js";
import {
  type NativeBrokerTransport,
  publishNativeArtifact,
} from "./native-build-transport.js";
import { workerIdentityCommand } from "./worker-security.js";

export interface RegistryBuildRequest {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly workspacePath: string;
  readonly workerUid?: string;
  readonly commit: string;
  readonly pullRequest: number;
  readonly action: string;
  /** Selected by the gateway, never model arguments. */
  readonly secretFiles?: Readonly<Record<string, string>>;
}

/** Local git executes as the workspace uid. Only the opaque bundle crosses
 * into gateway scratch; no worker-controlled destination is opened by root. */
export async function* nativeGitBundle(
  request: RegistryBuildRequest,
  job: NativeRegistryJob,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const ref = `refs/partitura/native-build/${job.jobId}`;
  const run = (args: string[]) => {
    const argv = workerIdentityCommand(
      ["/usr/bin/git", "-C", request.workspacePath, ...args],
      request.workerUid,
    );
    const executable = argv.shift();
    if (!executable) throw new Error("native-bundle-command-missing");
    const child = spawn(executable, argv, {
      cwd: "/",
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("native-bundle-unavailable")));
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error("native-bundle-failed")),
      );
    });
    return { child, exited };
  };
  const update = run(["update-ref", ref, request.commit]);
  await update.exited;
  try {
    const { child, exited } = run(["bundle", "create", "-", ref]);
    // Keep a rejection handler attached while consuming stdout.
    void exited.catch(() => undefined);
    const kill = () => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(kill, 120_000);
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    try {
      for await (const bytes of child.stdout) yield Buffer.from(bytes);
      await exited;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      kill();
      await exited.catch(() => undefined);
    }
  } finally {
    const cleanup = run(["update-ref", "-d", ref]);
    await cleanup.exited;
  }
}

/** Slice 4 engine only. No conductor, config or production tool calls it. */
export async function createRegistryNativeBuildClient(
  state: NativeBuildState,
  transport: NativeBrokerTransport,
  options: {
    readonly now?: () => number;
    readonly prepareBundle?: typeof nativeGitBundle;
    /** Called under the state publication semaphore immediately before submitting.
     * The future registry owns enabled/conflict/health/floor checks here. */
    readonly canSubmit: (job: NativeRegistryJob) => boolean;
  },
) {
  const now = options.now ?? Date.now;
  await recoverNativeMetadata(state, now());
  const recovery = createNativeBuildRecovery(state, transport, { now });
  const active = new Map<
    string,
    { task: Promise<void>; abort: AbortController }
  >();
  let closing = false;
  const generationOf = (id: string) => {
    const generation = state.snapshot().generations.find((g) => g.id === id);
    if (!generation) throw new Error("native-generation-not-found");
    return generation;
  };
  return {
    recovery,
    start: async (request: RegistryBuildRequest) => {
      if (closing) throw new Error("native-engine-closed");
      const entries = Object.entries(request.secretFiles ?? {});
      if (
        entries.length > 16 ||
        entries.some(
          ([key, value]) =>
            !/^[a-z][a-z0-9-]{0,63}$/u.test(key) || typeof value !== "string",
        )
      )
        throw new Error("invalid-native-secrets");
      const secret = entries.length
        ? Buffer.from(JSON.stringify(Object.fromEntries(entries)))
        : Buffer.alloc(0);
      if (secret.length > 65_536) throw new Error("native-secrets-too-large");
      const generation = generationOf(request.generationId);
      if (!transport.hasCredential(generation.id))
        throw new Error("missing-credentials");
      const health = await transport.envelope(generation, "health");
      if (
        health.kind !== "health" ||
        health.hostId !== generation.transport.hostId ||
        !health.accepting ||
        health.status !== "ready" ||
        !health.epoch
      )
        throw new Error("native-builder-unavailable");
      const job = await state.transaction((draft) => {
        if (
          closing ||
          draft.jobs.some(
            (j) =>
              (j.verifiedHostId === generation.transport.hostId &&
                (!terminalNativeJob(j) || unresolvedRecovery(j))) ||
              (j.organizationId === request.organizationId &&
                j.sessionId === request.sessionId &&
                (!terminalNativeJob(j) || unresolvedRecovery(j))),
          )
        )
          throw new Error("native-builder-reserved");
        const job: NativeRegistryJob = {
          version: 1,
          jobId: opaqueId(),
          organizationId: request.organizationId,
          sessionId: request.sessionId,
          builderId: generation.builderId,
          generationId: generation.id,
          verifiedHostId: generation.transport.hostId,
          commit: request.commit,
          pullRequest: request.pullRequest,
          action: request.action,
          attempt: opaqueId(),
          epoch: health.epoch ?? "",
          submissionExpiresAt: 0,
          state: "starting",
          recovery: newRecovery(),
          createdAt: now(),
          updatedAt: now(),
        };
        if (!options.canSubmit(job)) throw new Error("native-admission-closed");
        draft.jobs.push(job);
        return job;
      });
      const abort = new AbortController();
      const task = (async () => {
        const release = state.retainGeneration(generation.id);
        let bundlePath: string | undefined;
        try {
          await state.prune();
          const reservation = await state.reserve(
            job,
            "source.bundle",
            nativeLimits.bundle,
          );
          bundlePath = reservation.path;
          try {
            const bytes = await writeNativeStream(
              reservation.path,
              (options.prepareBundle ?? nativeGitBundle)(
                request,
                job,
                abort.signal,
              ),
              nativeLimits.bundle,
              abort.signal,
            );
            if (!bytes) throw new Error("native-bundle-empty");
            await reservation.commit();
          } finally {
            await reservation.release();
          }
          // This write is the dispatch boundary. A failed write prevents spawn.
          const submitted = await state.transaction((draft) => {
            const current = draft.jobs.find((j) => j.jobId === job.jobId);
            if (
              current?.state !== "starting" ||
              abort.signal.aborted ||
              !options.canSubmit(current)
            )
              throw new Error("native-submission-closed");
            current.state = "submitting";
            current.submissionExpiresAt = Math.floor(now() / 1000) + 120;
            current.updatedAt = now();
            return current;
          });
          const file = await open(
            bundlePath,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const info = await file.stat();
            const input = (async function* () {
              if (secret.length) yield secret;
              for await (const bytes of file.createReadStream({
                autoClose: false,
              }))
                yield Buffer.from(bytes);
            })();
            const receipt = await transport.envelope(
              generation,
              `run-v2 ${job.jobId} ${job.commit} ${job.pullRequest} ${job.action} ${info.size} ${secret.length} ${job.epoch} ${job.attempt} ${submitted.submissionExpiresAt}`,
              submitted,
              { input, signal: abort.signal, timeout: 3_600_000 },
            );
            await state.transaction((draft) => {
              const current = draft.jobs.find((j) => j.jobId === job.jobId);
              if (!current) throw new Error("native-job-not-found");
              if (
                receipt.kind === "refused" &&
                receipt.accepted === false &&
                receipt.code === "host-busy"
              ) {
                current.state = "failed";
                current.failureCode = "host-busy";
              } else if (receipt.kind === "known")
                applyNativeReceipt(current, receipt);
              else if (
                receipt.kind === "refused" &&
                receipt.accepted === false
              ) {
                current.state = "failed";
                current.failureCode = receipt.code ?? "refused";
              } else throw new Error("invalid-native-run-response");
              current.updatedAt = now();
              // host-busy is the single receipt-free refusal which proves no
              // input/dispatch. Other outcomes still need fenced cleanup proof.
              if (
                !(receipt.kind === "refused" && receipt.code === "host-busy")
              ) {
                current.recovery.state = "pending";
                current.recovery.deadline = now() + 900_000;
                current.recovery.nextAt = now();
              }
            });
          } finally {
            await file.close();
          }
        } catch {
          await state.transaction((draft) => {
            const current = draft.jobs.find((j) => j.jobId === job.jobId);
            if (!current) throw new Error("native-job-not-found");
            if (current.state === "starting") {
              current.state = abort.signal.aborted ? "interrupted" : "failed";
              current.updatedAt = now();
            } else if (current.recovery.state === "not-required") {
              current.recovery.state = "pending";
              current.recovery.deadline = now() + 900_000;
              current.recovery.nextAt = now();
            }
          });
        } finally {
          if (bundlePath)
            await state.remove(bundlePath).catch((error: unknown) => {
              if (
                !(
                  error instanceof Error && error.message === "native-file-busy"
                )
              )
                throw error;
            });
          release();
        }
      })();
      active.set(job.jobId, { task, abort });
      void task.finally(() => active.delete(job.jobId)).catch(() => undefined);
      return job;
    },
    status: (
      organization: string,
      session: string,
      id: string,
      builder?: string,
    ) => state.owned(organization, session, id, builder),
    artifact: async (
      organization: string,
      session: string,
      id: string,
      builder?: string,
    ) => {
      const job = state.owned(organization, session, id, builder);
      if (
        !(
          job.state === "succeeded" ||
          (job.state === "failed" && job.failureCode === "workflow-failed")
        )
      )
        throw new Error("native-artifact-unavailable");
      return publishNativeArtifact(
        state,
        transport,
        generationOf(job.generationId),
        job,
      );
    },
    cancel: async (
      organization: string,
      session: string,
      id: string,
      builder?: string,
    ) => {
      state.owned(organization, session, id, builder);
      const pending = active.get(id);
      pending?.abort.abort();
      await pending?.task;
      await recovery.request(id);
      await recovery.tick(id);
    },
    wait: async (id: string) => {
      await active.get(id)?.task;
    },
    close: async () => {
      closing = true;
      for (const pending of active.values()) pending.abort.abort();
      await Promise.all([...active.values()].map((pending) => pending.task));
      for (const job of state
        .snapshot()
        .jobs.filter(
          (job) => !terminalNativeJob(job) || unresolvedRecovery(job),
        )) {
        await recovery.request(job.jobId);
        await recovery.tick(job.jobId);
      }
    },
  };
}
