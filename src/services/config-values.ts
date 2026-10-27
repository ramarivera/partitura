import { isAbsolute, resolve } from "node:path";
import { Config, ConfigProvider, Effect, Option } from "effect";
import type { LogLevel } from "../domain/models.js";
import {
  LOG_FILE_FREQUENCIES,
  type LogFileConfig,
  type LogFileFrequency,
  type WorkerSandboxMode,
} from "./config-types.js";

const isLogFileFrequency = (value: string): value is LogFileFrequency =>
  LOG_FILE_FREQUENCIES.some((frequency) => frequency === value);

const isWorkerSandboxMode = (value: string): value is WorkerSandboxMode =>
  value === "native" || value === "firecracker" || value === "sysbox";

export const positiveInteger = (name: string, fallback: number) =>
  Config.String(name).pipe(
    Config.withDefault(String(fallback)),
    Config.mapEffect((value) => {
      const trimmed = value.trim();
      // Digit-only: Number.parseInt would silently truncate "5m", "1.5",
      // and "1e3" into wrong-but-accepted values.
      const parsed = /^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN;
      return Number.isSafeInteger(parsed) && parsed > 0
        ? Effect.succeed(parsed)
        : Effect.fail(
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message: `${name} must be a positive integer`,
              }),
            ),
          );
    }),
  );
export const timeoutMilliseconds = (name: string, fallback: number) =>
  positiveInteger(name, fallback).pipe(
    Config.mapEffect((value) =>
      value <= 2_147_483_647
        ? Effect.succeed(value)
        : Effect.fail(
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message: `${name} must not exceed 2147483647 ms`,
              }),
            ),
          ),
    ),
  );

const decimalBetween = (name: string, fallback: number) =>
  Config.option(Config.String(name)).pipe(
    Config.mapEffect((value) => {
      const raw = Option.match(value, {
        onNone: () => String(fallback),
        onSome: (configured) => configured.trim(),
      });
      // Blank values must fail: Number("") is 0, which would silently
      // disable the repository-suggestion confidence gate.
      const parsed = raw.length === 0 ? Number.NaN : Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
        ? Effect.succeed(parsed)
        : Effect.fail(
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message: `${name} must be a number between 0 and 1`,
              }),
            ),
          );
    }),
  );

const LOG_LEVELS: ReadonlySet<string> = new Set([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);

const logLevel = Config.String("LOG_LEVEL").pipe(
  Config.withDefault("info"),
  Config.map((value): LogLevel => {
    const normalized = value.trim().toLowerCase();
    return LOG_LEVELS.has(normalized) ? (normalized as LogLevel) : "info";
  }),
);

const logFilePath = Config.String("LOG_FILE").pipe(
  Config.withDefault(""),
  Config.map((value) => {
    const trimmed = value.trim();
    return trimmed.length === 0
      ? Option.none<LogFileConfig["path"]>()
      : Option.some(resolve(trimmed));
  }),
);

const logFileFrequency = Config.String("LOG_FILE_FREQUENCY").pipe(
  Config.withDefault("daily"),
  Config.mapEffect((value) => {
    const normalized = value.trim().toLowerCase();
    return isLogFileFrequency(normalized)
      ? Effect.succeed(normalized)
      : Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "LOG_FILE_FREQUENCY must be daily or hourly",
            }),
          ),
        );
  }),
);

const logFileSize = Config.String("LOG_FILE_SIZE").pipe(
  Config.withDefault("25m"),
  Config.mapEffect((value) => {
    const normalized = value.trim().toLowerCase();
    const match = /^(\d+(?:\.\d+)?)([bkmg]?)$/.exec(normalized);
    return match !== null && Number(match[1]) > 0
      ? Effect.succeed(normalized)
      : Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message:
                "LOG_FILE_SIZE must be a positive number with an optional b, k, m, or g suffix",
            }),
          ),
        );
  }),
);

const logFileLimit = positiveInteger("LOG_FILE_LIMIT", 14);

export const invalid = (message: string) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message }));

export const absolutePath = (name: string, value: string) =>
  isAbsolute(value) && resolve(value) === value
    ? Effect.succeed(value)
    : Effect.fail(invalid(`${name} must be a normalized absolute path`));

const workerExtensionPaths = Config.String("WORKER_EXTENSION_PATHS").pipe(
  Config.withDefault(""),
  Config.mapEffect((value) =>
    Effect.forEach(
      value
        .split(",")
        .map((path) => path.trim())
        .filter(Boolean),
      (path) => absolutePath("WORKER_EXTENSION_PATHS", path),
    ),
  ),
);

const nixpkgsFlakeRef = Config.String("NIXPKGS_FLAKE_REF").pipe(
  Config.withDefault(
    "github:NixOS/nixpkgs/ac62194c3917d5f474c1a844b6fd6da2db95077d",
  ),
  Config.mapEffect((value) => {
    const normalized = value.trim();
    return /^github:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[0-9a-fA-F]{40}$/.test(
      normalized,
    )
      ? Effect.succeed(normalized)
      : Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message:
                "NIXPKGS_FLAKE_REF must be an immutable github owner/repository commit reference",
            }),
          ),
        );
  }),
);

const logFile = Config.all({
  path: logFilePath,
  frequency: logFileFrequency,
  size: logFileSize,
  limit: logFileLimit,
}).pipe(
  Config.map(({ path, frequency, size, limit }) =>
    Option.map(path, (filePath) => ({
      path: filePath,
      frequency,
      size,
      limit,
    })),
  ),
);

