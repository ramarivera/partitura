import { Clock, Effect, Option, Schema } from "effect";
import type { SessionId } from "../domain/ids.js";
import type { AgentRun } from "../domain/models.js";
import { type GatewayConfigShape, organizationAllowed } from "./config.js";
import { deliverNativeArtifact } from "./native-build-client.js";
import { NativeOperationError, nativeIO } from "./native-build-errors.js";
import type { NativeBuildJobs } from "./native-build-jobs.js";
import {
  type NativeRegistryJob,
  terminalNativeJob,
} from "./native-build-state.js";
import type { RpcHostToolCall, RpcHostToolResult } from "./rpc-worker.js";
import type { RunRepo } from "./store/repositories.js";

const Builder = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/u),
);
const Start = Schema.Struct({
  builder: Schema.optionalKey(Builder),
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  pullRequest: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 99999999 }),
  ),
  action: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/u)),
});
const Follow = Schema.Struct({
  builder: Schema.optionalKey(Builder),
  job: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
});
const project = (job: NativeRegistryJob) => ({
  job: job.jobId,
  builder: job.builderId,
  state: job.state,
  commit: job.commit,
  pullRequest: job.pullRequest,
  action: job.action,
  ...(job.failureCode ? { failureCode: job.failureCode } : {}),
});
const result = (data: unknown): RpcHostToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  details: data,
});

/** Every invocation resolves live desired state or durable ownership. No captured defaults/clients. */
export const callRegistryNativeTool = Effect.fn(
  "SessionAuthority.registryNativeTool",
)(function* (
  deps: {
    readonly config: GatewayConfigShape;
    readonly owner: string;
    readonly jobs: NativeBuildJobs["Service"] | undefined;
    readonly runRepo: Pick<RunRepo["Service"], "get">;
    readonly withSessionMutationGate: <A, E, R>(
      session: SessionId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly repositoryAgeIdentity: (run: AgentRun) => string | undefined;
    readonly sandboxed: boolean;
    readonly workspacePath: string;
    readonly workerUid: string | undefined;
  },
  run: AgentRun,
  request: RpcHostToolCall,
): Effect.fn.Return<RpcHostToolResult> {
  return yield* deps
    .withSessionMutationGate(
      run.sessionId,
      Effect.gen(function* () {
        const current = yield* deps.runRepo.get(run.sessionId);
        const now = yield* Clock.currentTimeMillis;
        if (
          Option.isNone(current) ||
          current.value.organizationId !== run.organizationId ||
          !organizationAllowed(deps.config, current.value.organizationId) ||
          current.value.desiredState === "canceled" ||
          ["succeeded", "failed", "canceled"].includes(current.value.state) ||
          Option.getOrUndefined(current.value.leaseOwner) !== deps.owner ||
          Option.getOrElse(current.value.leaseExpiresAt, () => 0) <= now
        )
          return yield* Effect.fail(
            NativeOperationError.new("native-run-closed"),
          );
        const jobs = deps.jobs;
        if (!jobs)
          return yield* Effect.fail(
            NativeOperationError.new("native-registry-unavailable"),
          );
        if (request.toolName === "native_build_builders") {
          yield* Schema.decodeUnknownEffect(Schema.Struct({}))(
            request.arguments,
            { onExcessProperty: "error" },
          );
          return result(jobs.availability());
        }
        if (request.toolName === "native_build_start") {
          const input = yield* Schema.decodeUnknownEffect(Start)(
            request.arguments,
            { onExcessProperty: "error" },
          );
          const identity = deps.repositoryAgeIdentity(current.value);
          return result(
            project(
              yield* jobs.start({
                ...input,
                organizationId: current.value.organizationId,
                sessionId: run.sessionId,
                workspacePath: deps.workspacePath,
                ...(deps.workerUid ? { workerUid: deps.workerUid } : {}),
                ...(identity
                  ? { secretFiles: { "repository-age-identity": identity } }
                  : {}),
              }),
            ),
          );
        }
        const input = yield* Schema.decodeUnknownEffect(Follow)(
          request.arguments,
          { onExcessProperty: "error" },
        );
        const owned = yield* jobs.status(
          current.value.organizationId,
          run.sessionId,
          input.job,
          input.builder,
        );
        switch (request.toolName) {
          case "native_build_status":
            return result(project(owned));
          case "native_build_cancel": {
            if (terminalNativeJob(owned))
              return result({
                ...project(owned),
                cancellationRequested: false,
              });
            yield* jobs.cancel(
              current.value.organizationId,
              run.sessionId,
              input.job,
              input.builder,
            );
            return result({
              ...project(
                yield* jobs.status(
                  current.value.organizationId,
                  run.sessionId,
                  input.job,
                  input.builder,
                ),
              ),
              cancellationRequested: true,
            });
          }
          case "native_build_artifact": {
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const published = yield* jobs.artifact(
                  current.value.organizationId,
                  run.sessionId,
                  input.job,
                  input.builder,
                );
                if (
                  published.bytes === undefined ||
                  published.sha256 === undefined
                )
                  return yield* Effect.fail(
                    NativeOperationError.new("native-artifact-unavailable"),
                  );
                const verified = {
                  ...published,
                  bytes: published.bytes,
                  sha256: published.sha256,
                };
                const artifact = yield* nativeIO(() =>
                  deliverNativeArtifact(
                    { artifact: async () => verified },
                    {
                      sessionId: run.sessionId,
                      job: input.job,
                      workspacePath: deps.workspacePath,
                      ...(deps.workerUid ? { workerUid: deps.workerUid } : {}),
                    },
                  ),
                );
                return result({
                  ...artifact,
                  builder: owned.builderId,
                  path: deps.sandboxed
                    ? `/workspace/.omp-home/native-build/${input.job}.tar`
                    : artifact.path,
                });
              }),
            );
          }
          default:
            return yield* Effect.fail(
              NativeOperationError.new("native-tool-unknown"),
            );
        }
      }),
    )
    .pipe(
      Effect.catch((error) =>
        Effect.logWarning("Native tool request refused", {
          code:
            error instanceof NativeOperationError
              ? error.reason
              : "native-tool-unavailable",
        }).pipe(
          Effect.as({
            content: [
              { type: "text", text: "Native build operation unavailable" },
            ],
            isError: true,
          }),
        ),
      ),
    );
});
