import { Cause, Effect, Option } from "effect";
import { redact } from "../admin-ui/run-detail.js";
import type { RunDetailModel } from "../admin-ui.js";
import {
  DatabaseError,
  RowDecodeError,
  type TokenCipherError,
} from "../domain/errors.js";
import type { OrganizationId } from "../domain/ids.js";
import type {
  AgentRun,
  Installation,
  McpServerRecord,
  NixCacheEntry,
  RunEvent,
} from "../domain/models.js";
import {
  type AdminDeps,
  AdminError,
  HTML_SECURITY_HEADERS,
  SECURITY_HEADERS,
} from "./admin-core.js";
import { record } from "./admin-payloads.js";
import { type ExecutorRequestError, executorUrlForPath } from "./executor.js";
export const EXECUTOR_ATTACHMENT_PREFIX = "executor:";

export const executorAttachmentSlug = (
  server: McpServerRecord,
): string | null => {
  if (!server.name.startsWith(EXECUTOR_ATTACHMENT_PREFIX)) return null;
  const marker = server.name
    .slice(EXECUTOR_ATTACHMENT_PREFIX.length)
    .split(":", 1)[0];
  if (!marker) return null;
  try {
    return decodeURIComponent(marker);
  } catch {
    return null;
  }
};

export const synchronizeExecutorAttachments = (
  deps: AdminDeps,
  organizationId: OrganizationId,
  endpoint: string | null,
  token: string | null,
  now: number,
): Effect.Effect<void, DatabaseError | RowDecodeError | TokenCipherError> =>
  Effect.gen(function* () {
    const servers = yield* deps.mcpServerRepo.listMcpServers(organizationId);
    yield* Effect.forEach(servers, (server) => {
      if (executorAttachmentSlug(server) === null) return Effect.void;
      if (endpoint === null || token === null) {
        return deps.mcpServerRepo
          .updateMcpServer(organizationId, server.id, {
            enabled: false,
            now,
          })
          .pipe(Effect.asVoid);
      }
      const slug = executorAttachmentSlug(server);
      if (slug === null) return Effect.void;
      return deps.mcpServerRepo
        .updateMcpServer(organizationId, server.id, {
          url: executorUrlForPath(
            endpoint,
            `mcp/toolkits/${encodeURIComponent(slug)}`,
          ),
          headers: { Authorization: `Bearer ${token}` },
          now,
        })
        .pipe(Effect.asVoid);
    });
  });

export function toApiExecutorInstance(instance: {
  readonly endpoint: string;
  readonly updatedAt: number;
}) {
  return {
    endpoint: instance.endpoint,
    token: "•••",
    updatedAt: instance.updatedAt,
  };
}

export function executorError(error: ExecutorRequestError): AdminError {
  const status =
    error.reason === "not_configured"
      ? 404
      : error.reason === "invalid_endpoint"
        ? 400
        : 502;
  return new AdminError({ message: error.message, status });
}

export function toAdminInstallation(installation: Installation) {
  return {
    organizationId: installation.organizationId,

    appUserId: installation.appUserId,
    scopes: [...installation.scopes],
    revokedAt: Option.getOrElse(installation.revokedAt, () => null),
    accessibleTeamIds: Option.match(installation.accessibleTeamIds, {
      onNone: () => null,
      onSome: (ids) => [...ids],
    }),
    canAccessAllPublicTeams: Option.getOrElse(
      installation.canAccessAllPublicTeams,
      () => null,
    ),
  };
}

export function toApiNixCache(entry: NixCacheEntry) {
  return {
    cacheKey: entry.cacheKey,
    status: "ready",
    sizeBytes: entry.sizeBytes,
    lastUsedAt: entry.updatedAt,
  };
}

export function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : null;
}

export function safeUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? redact(value)
      : null;
  } catch {
    return null;
  }
}

export function redactedStringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = stringField(value, key);
  return field === null ? null : redact(field);
}

export function hasIssueEvent(events: ReadonlyArray<RunEvent>): boolean {
  return events.some(
    (event) =>
      record(event.payload) &&
      record(event.payload.agentSession) &&
      record(event.payload.agentSession.issue),
  );
}

