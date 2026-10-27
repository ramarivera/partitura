import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { WorkspaceError } from "../domain/errors.js";
import { detachedProcessGroup, signalProcessTree } from "./process.js";
import {
  prepareWorkerWorkspace,
  workerIdentityCommand,
} from "./worker-security.js";
import { lstatOrMissing } from "./workspace-files.js";
import {
  cleanupWorkspaceProcess,
  gitEnvironment,
  needsWorkspaceIdentity,
  workspaceProcess,
  workspaceWorkerUid,
} from "./workspace-process.js";
export const enoent = (error: unknown): error is Error & { code: "ENOENT" } =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const workspaceFailure =
  (message: string, reason: WorkspaceError["reason"], sessionId: string) =>
  (cause: unknown) =>
    new WorkspaceError({
      message,
      sessionId,
      reason,
      cause: cause instanceof Error ? cause.message : String(cause),
    });

export const GITHUB_EXTRA_HEADER_KEY = "http.https://github.com/.extraheader";

export const redactGitOutput = (
  value: string,
  args: ReadonlyArray<string> = [],
): string => {
  let redacted = value;
  for (const arg of args) {
    if (
      arg.includes("AUTHORIZATION: basic") ||
      arg.includes(`${GITHUB_EXTRA_HEADER_KEY}=`)
    ) {
      redacted = redacted.replaceAll(arg, "<redacted>");
    }
  }
  return redacted
    .replace(
      /(http\.https:\/\/github\.com\/\.extraheader=)\S+/giu,
      "$1<redacted>",
    )
    .replace(/(AUTHORIZATION:\s*basic\s+)\S+/giu, "$1<redacted>");
};

export const gitSubcommand = (args: ReadonlyArray<string>): string => {
  for (const command of ["clone", "config", "fetch", "checkout"]) {
    if (args.includes(command)) return command;
  }
  return "command";
};

export const runGit = (
  args: ReadonlyArray<string>,
  cwd: string | undefined,
  sessionId: string,
  timeoutMs = 120_000,
  extraHeader?: string,
) =>
  runGitOutput(args, cwd, sessionId, timeoutMs, extraHeader).pipe(
    Effect.asVoid,
  );

export const persistGitHubExtraHeader = (
  target: string,
  sessionId: string,
  header: string,
): Effect.Effect<void, WorkspaceError> => {
  if (needsWorkspaceIdentity())
    return Effect.tryPromise({
      try: async () => {
        await prepareWorkerWorkspace(target, workspaceWorkerUid(target));
        await workspaceProcess(target, "persist-git", header);
      },
      catch: workspaceFailure(
        "Could not persist GitHub credential",
        "git_failed",
        sessionId,
      ),
    });
  return removeGitHubExtraHeaders(target, sessionId).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: async () => {
          if (!isGatewayGitHubExtraHeader(header))
            throw new Error("Invalid gateway credential");
          const gitDir = await open(
            join(target, ".git"),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          try {
            const configPath =
              process.platform === "linux"
                ? `/proc/self/fd/${gitDir.fd}/config`
                : join(target, ".git", "config");
            const config = await open(
              configPath,
              constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
            );
            try {
              const stat = await config.stat();
              if (!stat.isFile() || stat.nlink !== 1)
                throw new Error("Git config must be a regular file");
              await config.chmod(0o600);
              await config.writeFile(
                `\n[http "https://github.com/"]\n\textraheader = ${header}\n`,
              );
            } finally {
              await config.close();
            }
          } finally {
            await gitDir.close();
          }
        },
        catch: workspaceFailure(
          "Could not persist GitHub credential",
          "git_failed",
          sessionId,
        ),
      }),
    ),
  );
};

