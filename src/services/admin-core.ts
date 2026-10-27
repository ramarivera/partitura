import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Effect, Schema, Semaphore } from "effect";
import type {
  DatabaseError,
  RowDecodeError,
  WorkspaceError,
} from "../domain/errors.js";
import type { OrganizationId } from "../domain/ids.js";
import type { NixPackageName, RepositoryRecord } from "../domain/models.js";
import type { GatewayConfigShape } from "./config.js";
import type { Executor } from "./executor.js";
import type { LinearGateway } from "./linear-gateway.js";
import type { McpOAuth } from "./mcp-oauth.js";
import type { NativeBuildFleet } from "./native-build-fleet.js";
import type { NixEnvironment } from "./nix-environment.js";
import type { ReconcilerStatus } from "./reconciler.js";
import type {
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
import type { RepositoryResolution } from "./workspace.js";

export const ADMIN_COOKIE = "omp_gateway_admin";
export const CSRF_SALT = "omp-gateway-admin-csrf";
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export const HTTP_TOKEN_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
// Linear exposes no public session-delete API, so preventing duplicate reruns
// before creating a session is the only way to avoid orphaned sessions.
export const rerunIssueGates = new Map<
  string,
  { semaphore: Semaphore.Semaphore; users: number }
>();

export const withRerunIssueGate = <A, E, R>(
  organizationId: OrganizationId,
  issueId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const key = `${organizationId}:${issueId}`;
      const entry = rerunIssueGates.get(key) ?? {
        semaphore: Semaphore.makeUnsafe(1),
        users: 0,
      };
      entry.users += 1;
      rerunIssueGates.set(key, entry);
      return { key, entry };
    }),
    ({ entry }) => entry.semaphore.withPermits(1)(effect),
    ({ key, entry }) =>
      Effect.sync(() => {
        entry.users -= 1;
        if (entry.users === 0 && rerunIssueGates.get(key) === entry)
          rerunIssueGates.delete(key);
      }),
  );
export const rerunIssueGateCount = (): number => rerunIssueGates.size;

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cache-Control": "no-store",
};

export const HTML_SECURITY_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
};

export interface WorkspaceShape {
  readonly resolve: (
    context: unknown,
  ) => Effect.Effect<RepositoryResolution, DatabaseError | RowDecodeError>;
  readonly materialize: (
    sessionId: string,
    repository: RepositoryRecord,
  ) => Effect.Effect<string, WorkspaceError>;
}

export interface ReconcilerShape {
  readonly status: () => Effect.Effect<ReconcilerStatus, never>;
  readonly trigger: () => Effect.Effect<void, never>;
}
export interface AdminDeps {
  readonly nativeBuilders?: NativeBuildFleet["Service"];
  readonly config: GatewayConfigShape;
  readonly adminSessionRepo: AdminSessionRepo["Service"];
  readonly executorInstanceRepo: ExecutorInstanceRepo["Service"];
  readonly executor: {
    readonly listToolkits: Executor["Service"]["listToolkits"];
  };
  readonly installationRepo: InstallationRepo["Service"];
  readonly runRepo: RunRepo["Service"];
  readonly runEventRepo: RunEventRepo["Service"];
  readonly runInputRepo: RunInputRepo["Service"];
  readonly linearGateway: {
    readonly createSessionOnIssue: LinearGateway["Service"]["createSessionOnIssue"];
  };
  readonly workspaceRepo: WorkspaceRepo["Service"];
  readonly promptTemplateRepo: PromptTemplateRepo["Service"];
  readonly agentSettingsRepo: AgentSettingsRepo["Service"];
  readonly mcpServerRepo: McpServerRepo["Service"];
  readonly mcpOAuth: McpOAuth["Service"];
  readonly workspace: WorkspaceShape;
  readonly reconciler: ReconcilerShape;
  readonly nixEnvironment: NixEnvironment["Service"];
}

export interface RepositoryPayload {
  readonly id: string;
  readonly url: string;
  readonly ref: string;
  readonly teamIds: ReadonlyArray<string>;
  readonly projectIds: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<string>;
  readonly isDefault: boolean | undefined;
  readonly defaultDriver: "omp" | "t3" | undefined;
  readonly nixPackages: ReadonlyArray<NixPackageName>;
}

export class AdminError extends Schema.TaggedError<AdminError>()(
  "@Gateway/AdminError",
  {
    message: Schema.String,
    status: Schema.Literals([400, 401, 403, 404, 409, 429, 500, 502]),
  },
) {}

export const RunEventCursorParam = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({
        createdAt: Schema.Finite,
        sourceKey: Schema.String,
      }),
    ),
  ),
);
export const RunEventQuery = Schema.Struct({
  limit: Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 1000 }),
  ),
  cursor: Schema.optionalKey(RunEventCursorParam),
});

export function isSecure(config: { publicUrl: URL }): boolean {
  return config.publicUrl.protocol === "https:";
}

export function adminCookieAttributes(
  config: { publicUrl: URL },
  expiresAt?: number,
): string {
  const base = "HttpOnly; SameSite=Lax; Path=/";
  const secure = isSecure(config) ? "; Secure" : "";
  const expiry =
    expiresAt === undefined
      ? "; Max-Age=0"
      : `; Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`;
  return `${base}${secure}${expiry}`;
}

export function setAdminCookie(
  config: GatewayConfigShape,
  token: string,
  expiresAt: number,
): string {
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; ${adminCookieAttributes(config, expiresAt)}`;
}

export function clearAdminCookie(config: GatewayConfigShape): string {
  return `${ADMIN_COOKIE}=; ${adminCookieAttributes(config)}`;
}

export function tokenHash(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("base64url");
}

export function deriveCsrfToken(rawToken: string): string {
  return createHmac("sha256", rawToken).update(CSRF_SALT).digest("base64url");
}

export function csrfHash(rawCsrf: string): string {
  return createHash("sha256").update(rawCsrf).digest("base64url");
}

export function timingSafeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function findCookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const pattern = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, "u");
  const match = pattern.exec(header);
  if (!match) return null;
  try {
    return match[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export function validateOrigin(
  config: GatewayConfigShape,
  request: Request,
): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === config.publicUrl.origin;
  } catch {
    return false;
  }
}

export function validateCsrf(request: Request, csrfTokenHash: string): boolean {
  const header = request.headers.get("x-csrf-token");
  if (!header) return false;
  return timingSafeEquals(csrfHash(header), csrfTokenHash);
}
