import { Clock, Effect, Option, Schema } from "effect";
import { McpServerId, WorkspaceId } from "../domain/ids.js";
import type { AdminContext } from "./admin-context.js";
import { AdminError, deriveCsrfToken } from "./admin-core.js";
import {
  optionalString,
  toApiMcpServer,
  toApiRepository,
} from "./admin-payloads.js";
import {
  EXECUTOR_ATTACHMENT_PREFIX,
  emptyResponse,
  executorError,
  json,
  parseJsonBody,
  synchronizeExecutorAttachments,
  text,
  toAdminInstallation,
  toApiExecutorInstance,
} from "./admin-responses.js";
import { validateAgentSettings } from "./agent-settings.js";
import { executorUrlForPath } from "./executor.js";
import { promptTemplateWarnings } from "./prompt-templates.js";

export const settingsRoutes = (context: AdminContext) =>
  Effect.gen(function* () {
    const { deps, request, now, url, requireSession, requireMutation } =
      context;
    if (url.pathname === "/api/admin/bootstrap" && request.method === "GET") {
      const session = yield* requireSession(request);
      const installation = yield* deps.installationRepo.get(
        session.organizationId,
      );
      const adminInstallation = Option.match(installation, {
        onNone: () => null,
        onSome: toAdminInstallation,
      });
      const repositories = yield* deps.workspaceRepo.listRepositories(
        session.organizationId,
      );
      const mcpServers = yield* deps.mcpServerRepo.listMcpServers(
        session.organizationId,
      );
      const oauthStatuses = yield* deps.mcpOAuth.listStatuses(
        session.organizationId,
      );
      const executorInstance = yield* deps.executorInstanceRepo.get(
        session.organizationId,
      );
      const agentSettings = yield* deps.agentSettingsRepo.get(
        session.organizationId,
      );
      const reconcilerStatus = yield* deps.reconciler.status();
      return Option.some(
        json({
          health: {
            installation:
              adminInstallation !== null &&
              adminInstallation.revokedAt === null,
            reconciler: reconcilerStatus,
          },
          installation: adminInstallation,
          repositories: repositories.map(toApiRepository),
          executorInstance: Option.match(executorInstance, {
            onNone: () => null,
            onSome: toApiExecutorInstance,
          }),
          agentSettings,
          csrfToken: deriveCsrfToken(session.rawToken),
          mcpServers: mcpServers.map((server) =>
            toApiMcpServer(
              server,
              (() => {
                const status = oauthStatuses.get(server.id);
                const url = Option.getOrElse(server.url, () => null);
                return status !== undefined &&
                  (status.serverUrl === undefined || status.serverUrl === url)
                  ? status
                  : undefined;
              })(),
            ),
          ),
        }),
      );
    }

    if (
      url.pathname === "/api/admin/agent-settings" &&
      request.method === "PUT"
    ) {
      const session = yield* requireMutation(request);
      const payload = yield* parseJsonBody(request);
      const validated = yield* Effect.try({
        try: () => validateAgentSettings(payload),
        catch: (error) =>
          new AdminError({
            message: error instanceof Error ? error.message : String(error),
            status: 400,
          }),
      });
      const settings = yield* deps.agentSettingsRepo.upsert(
        session.organizationId,
        validated,
      );
      return Option.some(json({ settings }));
    }
    if (
      url.pathname === "/api/admin/prompt-templates" &&
      request.method === "GET"
    ) {
      const session = yield* requireSession(request);
      if (deps.promptTemplateRepo === undefined) {
        return Option.some(text("Prompt templates unavailable", 500));
      }
      const templates = yield* deps.promptTemplateRepo.list(
        session.organizationId,
      );
      return Option.some(json({ templates }));
    }
    if (
      url.pathname === "/api/admin/prompt-templates" &&
      request.method === "PUT"
    ) {
      const session = yield* requireMutation(request);
      if (deps.promptTemplateRepo === undefined) {
        return Option.some(text("Prompt templates unavailable", 500));
      }
      const payload = yield* parseJsonBody(request);
      const kind = yield* Schema.decodeUnknownEffect(
        Schema.Literals(["created", "prompted", "contract"]),
      )(payload.kind).pipe(
        Effect.catchTag(
          "SchemaError",
          () =>
            new AdminError({
              message: "Invalid prompt template kind",
              status: 400,
            }),
        ),
      );
      if (typeof payload.body !== "string") {
        return Option.some(text("Prompt template body must be a string", 400));
      }
      const body = payload.body.trim().length === 0 ? "" : payload.body;
      if (new TextEncoder().encode(body).byteLength > 16_384) {
        return Option.some(
          text("Prompt template body exceeds the 16 KiB limit", 400),
        );
      }
      const updatedAt = yield* Clock.currentTimeMillis;
      if (body.length === 0) {
        yield* deps.promptTemplateRepo.remove(session.organizationId, kind);
        return Option.some(
          json({
            template: null,
            warnings: [],
          }),
        );
      }
      yield* deps.promptTemplateRepo.upsert({
        organizationId: session.organizationId,
        kind,
        body,
        updatedAt,
      });
      return Option.some(
        json({
          template: {
            organizationId: session.organizationId,
            kind,
            body,
            updatedAt,
          },
          warnings: promptTemplateWarnings(kind, body),
        }),
      );
    }
    if (
      url.pathname === "/api/admin/executor-instance" &&
      request.method === "GET"
    ) {
      const session = yield* requireSession(request);
      const instance = yield* deps.executorInstanceRepo.get(
        session.organizationId,
      );
      return Option.some(
        json({
          executorInstance: Option.match(instance, {
            onNone: () => null,
            onSome: toApiExecutorInstance,
          }),
        }),
      );
    }
    if (
      url.pathname === "/api/admin/executor-instance" &&
      request.method === "PUT"
    ) {
      const session = yield* requireMutation(request);
      const body = yield* parseJsonBody(request);
      const endpoint = optionalString(body.endpoint);
      if (endpoint === null)
        return Option.some(text("endpoint is required", 400));
      let parsedEndpoint: URL;
      try {
        parsedEndpoint = new URL(endpoint);
      } catch {
        return Option.some(text("endpoint must be a URL", 400));
      }
      if (parsedEndpoint.protocol !== "https:")
        return Option.some(text("endpoint must use https", 400));
      if (
        parsedEndpoint.username ||
        parsedEndpoint.password ||
        parsedEndpoint.search ||
        parsedEndpoint.hash
      )
        return Option.some(
          text(
            "endpoint must not contain credentials, query, or fragment",
            400,
          ),
        );
      const current = yield* deps.executorInstanceRepo.get(
        session.organizationId,
      );
      const rawToken = optionalString(body.token);
      const token =
        rawToken === null || rawToken === "•••"
          ? Option.match(current, {
              onNone: () => null,
              onSome: (entry) => entry.token,
            })
          : rawToken;
      if (token === null) return Option.some(text("token is required", 400));
      const instance = yield* deps.executorInstanceRepo.put({
        organizationId: session.organizationId,
        endpoint: parsedEndpoint.toString().replace(/\/+$/u, ""),
        token,
        updatedAt: now,
      });
      yield* synchronizeExecutorAttachments(
        deps,
        session.organizationId,
        instance.endpoint,
        instance.token,
        now,
      );
      return Option.some(
        json({ executorInstance: toApiExecutorInstance(instance) }),
      );
    }
    if (
      url.pathname === "/api/admin/executor-instance" &&
      request.method === "DELETE"
    ) {
      const session = yield* requireMutation(request);
      yield* deps.executorInstanceRepo.remove(session.organizationId);
      yield* synchronizeExecutorAttachments(
        deps,
        session.organizationId,
        null,
        null,
        now,
      );
      return Option.some(emptyResponse(204));
    }
    if (
      url.pathname === "/api/admin/executor/toolkits" &&
      request.method === "GET"
    ) {
      const session = yield* requireSession(request);
      const toolkits = yield* deps.executor
        .listToolkits(session.organizationId)
        .pipe(Effect.mapError(executorError));
      return Option.some(json({ toolkits }));
    }
    if (
      url.pathname === "/api/admin/executor/attach" &&
      request.method === "POST"
    ) {
      const session = yield* requireMutation(request);
      const body = yield* parseJsonBody(request);
      const slug = optionalString(body.slug);
      if (slug === null) return Option.some(text("slug is required", 400));
      const instance = yield* deps.executorInstanceRepo.get(
        session.organizationId,
      );
      if (Option.isNone(instance))
        return Option.some(text("Executor is not configured", 404));
      const name = `${EXECUTOR_ATTACHMENT_PREFIX}${encodeURIComponent(slug)}:${optionalString(body.name) ?? slug}`;
      const rawId = optionalString(body.id) ?? `executor-${slug}`;
      const id = yield* Schema.decodeUnknownEffect(McpServerId)(rawId).pipe(
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new AdminError({
                message: "Invalid MCP server id",
                status: 400,
              }),
            ),
        }),
      );
      let repositoryId = Option.none<WorkspaceId>();
      if (body.repositoryId !== undefined && body.repositoryId !== null) {
        const value = optionalString(body.repositoryId);
        if (value === null)
          return Option.some(
            text("repositoryId must be a string or null", 400),
          );
        repositoryId = Option.some(
          yield* Schema.decodeUnknownEffect(WorkspaceId)(value).pipe(
            Effect.catchTags({
              SchemaError: () =>
                Effect.fail(
                  new AdminError({
                    message: "Invalid repository id",
                    status: 400,
                  }),
                ),
            }),
          ),
        );
      }
      const server = yield* deps.mcpServerRepo.createMcpServer({
        organizationId: session.organizationId,
        id,
        name,
        transport: "http",
        url: executorUrlForPath(
          instance.value.endpoint,
          `mcp/toolkits/${encodeURIComponent(slug)}`,
        ),
        headers: { Authorization: `Bearer ${instance.value.token}` },
        repositoryId,
        enabled: true,
        now,
      });
      return Option.some(json({ mcpServer: toApiMcpServer(server) }, 201));
    }
    if (
      url.pathname === "/api/admin/repositories" &&
      request.method === "GET"
    ) {
      const session = yield* requireSession(request);
      const repositories = yield* deps.workspaceRepo.listRepositories(
        session.organizationId,
      );
      return Option.some(
        json({ repositories: repositories.map(toApiRepository) }),
      );
    }
    if (url.pathname === "/api/admin/mcp-servers" && request.method === "GET") {
      const session = yield* requireSession(request);
      const oauthStatuses = yield* deps.mcpOAuth.listStatuses(
        session.organizationId,
      );
      const mcpServers = yield* deps.mcpServerRepo.listMcpServers(
        session.organizationId,
      );
      return Option.some(
        json({
          mcpServers: mcpServers.map((server) =>
            toApiMcpServer(
              server,
              (() => {
                const status = oauthStatuses.get(server.id);
                const url = Option.getOrElse(server.url, () => null);
                return status !== undefined &&
                  (status.serverUrl === undefined || status.serverUrl === url)
                  ? status
                  : undefined;
              })(),
            ),
          ),
        }),
      );
    }

    return Option.none<Response>();
  });
