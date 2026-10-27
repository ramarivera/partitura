import { Option, Result } from "effect";
import type {
  McpServerRecord,
  NixPackageName,
  RepositoryRecord,
} from "../domain/models.js";
import { normalizeNixPackages } from "../domain/models.js";
import { HTTP_TOKEN_RE, type RepositoryPayload } from "./admin-core.js";
import type { McpOAuthTokenEndpointAuthMethod } from "./mcp-oauth.js";
import { isHttpsGitHubRepositoryUrl } from "./workspace.js";
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function stringArray(
  value: unknown,
  field: string,
): Result.Result<ReadonlyArray<string>, string> {
  if (!Array.isArray(value)) return Result.fail(`${field} must be an array`);
  if (value.some((item) => typeof item !== "string"))
    return Result.fail(`${field} must contain only strings`);
  return Result.succeed(
    value.map((item) => String(item).trim().toLowerCase()).filter(Boolean),
  );
}
export function preservingStringArray(
  value: unknown,
  field: string,
): Result.Result<ReadonlyArray<string>, string> {
  if (!Array.isArray(value)) return Result.fail(`${field} must be an array`);
  if (value.some((item) => typeof item !== "string")) {
    return Result.fail(`${field} must contain only strings`);
  }
  return Result.succeed(
    value.map((item) => String(item).trim()).filter(Boolean),
  );
}

export function optionalStringArray(
  value: unknown,
  field: string,
): Result.Result<ReadonlyArray<string>, string> {
  if (value === undefined || value === null) return Result.succeed([]);
  return stringArray(value, field);
}

export function optionalNixPackageArray(
  value: unknown,
): Result.Result<ReadonlyArray<NixPackageName>, string> {
  if (value === undefined || value === null) return Result.succeed([]);
  if (!Array.isArray(value)) return Result.fail("nixPackages must be an array");
  if (value.some((item) => typeof item !== "string")) {
    return Result.fail("nixPackages must contain only strings");
  }
  const values = value.map((item) => item.trim()).filter(Boolean);
  if (
    values.some(
      (item) => !/^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)*$/u.test(item),
    )
  ) {
    return Result.fail("Invalid Nix package name");
  }
  return Result.succeed(normalizeNixPackages(values));
}

export function optionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  return undefined;
}

export function repositoryPayload(
  body: Record<string, unknown>,
): Result.Result<RepositoryPayload, string> {
  const id = optionalString(body.id);
  const url = optionalString(body.url);
  const ref = optionalString(body.ref);
  if (id === null) return Result.fail("id is required");
  if (url === null) return Result.fail("url is required");
  if (!isHttpsGitHubRepositoryUrl(url))
    return Result.fail("url must be https://github.com/<owner>/<repo>");
  if (ref === null) return Result.fail("ref is required");
  if (ref.startsWith("-") || /[\r\n\0]/u.test(ref))
    return Result.fail("Invalid repository ref");
  const teamIds = optionalStringArray(body.teamIds, "teamIds");
  if (Result.isFailure(teamIds)) return Result.fail(teamIds.failure);
  const projectIds = optionalStringArray(body.projectIds, "projectIds");
  if (Result.isFailure(projectIds)) return Result.fail(projectIds.failure);
  const labels = optionalStringArray(body.labels, "labels");
  if (Result.isFailure(labels)) return Result.fail(labels.failure);
  const nixPackages = optionalNixPackageArray(body.nixPackages);
  if (Result.isFailure(nixPackages)) return Result.fail(nixPackages.failure);
  if (
    body.defaultDriver !== undefined &&
    body.defaultDriver !== "omp" &&
    body.defaultDriver !== "t3"
  ) {
    return Result.fail("defaultDriver must be omp or t3");
  }
  return Result.succeed({
    id,
    url,
    ref,
    defaultDriver: body.defaultDriver,
    teamIds: teamIds.success,
    projectIds: projectIds.success,
    labels: labels.success,
    nixPackages: nixPackages.success,
    isDefault: optionalBoolean(body.isDefault),
  });
}

export function toApiRepository(repository: RepositoryRecord) {
  return {
    id: repository.id,
    organizationId: repository.organizationId,
    nixPackages: [...repository.nixPackages],
    url: repository.url,
    ref: repository.ref,
    teamIds: [...repository.teamIds],
    projectIds: [...repository.projectIds],
    labels: [...repository.labels],
    isDefault: repository.isDefault,
    defaultDriver: repository.defaultDriver ?? "omp",
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
  };
}
export interface McpServerPayload {
  readonly id: string;
  readonly name: string;
  readonly transport: "stdio" | "http" | "sse";
  readonly command: string | null;
  readonly args: ReadonlyArray<string>;
  readonly url: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly oauthClientId: string | null;
  readonly oauthClientSecret: string | null;
  readonly oauthScope: string | null;
  readonly oauthTokenEndpointAuthMethod: McpOAuthTokenEndpointAuthMethod | null;
  readonly repositoryId: string | null;
  readonly enabled: boolean | undefined;
}

