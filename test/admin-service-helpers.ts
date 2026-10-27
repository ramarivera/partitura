import { Effect, Option, Redacted, Schema } from "effect";
import { WorkspaceError } from "../src/domain/errors.js";
import {
  IssueId,
  OrganizationId,
  ProjectId,
  TeamId,
  WorkspaceId,
} from "../src/domain/ids.js";
import type { RepositoryRecord as RepositoryRecordType } from "../src/domain/models.js";
import {
  type AdminDeps,
  createAdminHandle,
  csrfHash,
  deriveCsrfToken,
} from "../src/services/admin.js";
import {
  DEFAULT_AGENT_SETTINGS,
  validateAgentSettings,
} from "../src/services/agent-settings.js";
import type { GatewayConfigShape } from "../src/services/config.js";
import { NixEnvironment } from "../src/services/nix-environment.js";
import {
  AdminSessionRepo,
  AgentSettingsRepo,
  InstallationRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { suitePaths } from "./fixtures/paths.js";

export const suitePath = suitePaths();

export const unreachable = (..._args: ReadonlyArray<unknown>) => Effect.never;
export const token = "admin-token";
export const organizationId = Schema.decodeUnknownSync(OrganizationId)(
  "11111111-1111-4111-8111-111111111111",
);
export const issueId = Schema.decodeUnknownSync(IssueId)(
  "44444444-4444-4444-8444-444444444444",
);
export const repositoryId = Schema.decodeUnknownSync(WorkspaceId)("repo-main");
export const teamId = Schema.decodeUnknownSync(TeamId)("team-main");
export const projectId = Schema.decodeUnknownSync(ProjectId)("project-main");
export const config: GatewayConfigShape = {
  allowedOrganizationIds: new Set([organizationId]),
  gatewayAdminOrganizationIds: new Set([organizationId]),
  githubAppId: undefined,
  githubAppPrivateKey: undefined,
  linearClientId: "client",
  linearClientSecret: Redacted.make("secret"),
  linearWebhookSecret: Redacted.make("webhook"),
  tokenEncryptionKey: Redacted.make("key"),
  publicUrl: new URL("http://localhost:3000"),
  logLevel: "silent",
  logFile: Option.none(),
  databasePath: ":memory:",
  workspaceRoot: suitePath("workspaces"),
  ompCliPath: "omp",
  port: 3000,
  leaseDurationMs: 60_000,
  reconcilerIntervalMs: 1_000,
  nixBinaryPath: "nix",
  nixpkgsFlakeRef:
    "github:NixOS/nixpkgs/0123456789abcdef0123456789abcdef01234567",
  nixRootsDir: suitePath("nix-roots"),
  nixGcMaxBytes: 1_000_000,
  reconcilerCatchupIntervalMs: 300_000,
  reconcilerCatchupMinAgeMs: 120_000,
  webhookReplayWindowMs: 60_000,
  repositorySuggestionConfidenceThreshold: 0.8,
};

export const deps: AdminDeps = {
  config,
  adminSessionRepo: AdminSessionRepo.of({
    get: () =>
      Effect.succeed(
        Option.some({
          organizationId,
          csrfTokenHash: csrfHash(deriveCsrfToken(token)),
        }),
      ),
    create: unreachable,
    deleteAdminSession: unreachable,
  }),
  agentSettingsRepo: AgentSettingsRepo.of({
    get: () => Effect.succeed(DEFAULT_AGENT_SETTINGS),
    upsert: (_organizationId, settings) =>
      Effect.succeed(validateAgentSettings(settings)),
    getSnapshot: () => Effect.succeed(Option.none()),
    saveSnapshot: unreachable,
  }),
  installationRepo: InstallationRepo.of({
    put: unreachable,
    get: unreachable,
    revoke: unreachable,
    applyPermissionChange: unreachable,
    getRawEncryptedAccessToken: unreachable,
    createOAuthState: unreachable,
    consumeOAuthState: unreachable,
  }),
  runRepo: RunRepo.of({
    get: unreachable,
    create: unreachable,
    createIfNoActiveForIssue: unreachable,
    update: unreachable,
    reopen: unreachable,
    hasActiveForIssue: unreachable,
    listNonTerminalByIssue: unreachable,
    listRunnable: unreachable,
    listCatchupCandidates: unreachable,
    listCancellationPending: unreachable,
    claimLease: unreachable,
    renewLease: unreachable,
    releaseLease: unreachable,
    recoverInterruptedRuns: unreachable,
  }),
  runEventRepo: RunEventRepo.of({
    upsert: unreachable,
    list: unreachable,
    getBySourceKey: unreachable,
    maxRpcSequence: unreachable,
  }),
  mcpServerRepo: {
    listMcpServers: unreachable,
    createMcpServer: unreachable,
    updateMcpServer: unreachable,
    deleteMcpServer: unreachable,
  } as unknown as AdminDeps["mcpServerRepo"],
  mcpOAuth: {
    listStatuses: () => Effect.succeed(new Map()),
    startMcpAuthorization: unreachable,
    completeMcpAuthorization: unreachable,
    disconnect: unreachable,
  } as unknown as AdminDeps["mcpOAuth"],
  promptTemplateRepo: {
    get: () => Effect.succeed(Option.none()),
    upsert: unreachable,
    remove: unreachable,
    list: unreachable,
  } as unknown as AdminDeps["promptTemplateRepo"],
  executorInstanceRepo: {
    get: () => Effect.succeed(Option.none()),
    put: unreachable,
    remove: unreachable,
  } as unknown as AdminDeps["executorInstanceRepo"],
  executor: {
    listToolkits: unreachable,
  } as unknown as AdminDeps["executor"],
  runInputRepo: RunInputRepo.of({
    enqueue: unreachable,
    applyStop: unreachable,
    pending: unreachable,
    latestActionableInput: unreachable,
    listSessionsWithPendingInputs: unreachable,
    markProcessed: unreachable,
  }),
  linearGateway: {
    createSessionOnIssue: unreachable,
  },
  workspaceRepo: WorkspaceRepo.of({
    setWorkspace: unreachable,
    getDriverSession: unreachable,
    setDriverSession: unreachable,
    createRepository: unreachable,
    getRepository: unreachable,
    listRepositories: unreachable,
    updateRepository: unreachable,
    deleteRepository: unreachable,
    getDefaultRepository: unreachable,
  }),
  workspace: {
    resolve: () => Effect.succeed({ kind: "none" }),
    materialize: (_sessionId: string, _repository: RepositoryRecordType) =>
      Effect.fail(
        new WorkspaceError({
          message: "unused",
          sessionId: "unused",
          reason: "git_failed",
        }),
      ),
  },
  reconciler: {
    trigger: () => Effect.void,
    status: () =>
      Effect.succeed({
        running: false,
        lastStartedAt: Option.none(),
        lastCompletedAt: Option.none(),
        lastError: Option.none(),
      }),
  },
  nixEnvironment: NixEnvironment.of({
    enforceBudget: () =>
      Effect.succeed({ removed: 0, sizeBytes: 0, withinBudget: true }),
    prepare: unreachable,
    list: () => Effect.succeed([]),
    prune: () => Effect.succeed(false),
  }),
};

export const handle = createAdminHandle(deps);
export const request = (path: string, body: unknown): Request =>
  new Request(new URL(path, config.publicUrl).toString(), {
    method: "POST",
    headers: {
      Cookie: `omp_gateway_admin=${token}`,
      Origin: config.publicUrl.toString(),
      "X-CSRF-Token": deriveCsrfToken(token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

export const run = async (requestValue: Request): Promise<Response> => {
  const result = await Effect.runPromise(handle(requestValue));
  return Option.match(result, {
    onNone: () => {
      throw new Error("expected an admin response");
    },
    onSome: (response) => response,
  });
};
