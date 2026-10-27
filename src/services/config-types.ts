import type { Option, Redacted } from "effect";
import type { LogLevel } from "../domain/models.js";
import type { RuntimeMode } from "../drivers/driver.js";
import type { NativeBuildConfig } from "./native-build-client.js";
import type { T3DeviceBackupConfig } from "./t3-device-backup.js";
export const LOG_FILE_FREQUENCIES = ["daily", "hourly"] as const;
export type LogFileFrequency = (typeof LOG_FILE_FREQUENCIES)[number];
export type WorkerSandboxMode = "native" | "firecracker" | "sysbox";

export interface LogFileConfig {
  readonly path: string;
  readonly frequency: LogFileFrequency;
  readonly size: string;
  readonly limit: number;
}
export type T3TokenSource =
  | { readonly _tag: "Inline"; readonly token: Redacted.Redacted<string> }
  /** Re-read on every connect so a rotated token file is picked up. */
  | { readonly _tag: "File"; readonly path: string };

/** Settings for the gateway-owned per-session `t3 serve` launcher. */
export interface T3LaunchConfig {
  readonly _tag: "Launch";
  readonly cliPath: string;
  /** First loopback port; a session's port is portBase + its slot. */
  readonly portBase: number;
  readonly portCount: number;
  readonly launchTimeoutMs: number;
  readonly codexExecutable: string;
  readonly claudeExecutable: string;
  readonly codexModel: string;
  readonly codexReasoningEffort: string;
  readonly textGenerationModel: string;
}

/**
 * Remote: one externally managed daemon shared by every T3 session. Launch:
 * the gateway starts a private daemon per session under its worker uid.
 */
export type T3Connection =
  | {
      readonly _tag: "Remote";
      readonly baseUrl: URL;
      readonly token: T3TokenSource;
    }
  | T3LaunchConfig;

export interface T3DriverConfig {
  readonly connection: T3Connection;
  readonly projectId?: string;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly modelOptions: ReadonlyArray<{
    readonly id: string;
    readonly value: string | boolean;
  }>;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: "default" | "plan";
  /** Prefix for every id the driver derives (threads, commands, messages). */
  readonly idNamespace: string;
}

export interface GatewayConfigShape {
  readonly allowedOrganizationIds?: ReadonlySet<string> | undefined;
  readonly gatewayAdminOrganizationIds?: ReadonlySet<string> | undefined;
  readonly githubAppAllowedOwners?:
    | Readonly<Record<string, ReadonlyArray<string>>>
    | undefined;
  readonly mcpOAuthAllowLoopbackHttp?: boolean | undefined;
  readonly tokenEncryptionKeyId?: number | undefined;
  readonly tokenEncryptionPreviousKeys?: Redacted.Redacted<string> | undefined;
  readonly linearClientId: string;
  readonly linearClientSecret: Redacted.Redacted<string>;
  readonly linearWebhookSecret: Redacted.Redacted<string>;
  readonly tokenEncryptionKey: Redacted.Redacted<string>;
  readonly githubAppId: string | undefined;
  readonly githubAppPrivateKey: Redacted.Redacted<string> | undefined;
  readonly publicUrl: URL;
  readonly logLevel: LogLevel;
  readonly logFile: Option.Option<LogFileConfig>;
  readonly nixBinaryPath: string;
  readonly nixpkgsFlakeRef: string;
  readonly nixRootsDir: string;
  readonly nixGcMaxBytes: number;
  readonly databasePath: string;
  readonly workspaceRoot: string;
  readonly ompCliPath: string;
  readonly port: number;
  readonly leaseDurationMs: number;
  readonly rpcRequestTimeoutMs?: number;
  readonly gitTimeoutMs?: number;
  readonly nixTimeoutMs?: number;
  readonly maxConcurrentWorkers?: number;
  readonly reconcilerIntervalMs: number;
  readonly reconcilerCatchupIntervalMs: number;
  readonly reconcilerCatchupMinAgeMs: number;
  readonly webhookReplayWindowMs: number;
  readonly repositorySuggestionConfidenceThreshold: number;
  /** Read-only, credential-free omp profile copied into each worker agent dir. */
  readonly workerProfileDir?: string | undefined;
  readonly workerProfileMaxBytes?: number;
  readonly workerProfileMaxEntries?: number;
  /** CLIProxyAPI origin; the only model endpoint workers are configured for. */
  readonly cliproxyApiBaseUrl?: string | undefined;
  /** Dedicated Partitura client key, passed only into worker environments. */
  readonly cliproxyApiKey?: Redacted.Redacted<string> | undefined;
  readonly workerDefaultModel?: string | undefined;
  /** Org/repository-bound scoped identities. Never inherit a gateway age key. */
  readonly workerRepositoryAgeKeys?: Redacted.Redacted<
    Readonly<Record<string, Readonly<Record<string, string>>>>
  >;
  /** Gateway-installed omp extensions loaded into every worker, e.g. pi-claude-cli. */
  readonly workerExtensionPaths?: ReadonlyArray<string>;
  readonly workerClaudeExecutable?: string;
  /** Firecracker is the default. Isolated runtimes fail closed without their broker. */
  readonly workerSandboxMode?: WorkerSandboxMode | undefined;
  readonly sessionSandboxBrokerSocketPath?: string | undefined;
  /** Gateway-only SSH transport for optional native build host tools. */
  readonly nativeBuild?: NativeBuildConfig | undefined;
  /** Explicit second builder, with its own dedicated transport and job store. */
  readonly nativeBuildBackup?: NativeBuildConfig | undefined;
  readonly t3DeviceBackup?: T3DeviceBackupConfig | undefined;
  /** Present only when T3_MODE or T3_BASE_URL is set. */
  readonly t3Driver?: T3DriverConfig;
}
