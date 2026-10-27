import { Effect, Option, Result, Schema } from "effect";
import { McpServerId, WorkspaceId } from "../domain/ids.js";
import type { AdminContext } from "./admin-context.js";
import { AdminError, tokenHash } from "./admin-core.js";
import { mcpServerPayload, toApiMcpServer } from "./admin-payloads.js";
import { emptyResponse, json, parseJsonBody, text } from "./admin-responses.js";

export const mcpRoutes = (context: AdminContext) =>
  Effect.gen(function* () {
    const { deps, request, now, url, requireSession, requireMutation } =
      context;
    if (
      url.pathname === "/api/admin/mcp-servers" &&
      request.method === "POST"
    ) {
      const session = yield* requireMutation(request);
      const body = yield* parseJsonBody(request);
      const payloadEither = mcpServerPayload(body);
      if (Result.isFailure(payloadEither))
        return Option.some(text(payloadEither.failure, 400));
      const payload = payloadEither.success;
      const repositoryId =
        payload.repositoryId === null
          ? Option.none<WorkspaceId>()
          : yield* Schema.decodeUnknownEffect(WorkspaceId)(payload.repositoryId)
              .pipe(
                Effect.catchTags({
                  SchemaError: () =>
                    Effect.fail(
                      new AdminError({
                        message: "Invalid repository id",
                        status: 400,
                      }),
                    ),
                }),
              )
              .pipe(Effect.map(Option.some));
      const id = yield* Schema.decodeUnknownEffect(McpServerId)(
        payload.id,
      ).pipe(
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
      const oauthClient =
        payload.oauthClientId === null && payload.oauthScope === null
          ? null
          : {
              ...(payload.oauthClientId !== null
                ? { clientId: payload.oauthClientId }
                : {}),
              ...(payload.oauthClientSecret !== null
                ? { clientSecret: payload.oauthClientSecret }
                : {}),
              ...(payload.oauthScope !== null
                ? { scope: payload.oauthScope }
                : {}),
              ...(payload.oauthTokenEndpointAuthMethod !== null
                ? {
                    tokenEndpointAuthMethod:
                      payload.oauthTokenEndpointAuthMethod,
                  }
                : {}),
            };
      const server = yield* deps.mcpServerRepo.createMcpServer({
        organizationId: session.organizationId,
        id,
        name: payload.name,
        transport: payload.transport,
        command: payload.command,
        args: payload.args,
        url: payload.url,
        env: payload.env,
        headers: payload.headers,
        oauthClient,
        repositoryId,
        enabled: payload.enabled ?? true,
        now,
      });
      return Option.some(json({ mcpServer: toApiMcpServer(server) }, 201));
    }

    const mcpOauthConnect =
      /^\/api\/admin\/mcp-servers\/([^/]+)\/oauth\/connect$/u.exec(
        url.pathname,
      );
    if (mcpOauthConnect !== null && request.method === "POST") {
      const session = yield* requireMutation(request);
      const rawId = mcpOauthConnect[1];
      if (rawId === undefined) return Option.some(text("Not found", 404));
      const id = yield* Schema.decodeUnknownEffect(McpServerId)(
        decodeURIComponent(rawId),
      ).pipe(
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
      const server = yield* deps.mcpServerRepo.getMcpServer(
        session.organizationId,
        id,
      );
      if (Option.isNone(server)) return Option.some(text("Not found", 404));
      const oauth = Option.isSome(server)
        ? server.value.oauthClient
        : undefined;
      const result = yield* deps.mcpOAuth
        .startMcpAuthorization(
          session.organizationId,
          id,
          oauth?.clientId !== undefined
            ? {
                clientId: oauth.clientId,
                ...(oauth.clientSecret !== undefined
                  ? { clientSecret: oauth.clientSecret }
                  : {}),
                ...(oauth.scope !== undefined ? { scope: oauth.scope } : {}),
                ...(oauth.tokenEndpointAuthMethod !== undefined
                  ? {
                      tokenEndpointAuthMethod: oauth.tokenEndpointAuthMethod,
                    }
                  : {}),
              }
            : undefined,
          oauth?.scope,
          tokenHash(session.rawToken),
        )
        .pipe(
          Effect.catchTag("@Gateway/McpOAuthError", (error) =>
            Effect.fail(
              new AdminError({
                message: `MCP OAuth setup failed (${error.reason}): ${error.message}`,
                status: 400,
              }),
            ),
          ),
        );
      return Option.some(json({ authorizationUrl: result.url.toString() }));
    }
    const mcpOauthDisconnect =
      /^\/api\/admin\/mcp-servers\/([^/]+)\/oauth\/disconnect$/u.exec(
        url.pathname,
      );
    if (mcpOauthDisconnect !== null && request.method === "POST") {
      const session = yield* requireMutation(request);
      const rawId = mcpOauthDisconnect[1];
      if (rawId === undefined) return Option.some(text("Not found", 404));
      const id = yield* Schema.decodeUnknownEffect(McpServerId)(
        decodeURIComponent(rawId),
      ).pipe(
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
      yield* deps.mcpOAuth.disconnect(session.organizationId, id);
      return Option.some(json({ disconnected: true }));
    }
    if (url.pathname.startsWith("/api/admin/mcp-servers/")) {
      const rawId = decodeURIComponent(
        url.pathname.slice("/api/admin/mcp-servers/".length),
      );
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
      if (request.method === "GET") {
        const session = yield* requireSession(request);
        const server = yield* deps.mcpServerRepo.getMcpServer(
          session.organizationId,
          id,
        );
        if (Option.isNone(server)) return Option.some(text("Not found", 404));
        const statuses = yield* deps.mcpOAuth.listStatuses(
          session.organizationId,
        );
        return Option.some(
          json({
            mcpServer: toApiMcpServer(
              server.value,
              (() => {
                const status = statuses.get(id);
                const url = Option.getOrElse(server.value.url, () => null);
                return status !== undefined && status.serverUrl === url
                  ? status
                  : undefined;
              })(),
            ),
          }),
        );
      }
      if (request.method === "PUT") {
        const session = yield* requireMutation(request);
        const body = yield* parseJsonBody(request);
        const payloadEither = mcpServerPayload(body);
        if (Result.isFailure(payloadEither))
          return Option.some(text(payloadEither.failure, 400));
        const payload = payloadEither.success;
        if (payload.id !== id)
          return Option.some(
            text("MCP server id in body does not match path", 400),
          );
        const current = yield* deps.mcpServerRepo.getMcpServer(
          session.organizationId,
          id,
        );
        if (Option.isNone(current)) return Option.some(text("Not found", 404));
        const repositoryId =
          payload.repositoryId === null
            ? Option.none<WorkspaceId>()
            : yield* Schema.decodeUnknownEffect(WorkspaceId)(
                payload.repositoryId,
              )
                .pipe(
                  Effect.catchTags({
                    SchemaError: () =>
                      Effect.fail(
                        new AdminError({
                          message: "Invalid repository id",
                          status: 400,
                        }),
                      ),
                  }),
                )
                .pipe(Effect.map(Option.some));
        const env: Record<string, string> =
          body.env === undefined ? { ...current.value.env } : {};
        if (body.env !== undefined) {
          for (const [key, value] of Object.entries(payload.env)) {
            const preserved = current.value.env[key];
            env[key] =
              value === "•••" && preserved !== undefined ? preserved : value;
          }
        }
        const headers: Record<string, string> =
          body.headers === undefined ? { ...current.value.headers } : {};
        if (body.headers !== undefined) {
          for (const [key, value] of Object.entries(payload.headers)) {
            const preserved = current.value.headers[key];
            headers[key] =
              value === "•••" && preserved !== undefined ? preserved : value;
          }
        }
        const oauthClient =
          body.oauthClientId === undefined
            ? (current.value.oauthClient ?? null)
            : payload.oauthClientId === null && payload.oauthScope === null
              ? null
              : {
                  ...(payload.oauthClientId !== null
                    ? { clientId: payload.oauthClientId }
                    : {}),
                  ...(payload.oauthClientSecret !== null &&
                  payload.oauthClientSecret !== "•••"
                    ? { clientSecret: payload.oauthClientSecret }
                    : current.value.oauthClient?.clientId ===
                          payload.oauthClientId &&
                        current.value.oauthClient?.clientSecret !== undefined
                      ? {
                          clientSecret: current.value.oauthClient.clientSecret,
                        }
                      : {}),
                  ...(payload.oauthScope !== null
                    ? { scope: payload.oauthScope }
                    : body.oauthScope === undefined &&
                        current.value.oauthClient?.clientId ===
                          payload.oauthClientId &&
                        current.value.oauthClient?.scope !== undefined
                      ? { scope: current.value.oauthClient.scope }
                      : {}),
                  ...(payload.oauthTokenEndpointAuthMethod !== null
                    ? {
                        tokenEndpointAuthMethod:
                          payload.oauthTokenEndpointAuthMethod,
                      }
                    : body.oauthTokenEndpointAuthMethod === undefined &&
                        current.value.oauthClient?.clientId ===
                          payload.oauthClientId &&
                        current.value.oauthClient?.tokenEndpointAuthMethod !==
                          undefined
                      ? {
                          tokenEndpointAuthMethod:
                            current.value.oauthClient.tokenEndpointAuthMethod,
                        }
                      : {}),
                };
        const previousOAuthClient = current.value.oauthClient ?? null;
        const oauthClientChanged =
          previousOAuthClient?.clientId !== oauthClient?.clientId ||
          previousOAuthClient?.clientSecret !== oauthClient?.clientSecret ||
          previousOAuthClient?.scope !== oauthClient?.scope ||
          previousOAuthClient?.tokenEndpointAuthMethod !==
            oauthClient?.tokenEndpointAuthMethod;
        const previousUrl = Option.getOrNull(current.value.url);
        const oauthCredentialInvalidated =
          oauthClientChanged || previousUrl !== payload.url;
        if (oauthCredentialInvalidated) {
          yield* deps.mcpOAuth.disconnect(session.organizationId, id);
        }
        const server = yield* deps.mcpServerRepo.updateMcpServer(
          session.organizationId,
          id,
          {
            name: payload.name,
            transport: payload.transport,
            command: payload.command,
            args: payload.args,
            url: payload.url,
            env,
            headers,
            oauthClient,
            enabled: payload.enabled,
            repositoryId,
            now,
          },
        );

        return Option.some(json({ mcpServer: toApiMcpServer(server) }));
      }
      if (request.method === "DELETE") {
        const session = yield* requireMutation(request);
        const deleted = yield* deps.mcpServerRepo.deleteMcpServer(
          session.organizationId,
          id,
        );
        return deleted
          ? Option.some(emptyResponse(204))
          : Option.some(text("Not found", 404));
      }
    }

    return Option.none<Response>();
  });
