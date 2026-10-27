import { Effect, Option, Schema } from "effect";
import {
  type DatabaseError,
  LinearApiError,
  type RowDecodeError,
} from "../domain/errors.js";
import { SessionId } from "../domain/ids.js";
import { readBoundedBody } from "./bounded-body.js";
import type { makeLinearCore } from "./linear-gateway-core.js";
import { isRecord } from "./linear-helpers.js";
import {
  LINEAR_WORKSPACE_MUTATIONS,
  type LinearWorkspaceMutation,
  prepareLinearWorkspaceRead,
  validateLinearWorkspaceMutationInput,
} from "./linear-workspace-tools.js";

export const makeLinearWorkspace = ({
  runRepo,
  mapLinearError,
  ensureToken,
  withRateLimitRetry,
  withOrgQueue,
}: Effect.Success<typeof makeLinearCore>) => {
  const workspaceOperationContext = (sessionIdInput: string) =>
    Effect.gen(function* () {
      const sessionId = yield* Schema.decodeUnknownEffect(SessionId)(
        sessionIdInput,
      ).pipe(
        Effect.catchTag(
          "SchemaError",
          (error) =>
            new LinearApiError({
              operation: "workspaceOperation",
              message: `Invalid session id: ${error.message}`,
            }),
        ),
      );
      const runOption = yield* runRepo.get(sessionId).pipe(
        Effect.catchTags({
          "@Gateway/DatabaseError": (error: DatabaseError) =>
            Effect.fail(
              new LinearApiError({
                operation: "workspaceOperation",
                message: error.message,
              }),
            ),
          "@Gateway/RowDecodeError": (error: RowDecodeError) =>
            Effect.fail(
              new LinearApiError({
                operation: "workspaceOperation",
                message: error.message,
              }),
            ),
        }),
      );
      return yield* Option.match(runOption, {
        onNone: () =>
          Effect.fail(
            new LinearApiError({
              operation: "workspaceOperation",
              message: `Unknown run ${sessionId}`,
            }),
          ),
        onSome: Effect.succeed,
      });
    });

  const executeGraphql = (input: {
    readonly organizationId: string;
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
  }) =>
    Effect.gen(function* () {
      const installation = yield* ensureToken(input.organizationId);
      return yield* withRateLimitRetry(
        Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch("https://api.linear.app/graphql", {
              method: "POST",
              redirect: "error",
              signal,
              headers: {
                authorization: `Bearer ${installation.accessToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                query: input.query,
                variables: input.variables,
              }),
            });
            if (response.status === 429) {
              const retryAfter = Number(response.headers.get("retry-after"));
              throw {
                status: 429,
                retryAfter: Number.isFinite(retryAfter)
                  ? retryAfter
                  : undefined,
                type: "Ratelimited",
              };
            }
            if (!response.ok)
              throw Object.assign(
                new Error(`Linear GraphQL returned HTTP ${response.status}`),
                { status: response.status },
              );
            const body = await readBoundedBody(response, 1_048_576);
            const decoded: unknown = JSON.parse(new TextDecoder().decode(body));
            if (!isRecord(decoded))
              throw new Error("Linear GraphQL response is not an object");
            if (Array.isArray(decoded.errors) && decoded.errors.length > 0)
              throw new Error(
                `Linear GraphQL error: ${JSON.stringify(decoded.errors).slice(0, 4_000)}`,
              );
            return decoded.data ?? {};
          },
          catch: (error) => mapLinearError(input.operation, error),
        }),
      );
    });

  const workspaceRead = Effect.fn("LinearGateway.workspaceRead")(
    function* (input: {
      readonly sessionId: string;
      readonly operation: string;
      readonly input: unknown;
    }) {
      let read: ReturnType<typeof prepareLinearWorkspaceRead>;
      try {
        read = prepareLinearWorkspaceRead(input.operation, input.input);
      } catch (error) {
        return yield* Effect.fail(
          new LinearApiError({
            operation: "workspaceRead",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      if (Buffer.byteLength(JSON.stringify(read.variables), "utf8") > 65_536)
        return yield* Effect.fail(
          new LinearApiError({
            operation: "workspaceRead",
            message: "read input exceeds 64 KiB",
          }),
        );
      const run = yield* workspaceOperationContext(input.sessionId);
      return yield* withOrgQueue(
        run.organizationId,
        executeGraphql({
          organizationId: run.organizationId,
          operation: "workspaceRead",
          query: read.document,
          variables: read.variables,
        }),
      );
    },
  );

  const workspaceWrite = Effect.fn("LinearGateway.workspaceWrite")(
    function* (input: {
      readonly sessionId: string;
      readonly operation: LinearWorkspaceMutation;
      readonly id?: unknown;
      readonly input: unknown;
    }) {
      let validated: ReturnType<typeof validateLinearWorkspaceMutationInput>;
      try {
        validated = validateLinearWorkspaceMutationInput(
          input.operation,
          input.id,
          input.input,
        );
      } catch (error) {
        return yield* Effect.fail(
          new LinearApiError({
            operation: "workspaceWrite",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      if (Buffer.byteLength(JSON.stringify(validated), "utf8") > 65_536)
        return yield* Effect.fail(
          new LinearApiError({
            operation: "workspaceWrite",
            message: "mutation input exceeds 64 KiB",
          }),
        );
      const run = yield* workspaceOperationContext(input.sessionId);
      const definition = LINEAR_WORKSPACE_MUTATIONS[input.operation];
      return yield* withOrgQueue(
        run.organizationId,
        executeGraphql({
          organizationId: run.organizationId,
          operation: `workspaceWrite:${input.operation}`,
          query: definition.document,
          variables: {
            ...(validated.id === undefined ? {} : { id: validated.id }),
            input: validated.input,
          },
        }),
      );
    },
  );

  return {
    workspaceOperationContext,
    executeGraphql,
    workspaceRead,
    workspaceWrite,
  };
};
