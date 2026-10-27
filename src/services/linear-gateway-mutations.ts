import { Effect, Option, Schema } from "effect";
import {
  type DatabaseError,
  type InstallationRevokedError,
  LinearApiError,
  type LinearRateLimitError,
  type RowDecodeError,
  type TokenRefreshError,
} from "../domain/errors.js";
import { IssueId, SessionId } from "../domain/ids.js";
import type { makeLinearActivity } from "./linear-gateway-activity.js";
import type { makeLinearCore } from "./linear-gateway-core.js";
import type { makeLinearIssues } from "./linear-gateway-issues.js";
import type { makeLinearWorkspace } from "./linear-gateway-workspace.js";

export const makeLinearMutations = ({
  runRepo,
  mapLinearError,
  ensureToken,
  clientFor,
  withRateLimitRetry,
  withOrgQueue,
}: Effect.Success<typeof makeLinearCore> &
  ReturnType<typeof makeLinearWorkspace> &
  ReturnType<typeof makeLinearActivity> &
  ReturnType<typeof makeLinearIssues>) => {
  const addSessionExternalUrls = Effect.fn(
    "LinearGateway.addSessionExternalUrls",
  )(function* (input: {
    readonly sessionId: string;
    readonly urls: ReadonlyArray<{
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
            operation: "addSessionExternalUrls",
            message: `Invalid session id: ${error.message}`,
          }),
      ),
    );
    if (input.urls.length === 0) return;
    const runOption = yield* runRepo.get(sessionId).pipe(
      Effect.catchTags({
        "@Gateway/DatabaseError": (error: DatabaseError) =>
          Effect.fail(
            new LinearApiError({
              operation: "addSessionExternalUrls",
              message: error.message,
            }),
          ),
        "@Gateway/RowDecodeError": (error: RowDecodeError) =>
          Effect.fail(
            new LinearApiError({
              operation: "addSessionExternalUrls",
              message: error.message,
            }),
          ),
      }),
    );
    const run = yield* Option.match(runOption, {
      onNone: () =>
        Effect.fail(
          new LinearApiError({
            operation: "addSessionExternalUrls",
            message: `Unknown run ${sessionId}`,
          }),
        ),
      onSome: Effect.succeed,
    });
    yield* withOrgQueue(
      run.organizationId,
      Effect.gen(function* () {
        const client = yield* clientFor(run.organizationId);
        yield* withRateLimitRetry(
          Effect.tryPromise({
            try: async () => {
              const payload = await client.updateAgentSession(sessionId, {
                addedExternalUrls: input.urls.map((item) => ({
                  label: item.label,
                  url: item.url,
                })),
              });
              if (!payload.success)
                throw new Error("Linear failed to update agent session");
            },
            catch: (error) => mapLinearError("addSessionExternalUrls", error),
          }),
        );
      }),
    );
  });

  const createIssueComment = Effect.fn("LinearGateway.createIssueComment")(
    function* (input: {
      readonly sessionId: string;
      readonly body: string;
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
              operation: "createIssueComment",
              message: `Invalid session id: ${error.message}`,
            }),
        ),
      );
      const runOption = yield* runRepo.get(sessionId).pipe(
        Effect.catchTags({
          "@Gateway/DatabaseError": (error: DatabaseError) =>
            Effect.fail(
              new LinearApiError({
                operation: "createIssueComment",
                message: error.message,
              }),
            ),
          "@Gateway/RowDecodeError": (error: RowDecodeError) =>
            Effect.fail(
              new LinearApiError({
                operation: "createIssueComment",
                message: error.message,
              }),
            ),
        }),
      );
      const run = yield* Option.match(runOption, {
        onNone: () =>
          Effect.fail(
            new LinearApiError({
              operation: "createIssueComment",
              message: `Unknown run ${sessionId}`,
            }),
          ),
        onSome: Effect.succeed,
      });
      const issueId = yield* Option.match(run.issueId, {
        onNone: () =>
          Effect.fail(
            new LinearApiError({
              operation: "createIssueComment",
              message: `Run ${sessionId} is not linked to a Linear issue`,
            }),
          ),
        onSome: Effect.succeed,
      });

      return yield* withOrgQueue(
        run.organizationId,
        Effect.gen(function* () {
          const client = yield* clientFor(run.organizationId);
          return yield* withRateLimitRetry(
            Effect.tryPromise({
              try: async () => {
                const payload = await client.createComment({
                  issueId,
                  body: input.body,
                });
                if (!payload.success)
                  throw new Error("Linear failed to create issue comment");
                const comment = await payload.comment;
                if (!comment?.id)
                  throw new Error("Linear did not return a comment id");
                return comment.id;
              },
              catch: (error) => mapLinearError("createIssueComment", error),
            }),
          );
        }),
      );
    },
  );

  const refreshInstallation = Effect.fn("LinearGateway.refreshInstallation")(
    function* (
      organizationId: string,
    ): Effect.fn.Return<string, InstallationRevokedError | TokenRefreshError> {
      yield* Effect.annotateCurrentSpan({
        "linear.organizationId": organizationId,
      });
      const installation = yield* ensureToken(organizationId);
      yield* Effect.logInfo("linear.refreshInstallation").pipe(
        Effect.annotateLogs({ organizationId }),
      );
      return installation.accessToken;
    },
  );

  const createSessionOnIssue = Effect.fn("LinearGateway.createSessionOnIssue")(
    function* (input: {
      readonly organizationId: string;
      readonly issueId: string;
    }): Effect.fn.Return<
      string,
      | InstallationRevokedError
      | LinearApiError
      | LinearRateLimitError
      | TokenRefreshError
    > {
      const issueId = yield* Schema.decodeUnknownEffect(IssueId)(
        input.issueId,
      ).pipe(
        Effect.catchTag(
          "SchemaError",
          (error) =>
            new LinearApiError({
              operation: "createSessionOnIssue",
              message: `Invalid issue id: ${error.message}`,
            }),
        ),
      );
      yield* Effect.annotateCurrentSpan({
        "linear.organizationId": input.organizationId,
        "linear.issueId": issueId,
      });

      const newSessionId = yield* withOrgQueue(
        input.organizationId,
        Effect.gen(function* () {
          const client = yield* clientFor(input.organizationId);
          return yield* withRateLimitRetry(
            Effect.tryPromise({
              try: async () => {
                const payload = await client.agentSessionCreateOnIssue({
                  issueId,
                });
                if (!payload.success)
                  throw new Error(
                    "Linear failed to create agent session on issue",
                  );
                const id = payload.agentSessionId;
                if (!id)
                  throw new Error("Linear did not return an agent session id");
                return id;
              },
              catch: (error) =>
                mapLinearError("agentSessionCreateOnIssue", error),
            }),
          );
        }),
      );

      yield* Effect.logInfo("linear.createSessionOnIssue").pipe(
        Effect.annotateLogs({
          organizationId: input.organizationId,
          issueId,
          newSessionId,
        }),
      );
      return newSessionId;
    },
  );

  return {
    addSessionExternalUrls,
    createIssueComment,
    refreshInstallation,
    createSessionOnIssue,
  };
};
