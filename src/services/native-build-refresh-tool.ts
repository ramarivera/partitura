import { createHash } from "node:crypto";
import { Clock, Effect, Option } from "effect";
import type { SessionId } from "../domain/ids.js";
import type { AgentRun } from "../domain/models.js";
import { type GatewayConfigShape, organizationAllowed } from "./config.js";
import type { NativeBuildFleet } from "./native-build-fleet.js";
import { NativeFleetError } from "./native-build-fleet-models.js";
import type { RpcHostToolDefinition, RpcHostToolResult } from "./rpc-worker.js";
import type { RunRepo } from "./store/repositories.js";

export const nativeBuildRefreshTool: RpcHostToolDefinition = {
  name: "native_build_refresh",
  label: "Native builders: refresh credentials",
  description:
    "Explicitly refresh builder credentials. Restricted to gateway administrators. Poll refresh progress through the browser admin page. Does not start or retry builds.",
  parameters: {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["scope", "builder"],
        properties: {
          scope: { const: "builder" },
          builder: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["scope"],
        properties: { scope: { const: "all" } },
      },
    ],
  },
};
export const nativeRefreshAdvertised = (
  config: GatewayConfigShape,
  organizationId: string,
  fleet: NativeBuildFleet["Service"] | undefined,
) =>
  fleet !== undefined &&
  organizationAllowed(config, organizationId) &&
  config.gatewayAdminOrganizationIds?.has(organizationId) === true;

export const callNativeRefresh = Effect.fn("SessionAuthority.nativeRefresh")(
  function* (
    deps: {
      readonly config: GatewayConfigShape;
      readonly owner: string;
      readonly fleet: NativeBuildFleet["Service"] | undefined;
      readonly runRepo: Pick<RunRepo["Service"], "get">;
      readonly withSessionMutationGate: <A, E, R>(
        sessionId: SessionId,
        effect: Effect.Effect<A, E, R>,
      ) => Effect.Effect<A, E, R>;
    },
    run: AgentRun,
    input: unknown,
  ): Effect.fn.Return<RpcHostToolResult, never> {
    const result = yield* deps
      .withSessionMutationGate(
        run.sessionId,
        Effect.gen(function* () {
          // Reject forged/stale scope before builder lookup or budget consumption.
          if (
            !nativeRefreshAdvertised(
              deps.config,
              run.organizationId,
              deps.fleet,
            )
          )
            return yield* Effect.fail(
              NativeFleetError.new("fleet-forbidden", 403),
            );
          const current = yield* deps.runRepo.get(run.sessionId);
          const now = yield* Clock.currentTimeMillis;
          if (
            Option.isNone(current) ||
            current.value.organizationId !== run.organizationId ||
            !nativeRefreshAdvertised(
              deps.config,
              current.value.organizationId,
              deps.fleet,
            ) ||
            current.value.desiredState === "canceled" ||
            ["succeeded", "failed", "canceled"].includes(current.value.state) ||
            Option.getOrUndefined(current.value.leaseOwner) !== deps.owner ||
            Option.getOrElse(current.value.leaseExpiresAt, () => 0) <= now
          )
            return yield* Effect.fail(
              NativeFleetError.new("fleet-run-closed", 403),
            );
          if (!deps.fleet)
            return yield* Effect.fail(NativeFleetError.new("fleet-disabled"));
          return yield* deps.fleet.refresh(
            {
              kind: "agent",
              organizationId: current.value.organizationId,
              sessionHash: createHash("sha256")
                .update(run.sessionId)
                .digest("base64url"),
            },
            input,
          );
        }),
      )
      .pipe(
        Effect.match({
          onFailure: (error) => ({
            content: [
              {
                type: "text" as const,
                text:
                  error instanceof NativeFleetError
                    ? error.code
                    : "fleet-unavailable",
              },
            ],
            isError: true,
          }),
          onSuccess: (result) => ({
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            details: result,
          }),
        }),
      );
    return result;
  },
);
