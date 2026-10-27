import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { Effect, Schema } from "effect";
import {
  DatabaseError,
  McpOAuthError,
  type TokenCipherError,
} from "../domain/errors.js";
import { type NetworkPolicy, safeOAuthFetch } from "./safe-http.js";
import type { TokenCrypto } from "./token-crypto.js";

export const MCP_OAUTH_PROVIDER_PREFIX = "mcp_oauth:profile:default:";
export const MCP_OAUTH_ENCRYPTED_PREFIX = "mcpenc:v1:";
export const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp/callback";
export const MCP_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const PKCE_BYTES = 32;
export const NON_EXPIRING_TOKEN_EXPIRES_AT = Number.MAX_SAFE_INTEGER;

export type FetchLike = typeof fetch;

export interface McpOAuthMetadata {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string | undefined;
}

export type McpOAuthTokenEndpointAuthMethod =
  | "none"
  | "client_secret_basic"
  | "client_secret_post";

export interface McpOAuthClientMetadata {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly tokenEndpointAuthMethod?:
    | McpOAuthTokenEndpointAuthMethod
    | undefined;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string | undefined;
}

export interface McpOAuthToken {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresAt: number;
  readonly tokenType?: string | undefined;
  readonly scope?: string | undefined;
}

export interface McpOAuthCredential {
  readonly serverUrl: string;
  readonly client: McpOAuthClientMetadata;
  readonly token: McpOAuthToken;
}
export type StoredMcpOAuthCredential = McpOAuthCredential & {
  readonly updatedAt: number;
};

export const McpOAuthClientMetadataSchema = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.optional(Schema.String),
  tokenEndpointAuthMethod: Schema.optional(
    Schema.Literals(["none", "client_secret_basic", "client_secret_post"]),
  ),
  authorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  registrationEndpoint: Schema.optional(Schema.String),
});
export const ProtectedResourceResponse = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.optional(Schema.Array(Schema.String)),
  authorization_server: Schema.optional(Schema.String),
});
export const AuthorizationServerResponse = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.String),
});
export const RegistrationResponse = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
  token_endpoint_auth_method: Schema.optional(
    Schema.Literals(["none", "client_secret_basic", "client_secret_post"]),
  ),
});
export const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(
    Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  token_type: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
});

export const StateRow = Schema.Struct({
  state_hash: Schema.String,
  organization_id: Schema.String,
  server_id: Schema.String,
  server_url: Schema.String,
  admin_session_hash: Schema.NullOr(Schema.String),
  code_verifier: Schema.String,
  redirect_uri: Schema.String,
  client_json: Schema.String,
  expires_at: Schema.Number,
});
export type StateRow = Schema.Schema.Type<typeof StateRow>;

export const CredentialRow = Schema.Struct({
  server_url: Schema.String,
  client_json: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.NullOr(Schema.String),
  expires_at: Schema.Number,
  token_type: Schema.NullOr(Schema.String),
  scope: Schema.NullOr(Schema.String),
  updated_at: Schema.Number,
});
export type CredentialRow = Schema.Schema.Type<typeof CredentialRow>;

export const StatusRow = Schema.Struct({
  server_id: Schema.String,
  server_url: Schema.String,
  expires_at: Schema.Number,
});
export type StatusRow = Schema.Schema.Type<typeof StatusRow>;

export const hash = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

export const createPkceVerifier = (): string =>
  randomBytes(PKCE_BYTES).toString("base64url");

export const createPkceChallenge = (verifier: string): string => hash(verifier);

export const callbackUri = (publicUrl: URL): string => {
  const base = publicUrl.toString().endsWith("/")
    ? publicUrl.toString()
    : `${publicUrl.toString()}/`;
  const value = new URL(base);
  value.pathname = `${value.pathname.replace(/\/$/u, "")}${MCP_OAUTH_CALLBACK_PATH}`;
  return value.toString();
};

export const discoveryUrl = (base: URL, suffix: string): URL => {
  const value = new URL(base.toString());
  const path = value.pathname === "/" ? "" : value.pathname.replace(/\/$/u, "");
  value.pathname = `/.well-known/${suffix}${path}`;
  return value;
};