export const GatewayConfigValues = Config.all({
  workerSandboxMode: Config.String("WORKER_SANDBOX_MODE").pipe(
    Config.withDefault("firecracker"),
    Config.mapEffect((value) => {
      const mode = value.trim();
      return isWorkerSandboxMode(mode)
        ? Effect.succeed(mode)
        : Effect.fail(
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message:
                  "WORKER_SANDBOX_MODE must be native, firecracker, or sysbox",
              }),
            ),
          );
    }),
  ),
  sessionSandboxBrokerSocketPath: Config.option(
    Config.String("SESSION_SANDBOX_BROKER_SOCKET"),
  ).pipe(
    Config.map((value) =>
      Option.isSome(value) && value.value.trim().length > 0
        ? resolve(value.value.trim())
        : undefined,
    ),
  ),
  nativeBuildSshConfigFile: Config.option(
    Config.String("NATIVE_BUILD_SSH_CONFIG_FILE"),
  ).pipe(
    Config.map((value) =>
      Option.isSome(value) && value.value.trim().length > 0
        ? resolve(value.value.trim())
        : undefined,
    ),
  ),
  nativeBuildScratchRoot: Config.option(
    Config.String("NATIVE_BUILD_SCRATCH_ROOT"),
  ).pipe(
    Config.map((value) =>
      Option.isSome(value) && value.value.trim().length > 0
        ? resolve(value.value.trim())
        : undefined,
    ),
  ),
  nativeBuildBackupSshConfigFile: Config.option(
    Config.String("NATIVE_BUILD_BACKUP_SSH_CONFIG_FILE"),
  ).pipe(
    Config.map((value) =>
      Option.isSome(value) && value.value.trim().length > 0
        ? resolve(value.value.trim())
        : undefined,
    ),
  ),
  nativeBuildBackupScratchRoot: Config.option(
    Config.String("NATIVE_BUILD_BACKUP_SCRATCH_ROOT"),
  ).pipe(
    Config.map((value) =>
      Option.isSome(value) && value.value.trim().length > 0
        ? resolve(value.value.trim())
        : undefined,
    ),
  ),
  logLevel,
  logFile,
  mcpOAuthAllowLoopbackHttp: Config.Boolean(
    "MCP_OAUTH_ALLOW_LOOPBACK_HTTP",
  ).pipe(Config.withDefault(false)),
  tokenEncryptionKeyId: positiveInteger("TOKEN_ENCRYPTION_KEY_ID", 1),
  databasePath: Config.String("DATABASE_PATH").pipe(
    Config.withDefault("./data/gateway.sqlite"),
    Config.map((value) => (value === ":memory:" ? value : resolve(value))),
  ),
  workspaceRoot: Config.String("WORKSPACE_ROOT").pipe(
    Config.withDefault("./data/workspaces"),
    Config.map(resolve),
  ),
  ompCliPath: Config.String("OMP_CLI_PATH").pipe(
    Config.withDefault("omp"),
    Config.map((value) => value.trim() || "omp"),
  ),
  port: positiveInteger("PORT", 3000),
  leaseDurationMs: positiveInteger("LEASE_DURATION_MS", 60_000),
  rpcRequestTimeoutMs: timeoutMilliseconds("RPC_REQUEST_TIMEOUT_MS", 30_000),
  gitTimeoutMs: timeoutMilliseconds("GIT_TIMEOUT_MS", 120_000),
  nixTimeoutMs: timeoutMilliseconds("NIX_TIMEOUT_MS", 600_000),
  maxConcurrentWorkers: positiveInteger("MAX_CONCURRENT_WORKERS", 4),
  reconcilerIntervalMs: positiveInteger("RECONCILER_INTERVAL_MS", 1_000),
  reconcilerCatchupIntervalMs: positiveInteger(
    "RECONCILER_CATCHUP_INTERVAL_MS",
    5 * 60_000,
  ),
  reconcilerCatchupMinAgeMs: positiveInteger(
    "RECONCILER_CATCHUP_MIN_AGE_MS",
    2 * 60_000,
  ),
  webhookReplayWindowMs: positiveInteger("WEBHOOK_REPLAY_WINDOW_MS", 60_000),
  repositorySuggestionConfidenceThreshold: decimalBetween(
    "REPOSITORY_SUGGESTION_CONFIDENCE_THRESHOLD",
    0.8,
  ),
  nixBinaryPath: Config.String("NIX_BINARY_PATH").pipe(
    Config.withDefault("nix"),
    Config.map((value) => value.trim() || "nix"),
  ),
  nixpkgsFlakeRef,
  nixRootsDir: Config.String("NIX_ROOTS_DIR").pipe(
    Config.withDefault("/app/nix-roots"),
    Config.map(resolve),
  ),
  nixGcMaxBytes: positiveInteger("NIX_GC_MAX_BYTES", 10 * 1024 * 1024 * 1024),
  workerProfileMaxBytes: positiveInteger(
    "WORKER_PROFILE_MAX_BYTES",
    64 * 1024 * 1024,
  ),
  workerProfileMaxEntries: positiveInteger(
    "WORKER_PROFILE_MAX_ENTRIES",
    10_000,
  ),
  workerExtensionPaths,
  workerClaudeExecutable: Config.String("WORKER_CLAUDE_EXECUTABLE").pipe(
    Config.withDefault("claude-cliproxy"),
    Config.map((value) => value.trim() || "claude-cliproxy"),
  ),
});
