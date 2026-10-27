import { createHmac } from "node:crypto";
import {
  Clock,
  ConfigProvider,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { expect } from "vitest";
import {
  AppUserId,
  IssueId,
  OrganizationId,
  ProjectId,
  SessionId,
  TeamId,
} from "../src/domain/ids.js";
import type { Installation } from "../src/domain/models.js";
import {
  GatewayConfig,
  type GatewayConfigShape,
} from "../src/services/config.js";
import {
  DeliveryRepo,
  InstallationRepo,
  PromptTemplateRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import {
  type SqliteClient,
  SqliteClientLive,
} from "../src/services/store/sqlite-client.js";
import { TokenCrypto } from "../src/services/token-crypto.js";
import { WebhookPipeline } from "../src/services/webhook.js";
import { suitePaths } from "./fixtures/paths.js";

export const suitePath = suitePaths();

export const secret = "webhook-secret";
export const tokenEncryptionKey =
  "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
export const config: GatewayConfigShape = {
  githubAppId: undefined,
  githubAppPrivateKey: undefined,
  linearClientId: "client",
  linearClientSecret: Redacted.make("client-secret"),
  linearWebhookSecret: Redacted.make(secret),
  tokenEncryptionKey: Redacted.make(tokenEncryptionKey),
  publicUrl: new URL("https://gateway.example.com"),
  databasePath: ":memory:",
  nixBinaryPath: "nix",
  nixpkgsFlakeRef:
    "github:NixOS/nixpkgs/0123456789abcdef0123456789abcdef01234567",
  nixRootsDir: suitePath("nix-roots"),
  nixGcMaxBytes: 1_000_000,
  workspaceRoot: "/workspaces",
  ompCliPath: "omp",
  port: 3000,
  leaseDurationMs: 60_000,
  reconcilerIntervalMs: 1_000,
  reconcilerCatchupIntervalMs: 300_000,
  reconcilerCatchupMinAgeMs: 120_000,
  webhookReplayWindowMs: 60_000,
  repositorySuggestionConfidenceThreshold: 0.8,
  logLevel: "silent",
  logFile: Option.none(),
};
export const configProviderFor = (gatewayConfig: GatewayConfigShape) =>
  ConfigProvider.fromUnknown(
    Object.fromEntries(
      new Map([
        ...(gatewayConfig.allowedOrganizationIds === undefined
          ? []
          : [
              [
                "LINEAR_ALLOWED_ORGANIZATION_IDS",
                [...gatewayConfig.allowedOrganizationIds].join(","),
              ] as const,
            ]),
        ["WORKER_SANDBOX_MODE", "native"],
        ["LINEAR_CLIENT_ID", gatewayConfig.linearClientId],
        ["LINEAR_CLIENT_SECRET", "client-secret"],
        ["LINEAR_WEBHOOK_SECRET", secret],
        ["TOKEN_ENCRYPTION_KEY", tokenEncryptionKey],
        ["PUBLIC_URL", gatewayConfig.publicUrl.toString()],
        ["DATABASE_PATH", gatewayConfig.databasePath],
        ["WORKSPACE_ROOT", gatewayConfig.workspaceRoot],
        ["OMP_CLI_PATH", gatewayConfig.ompCliPath],
        ["PORT", String(gatewayConfig.port)],
        ["LEASE_DURATION_MS", String(gatewayConfig.leaseDurationMs)],
        ["RECONCILER_INTERVAL_MS", String(gatewayConfig.reconcilerIntervalMs)],
        [
          "WEBHOOK_REPLAY_WINDOW_MS",
          String(gatewayConfig.webhookReplayWindowMs),
        ],
        ["LOG_LEVEL", gatewayConfig.logLevel],
        ["NIX_BINARY_PATH", gatewayConfig.nixBinaryPath],
        ["NIXPKGS_FLAKE_REF", gatewayConfig.nixpkgsFlakeRef],
        ["NIX_ROOTS_DIR", gatewayConfig.nixRootsDir],
        ["NIX_GC_MAX_BYTES", String(gatewayConfig.nixGcMaxBytes)],
      ]),
    ),
    { preserveEmptyStrings: true },
  );

export const sessionId = (value: string) =>
  Schema.decodeUnknownSync(SessionId)(value);
export const organizationId = (value: string) =>
  Schema.decodeUnknownSync(OrganizationId)(value);
export const appUserId = (value: string) =>
  Schema.decodeUnknownSync(AppUserId)(value);
export const issueId = (value: string) =>
  Schema.decodeUnknownSync(IssueId)(value);
export const teamId = (value: string) =>
  Schema.decodeUnknownSync(TeamId)(value);
export const projectId = (value: string) =>
  Schema.decodeUnknownSync(ProjectId)(value);

export const makeLayer = (gatewayConfig: GatewayConfigShape) =>
  Layer.mergeAll(
    GatewayConfig.layer,
    TokenCrypto.layer,
    InstallationRepo.layer,
    DeliveryRepo.layer,
    RunEventRepo.layer,
    RunRepo.layer,
    PromptTemplateRepo.layer,
    RunInputRepo.layer,
    WebhookPipeline.layer,
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqliteClientLive(gatewayConfig.databasePath),
        ConfigProvider.layer(configProviderFor(gatewayConfig)),
      ),
    ),
  );

