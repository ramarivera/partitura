import { Clock, Effect, Option, Schema } from "effect";
import { InputId, SessionId } from "../domain/ids.js";
import { TERMINAL_RUN_STATES } from "../domain/models.js";
import type { AdminContext } from "./admin-context.js";
import { AdminError, withRerunIssueGate } from "./admin-core.js";
import { json, text } from "./admin-responses.js";
import { substitutePromptTemplate } from "./prompt-templates.js";

export const rerunRoutes = (context: AdminContext) =>
  Effect.gen(function* () {
    const { deps, request, url, requireMutation } = context;
    const rerunMatch = /^\/api\/admin\/runs\/([^/]+)\/rerun$/u.exec(
      url.pathname,
    );
    if (rerunMatch !== null && request.method === "POST") {
      const rawSessionId = decodeURIComponent(rerunMatch[1] ?? "");
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
      const adminSession = yield* requireMutation(request);
      const runOption = yield* deps.runRepo.get(sessionId);
      if (Option.isNone(runOption)) {
        return Option.some(text("Not found", 404));
      }
      const run = runOption.value;
      // Scope to the authenticated admin's organization: a valid admin
      // session for org A must not drive runs (or spend tokens) of org B.
      // 404 rather than 403 so cross-org run ids are not confirmable.
      if (run.organizationId !== adminSession.organizationId) {
        return Option.some(text("Not found", 404));
      }
      if (Option.isNone(run.issueId)) {
        return Option.some(text("Run is not linked to an issue", 409));
      }
      if (!TERMINAL_RUN_STATES.includes(run.state)) {
        return Option.some(text("Run is not terminal", 409));
      }
      const issueId = run.issueId.value;
      const rerunResponse = yield* withRerunIssueGate(
        run.organizationId,
        issueId,
        Effect.gen(function* () {
          const hasActiveRun = yield* deps.runRepo.hasActiveForIssue({
            organizationId: run.organizationId,
            issueId,
          });
          if (hasActiveRun) {
            return Option.some(
              text("A run for this issue is already active", 409),
            );
          }
          const rerunTemplate = yield* deps.promptTemplateRepo
            .get(run.organizationId, "created")
            .pipe(
              Effect.catchTag(
                "@Gateway/DatabaseError",
                (error) =>
                  new AdminError({
                    message: error.message,
                    status: 500,
                  }),
              ),
            );
          // Admin reruns honor a configured created template; the
          // substitution mirrors the webhook's created body builder with
          // the synthetic context.
          const body = Option.isSome(rerunTemplate)
            ? substitutePromptTemplate(rerunTemplate.value.body, {
                userRequest: "User request:\nWork on the issue below.",
                issueContext: `Issue context:\nIssue: ${issueId}`,
                threadComment: "",
                previousComments: "",
                guidance: "",
              })
            : `User request:\nWork on the issue below.\n\nIssue context:\nIssue: ${issueId}`;
          const newSessionId = yield* deps.linearGateway
            .createSessionOnIssue({
              organizationId: run.organizationId,
              issueId,
            })
            .pipe(
              Effect.mapError((error) => {
                if (error._tag === "@Gateway/LinearRateLimitError") {
                  const retry =
                    error.retryAfterMs === undefined
                      ? ""
                      : ` Retry after ${error.retryAfterMs}ms.`;
                  return new AdminError({
                    message: `Could not create Linear agent session: ${error.message}.${retry}`,
                    status: 429,
                  });
                }
                return new AdminError({
                  message: `Could not create Linear agent session: ${error.message}`,
                  status: 500,
                });
              }),
            );
          const newRunSessionId = yield* Schema.decodeUnknownEffect(SessionId)(
            newSessionId,
          ).pipe(
            Effect.catchTags({
              SchemaError: () =>
                Effect.fail(
                  new AdminError({
                    message: "Invalid session id from Linear",
                    status: 500,
                  }),
                ),
            }),
          );
          const rerunStatus = yield* deps.runRepo.createIfNoActiveForIssue({
            sessionId: newRunSessionId,
            organizationId: run.organizationId,
            issueId: Option.some(issueId),
            repositoryId: run.repositoryId,
            teamId: run.teamId,
            projectId: run.projectId,
          });
          if (rerunStatus === "active") {
            return Option.some(
              text("A run for this issue is already active", 409),
            );
          }
          const rerunCreatedAt = yield* Clock.currentTimeMillis;
          const inputId = yield* Schema.decodeUnknownEffect(InputId)(
            `${newSessionId}:created`,
          ).pipe(
            Effect.catchTags({
              SchemaError: () =>
                Effect.fail(
                  new AdminError({
                    message: "Invalid input id",
                    status: 500,
                  }),
                ),
            }),
          );
          yield* deps.runInputRepo.enqueue({
            id: inputId,
            sessionId: newRunSessionId,
            kind: "created",
            body,
            payload: {
              type: "AgentSessionEvent",
              action: "created",
              organizationId: run.organizationId,
              ...(Option.isSome(run.repositoryId)
                ? { repositoryId: run.repositoryId.value }
                : {}),
              automationDelegated: false,
              appUserId: "synthetic",
              oauthClientId: "synthetic",
              webhookId: "synthetic",
              webhookTimestamp: rerunCreatedAt,
              agentSession: {
                id: newSessionId,
                appUserId: "synthetic",
                organizationId: run.organizationId,
                status: "pending",
                createdAt: rerunCreatedAt,
                updatedAt: rerunCreatedAt,
                issueId,
              },
            },
            createdAt: rerunCreatedAt,
          });
          yield* deps.reconciler.trigger();
          return Option.some(json({ sessionId: newSessionId }));
        }),
      );
      return rerunResponse;
    }

    return Option.none<Response>();
  });
