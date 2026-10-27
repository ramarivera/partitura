import { randomBytes } from "node:crypto";
import { Clock, Context, Deferred, Effect, Layer, Option, Ref } from "effect";
import {
  DatabaseError,
  McpOAuthError,
  OAuthStateError,
  type RowDecodeError,
  type TokenCipherError,
  TokenRefreshError,
} from "../domain/errors.js";
import type { McpServerId, OrganizationId } from "../domain/ids.js";
import { GatewayConfig } from "./config.js";
import {
  buildMcpAuthorizeUrl,
  CredentialRow,
  callbackUri,
  createPkceVerifier,
  decodeStoredJson,
  decryptValue,
  discoverMcpOAuthMetadataEffect,
  encrypted,
  hash,
  isLoopbackHost,
  MCP_OAUTH_STATE_TTL_MS,
  McpOAuthClientMetadataSchema,
  type McpOAuthToken,
  type McpOAuthTokenEndpointAuthMethod,
  redeemCode,
  refreshAccessToken,
  registerClient,
  StateRow,
  type StoredMcpOAuthCredential,
} from "./mcp-oauth-protocol.js";
import { makeMcpOAuthListStatuses } from "./mcp-oauth-status.js";
import { McpServerRepo } from "./store/repositories.js";
import {
  decodeRow,
  runChanges,
  SqliteClient,
  transact,
  tryDb,
} from "./store/sqlite-client.js";
import { TokenCrypto } from "./token-crypto.js";
import { tokenContext } from "./token-migration.js";

