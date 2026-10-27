import { randomBytes } from "node:crypto";
import { Clock, Context, Effect, Layer, Option } from "effect";
import type { DatabaseError } from "../domain/errors.js";
import type { OrganizationId } from "../domain/ids.js";
import { createAdminContext } from "./admin-context.js";
import {
  type AdminDeps,
  csrfHash,
  deriveCsrfToken,
  SEVEN_DAYS_MS,
  tokenHash,
} from "./admin-core.js";
import { mapCauseToResponse } from "./admin-responses.js";
import { mcpRoutes } from "./admin-routes-mcp.js";
import { nativeBuildersRoutes } from "./admin-routes-native-builders.js";
import { pagesRoutes } from "./admin-routes-pages.js";
import { repositoriesRoutes } from "./admin-routes-repositories.js";
import { rerunRoutes } from "./admin-routes-rerun.js";
import { settingsRoutes } from "./admin-routes-settings.js";
import { GatewayConfig } from "./config.js";
import { Executor } from "./executor.js";
import { LinearGateway } from "./linear-gateway.js";
import { McpOAuth } from "./mcp-oauth.js";
import { NativeBuildFleet } from "./native-build-fleet.js";
import { NixEnvironment } from "./nix-environment.js";
import { Reconciler } from "./reconciler.js";
import {
  AdminSessionRepo,
  AgentSettingsRepo,
  ExecutorInstanceRepo,
  InstallationRepo,
  McpServerRepo,
  PromptTemplateRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "./store/repositories.js";
import { Workspace } from "./workspace.js";

export type {
  AdminDeps,
  ReconcilerShape,
  WorkspaceShape,
} from "./admin-core.js";
export {
  clearAdminCookie,
  csrfHash,
  deriveCsrfToken,
  rerunIssueGateCount,
  setAdminCookie,
  tokenHash,
  withRerunIssueGate,
} from "./admin-core.js";
export { toApiMcpServer, toApiRepository } from "./admin-payloads.js";
export const createAdminHandle = (deps: AdminDeps) =>
  Effect.fn("Admin.handle")(
    function* (request: Request) {
      const now = yield* Clock.currentTimeMillis;
      const url = new URL(request.url);
      const context = createAdminContext(deps, request, now, url);
      const nativeBuilders = yield* nativeBuildersRoutes(context);
      if (Option.isSome(nativeBuilders)) return nativeBuilders;
      const pages = yield* pagesRoutes(context);
      if (Option.isSome(pages)) return pages;
      const rerun = yield* rerunRoutes(context);
      if (Option.isSome(rerun)) return rerun;
      const settings = yield* settingsRoutes(context);
      if (Option.isSome(settings)) return settings;
      const mcp = yield* mcpRoutes(context);
      if (Option.isSome(mcp)) return mcp;
      const repositories = yield* repositoriesRoutes(context);
      if (Option.isSome(repositories)) return repositories;
      return Option.none<Response>();
    },
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.succeed(mapCauseToResponse(cause))),
      ),
  );

export const createAdminSession = (
  deps: Pick<AdminDeps, "config" | "adminSessionRepo">,
  organizationId: OrganizationId,
  now = Date.now(),
): Effect.Effect<
  { readonly token: string; readonly csrf: string; readonly expiresAt: number },
  DatabaseError
> =>
  Effect.gen(function* () {
    const token = randomBytes(32).toString("base64url");
    const csrf = deriveCsrfToken(token);
    const expiresAt = now + SEVEN_DAYS_MS;
    yield* deps.adminSessionRepo.create({
      organizationId,
      tokenHash: tokenHash(token),
      csrfTokenHash: csrfHash(csrf),
      expiresAt,
      now,
    });
    return { token, csrf, expiresAt };
  });

export class Admin extends Context.Service<Admin>()("Admin", {
  make: Effect.gen(function* () {
    const config = yield* GatewayConfig;
    const adminSessionRepo = yield* AdminSessionRepo;
    const executorInstanceRepo = yield* ExecutorInstanceRepo;
    const executor = yield* Executor;
    const installationRepo = yield* InstallationRepo;
    const runRepo = yield* RunRepo;
    const runEventRepo = yield* RunEventRepo;
    const workspaceRepo = yield* WorkspaceRepo;
    const mcpServerRepo = yield* McpServerRepo;
    const mcpOAuth = yield* McpOAuth;
    const promptTemplateRepo = yield* PromptTemplateRepo;
    const agentSettingsRepo = yield* AgentSettingsRepo;
    const workspace = yield* Workspace;
    const reconciler = yield* Reconciler;
    const nixEnvironment = yield* NixEnvironment;
    const runInputRepo = yield* RunInputRepo;
    const linearGateway = yield* LinearGateway;
    const nativeBuilders = yield* Effect.serviceOption(NativeBuildFleet);
    const handle = createAdminHandle({
      ...(Option.isSome(nativeBuilders)
        ? { nativeBuilders: nativeBuilders.value }
        : {}),
      config,
      adminSessionRepo,
      executorInstanceRepo,
      executor,
      installationRepo,
      runRepo,
      runEventRepo,
      runInputRepo,
      linearGateway,
      workspaceRepo,
      promptTemplateRepo,
      agentSettingsRepo,
      mcpServerRepo,
      workspace,
      mcpOAuth,
      reconciler,
      nixEnvironment,
    });
    return { handle };
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide([
      GatewayConfig.layer,
      AdminSessionRepo.layer,
      InstallationRepo.layer,
      ExecutorInstanceRepo.layer,
      Executor.layer,
      RunRepo.layer,
      RunEventRepo.layer,
      RunInputRepo.layer,
      LinearGateway.layer,
      WorkspaceRepo.layer,
      PromptTemplateRepo.layer,
      AgentSettingsRepo.layer,
      McpServerRepo.layer,
      McpOAuth.layer,
      Workspace.layer,
      Reconciler.layer,
      NixEnvironment.layer,
    ]),
  );
}
