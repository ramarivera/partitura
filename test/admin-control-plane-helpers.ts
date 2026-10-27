import { ConfigProvider, Effect, Layer, Option, type Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { expect } from "vitest";
import type {
  AppUserId,
  IssueId,
  OrganizationId,
  ProjectId,
  SessionId,
  SourceKey,
  TeamId,
  WorkspaceId,
} from "../src/domain/ids.js";
import { httpApp } from "../src/http/router.js";
import { Admin, createAdminSession } from "../src/services/admin.js";
import { GatewayConfig } from "../src/services/config.js";
import { McpOAuth } from "../src/services/mcp-oauth.js";
import { NativeBuildFleet } from "../src/services/native-build-fleet.js";
import { NixEnvironment } from "../src/services/nix-environment.js";
import { OAuth } from "../src/services/oauth.js";
import { Reconciler } from "../src/services/reconciler.js";
import {
  AdminSessionRepo,
  DeliveryRepo,
  InstallationRepo,
  McpServerRepo,
  NixCacheRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { SqliteClientLive } from "../src/services/store/sqlite-client.js";
import { TokenCrypto } from "../src/services/token-crypto.js";
import { WebhookPipeline } from "../src/services/webhook.js";
import { Workspace } from "../src/services/workspace.js";
import { suitePaths } from "./fixtures/paths.js";

export const suitePath = suitePaths();

export const PUBLIC_URL = "http://localhost:3000";
export const TEST_KEY = Buffer.from(new Uint8Array(32).fill(9)).toString(
  "base64",
);

export const configProvider = ConfigProvider.fromUnknown(
  Object.fromEntries(
    new Map<string, string>([
      ["PUBLIC_URL", PUBLIC_URL],
      ["WORKER_SANDBOX_MODE", "native"],
      ["LINEAR_CLIENT_ID", "client"],
      ["LINEAR_CLIENT_SECRET", "secret"],
      ["LINEAR_WEBHOOK_SECRET", "webhook"],
      ["TOKEN_ENCRYPTION_KEY", TEST_KEY],
      ["DATABASE_PATH", ":memory:"],
      ["WORKSPACE_ROOT", suitePath("gateway-admin-workspaces")],
      ["PORT", "3000"],
      ["OMP_CLI_PATH", "omp"],
      ["LEASE_DURATION_MS", "60000"],
      ["WEBHOOK_REPLAY_WINDOW_MS", "60000"],
      ["LOG_LEVEL", "silent"],
      ["NIX_BINARY_PATH", "nix"],
      [
        "NIXPKGS_FLAKE_REF",
        "github:NixOS/nixpkgs/0123456789abcdef0123456789abcdef01234567",
      ],
      ["NIX_ROOTS_DIR", suitePath("gateway-admin-nix-roots")],
      ["NIX_GC_MAX_BYTES", "1000000"],
    ]),
  ),
  { preserveEmptyStrings: true },
);

export const reconcilerLayer = Layer.succeed(Reconciler, {
  status: () =>
    Effect.succeed({
      running: false,
      lastStartedAt: Option.none(),
      lastCompletedAt: Option.none(),
      lastError: Option.none(),
    }),
  tick: () => Effect.void,
  catchup: () => Effect.void,
  trigger: () => Effect.void,
  awaitTrigger: () => Effect.void,
});

export const withApp = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | Admin
    | AdminSessionRepo
    | DeliveryRepo
    | GatewayConfig
    | InstallationRepo
    | NixCacheRepo
    | NixEnvironment
    | OAuth
    | McpOAuth
    | McpServerRepo
    | RunEventRepo
    | RunInputRepo
    | RunRepo
    | WebhookPipeline
    | Reconciler
    | Workspace
    | WorkspaceRepo
    | Scope.Scope
  >,
  options?: {
    readonly nativeBuilders?: NativeBuildFleet["Service"];
    readonly config?: GatewayConfig["Service"];
  },
) =>
  Effect.gen(function* () {
    yield* Effect.scope;
    const services = Layer.mergeAll(
      options?.config
        ? Layer.succeed(GatewayConfig, options.config)
        : GatewayConfig.layer,
      TokenCrypto.layer,
      AdminSessionRepo.layer,
      DeliveryRepo.layer,
      InstallationRepo.layer,
      OAuth.layer,
      McpOAuth.layer,
      RunEventRepo.layer,
      RunInputRepo.layer,
      McpServerRepo.layer,
      RunRepo.layer,
      WebhookPipeline.layer,
      WorkspaceRepo.layer,
      Workspace.layer,
      NixCacheRepo.layer,
      NixEnvironment.layer,
      Admin.layer,
      reconcilerLayer,
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          SqliteClientLive(":memory:"),
          ConfigProvider.layer(
            options?.config
              ? ConfigProvider.orElse(
                  ConfigProvider.fromUnknown({
                    GATEWAY_ADMIN_ORGANIZATION_IDS: [
                      ...(options.config.gatewayAdminOrganizationIds ?? []),
                    ].join(","),
                  }),
                  configProvider,
                )
              : configProvider,
          ),
          ...(options?.nativeBuilders
            ? [Layer.succeed(NativeBuildFleet, options.nativeBuilders)]
            : []),
        ),
      ),
    );
    return yield* effect.pipe(Effect.provide(services));
  });

export const organizationId = (value: string): OrganizationId =>
  value as OrganizationId;
export const appUserId = (value: string): AppUserId => value as AppUserId;
export const workspaceId = (value: string): WorkspaceId => value as WorkspaceId;
export const teamId = (value: string): TeamId => value as TeamId;
export const projectId = (value: string): ProjectId => value as ProjectId;
export const sessionId = (value: string): SessionId => value as SessionId;
export const issueId = (value: string): IssueId => value as IssueId;
export const sourceKey = (value: string): SourceKey => value as SourceKey;

export const adminRequest = (
  path: string,
  options: {
    readonly method?: string;
    readonly token?: string;
    readonly csrf?: string;
    readonly origin?: string;
    readonly body?: unknown;
  } = {},
): Request => {
  const headers = new Headers();
  if (options.token)
    headers.set("Cookie", `omp_gateway_admin=${options.token}`);
  if (options.csrf) headers.set("X-CSRF-Token", options.csrf);
  if (options.origin) headers.set("Origin", options.origin);
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }
  return new Request(new URL(path, PUBLIC_URL).toString(), init);
};

export const fetchApp = (request: Request) =>
  Effect.gen(function* () {
    const app = yield* httpApp;
    const response = yield* app.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
    );
    return HttpServerResponse.toWeb(response);
  });

export const createSession = (organization: string, now: number) =>
  Effect.gen(function* () {
    const config = yield* GatewayConfig;
    const adminSessionRepo = yield* AdminSessionRepo;
    return yield* createAdminSession(
      { config, adminSessionRepo },
      organizationId(organization),
      now,
    );
  });

export const requireSome = <A>(value: Option.Option<A>): A => {
  expect(Option.isSome(value)).toBe(true);
  if (Option.isSome(value)) return value.value;
  throw new Error("Expected Option.some");
};