export const validateEndpoint = (
  endpoint: string,
  base: URL,
  policy: NetworkPolicy = {},
): string => {
  const value = new URL(endpoint);
  if (
    value.protocol !== "https:" &&
    !(
      policy.allowLoopbackHttp &&
      value.protocol === "http:" &&
      isLoopbackHost(value.hostname)
    )
  )
    throw new Error("MCP OAuth endpoint must use HTTPS");
  if (value.username || value.password)
    throw new Error("MCP OAuth endpoint must not contain credentials");
  if (value.origin !== base.origin)
    throw new Error("MCP OAuth endpoint has an untrusted origin");
  return value.toString();
};
export const isLoopbackHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  )
    return true;
  return isIP(normalized) === 4 && normalized.split(".")[0] === "127";
};

export const fetchWithTimeout = (
  fetchImpl: FetchLike,
  input: Parameters<FetchLike>[0],
  init?: Parameters<FetchLike>[1],
  policy: NetworkPolicy = {},
): Promise<Response> => safeOAuthFetch(input, init, policy, fetchImpl);

export const decodeJsonResponse = <A, I, R>(
  schema: Schema.Codec<A, I, R>,
  response: Response,
  operation: string,
): Effect.Effect<A, DatabaseError, R> =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: (error) =>
      new DatabaseError({
        message: `${operation} response JSON failed: ${String(error)}`,
      }),
  }).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body)),
    Effect.catchTag(
      "SchemaError",
      (error) =>
        new DatabaseError({
          message: `${operation} response schema failed: ${String(error)}`,
        }),
    ),
  );

export const decodeStoredJson = <A, I, R>(
  schema: Schema.Codec<A, I, R>,
  value: string,
  operation: string,
): Effect.Effect<A, DatabaseError, R> =>
  Effect.tryPromise({
    // Response.json performs JSON decoding without bypassing Effect's error channel.
    try: () => new Response(value).json(),
    catch: (error) =>
      new DatabaseError({
        message: `${operation} JSON failed: ${String(error)}`,
      }),
  }).pipe(
    Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body)),
    Effect.catchTag(
      "SchemaError",
      (error) =>
        new DatabaseError({
          message: `${operation} schema failed: ${String(error)}`,
        }),
    ),
  );

export const discoverMcpOAuthMetadataEffect = (
  serverUrl: string,
  fetchImpl: FetchLike,
  policy: NetworkPolicy = {},
): Effect.Effect<McpOAuthMetadata, DatabaseError | McpOAuthError> =>
  Effect.gen(function* () {
    const base = new URL(serverUrl);
    const protectedResource = new URL(
      discoveryUrl(base, "oauth-protected-resource").pathname,
      base,
    );
    const resourceResponse = yield* Effect.tryPromise({
      try: () =>
        fetchWithTimeout(fetchImpl, protectedResource, undefined, policy),
      catch: (error) => new DatabaseError({ message: String(error) }),
    });
    if (!resourceResponse.ok) {
      return yield* Effect.fail(
        new DatabaseError({
          message: `MCP OAuth protected-resource discovery failed (${resourceResponse.status})`,
        }),
      );
    }
    const resource = yield* decodeJsonResponse(
      ProtectedResourceResponse,
      resourceResponse,
      "MCP OAuth protected-resource discovery",
    );
    let resourceIdentifier: URL;
    try {
      resourceIdentifier = new URL(resource.resource);
    } catch (error) {
      return yield* Effect.fail(
        new McpOAuthError({
          message: `Invalid protected-resource identifier: ${String(error)}`,
          reason: "endpoint_validation",
        }),
      );
    }
    if (resourceIdentifier.toString() !== base.toString()) {
      return yield* Effect.fail(
        new McpOAuthError({
          message: `Protected-resource metadata describes ${resourceIdentifier}, not ${base}`,
          reason: "endpoint_validation",
        }),
      );
    }
    const issuer =
      resource.authorization_servers?.[0] ??
      resource.authorization_server ??
      base.origin;
    let authServerUrl: URL;
    try {
      authServerUrl = new URL(issuer);
      if (
        (authServerUrl.protocol !== "https:" &&
          !(
            policy.allowLoopbackHttp &&
            authServerUrl.protocol === "http:" &&
            isLoopbackHost(authServerUrl.hostname)
          )) ||
        authServerUrl.username ||
        authServerUrl.password
      )
        throw new Error(
          "MCP OAuth issuer must be HTTPS and must not contain credentials",
        );
    } catch (error) {
      return yield* Effect.fail(
        new McpOAuthError({
          message: String(error),
          reason: "endpoint_validation",
        }),
      );
    }
    const metadataUrl = new URL(
      discoveryUrl(authServerUrl, "oauth-authorization-server").pathname,
      authServerUrl,
    );
    const authResponse = yield* Effect.tryPromise({
      try: () => fetchWithTimeout(fetchImpl, metadataUrl, undefined, policy),
      catch: (error) => new DatabaseError({ message: String(error) }),
    });
    if (!authResponse.ok) {
      return yield* Effect.fail(
        new DatabaseError({
          message: `MCP OAuth authorization-server discovery failed (${authResponse.status})`,
        }),
      );
    }
    const metadata = yield* decodeJsonResponse(
      AuthorizationServerResponse,
      authResponse,
      "MCP OAuth authorization-server discovery",
    );
    let metadataIssuer: string;
    try {
      metadataIssuer = new URL(metadata.issuer).toString();
    } catch {
      return yield* Effect.fail(
        new McpOAuthError({
          message: "MCP OAuth metadata issuer is not a valid URL",
          reason: "endpoint_validation",
        }),
      );
    }
    if (metadataIssuer !== authServerUrl.toString()) {
      return yield* Effect.fail(
        new McpOAuthError({
          message: `MCP OAuth metadata issuer ${metadata.issuer} does not match ${authServerUrl}`,
          reason: "endpoint_validation",
        }),
      );
    }
    let authorizationEndpoint: string;
    let tokenEndpoint: string;
    let registrationEndpoint: string | undefined;
    try {
      authorizationEndpoint = validateEndpoint(
        metadata.authorization_endpoint,
        authServerUrl,
        policy,
      );
      tokenEndpoint = validateEndpoint(
        metadata.token_endpoint,
        authServerUrl,
        policy,
      );
      registrationEndpoint =
        metadata.registration_endpoint === undefined
          ? undefined
          : validateEndpoint(
              metadata.registration_endpoint,
              authServerUrl,
              policy,
            );
    } catch (error) {
      return yield* Effect.fail(
        new McpOAuthError({
          message: String(error),
          reason: "endpoint_validation",
        }),
      );
    }
    return {
      authorizationEndpoint,
      tokenEndpoint,
      ...(registrationEndpoint ? { registrationEndpoint } : {}),
    };
  }).pipe(
    Effect.mapError((error) =>
      error instanceof McpOAuthError
        ? error
        : new McpOAuthError({ message: error.message, reason: "discovery" }),
    ),
  );

