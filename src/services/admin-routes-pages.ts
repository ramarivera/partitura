import { Effect, Option, Result, Schema } from "effect";
import {
  renderAdminPage,
  renderLandingPage,
  renderRunDetailPage,
} from "../admin-ui.js";
import { SessionId } from "../domain/ids.js";
import type { AdminContext } from "./admin-context.js";
import {
  ADMIN_COOKIE,
  AdminError,
  deriveCsrfToken,
  findCookieValue,
  RunEventCursorParam,
  RunEventQuery,
  tokenHash,
} from "./admin-core.js";
import {
  hasIssueEvent,
  html,
  json,
  redirect,
  runDetailModel,
  text,
} from "./admin-responses.js";
import { runEventCursor } from "./store/run-event-repo.js";

export const pagesRoutes = (context: AdminContext) =>
  Effect.gen(function* () {
    const { deps, request, now, url, requireSession } = context;
    if (url.pathname === "/" && request.method === "GET") {
      const rawToken = findCookieValue(request, ADMIN_COOKIE);
      if (rawToken !== null) {
        const session = yield* deps.adminSessionRepo.get(
          tokenHash(rawToken),
          now,
        );
        if (Option.isSome(session)) {
          return Option.some(redirect("/admin"));
        }
      }
      return Option.some(html(renderLandingPage()));
    }

    if (url.pathname !== "/") {
      const authenticated = yield* requireSession(request).pipe(Effect.result);
      if (Result.isFailure(authenticated)) {
        if (
          request.method === "GET" &&
          !url.pathname.endsWith(".json") &&
          !url.pathname.startsWith("/api/") &&
          !request.headers.get("accept")?.includes("application/json")
        ) {
          return Option.some(
            redirect(
              `/oauth/start?returnTo=${encodeURIComponent(url.pathname + url.search)}`,
            ),
          );
        }
        return Option.some(text("Unauthorized", 401));
      }
    }

    if (url.pathname === "/admin" && request.method === "GET") {
      const rawToken = findCookieValue(request, ADMIN_COOKIE);
      if (rawToken === null) {
        return Option.some(redirect("/"));
      }
      const session = yield* deps.adminSessionRepo.get(
        tokenHash(rawToken),
        now,
      );
      if (Option.isNone(session)) {
        return Option.some(redirect("/"));
      }
      return Option.some(
        html(
          renderAdminPage(
            deps.config.gatewayAdminOrganizationIds?.has(
              session.value.organizationId,
            ) === true,
          ),
        ),
      );
    }

    if (url.pathname.startsWith("/runs/") && request.method === "GET") {
      const encodedRunId = url.pathname.slice("/runs/".length);
      const isJsonPath = encodedRunId.endsWith(".json");
      const rawSessionId = decodeURIComponent(
        isJsonPath ? encodedRunId.slice(0, -".json".length) : encodedRunId,
      );
      const sessionId = yield* Schema.decodeUnknownEffect(SessionId)(
        rawSessionId,
      ).pipe(
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new AdminError({ message: "Invalid run id", status: 400 }),
            ),
        }),
      );
      const runOption = yield* deps.runRepo.get(sessionId);
      if (Option.isNone(runOption)) {
        return Option.some(text("Not found", 404));
      }
      const session = yield* requireSession(request);
      const run = runOption.value;
      if (run.organizationId !== session.organizationId)
        return Option.some(text("Not found", 404));
      const pageOptions = yield* Schema.decodeUnknownEffect(RunEventQuery)({
        limit: url.searchParams.get("limit") ?? "100",
        ...(url.searchParams.has("cursor")
          ? { cursor: url.searchParams.get("cursor") }
          : {}),
      }).pipe(
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new AdminError({
                message: "Invalid event pagination",
                status: 400,
              }),
            ),
        }),
      );
      const events = yield* deps.runEventRepo.list(sessionId, pageOptions);
      const lastEvent = events.at(-1);
      let nextEventsUrl: string | null = null;
      if (events.length === pageOptions.limit && lastEvent !== undefined) {
        const cursor = runEventCursor(lastEvent);
        const remaining = yield* deps.runEventRepo.list(sessionId, {
          limit: 1,
          cursor,
        });
        if (remaining.length > 0) {
          const encodedCursor = yield* Schema.encodeEffect(RunEventCursorParam)(
            cursor,
          ).pipe(
            Effect.mapError(
              () =>
                new AdminError({
                  message: "Could not encode event cursor",
                  status: 500,
                }),
            ),
          );
          const query = new URLSearchParams({
            limit: String(pageOptions.limit),
            cursor: encodedCursor,
          });
          nextEventsUrl = `${url.pathname}?${query}`;
        }
      }
      // Issue metadata arrives with the first webhook events, so later pages
      // read it from the head of the timeline instead of the current page.
      const issueEvents =
        pageOptions.cursor === undefined || hasIssueEvent(events)
          ? events
          : yield* deps.runEventRepo.list(sessionId, { limit: 100 });
      const runSettings = yield* deps.agentSettingsRepo.getSnapshot(
        sessionId,
        run.organizationId,
      );
      const model = {
        ...runDetailModel(run, events, issueEvents),
        settings: Option.isSome(runSettings)
          ? runSettings.value.settings
          : null,
      };

      const rawToken = findCookieValue(request, ADMIN_COOKIE);
      const adminSession =
        rawToken === null
          ? Option.none()
          : yield* deps.adminSessionRepo.get(tokenHash(rawToken), now).pipe(
              Effect.catch((error) =>
                Effect.logWarning("admin.session_lookup_failed").pipe(
                  Effect.annotateLogs({
                    sessionId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  }),
                  Effect.as(Option.none()),
                ),
              ),
            );
      const csrfToken = Option.match(adminSession, {
        onNone: () => null,
        onSome: () => deriveCsrfToken(rawToken ?? ""),
      });

      const acceptsJson =
        request.headers.get("accept")?.includes("application/json") ?? false;
      const detail = {
        sessionId: model.run.sessionId,
        state: model.run.state,
        attempt: model.run.attempt,
        lastActivityAt: model.run.lastActivityAt,
        ...model,
      };
      const response =
        isJsonPath || acceptsJson
          ? json(detail)
          : html(renderRunDetailPage(model, csrfToken, nextEventsUrl));
      if (nextEventsUrl !== null)
        response.headers.set("Link", `<${nextEventsUrl}>; rel="next"`);
      return Option.some(response);
    }

    return Option.none<Response>();
  });
