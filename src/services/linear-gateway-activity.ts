import type { LinearClient } from "@linear/sdk";
import { Effect, Option, Schema } from "effect";
import {
  type DatabaseError,
  type InstallationRevokedError,
  LinearApiError,
  type LinearRateLimitError,
  type RowDecodeError,
  type TokenRefreshError,
} from "../domain/errors.js";
import { SessionId } from "../domain/ids.js";
import type { makeLinearCore } from "./linear-gateway-core.js";
import type { ListedSessionActivity } from "./linear-gateway-types.js";
import type { makeLinearWorkspace } from "./linear-gateway-workspace.js";
import { isActivitySignal, isRecord } from "./linear-helpers.js";

const LIST_SESSION_ACTIVITIES_MAX_PAGES = 10;

export const makeLinearActivity = ({
  runRepo,
  mapLinearError,
  decodeActivityContent,
  mapActivityContent,
  mapActivitySignal,
  clientFor,
  withRateLimitRetry,
  withOrgQueue,
}: Effect.Success<typeof makeLinearCore> &
  ReturnType<typeof makeLinearWorkspace>) => {
  const createActivity = Effect.fn("LinearGateway.createActivity")(
    function* (input: {
      readonly sessionId: string;
      readonly content: unknown;
    }): Effect.fn.Return<
      string,
      | InstallationRevokedError
      | LinearApiError
      | LinearRateLimitError
      | TokenRefreshError
    > {
      const sessionId = yield* Schema.decodeUnknownEffect(SessionId)(
        input.sessionId,
      ).pipe(
        Effect.catchTag(
          "SchemaError",
          (error) =>
            new LinearApiError({
              operation: "createActivity",
              message: `Invalid session id: ${error.message}`,
            }),
        ),
      );
      yield* Effect.annotateCurrentSpan({ "linear.sessionId": sessionId });
      if (!isRecord(input.content)) {
        yield* Effect.logWarning("linear.createActivity.invalid").pipe(
          Effect.annotateLogs({
            sessionId,
            reason: "content_not_record",
          }),
        );
        return yield* Effect.fail(
          new LinearApiError({
            operation: "createActivity",
            message: "Activity content is not a record",
          }),
        );
      }
      const content = input.content;
      const runOption = yield* runRepo.get(sessionId).pipe(
        Effect.catchTags({
          "@Gateway/DatabaseError": (error: DatabaseError) =>
            Effect.fail(
              new LinearApiError({
                operation: "createActivity",
                message: error.message,
              }),
            ),
          "@Gateway/RowDecodeError": (error: RowDecodeError) =>
            Effect.fail(
              new LinearApiError({
                operation: "createActivity",
                message: error.message,
              }),
            ),
        }),
      );
      const run = yield* Option.match(runOption, {
        onNone: () =>
          Effect.fail(
            new LinearApiError({
              operation: "createActivity",
              message: `Unknown run ${sessionId}`,
            }),
          ),
        onSome: Effect.succeed,
      });
      yield* Effect.annotateCurrentSpan({
        "linear.organizationId": run.organizationId,
      });

      const contentRecord = yield* Effect.try({
        try: () => mapActivityContent(decodeActivityContent(content)),
        catch: (error) =>
          new LinearApiError({
            operation: "createActivity",
            message: error instanceof Error ? error.message : String(error),
          }),
      });

      const activityInput: Parameters<LinearClient["createAgentActivity"]>[0] =
        {
          agentSessionId: sessionId,
          content: contentRecord,
        };
      if (content.ephemeral === true) activityInput.ephemeral = true;
      const signal = isActivitySignal(content.signal)
        ? content.signal
        : undefined;
      if (signal !== undefined)
        activityInput.signal = mapActivitySignal(signal);
      if (isRecord(content.signalMetadata)) {
        activityInput.signalMetadata = content.signalMetadata;
      }

      const id = yield* withOrgQueue(
        run.organizationId,
        Effect.gen(function* () {
          const client = yield* clientFor(run.organizationId);
          return yield* withRateLimitRetry(
            Effect.tryPromise({
              try: async () => {
                const payload = await client.createAgentActivity(activityInput);
                if (!payload.success)
                  throw new Error("Linear failed to create agent activity");
                const id =
                  payload.agentActivityId ??
                  (payload.agentActivity
                    ? (await payload.agentActivity).id
                    : undefined);
                if (!id)
                  throw new Error("Linear did not return an agent activity id");
                return id;
              },
              catch: (error) => mapLinearError("createActivity", error),
            }),
          );
        }),
      );

      yield* Effect.logInfo("linear.createActivity").pipe(
        Effect.annotateLogs({
          sessionId,
          activityId: id,
        }),
      );
      return id;
    },
  );

  const listSessionActivities = Effect.fn(
    "LinearGateway.listSessionActivities",
  )(function* (input: {
    readonly sessionId: string;
  }): Effect.fn.Return<
    ReadonlyArray<ListedSessionActivity>,
    | InstallationRevokedError
    | LinearApiError
    | LinearRateLimitError
    | TokenRefreshError
  > {
    const sessionId = yield* Schema.decodeUnknownEffect(SessionId)(
      input.sessionId,
    ).pipe(
      Effect.catchTag(
        "SchemaError",
        (error) =>
          new LinearApiError({
            operation: "listSessionActivities",
            message: `Invalid session id: ${error.message}`,
          }),
      ),
    );
    yield* Effect.annotateCurrentSpan({ "linear.sessionId": sessionId });
    const runOption = yield* runRepo.get(sessionId).pipe(
      Effect.catchTags({
        "@Gateway/DatabaseError": (error: DatabaseError) =>
          Effect.fail(
            new LinearApiError({
              operation: "listSessionActivities",
              message: error.message,
            }),
          ),
        "@Gateway/RowDecodeError": (error: RowDecodeError) =>
          Effect.fail(
            new LinearApiError({
              operation: "listSessionActivities",
              message: error.message,
            }),
          ),
      }),
    );
    const run = yield* Option.match(runOption, {
      onNone: () =>
        Effect.fail(
          new LinearApiError({
            operation: "listSessionActivities",
            message: `Unknown run ${sessionId}`,
          }),
        ),
      onSome: Effect.succeed,
    });
    yield* Effect.annotateCurrentSpan({
      "linear.organizationId": run.organizationId,
    });

    const mapSignal = (value: unknown): ListedSessionActivity["signal"] => {
      if (typeof value !== "string") return null;
      const normalized = value.toLowerCase();
      return normalized === "auth" ||
        normalized === "continue" ||
        normalized === "select" ||
        normalized === "stop"
        ? normalized
        : null;
    };
    const mapActivity = (activity: {
      readonly id: unknown;
      readonly content: unknown;
      readonly signal?: unknown;
      readonly createdAt: unknown;
    }): ListedSessionActivity => {
      const content =
        typeof activity.content === "object" && activity.content !== null
          ? (activity.content as Record<string, unknown>)
          : {};
      const typename = content.__typename;
      const type: ListedSessionActivity["type"] =
        typename === "AgentActivityThoughtContent"
          ? "thought"
          : typename === "AgentActivityActionContent"
            ? "action"
            : typename === "AgentActivityElicitationContent"
              ? "elicitation"
              : typename === "AgentActivityResponseContent"
                ? "response"
                : typename === "AgentActivityErrorContent"
                  ? "error"
                  : typename === "AgentActivityPromptContent"
                    ? "prompt"
                    : "unknown";
      const body = typeof content.body === "string" ? content.body : null;
      const title = typeof content.title === "string" ? content.title : null;
      const createdAt =
        activity.createdAt instanceof Date
          ? activity.createdAt.toISOString()
          : typeof activity.createdAt === "string"
            ? activity.createdAt
            : String(activity.createdAt ?? "");
      return {
        id: typeof activity.id === "string" ? activity.id : String(activity.id),
        type,
        body,
        title,
        signal: mapSignal(activity.signal),
        createdAt,
      };
    };

    return yield* withOrgQueue(
      run.organizationId,
      Effect.gen(function* () {
        const client = yield* clientFor(run.organizationId);
        const result = yield* withRateLimitRetry(
          Effect.tryPromise({
            try: async () => {
              const activities: Array<ListedSessionActivity> = [];
              const session = await client.agentSession(sessionId);
              let after: string | undefined;
              let pages = 0;
              let capped = false;
              while (pages < LIST_SESSION_ACTIVITIES_MAX_PAGES) {
                const connection = await session.activities({
                  after,
                  first: 100,
                  orderBy: "createdAt",
                } as Parameters<typeof session.activities>[0]);
                pages += 1;
                for (const activity of connection.nodes) {
                  activities.push(mapActivity(activity));
                }
                if (!connection.pageInfo.hasNextPage) break;
                const next = connection.pageInfo.endCursor;
                if (!next || next === after) break;
                after = next;
                if (pages === LIST_SESSION_ACTIVITIES_MAX_PAGES) {
                  capped = true;
                }
              }
              return { activities, capped };
            },
            catch: (error) => mapLinearError("listSessionActivities", error),
          }),
        );
        if (result.capped) {
          yield* Effect.logDebug(
            "linear.listSessionActivities.pagination_capped",
          ).pipe(
            Effect.annotateLogs({
              sessionId,
              maxPages: LIST_SESSION_ACTIVITIES_MAX_PAGES,
            }),
          );
        }
        return result.activities;
      }),
    );
  });

  const updateSession = Effect.fn("LinearGateway.updateSession")(
    function* (input: {
      readonly sessionId: string;
      readonly plan?: ReadonlyArray<{
        readonly content: string;
        readonly status: string;
      }>;
      readonly externalUrls?: ReadonlyArray<{
        readonly label: string;
        readonly url: string;
      }>;
    }): Effect.fn.Return<
      void,
      | InstallationRevokedError
      | LinearApiError
      | LinearRateLimitError
      | TokenRefreshError
    > {
      const sessionId = yield* Schema.decodeUnknownEffect(SessionId)(
        input.sessionId,
      ).pipe(
        Effect.catchTag(
          "SchemaError",
          (error) =>
            new LinearApiError({
              operation: "updateSession",
              message: `Invalid session id: ${error.message}`,
            }),
        ),
      );
      yield* Effect.annotateCurrentSpan({ "linear.sessionId": sessionId });
      const runOption = yield* runRepo.get(sessionId).pipe(
        Effect.catchTags({
          "@Gateway/DatabaseError": (error: DatabaseError) =>
            Effect.fail(
              new LinearApiError({
                operation: "updateSession",
                message: error.message,
              }),
            ),
          "@Gateway/RowDecodeError": (error: RowDecodeError) =>
            Effect.fail(
              new LinearApiError({
                operation: "updateSession",
                message: error.message,
              }),
            ),
        }),
      );
      const run = yield* Option.match(runOption, {
        onNone: () =>
          Effect.fail(
            new LinearApiError({
              operation: "updateSession",
              message: `Unknown run ${sessionId}`,
            }),
          ),
        onSome: Effect.succeed,
      });
      yield* Effect.annotateCurrentSpan({
        "linear.organizationId": run.organizationId,
      });

      const updateInput: Parameters<LinearClient["updateAgentSession"]>[1] = {};
      if (input.plan !== undefined) {
        updateInput.plan = input.plan.map((item) => ({
          content: item.content,
          status: item.status,
        }));
      }
      if (input.externalUrls !== undefined) {
        updateInput.externalUrls = input.externalUrls.map((item) => ({
          label: item.label,
          url: item.url,
        }));
      }

      yield* withOrgQueue(
        run.organizationId,
        Effect.gen(function* () {
          const client = yield* clientFor(run.organizationId);
          return yield* withRateLimitRetry(
            Effect.tryPromise({
              try: async () => {
                const payload = await client.updateAgentSession(
                  sessionId,
                  updateInput,
                );
                if (!payload.success)
                  throw new Error("Linear failed to update agent session");
              },
              catch: (error) => mapLinearError("updateSession", error),
            }),
          );
        }),
      );

      yield* Effect.logInfo("linear.updateSession").pipe(
        Effect.annotateLogs({ sessionId }),
      );
    },
  );

  return { createActivity, listSessionActivities, updateSession };
};