export const withWebhook = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | WebhookPipeline
    | InstallationRepo
    | RunRepo
    | RunInputRepo
    | DeliveryRepo
    | PromptTemplateRepo
    | SqliteClient
  >,
  gatewayConfig = config,
) =>
  Effect.gen(function* () {
    yield* Effect.scope;
    return yield* effect.pipe(Effect.provide(makeLayer(gatewayConfig)));
  });

export const sign = (body: string, signingSecret = secret): string =>
  createHmac("sha256", signingSecret).update(body).digest("hex");

let deliveryCounter = 0;

type RequestOptions = {
  readonly delivery?: string;
  readonly includeTimestampHeader?: boolean;
  readonly body?: string;
  readonly signature?: string;
  readonly method?: string;
  readonly url?: string;
};

export const signedRequest = (
  payload: Record<string, unknown>,
  options: RequestOptions = {},
): Request => {
  const body = options.body ?? JSON.stringify(payload);
  const delivery =
    options.delivery ??
    `${typeof payload.webhookId === "string" ? payload.webhookId : "delivery"}-${++deliveryCounter}`;
  const headers = new Headers({
    "content-type": "application/json",
    "linear-signature": options.signature ?? sign(body),
    "linear-delivery": delivery,
  });
  if (options.includeTimestampHeader) {
    headers.set("linear-timestamp", String(payload.webhookTimestamp));
  }
  return new Request(
    options.url ?? "https://gateway.example.com/webhooks/linear",
    {
      method: options.method ?? "POST",
      headers,
      body,
    },
  );
};

type InstallationOverrides = {
  readonly organizationId?: OrganizationId;
  readonly appUserId?: AppUserId;
  readonly revokedAt?: Option.Option<number>;
  readonly accessibleTeamIds?: Option.Option<ReadonlyArray<TeamId>>;
  readonly canAccessAllPublicTeams?: Option.Option<boolean>;
};

export const install = (overrides: InstallationOverrides = {}) =>
  Effect.gen(function* () {
    const installationRepo = yield* InstallationRepo;
    const installation: Installation = {
      organizationId: overrides.organizationId ?? organizationId("org"),
      appUserId: overrides.appUserId ?? appUserId("app-user"),
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1_060_000,
      scopes: ["read", "write", "app:assignable", "app:mentionable"],
      revokedAt: overrides.revokedAt ?? Option.none(),
      accessibleTeamIds:
        overrides.accessibleTeamIds ?? Option.some([teamId("team-a")]),
      canAccessAllPublicTeams:
        overrides.canAccessAllPublicTeams ?? Option.some(false),
    };
    yield* installationRepo.put(installation);
  });