export const isGatewayGitHubExtraHeader = (value: string): boolean => {
  const match = /^AUTHORIZATION: basic ([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (match === null) return false;
  const encoded = match[1];
  if (encoded === undefined) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  return (
    decoded.startsWith("x-access-token:") &&
    Buffer.from(decoded, "utf8").toString("base64") === encoded
  );
};

export const runGitOutput = (
  args: ReadonlyArray<string>,
  cwd: string | undefined,
  sessionId: string,
  timeoutMs = 120_000,
  extraHeader?: string,
  allowMissingConfig = false,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const command = [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        ...args,
      ];
      const process = Bun.spawn(
        cwd === undefined
          ? command
          : workerIdentityCommand(command, workspaceWorkerUid(cwd)),
        {
          env: {
            ...gitEnvironment(globalThis.process.env),
            ...(extraHeader === undefined
              ? {}
              : {
                  GIT_CONFIG_COUNT: "1",
                  GIT_CONFIG_KEY_0: GITHUB_EXTRA_HEADER_KEY,
                  GIT_CONFIG_VALUE_0: extraHeader,
                }),
          },
          detached: detachedProcessGroup,
          ...(cwd ? { cwd } : {}),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const abort = () => signalProcessTree(process, "SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]).finally(() => signal.removeEventListener("abort", abort));
      if (exitCode !== 0 && !(allowMissingConfig && exitCode === 1)) {
        throw new Error(
          `git ${gitSubcommand(args)} failed: ${redactGitOutput(stderr.trim(), args)}`,
        );
      }
      return stdout;
    },
    catch: (cause) =>
      new WorkspaceError({
        message:
          cause instanceof Error
            ? redactGitOutput(cause.message, args)
            : "git command failed",
        sessionId,
        reason: "git_failed",
      }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new WorkspaceError({
            message: `git ${gitSubcommand(args)} timed out after ${timeoutMs}ms`,
            sessionId,
            reason: "git_failed",
          }),
        ),
    }),
  );

export const unsetGitHubExtraHeader = (
  target: string,
  sessionId: string,
  timeoutMs = 120_000,
): Effect.Effect<void, never> => {
  if (needsWorkspaceIdentity())
    return cleanupWorkspaceProcess(
      target,
      "clear-git",
      "workspace.github_cleanup_failed",
      { sessionId },
    );
  return removeGitHubExtraHeaders(target, sessionId, timeoutMs).pipe(
    Effect.catch((error) =>
      Effect.logWarning("workspace.github_cleanup_failed").pipe(
        Effect.annotateLogs({ sessionId, error: error.message }),
      ),
    ),
  );
};

export const removeGitHubExtraHeaders = (
  target: string,
  sessionId: string,
  timeoutMs = 120_000,
): Effect.Effect<void, WorkspaceError> =>
  Effect.gen(function* () {
    // --file works for a repository owned by the worker and never consults
    // repository discovery/safe.directory or executes repository hooks.
    const configuredHeaders = yield* runGitOutput(
      [
        "config",
        "--file",
        join(target, ".git", "config"),
        "--get-all",
        "--",
        GITHUB_EXTRA_HEADER_KEY,
      ],
      target,
      sessionId,
      timeoutMs,
      undefined,
      true,
    );
    if (configuredHeaders.split(/\r?\n/u).some(isGatewayGitHubExtraHeader)) {
      yield* runGit(
        [
          "config",
          "--file",
          join(target, ".git", "config"),
          "--unset-all",
          "--",
          GITHUB_EXTRA_HEADER_KEY,
          "^AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46",
        ],
        target,
        sessionId,
      );
    }
  });

/** Only private daemons may retain the gateway's repository-scoped Git header. */
export const assertT3GitCredentials = (
  target: string,
  sessionId: string,
  timeoutMs = 120_000,
  allowGatewayHeader = false,
): Effect.Effect<void, WorkspaceError> =>
  Effect.gen(function* () {
    const configs = yield* Effect.forEach(
      [
        join(target, ".git", "config"),
        join(target, ".omp-home", ".gitconfig"),
        join(target, ".omp-home", ".config", "git", "config"),
      ],
      (file, index) =>
        Effect.gen(function* () {
          if (
            index > 0 &&
            Option.isNone(yield* lstatOrMissing(file, sessionId, "git_failed"))
          )
            return "";
          return yield* runGitOutput(
            ["config", "--file", file, "--null", "--list"],
            target,
            sessionId,
            timeoutMs,
          );
        }),
    );
    const unsafe = configs
      .join("\0")
      .split("\0")
      .some((entry) => {
        const separator = entry.indexOf("\n");
        const key = entry.slice(0, separator).toLowerCase();
        const value = entry.slice(separator + 1);
        return (
          key.startsWith("credential.") ||
          key.startsWith("include.") ||
          key.startsWith("includeif.") ||
          key === "core.askpass" ||
          (key.endsWith(".extraheader") &&
            !(
              allowGatewayHeader &&
              key === GITHUB_EXTRA_HEADER_KEY &&
              isGatewayGitHubExtraHeader(value)
            )) ||
          key.endsWith(".proxy") ||
          key.endsWith(".sslkey") ||
          key.endsWith(".sslcert") ||
          /https?:\/\/[^/\s]*@/iu.test(value)
        );
      });
    const credentialFiles = yield* Effect.tryPromise({
      try: async () => {
        for (const name of [
          ".git-credentials",
          ".netrc",
          ".omp-home/.git-credentials",
          ".omp-home/.netrc",
          ".omp-home/.config/git/credentials",
        ]) {
          try {
            await lstat(join(target, name));
            return true;
          } catch (error) {
            if (!enoent(error)) throw error;
          }
        }
        return false;
      },
      catch: workspaceFailure(
        "Could not inspect T3 credentials",
        "git_failed",
        sessionId,
      ),
    });
    if (unsafe || credentialFiles)
      return yield* new WorkspaceError({
        message:
          "T3 refused non-gateway workspace Git credentials or config includes; remove them before retrying",
        reason: "git_failed",
        sessionId,
      });
  });
