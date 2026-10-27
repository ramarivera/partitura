import type { LinearClient } from "@linear/sdk";
import { Clock, Effect, Option, Ref, Schema } from "effect";
import {
  type DatabaseError,
  type InstallationRevokedError,
  LinearApiError,
  type LinearRateLimitError,
  type RowDecodeError,
  type TokenRefreshError,
} from "../domain/errors.js";
import { SessionId } from "../domain/ids.js";
import type { makeLinearActivity } from "./linear-gateway-activity.js";
import type { makeLinearCore } from "./linear-gateway-core.js";
import type { LinearIssue } from "./linear-gateway-types.js";
import type { makeLinearWorkspace } from "./linear-gateway-workspace.js";

const STARTED_STATES_CACHE_TTL_MS = 60 * 60 * 1000;
const STARTED_STATES_CACHE_MAX_TEAMS = 100;

export const makeLinearIssues = ({
  runRepo,
  startedStatesCache,
  rateLimitDelay,
  mapLinearError,
  clientFor,
  withRateLimitRetry,
  withOrgQueue,
}: Effect.Success<typeof makeLinearCore> &
  ReturnType<typeof makeLinearWorkspace> &
  ReturnType<typeof makeLinearActivity>) => {
  const teamStartedStates = Effect.fn("LinearGateway.teamStartedStates")(
    function* (input: {
      readonly sessionId: string;
      readonly teamId: string;
    }): Effect.fn.Return<
      ReadonlyArray<{ id: string; name: string; position: number }>,
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
              operation: "teamStartedStates",
              message: `Invalid session id: ${error.message}`,
            }),
        ),
      );
      const runOption = yield* runRepo.get(sessionId).pipe(
        Effect.catchTags({
          "@Gateway/DatabaseError": (error: DatabaseError) =>
            Effect.fail(
              new LinearApiError({
                operation: "teamStartedStates",
                message: error.message,
              }),
            ),
          "@Gateway/RowDecodeError": (error: RowDecodeError) =>
            Effect.fail(
              new LinearApiError({
                operation: "teamStartedStates",
                message: error.message,
              }),
            ),
        }),
      );
      const run = yield* Option.match(runOption, {
        onNone: () =>
          Effect.fail(
            new LinearApiError({
              operation: "teamStartedStates",
              message: `Unknown run ${sessionId}`,
            }),
          ),
        onSome: Effect.succeed,
      });
      const now = yield* Clock.currentTimeMillis;
      const cached = yield* Ref.get(startedStatesCache);
      const cacheKey = `${run.organizationId}:${input.teamId}`;
      const hit = cached.get(cacheKey);
      if (
        hit !== undefined &&
        now - hit.fetchedAt < STARTED_STATES_CACHE_TTL_MS
      ) {
        return hit.states;
      }
      const states = yield* withOrgQueue(
        run.organizationId,
        Effect.gen(function* () {
          const client = yield* clientFor(run.organizationId);
          return yield* withRateLimitRetry(
            Effect.tryPromise({
              try: async () => {
                const team = await client.team(input.teamId);
                if (!team)
                  throw new Error(`Linear team ${input.teamId} not found`);
                const connection = await team.states({
                  filter: { type: { eq: "started" } },
                  first: 50,
                });
                return connection.nodes
                  .map(
                    (state: {
                      id: string;
                      name: string;
                      position: number;
                    }) => ({
                      id: state.id,
                      name: state.name,
                      position: state.position,
                    }),
                  )
                  .sort(
                    (a: { position: number }, b: { position: number }) =>
                      a.position - b.position,
                  );
              },
              catch: (error) => mapLinearError("teamStartedStates", error),
            }),
          );
        }),
      );
      const fetchedAt = yield* Clock.currentTimeMillis;
      yield* Ref.update(startedStatesCache, (current) => {
        const next = new Map(current);
        if (
          !next.has(cacheKey) &&
          next.size >= STARTED_STATES_CACHE_MAX_TEAMS
        ) {
          let oldestCacheKey: string | undefined;
          let oldestFetchedAt = Number.POSITIVE_INFINITY;
          for (const [key, entry] of next) {
            if (entry.fetchedAt < oldestFetchedAt) {
              oldestCacheKey = key;
              oldestFetchedAt = entry.fetchedAt;
            }
          }
          if (oldestCacheKey !== undefined) next.delete(oldestCacheKey);
        }
        next.set(cacheKey, { states, fetchedAt });
        return next;
      });
      return states;
    },
  );

  const repositorySuggestions = Effect.fn(
    "LinearGateway.repositorySuggestions",
  )(function* (input: {
    readonly sessionId: string;
    readonly issueId: string;
    readonly candidates: ReadonlyArray<{
      readonly hostname: string;
      readonly repositoryFullName: string;
    }>;
  }): Effect.fn.Return<
    ReadonlyArray<{
      hostname: string;
      repositoryFullName: string;
      confidence: number;
    }>,
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
            operation: "repositorySuggestions",
            message: `Invalid session id: ${error.message}`,
          }),
      ),
    );
    const runOption = yield* runRepo.get(sessionId).pipe(
      Effect.catchTags({
        "@Gateway/DatabaseError": (error: DatabaseError) =>
          Effect.fail(
            new LinearApiError({
              operation: "repositorySuggestions",
              message: error.message,
            }),
          ),
        "@Gateway/RowDecodeError": (error: RowDecodeError) =>
          Effect.fail(
            new LinearApiError({
              operation: "repositorySuggestions",
              message: error.message,
            }),
          ),
      }),
    );
    const run = yield* Option.match(runOption, {
      onNone: () =>
        Effect.fail(
          new LinearApiError({
            operation: "repositorySuggestions",
            message: `Unknown run ${sessionId}`,
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
              const payload = await client.issueRepositorySuggestions(
                input.candidates.map((candidate) => ({
                  hostname: candidate.hostname,
                  repositoryFullName: candidate.repositoryFullName,
                })),
                input.issueId,
              );
              return payload.suggestions
                .filter(
                  (
                    suggestion,
                  ): suggestion is typeof suggestion & {
                    hostname: string;
                  } => typeof suggestion.hostname === "string",
                )
                .map((suggestion) => ({
                  hostname: suggestion.hostname,
                  repositoryFullName: suggestion.repositoryFullName,
                  confidence: suggestion.confidence,
                }))
                .sort((a, b) => b.confidence - a.confidence);
            },
            catch: (error) => mapLinearError("repositorySuggestions", error),
          }),
        );
      }),
    );
  });

  const getIssue = Effect.fn("LinearGateway.getIssue")(function* (input: {
    readonly sessionId: string;
    readonly issueId: string;
  }): Effect.fn.Return<
    LinearIssue,
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
            operation: "getIssue",
            message: `Invalid session id: ${error.message}`,
          }),
      ),
    );
    const issueId = input.issueId.trim();
    if (!issueId) {
      return yield* Effect.fail(
        new LinearApiError({
          operation: "getIssue",
          message: "Issue id is required",
        }),
      );
    }
    const runOption = yield* runRepo.get(sessionId).pipe(
      Effect.catchTags({
        "@Gateway/DatabaseError": (error: DatabaseError) =>
          Effect.fail(
            new LinearApiError({
              operation: "getIssue",
              message: error.message,
            }),
          ),
        "@Gateway/RowDecodeError": (error: RowDecodeError) =>
          Effect.fail(
            new LinearApiError({
              operation: "getIssue",
              message: error.message,
            }),
          ),
      }),
    );
    const run = yield* Option.match(runOption, {
      onNone: () =>
        Effect.fail(
          new LinearApiError({
            operation: "getIssue",
            message: `Unknown run ${sessionId}`,
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
              const issue = await client.issue(issueId);
              if (!issue) throw new Error(`Linear issue ${issueId} not found`);
              const state = issue.state ? await issue.state : null;
              const labelsConnection = await issue.labels();
              let projectId = issue.projectId ?? null;
              let projectLabels: string[] = [];
              try {
                const project = await issue.project;
                const labels = project ? await project.labels() : null;
                projectId ??= project?.id ?? null;
                projectLabels = labels?.nodes.map((label) => label.name) ?? [];
              } catch (error) {
                if (rateLimitDelay(error) !== null) throw error;
              }
              return {
                id: issue.id,
                identifier: issue.identifier ?? null,
                title: issue.title,
                description: issue.description ?? null,
                stateId: issue.stateId ?? state?.id ?? null,
                stateName: state?.name ?? null,
                stateType: state?.type ?? null,
                delegateId: issue.delegateId ?? null,
                url: issue.url ?? null,
                teamId: issue.teamId ?? null,
                projectId,
                projectLabels,
                labels: Array.isArray(labelsConnection?.nodes)
                  ? labelsConnection.nodes.map((label) => label.name)
                  : [],
              };
            },
            catch: (error) => mapLinearError("getIssue", error),
          }),
        );
      }),
    );
  });

  const updateIssue = Effect.fn("LinearGateway.updateIssue")(function* (input: {
    readonly sessionId: string;
    readonly issueId: string;
    readonly stateId?: string;
    readonly delegateId?: string | null;
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
            operation: "updateIssue",
            message: `Invalid session id: ${error.message}`,
          }),
      ),
    );
    const issueId = input.issueId.trim();
    if (!issueId) {
      return yield* Effect.fail(
        new LinearApiError({
          operation: "updateIssue",
          message: "Issue id is required",
        }),
      );
    }
    if (input.stateId === undefined && input.delegateId === undefined) {
      return yield* Effect.fail(
        new LinearApiError({
          operation: "updateIssue",
          message: "At least one issue field is required",
        }),
      );
    }
    const runOption = yield* runRepo.get(sessionId).pipe(
      Effect.catchTags({
        "@Gateway/DatabaseError": (error: DatabaseError) =>
          Effect.fail(
            new LinearApiError({
              operation: "updateIssue",
              message: error.message,
            }),
          ),
        "@Gateway/RowDecodeError": (error: RowDecodeError) =>
          Effect.fail(
            new LinearApiError({
              operation: "updateIssue",
              message: error.message,
            }),
          ),
      }),
    );
    const run = yield* Option.match(runOption, {
      onNone: () =>
        Effect.fail(
          new LinearApiError({
            operation: "updateIssue",
            message: `Unknown run ${sessionId}`,
          }),
        ),
      onSome: Effect.succeed,
    });
    const updateInput: Parameters<LinearClient["updateIssue"]>[1] = {};
    if (input.stateId !== undefined) updateInput.stateId = input.stateId;
    if (input.delegateId !== undefined)
      updateInput.delegateId = input.delegateId;
    yield* withOrgQueue(
      run.organizationId,
      Effect.gen(function* () {
        const client = yield* clientFor(run.organizationId);
        yield* withRateLimitRetry(
          Effect.tryPromise({
            try: async () => {
              const payload = await client.updateIssue(issueId, updateInput);
              if (!payload.success)
                throw new Error("Linear failed to update issue");
            },
            catch: (error) => mapLinearError("updateIssue", error),
          }),
        );
      }),
    );
  });

  return { teamStartedStates, repositorySuggestions, getIssue, updateIssue };
};