export const agentSessionBase = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "session-1",
  appUserId: "app-user",
  organizationId: "org",
  status: "pending",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  ...overrides,
});

export const createdPayload = (
  now: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "AgentSessionEvent",
  action: "created",
  organizationId: "org",
  appUserId: "app-user",
  oauthClientId: "client",
  webhookId: "webhook-config",
  webhookTimestamp: now,
  promptContext: "Implement the issue",
  guidance: [{ body: "Use TypeScript" }, { body: "Write tests" }],
  previousComments: [{ body: "Earlier comment" }],
  agentSession: agentSessionBase({
    issueId: "issue-1",
    issue: {
      id: "issue-1",
      title: "Fix the bug",
      description: "The bug description",
      identifier: "TEAM-123",
      url: "https://linear.app/issue/TEAM-123",
      teamId: "team-a",
      projectId: "project-1",
    },
    comment: { id: "comment-1", body: "A thread comment" },
  }),
  ...overrides,
});

export const promptedPayload = (
  now: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "AgentSessionEvent",
  action: "prompted",
  organizationId: "org",
  appUserId: "app-user",
  oauthClientId: "client",
  webhookId: "webhook-config",
  webhookTimestamp: now,
  agentActivity: {
    id: "activity-prompt-1",
    agentSessionId: "session-1",
    content: {
      type: "prompt",
      body: "Please add more tests",
      title: "Follow-up prompt",
    },
  },
  agentSession: agentSessionBase({
    status: "active",
    updatedAt: "2024-01-01T00:00:01.000Z",
  }),
  ...overrides,
});

export const stopPayload = (
  now: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "AgentSessionEvent",
  action: "stop",
  organizationId: "org",
  appUserId: "app-user",
  oauthClientId: "client",
  webhookId: "webhook-config",
  webhookTimestamp: now,
  agentActivity: {
    id: "activity-stop-1",
    agentSessionId: "session-1",
    content: { type: "prompt", body: "Stop" },
    signal: "stop",
  },
  agentSession: agentSessionBase({
    status: "active",
    updatedAt: "2024-01-01T00:00:02.000Z",
    issueId: "issue-1",
    issue: { id: "issue-1", title: "Fix the bug", teamId: "team-a" },
  }),
  ...overrides,
});

export const permissionChangePayload = (
  now: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "PermissionChange",
  action: "teamAccessChanged",
  organizationId: "org",
  appUserId: "app-user",
  oauthClientId: "client",
  webhookId: "webhook-config",
  webhookTimestamp: now,
  addedTeamIds: [],
  removedTeamIds: ["team-b"],
  canAccessAllPublicTeams: false,
  ...overrides,
});

export const appUserNotificationPayload = (
  now: number,
  action: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "AppUserNotification",
  action,
  appUserId: "app-user",
  createdAt: "2024-01-01T00:00:00.000Z",
  oauthClientId: "client",
  organizationId: "org",
  webhookId: "notification-webhook",
  webhookTimestamp: now,
  notification: {
    id: "notification-1",
    type: action,
    userId: "app-user",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    issueId: "issue-1",
    issue: {
      id: "issue-1",
      identifier: "TEAM-123",
      team: { id: "team-a", key: "TEAM", name: "Team" },
      teamId: "team-a",
      title: "Fix the bug",
      url: "https://linear.app/issue/TEAM-123",
      description: null,
    },
  },
  ...overrides,
});

export const oauthAppPayload = (
  now: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "OAuthApp",
  action: "revoked",
  organizationId: "org",
  oauthClientId: "client",
  webhookId: "webhook-config",
  webhookTimestamp: now,
  ...overrides,
});

export const currentTime = Clock.currentTimeMillis;

export const expectSome = <A>(value: Option.Option<A>): A | undefined => {
  expect(Option.isSome(value)).toBe(true);

  return Option.isSome(value) ? value.value : undefined;
};