export function mcpServerPayload(
  body: Record<string, unknown>,
): Result.Result<McpServerPayload, string> {
  const id = optionalString(body.id);
  const name = optionalString(body.name);
  if (id === null) return Result.fail("id is required");
  if (name === null) return Result.fail("name is required");
  const rawTransport = body.transport;
  if (
    rawTransport !== "stdio" &&
    rawTransport !== "http" &&
    rawTransport !== "sse"
  ) {
    return Result.fail("transport must be stdio, http, or sse");
  }
  const command = body.command === null ? null : optionalString(body.command);
  const url = body.url === null ? null : optionalString(body.url);
  if (rawTransport === "stdio" && command === null) {
    return Result.fail("stdio transport requires a command");
  }
  if (rawTransport !== "stdio") {
    if (url === null) {
      return Result.fail(`${rawTransport} transport requires a valid URL`);
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return Result.fail(
          `${rawTransport} transport requires a valid http(s) URL`,
        );
      }
    } catch {
      return Result.fail(
        `${rawTransport} transport requires a valid http(s) URL`,
      );
    }
  }
  const argsResult = preservingStringArray(body.args, "args");
  if (Result.isFailure(argsResult)) return Result.fail(argsResult.failure);
  const args = argsResult.success;
  let repositoryId: string | null;
  if (body.repositoryId === null || body.repositoryId === undefined) {
    repositoryId = null;
  } else if (typeof body.repositoryId !== "string") {
    return Result.fail("repositoryId must be a string or null");
  } else {
    repositoryId = optionalString(body.repositoryId);
  }
  const envValue = body.env;
  const env: Record<string, string> = {};
  if (envValue !== undefined && envValue !== null) {
    if (!record(envValue)) return Result.fail("env must be an object");
    for (const [key, value] of Object.entries(envValue)) {
      if (typeof value !== "string")
        return Result.fail(`env.${key} must be a string`);
      env[key] = value;
    }
  }
  const headersValue = body.headers;
  const headers: Record<string, string> = {};
  if (headersValue !== undefined && headersValue !== null) {
    if (!record(headersValue)) return Result.fail("headers must be an object");
    const invalidHeaderNames = Object.keys(headersValue).filter(
      (key) => !HTTP_TOKEN_RE.test(key),
    );
    if (invalidHeaderNames.length > 0) {
      return Result.fail(
        `Invalid MCP header name: ${invalidHeaderNames.join(", ")}`,
      );
    }
    for (const [key, value] of Object.entries(headersValue)) {
      if (typeof value !== "string")
        return Result.fail(`headers.${key} must be a string`);
      headers[key] = value;
    }
  }
  const oauthClientId = optionalString(body.oauthClientId);
  const oauthClientSecret = optionalString(body.oauthClientSecret);
  const oauthScope = optionalString(body.oauthScope);
  const rawAuthMethod = body.oauthTokenEndpointAuthMethod;
  const oauthTokenEndpointAuthMethod =
    rawAuthMethod === undefined ||
    rawAuthMethod === null ||
    rawAuthMethod === ""
      ? null
      : rawAuthMethod === "none" ||
          rawAuthMethod === "client_secret_basic" ||
          rawAuthMethod === "client_secret_post"
        ? rawAuthMethod
        : null;
  if (
    rawAuthMethod !== undefined &&
    rawAuthMethod !== null &&
    rawAuthMethod !== "" &&
    oauthTokenEndpointAuthMethod === null
  ) {
    return Result.fail(
      "oauthTokenEndpointAuthMethod must be none, client_secret_basic, or client_secret_post",
    );
  }
  if (oauthClientSecret !== null && oauthClientId === null) {
    return Result.fail(
      "oauthClientId is required when oauthClientSecret is set",
    );
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return Result.fail("enabled must be a boolean");
  }
  return Result.succeed({
    id,
    name,
    transport: rawTransport,
    command,
    args,
    url,
    env,
    headers,
    oauthClientId,
    oauthClientSecret,
    oauthScope,
    oauthTokenEndpointAuthMethod,
    repositoryId,
    enabled: optionalBoolean(body.enabled),
  });
}
export function toApiMcpServer(
  server: McpServerRecord,
  oauthStatus?: {
    readonly connected: boolean;
    readonly serverUrl?: string;
    readonly expired: boolean;
    readonly expiresAt: number | null;
  },
) {
  const env: Record<string, string> = {};
  for (const name of Object.keys(server.env)) env[name] = "•••";
  const headers: Record<string, string> = {};
  for (const name of Object.keys(server.headers ?? {})) {
    headers[name] = "•••";
  }
  return {
    oauthClient:
      server.oauthClient === undefined || server.oauthClient === null
        ? null
        : {
            clientId: server.oauthClient.clientId ?? null,
            clientSecret:
              server.oauthClient.clientSecret === undefined ? null : "•••",
            scope: server.oauthClient.scope ?? null,
            tokenEndpointAuthMethod:
              server.oauthClient.tokenEndpointAuthMethod ?? null,
          },
    id: server.id,
    organizationId: server.organizationId,
    name: server.name,
    transport: server.transport,
    command: Option.getOrElse(server.command, () => null),
    args: [...server.args],
    url: Option.getOrElse(server.url, () => null),
    env,
    headers,
    repositoryId: Option.getOrElse(server.repositoryId, () => null),
    enabled: server.enabled,
    oauth: oauthStatus ?? {
      connected: false,
      expired: false,
      expiresAt: null,
    },
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
  };
}