export class McpOAuth extends Context.Service<McpOAuth>()("McpOAuth", {
  make: Effect.gen(function* () {
    const config = yield* GatewayConfig;
    const mcpServerRepo = yield* McpServerRepo;
    const tokenCrypto = yield* TokenCrypto;
    const sqlite = yield* SqliteClient;
    const { db } = sqlite;
    const refreshState = yield* Ref.make(
      new Map<
        string,
        Deferred.Deferred<
          McpOAuthToken,
          DatabaseError | RowDecodeError | TokenCipherError | TokenRefreshError
        >
      >(),
    );

    const startMcpAuthorization = Effect.fn("McpOAuth.startMcpAuthorization")(
      function* (
        organizationId: OrganizationId,
        serverId: McpServerId,
        preRegisteredClient?: {
          readonly clientId: string;
          readonly clientSecret?: string;
          readonly scope?: string;
          readonly tokenEndpointAuthMethod?:
            | McpOAuthTokenEndpointAuthMethod
            | undefined;
        },
        requestedScope?: string,
        adminSessionHash?: string,
      ) {
        if (adminSessionHash === undefined) {
          return yield* Effect.fail(
            new OAuthStateError({
              message: "MCP OAuth requires an authenticated admin session",
            }),
          );
        }
        const server = yield* mcpServerRepo.getMcpServer(
          organizationId,
          serverId,
        );
        if (
          Option.isNone(server) ||
          Option.isNone(server.value.url) ||
          server.value.transport === "stdio"
        ) {
          return yield* Effect.fail(
            new DatabaseError({
              message: "MCP server is not an OAuth-capable HTTP/SSE server",
            }),
          );
        }
        if (!server.value.enabled) {
          return yield* Effect.fail(
            new McpOAuthError({
              message: "MCP server is disabled",
              reason: "server_disabled",
            }),
          );
        }
        const serverUrl = server.value.url.value;
        const resourceUrl = new URL(serverUrl);
        if (
          resourceUrl.protocol !== "https:" &&
          !(
            resourceUrl.protocol === "http:" &&
            config.mcpOAuthAllowLoopbackHttp === true &&
            isLoopbackHost(resourceUrl.hostname)
          )
        ) {
          return yield* Effect.fail(
            new McpOAuthError({
              message:
                "MCP OAuth requires an HTTPS resource URL (HTTP is only allowed for loopback development)",
              reason: "resource_validation",
            }),
          );
        }
        const scope = requestedScope ?? preRegisteredClient?.scope;
        const redirectUri = callbackUri(config.publicUrl);
        const discovered = yield* discoverMcpOAuthMetadataEffect(
          serverUrl,
          fetch,
          { allowLoopbackHttp: config.mcpOAuthAllowLoopbackHttp },
        );
        const client = preRegisteredClient
          ? {
              ...preRegisteredClient,
              authorizationEndpoint: discovered.authorizationEndpoint,
              tokenEndpoint: discovered.tokenEndpoint,
              ...(discovered.registrationEndpoint
                ? { registrationEndpoint: discovered.registrationEndpoint }
                : {}),
            }
          : yield* registerClient(discovered, redirectUri, fetch, scope, {
              allowLoopbackHttp: config.mcpOAuthAllowLoopbackHttp,
            });
        const state = randomBytes(32).toString("base64url");
        const verifier = createPkceVerifier();
        const now = yield* Clock.currentTimeMillis;
        const encryptedClient = yield* tokenCrypto.encrypt(
          JSON.stringify(client),
          tokenContext(
            "mcp_oauth_state",
            organizationId,
            hash(state),
            "client_json",
          ),
        );
        const encryptedVerifier = yield* tokenCrypto.encrypt(
          verifier,
          tokenContext(
            "mcp_oauth_state",
            organizationId,
            hash(state),
            "code_verifier",
          ),
        );
        yield* tryDb(
          () =>
            db
              .query(
                "DELETE FROM mcp_oauth_state WHERE consumed_at IS NOT NULL OR expires_at < ?",
              )
              .run(now),
          "McpOAuth.startMcpAuthorization.prune",
        );
        yield* tryDb(
          () =>
            db
              .query(
                "DELETE FROM mcp_oauth_state WHERE organization_id = ? AND server_id = ? AND consumed_at IS NULL",
              )
              .run(organizationId, serverId),
          "McpOAuth.startMcpAuthorization.invalidate",
        );
        yield* tryDb(
          () =>
            db
              .query(
                "INSERT INTO mcp_oauth_state (state_hash, organization_id, server_id, server_url, admin_session_hash, code_verifier, redirect_uri, client_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              )
              .run(
                hash(state),
                organizationId,
                serverId,
                serverUrl,
                adminSessionHash,
                encrypted(encryptedVerifier),
                redirectUri,
                encrypted(encryptedClient),
                now + MCP_OAUTH_STATE_TTL_MS,
              ),
          "McpOAuth.startMcpAuthorization",
        );
        return {
          state,
          url: buildMcpAuthorizeUrl({
            client,
            redirectUri,
            state,
            codeVerifier: verifier,
            ...(scope ? { scope } : {}),
            resource: serverUrl,
          }),
        };
      },
    );
    const completeMcpAuthorization = Effect.fn(
      "McpOAuth.completeMcpAuthorization",
    )(function* (callbackUrl: URL, adminSessionHash?: string) {
      const state = callbackUrl.searchParams.get("state");
      const oauthError = callbackUrl.searchParams.get("error");
      if (!state) {
        return yield* Effect.fail(
          new OAuthStateError({
            message: oauthError
              ? `MCP OAuth authorization failed: ${oauthError} (missing state)`
              : "Missing MCP OAuth code or state",
          }),
        );
      }
      const now = yield* Clock.currentTimeMillis;
      const rawRow = yield* tryDb(
        () =>
          db
            .query<StateRow, [string, number]>(
              "SELECT state_hash, organization_id, server_id, server_url, admin_session_hash, code_verifier, redirect_uri, client_json, expires_at FROM mcp_oauth_state WHERE state_hash = ? AND consumed_at IS NULL AND expires_at >= ?",
            )
            .get(hash(state), now),
        "McpOAuth.completeMcpAuthorization.state",
      );
      if (rawRow === null) {
        return yield* Effect.fail(
          new OAuthStateError({
            message: "Invalid or expired MCP OAuth state",
          }),
        );
      }
      const row = yield* decodeRow(StateRow, rawRow, "McpOAuthState");
      if (
        row.admin_session_hash !== null &&
        row.admin_session_hash !== adminSessionHash
      ) {
        return yield* Effect.fail(
          new OAuthStateError({
            message: "MCP OAuth state does not belong to this admin session",
          }),
        );
      }
      if (oauthError !== null) {
        const consumed = yield* tryDb(
          () =>
            db
              .query(
                "UPDATE mcp_oauth_state SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL AND expires_at >= ?",
              )
              .run(now, hash(state), now),
          "McpOAuth.completeMcpAuthorization.error.consume",
        );
        if (
          (yield* runChanges(
            consumed,
            "McpOAuth.completeMcpAuthorization.error.consume",
          )) !== 1
        ) {
          return yield* Effect.fail(
            new OAuthStateError({
              message: "Invalid or expired MCP OAuth state",
            }),
          );
        }
        const description =
          callbackUrl.searchParams.get("error_description") ?? oauthError;
        return yield* Effect.fail(
          new OAuthStateError({
            message: `MCP OAuth authorization failed: ${description}`,
          }),
        );
      }
      const code = callbackUrl.searchParams.get("code");
      if (!code) {
        return yield* Effect.fail(
          new OAuthStateError({ message: "Missing MCP OAuth code or state" }),
        );
      }
      const client = yield* decodeStoredJson(
        McpOAuthClientMetadataSchema,
        yield* decryptValue(
          tokenCrypto,
          row.client_json,
          tokenContext(
            "mcp_oauth_state",
            row.organization_id,
            row.state_hash,
            "client_json",
          ),
        ),
        "McpOAuth.completeMcpAuthorization.client",
      );
      const verifier = yield* decryptValue(
        tokenCrypto,
        row.code_verifier,
        tokenContext(
          "mcp_oauth_state",
          row.organization_id,
          row.state_hash,
          "code_verifier",
        ),
      );
      yield* transact(
        db,
        Effect.gen(function* () {
          const consumed = yield* tryDb(
            () =>
              db
                .query(
                  "UPDATE mcp_oauth_state SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL AND expires_at >= ?",
                )
                .run(now, hash(state), now),
            "McpOAuth.completeMcpAuthorization.consume",
          );
          if (
            (yield* runChanges(
              consumed,
              "McpOAuth.completeMcpAuthorization.consume",
            )) !== 1
          )
            return yield* Effect.fail(
              new OAuthStateError({
                message: "Invalid or expired MCP OAuth state",
              }),
            );
          yield* tryDb(
            () =>
              db
                .query(
                  "DELETE FROM mcp_oauth_state WHERE consumed_at IS NOT NULL OR expires_at < ?",
                )
                .run(now),
            "McpOAuth.completeMcpAuthorization.prune",
          );
        }),
      );
      const token = yield* redeemCode(
        client,
        code,
        row.redirect_uri,
        verifier,
        fetch,
        now,
        row.server_url,
        { allowLoopbackHttp: config.mcpOAuthAllowLoopbackHttp },
      );
      const result = yield* transact(
        db,
        Effect.gen(function* () {
          const currentServer = yield* mcpServerRepo.getMcpServer(
            row.organization_id as OrganizationId,
            row.server_id as McpServerId,
          );
          if (
            Option.isNone(currentServer) ||
            !currentServer.value.enabled ||
            currentServer.value.transport === "stdio" ||
            Option.isNone(currentServer.value.url) ||
            currentServer.value.url.value !== row.server_url
          ) {
            return yield* Effect.fail(
              new McpOAuthError({
                message:
                  "MCP server was removed, disabled, or changed while OAuth was in progress",
                reason: "server_validation",
              }),
            );
          }
          const accessToken = yield* tokenCrypto.encrypt(
            token.accessToken,
            tokenContext(
              "mcp_oauth_credential",
              row.organization_id,
              row.server_id,
              "access_token",
            ),
          );
          const refreshToken = token.refreshToken
            ? yield* tokenCrypto.encrypt(
                token.refreshToken,
                tokenContext(
                  "mcp_oauth_credential",
                  row.organization_id,
                  row.server_id,
                  "refresh_token",
                ),
              )
            : null;
          const encryptedClient = encrypted(
            yield* tokenCrypto.encrypt(
              JSON.stringify(client),
              tokenContext(
                "mcp_oauth_credential",
                row.organization_id,
                row.server_id,
                "client_json",
              ),
            ),
          );
          yield* tryDb(
            () =>
              db
                .query(
                  "INSERT INTO mcp_oauth_credential (organization_id, server_id, server_url, client_json, access_token, refresh_token, expires_at, token_type, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(organization_id, server_id) DO UPDATE SET server_url=excluded.server_url, client_json=excluded.client_json, access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, token_type=excluded.token_type, scope=excluded.scope, updated_at=excluded.updated_at",
                )
                .run(
                  row.organization_id,
                  row.server_id,
                  row.server_url,
                  encryptedClient,
                  encrypted(accessToken),
                  refreshToken ? encrypted(refreshToken) : null,
                  token.expiresAt,
                  token.tokenType ?? null,
                  token.scope ?? null,
                  now,
                  now,
                ),
            "McpOAuth.completeMcpAuthorization.credential",
          );
          return {
            organizationId: row.organization_id as OrganizationId,
            serverId: row.server_id as McpServerId,
            expiresAt: token.expiresAt,
          };
        }),
      );
      return result;
    });

    const disconnect = Effect.fn("McpOAuth.disconnect")(
      (organizationId: OrganizationId, serverId: McpServerId) =>
        transact(
          db,
          Effect.gen(function* () {
            yield* tryDb(
              () =>
                db
                  .query(
                    "DELETE FROM mcp_oauth_credential WHERE organization_id = ? AND server_id = ?",
                  )
                  .run(organizationId, serverId),
              "McpOAuth.disconnect.credential",
            );
            yield* tryDb(
              () =>
                db
                  .query(
                    "DELETE FROM mcp_oauth_state WHERE organization_id = ? AND server_id = ? AND consumed_at IS NULL",
                  )
                  .run(organizationId, serverId),
              "McpOAuth.disconnect.state",
            );
          }),
        ),
    );

    const getCredentialDetails = Effect.fn("McpOAuth.getCredentialDetails")(
      function* (organizationId: OrganizationId, serverId: McpServerId) {
        const server = yield* mcpServerRepo.getMcpServer(
          organizationId,
          serverId,
        );
        if (Option.isNone(server) || Option.isNone(server.value.url))
          return Option.none<StoredMcpOAuthCredential>();
        const serverUrl = server.value.url.value;
        const row = yield* tryDb(
          () =>
            db
              .query<CredentialRow, [string, string, string]>(
                "SELECT server_url, client_json, access_token, refresh_token, expires_at, token_type, scope, updated_at FROM mcp_oauth_credential WHERE organization_id = ? AND server_id = ? AND server_url = ?",
              )
              .get(organizationId, serverId, serverUrl),
          "McpOAuth.getCredentialDetails",
        );
        if (row === null) return Option.none<StoredMcpOAuthCredential>();
        const decoded = yield* decodeRow(
          CredentialRow,
          row,
          "McpOAuthCredential",
        );
        const accessToken = yield* decryptValue(
          tokenCrypto,
          decoded.access_token,
          tokenContext(
            "mcp_oauth_credential",
            organizationId,
            serverId,
            "access_token",
          ),
        );
        const refreshToken = decoded.refresh_token
          ? yield* decryptValue(
              tokenCrypto,
              decoded.refresh_token,
              tokenContext(
                "mcp_oauth_credential",
                organizationId,
                serverId,
                "refresh_token",
              ),
            )
          : undefined;
        const token: McpOAuthToken = {
          accessToken,
          expiresAt: decoded.expires_at,
          ...(refreshToken ? { refreshToken } : {}),
          ...(decoded.token_type ? { tokenType: decoded.token_type } : {}),
          ...(decoded.scope ? { scope: decoded.scope } : {}),
        };
        const client = yield* decodeStoredJson(
          McpOAuthClientMetadataSchema,
          yield* decryptValue(
            tokenCrypto,
            decoded.client_json,
            tokenContext(
              "mcp_oauth_credential",
              organizationId,
              serverId,
              "client_json",
            ),
          ),
          "McpOAuth.getCredentialDetails.client",
        );
        return Option.some({
          serverUrl: decoded.server_url,
          client,
          token,
          updatedAt: decoded.updated_at,
        });
      },
    );

    const getCredential = Effect.fn("McpOAuth.getCredential")(function* (
      organizationId: OrganizationId,
      serverId: McpServerId,
    ) {
      const details = yield* getCredentialDetails(organizationId, serverId);
      return Option.map(details, (value) => value.token);
    });

    const persistRefreshedToken = (
      organizationId: OrganizationId,
      serverId: McpServerId,
      token: McpOAuthToken,
      now: number,
      expectedUpdatedAt: number,
    ): Effect.Effect<boolean, DatabaseError | TokenCipherError> =>
      Effect.gen(function* () {
        const accessToken = yield* tokenCrypto.encrypt(
          token.accessToken,
          tokenContext(
            "mcp_oauth_credential",
            organizationId,
            serverId,
            "access_token",
          ),
        );
        const refreshToken = token.refreshToken
          ? yield* tokenCrypto.encrypt(
              token.refreshToken,
              tokenContext(
                "mcp_oauth_credential",
                organizationId,
                serverId,
                "refresh_token",
              ),
            )
          : null;
        const result = yield* tryDb(
          () =>
            db
              .query(
                "UPDATE mcp_oauth_credential SET access_token = ?, refresh_token = ?, expires_at = ?, token_type = ?, scope = ?, updated_at = ? WHERE organization_id = ? AND server_id = ? AND updated_at = ?",
              )
              .run(
                encrypted(accessToken),
                refreshToken ? encrypted(refreshToken) : null,
                token.expiresAt,
                token.tokenType ?? null,
                token.scope ?? null,
                now,
                organizationId,
                serverId,
                expectedUpdatedAt,
              ),
          "McpOAuth.persistRefreshedToken",
        );
        return (
          (yield* runChanges(result, "McpOAuth.persistRefreshedToken")) === 1
        );
      });

    const refreshTokens = Effect.fn("McpOAuth.refreshTokens")(function* (
      organizationId: OrganizationId,
      serverId: McpServerId,
      current: StoredMcpOAuthCredential,
      now: number,
    ): Effect.fn.Return<
      McpOAuthToken,
      DatabaseError | RowDecodeError | TokenCipherError | TokenRefreshError
    > {
      const refreshToken = current.token.refreshToken;
      if (refreshToken === undefined) {
        return yield* Effect.fail(
          new DatabaseError({ message: "MCP OAuth refresh token is missing" }),
        );
      }
      const key = `${organizationId}:${serverId}`;
      const mine = yield* Deferred.make<
        McpOAuthToken,
        DatabaseError | RowDecodeError | TokenCipherError | TokenRefreshError
      >();
      const claim = yield* Ref.modify(refreshState, (flights) => {
        const existing = flights.get(key);
        if (existing) return [Option.some(existing), flights] as const;
        const next = new Map(flights);
        next.set(key, mine);
        return [
          Option.none<
            Deferred.Deferred<
              McpOAuthToken,
              | DatabaseError
              | RowDecodeError
              | TokenCipherError
              | TokenRefreshError
            >
          >(),
          next,
        ] as const;
      });
      if (Option.isSome(claim)) return yield* Deferred.await(claim.value);
      // A caller can have read the old row before the previous flight completed.
      // Re-read after claiming, so rotated refresh tokens are never replayed.
      const refresh = Effect.gen(function* () {
        const latest = yield* getCredentialDetails(organizationId, serverId);
        if (Option.isNone(latest))
          return yield* Effect.fail(
            new TokenRefreshError({
              organizationId,
              message: "MCP OAuth credential disconnected while refreshing",
            }),
          );
        if (latest.value.serverUrl !== current.serverUrl)
          return yield* Effect.fail(
            new TokenRefreshError({
              organizationId,
              message: "MCP OAuth credential URL changed while refreshing",
            }),
          );
        if (
          (latest.value.updatedAt !== current.updatedAt ||
            latest.value.token.accessToken !== current.token.accessToken) &&
          latest.value.token.expiresAt > now + 60_000
        )
          return latest.value.token;
        const source = latest.value;
        if (source.token.refreshToken === undefined)
          return yield* Effect.fail(
            new TokenRefreshError({
              organizationId,
              message: "MCP OAuth refresh token is missing",
            }),
          );
        return yield* refreshAccessToken(
          source.client,
          source.token.refreshToken,
          fetch,
          now,
          source.serverUrl,
          { allowLoopbackHttp: config.mcpOAuthAllowLoopbackHttp },
        ).pipe(
          Effect.tap((token) =>
            persistRefreshedToken(
              organizationId,
              serverId,
              token,
              now,
              source.updatedAt,
            ).pipe(
              Effect.flatMap((persisted) =>
                persisted
                  ? Effect.succeed(undefined)
                  : Effect.fail(
                      new TokenRefreshError({
                        organizationId,
                        message:
                          "MCP OAuth credential changed while refreshing; discarded refreshed token",
                      }),
                    ),
              ),
            ),
          ),
        );
      });
      const refreshed = yield* refresh.pipe(
        Effect.tap((token) => Deferred.succeed(mine, token)),
        Effect.tapError((error) => Deferred.fail(mine, error)),
        Effect.onExit((exit) => Deferred.done(mine, exit)),
        Effect.ensuring(
          Ref.update(refreshState, (flights) => {
            const next = new Map(flights);
            next.delete(key);
            return next;
          }),
        ),
      );
      return refreshed;
    });

    const mintCredential = Effect.fn("McpOAuth.mintCredential")(function* (
      organizationId: OrganizationId,
      serverId: McpServerId,
      options: {
        readonly rejectedAccessToken?: string;
        readonly serverUrl?: string;
      } = {},
    ) {
      const details = yield* getCredentialDetails(organizationId, serverId);
      if (Option.isNone(details)) return Option.none<McpOAuthToken>();
      const now = yield* Clock.currentTimeMillis;
      const current = details.value;
      if (
        options.serverUrl !== undefined &&
        options.serverUrl !== current.serverUrl
      )
        return yield* Effect.fail(
          new TokenRefreshError({
            organizationId,
            message:
              "MCP OAuth credential URL no longer matches the worker server",
          }),
        );
      if (
        current.token.expiresAt > now + 60_000 &&
        current.token.accessToken !== options.rejectedAccessToken
      )
        return Option.some(current.token);
      if (current.token.refreshToken === undefined) {
        return yield* Effect.fail(
          new TokenRefreshError({
            organizationId,
            message:
              "MCP OAuth access token expired and no refresh token is available",
          }),
        );
      }
      const token = yield* refreshTokens(
        organizationId,
        serverId,
        current,
        now,
      );
      return Option.some(token);
    });

    const listStatuses = makeMcpOAuthListStatuses(db);

    return {
      startMcpAuthorization,
      completeMcpAuthorization,
      disconnect,
      getCredential,
      getCredentialDetails,
      mintCredential,
      listStatuses,
    };
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide([
      GatewayConfig.layer,
      McpServerRepo.layer,
      TokenCrypto.layer,
    ]),
  );
}