export function issueForRun(
  run: AgentRun,
  events: ReadonlyArray<RunEvent>,
): RunDetailModel["issue"] {
  for (const event of events) {
    if (!record(event.payload)) continue;
    const agentSession = event.payload.agentSession;
    if (!record(agentSession)) continue;
    const issue = agentSession.issue;
    if (!record(issue)) continue;
    return {
      identifier: redactedStringField(issue, "identifier"),
      title: redactedStringField(issue, "title"),
      url: safeUrl(stringField(issue, "url")),
    };
  }
  return Option.match(run.issueId, {
    onNone: () => null,
    onSome: (id) => ({
      identifier: redact(id),
      title: null,
      url: null,
    }),
  });
}

export function redactOption(value: Option.Option<string>): string | null {
  return Option.getOrElse(Option.map(value, redact), () => null);
}

export function runDetailModel(
  run: AgentRun,
  events: ReadonlyArray<RunEvent>,
  issueEvents: ReadonlyArray<RunEvent> = events,
): RunDetailModel {
  return {
    run: {
      sessionId: run.sessionId,
      organizationId: redact(run.organizationId),
      issueId: redactOption(Option.map(run.issueId, (x) => String(x))),
      repositoryId: redactOption(
        Option.map(run.repositoryId, (x) => String(x)),
      ),
      state: run.state,
      desiredState: run.desiredState,
      ompSessionId: redactOption(run.ompSessionId),
      ompSessionFile: redactOption(run.ompSessionFile),
      workspacePath: redactOption(run.workspacePath),
      teamId: redactOption(Option.map(run.teamId, (x) => String(x))),
      projectId: redactOption(Option.map(run.projectId, (x) => String(x))),
      attempt: run.attempt,
      leaseOwner: redactOption(run.leaseOwner),
      leaseExpiresAt: Option.getOrElse(run.leaseExpiresAt, () => null),
      lastActivityAt: Option.getOrElse(run.lastActivityAt, () => null),
      terminalReason: redactOption(run.terminalReason),
      nextAttemptAt: Option.getOrElse(run.nextAttemptAt, () => null),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    issue: issueForRun(run, issueEvents),
    events: events.map((event) => ({
      sourceKey: redact(String(event.sourceKey)),
      kind: redact(event.kind),
      level: event.level,
      text: redactOption(event.text),
      payload: redact(JSON.stringify(event.payload, null, 2) ?? "null"),
      status: redactOption(event.status),
      error: redactOption(event.error),
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
    })),
  };
}

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...SECURITY_HEADERS,
    },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...HTML_SECURITY_HEADERS,
    },
  });
}

export function text(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...SECURITY_HEADERS,
    },
  });
}

export function redirect(
  location: string,
  status = 302,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(null, {
    status,
    headers: { location, ...SECURITY_HEADERS, ...extraHeaders },
  });
}

export function emptyResponse(
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(null, {
    status,
    headers: { ...SECURITY_HEADERS, ...extraHeaders },
  });
}

export function parseJsonBody(request: Request) {
  return Effect.gen(function* () {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("application/json")) {
      return yield* Effect.fail(
        new AdminError({ message: "Request body must be JSON", status: 400 }),
      );
    }

    const body = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: (error) =>
        new DatabaseError({
          message: `body read failed: ${error}`,
        }),
    });

    if (body.length === 0) return {};

    const parsed = yield* Effect.try({
      try: () => JSON.parse(body),
      catch: () => new AdminError({ message: "Invalid JSON", status: 400 }),
    });

    if (Array.isArray(parsed) || !record(parsed)) {
      return yield* Effect.fail(
        new AdminError({
          message: "Request body must be a JSON object",
          status: 400,
        }),
      );
    }

    return parsed;
  });
}

export function mapCauseToResponse(
  cause: Cause.Cause<unknown>,
): Option.Option<Response> {
  const typed = cause.reasons
    .filter(Cause.isFailReason)
    .map((reason) => reason.error);
  const defects = cause.reasons
    .filter(Cause.isDieReason)
    .map((reason) => reason.defect);
  const all = [...typed, ...defects];

  for (const error of all) {
    if (error instanceof AdminError) {
      return Option.some(text(error.message, error.status));
    }
    if (error instanceof RowDecodeError) {
      return Option.some(text(error.message, 400));
    }
  }

  const message = all
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join("; ");

  if (/already exists|unique constraint/i.test(message)) {
    return Option.some(text(message, 409));
  }

  if (/not found|does not exist/i.test(message)) {
    return Option.some(text(message, 404));
  }

  return Option.some(text("Internal server error", 500));
}