export const discoverMcpOAuthMetadata = async (
  serverUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<McpOAuthMetadata> =>
  Effect.runPromise(discoverMcpOAuthMetadataEffect(serverUrl, fetchImpl));

export const buildMcpAuthorizeUrl = (input: {
  readonly client: McpOAuthClientMetadata;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly scope?: string;
  readonly resource?: string;
}): URL => {
  const url = new URL(input.client.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set(
    "code_challenge",
    createPkceChallenge(input.codeVerifier),
  );
  url.searchParams.set("code_challenge_method", "S256");
  if (input.scope) url.searchParams.set("scope", input.scope);
  if (input.resource) url.searchParams.set("resource", input.resource);
  return url;
};

export const registerClient = (
  metadata: McpOAuthMetadata,
  redirectUri: string,
  fetchImpl: FetchLike,
  scope?: string,
  policy: NetworkPolicy = {},
): Effect.Effect<McpOAuthClientMetadata, DatabaseError | McpOAuthError> =>
  Effect.gen(function* () {
    const registrationEndpoint = metadata.registrationEndpoint;
    if (!registrationEndpoint) {
      return yield* Effect.fail(
        new DatabaseError({
          message: "MCP OAuth server requires a pre-registered client",
        }),
      );
    }
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchWithTimeout(
          fetchImpl,
          registrationEndpoint,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              redirect_uris: [redirectUri],
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              client_name: "Oh My Pi Linear Gateway",
              ...(scope !== undefined ? { scope } : {}),
            }),
          },
          policy,
        ),
      catch: (error) => new DatabaseError({ message: String(error) }),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new DatabaseError({
          message: `MCP OAuth client registration failed (${response.status})`,
        }),
      );
    }
    const body = yield* decodeJsonResponse(
      RegistrationResponse,
      response,
      "MCP OAuth client registration",
    );
    return {
      clientId: body.client_id,
      ...(body.client_secret !== undefined
        ? { clientSecret: body.client_secret }
        : {}),
      ...(body.token_endpoint_auth_method !== undefined
        ? { tokenEndpointAuthMethod: body.token_endpoint_auth_method }
        : {}),
      authorizationEndpoint: metadata.authorizationEndpoint,
      tokenEndpoint: metadata.tokenEndpoint,
      ...(metadata.registrationEndpoint !== undefined
        ? { registrationEndpoint: metadata.registrationEndpoint }
        : {}),
    };
  }).pipe(
    Effect.mapError((error) =>
      error instanceof McpOAuthError
        ? error
        : new McpOAuthError({ message: error.message, reason: "registration" }),
    ),
  );

export const formEncode = (value: string): string =>
  new URLSearchParams({ value }).toString().slice("value=".length);

export const tokenEndpointAuth = (
  client: McpOAuthClientMetadata,
  params: URLSearchParams,
): Effect.Effect<Record<string, string>, DatabaseError> =>
  Effect.gen(function* () {
    const clientSecret = client.clientSecret;
    const method =
      client.tokenEndpointAuthMethod ??
      (clientSecret === undefined ? "none" : "client_secret_basic");
    if (method === "client_secret_basic") {
      if (clientSecret === undefined) {
        return yield* Effect.fail(
          new DatabaseError({
            message: `${method} requires a client secret`,
          }),
        );
      }
      return {
        Authorization: `Basic ${Buffer.from(
          `${formEncode(client.clientId)}:${formEncode(clientSecret)}`,
        ).toString("base64")}`,
      };
    }
    if (method === "client_secret_post") {
      if (clientSecret === undefined) {
        return yield* Effect.fail(
          new DatabaseError({
            message: `${method} requires a client secret`,
          }),
        );
      }
      params.set("client_secret", clientSecret);
    }
    return {};
  });

export const redeemCode = (
  client: McpOAuthClientMetadata,
  code: string,
  redirectUri: string,
  verifier: string,
  fetchImpl: FetchLike,
  now: number,
  resource: string,
  policy: NetworkPolicy = {},
): Effect.Effect<McpOAuthToken, DatabaseError> =>
  Effect.gen(function* () {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
      resource,
    });
    const authHeaders = yield* tokenEndpointAuth(client, params);
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchWithTimeout(
          fetchImpl,
          client.tokenEndpoint,
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              accept: "application/json",
              ...authHeaders,
            },
            body: params.toString(),
          },
          policy,
        ),
      catch: (error) => new DatabaseError({ message: String(error) }),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new DatabaseError({
          message: `MCP OAuth token redemption failed (${response.status})`,
        }),
      );
    }
    const body = yield* decodeJsonResponse(
      TokenResponse,
      response,
      "MCP OAuth token redemption",
    );
    return {
      accessToken: body.access_token,
      ...(body.refresh_token !== undefined
        ? { refreshToken: body.refresh_token }
        : {}),
      expiresAt:
        body.expires_in === undefined
          ? NON_EXPIRING_TOKEN_EXPIRES_AT
          : now + body.expires_in * 1000,
      ...(body.token_type !== undefined ? { tokenType: body.token_type } : {}),
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
    };
  });

export const refreshAccessToken = (
  client: McpOAuthClientMetadata,
  refreshToken: string,
  fetchImpl: FetchLike,
  now: number,
  resource: string,
  policy: NetworkPolicy = {},
): Effect.Effect<McpOAuthToken, DatabaseError> =>
  Effect.gen(function* () {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: client.clientId,
      resource,
    });
    const authHeaders = yield* tokenEndpointAuth(client, params);
    const response = yield* Effect.tryPromise({
      try: () =>
        fetchWithTimeout(
          fetchImpl,
          client.tokenEndpoint,
          {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              accept: "application/json",
              ...authHeaders,
            },
            body: params.toString(),
          },
          policy,
        ),
      catch: (error) => new DatabaseError({ message: String(error) }),
    });
    if (!response.ok) {
      return yield* Effect.fail(
        new DatabaseError({
          message: `MCP OAuth token refresh failed (${response.status})`,
        }),
      );
    }
    const body = yield* decodeJsonResponse(
      TokenResponse,
      response,
      "MCP OAuth token refresh",
    );
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? refreshToken,
      expiresAt:
        body.expires_in === undefined
          ? NON_EXPIRING_TOKEN_EXPIRES_AT
          : now + body.expires_in * 1000,
      ...(body.token_type !== undefined ? { tokenType: body.token_type } : {}),
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
    };
  });

export const encrypted = (value: string): string =>
  `${MCP_OAUTH_ENCRYPTED_PREFIX}${value}`;
export const decryptValue = (
  crypto: TokenCrypto["Service"],
  value: string,
  context: string,
): Effect.Effect<string, TokenCipherError> =>
  value.startsWith(MCP_OAUTH_ENCRYPTED_PREFIX)
    ? crypto.decrypt(value.slice(MCP_OAUTH_ENCRYPTED_PREFIX.length), context)
    : Effect.succeed(value);
