import { Effect, Option, Ref } from "effect";
import { RpcProtocolError } from "../domain/errors.js";
import type { SessionId } from "../domain/ids.js";
import type { AgentRun } from "../domain/models.js";
import type { GatewayConfig } from "./config.js";
import type { GitHubApp } from "./github-app.js";
import {
  createGitHubPullRequest,
  githubCreatePullRequestToolDefinition,
} from "./github-workspace-tools.js";
import type { LinearGateway } from "./linear-gateway.js";
import {
  LINEAR_WORKSPACE_MUTATIONS,
  LINEAR_WORKSPACE_TOOLS,
  type LinearWorkspaceMutation,
} from "./linear-workspace-tools.js";
import {
  type createNativeBuildClient,
  deliverNativeArtifact,
} from "./native-build-client.js";
import type { NativeBuildFleet } from "./native-build-fleet.js";
import {
  callNativeRefresh,
  nativeBuildRefreshTool,
  nativeRefreshAdvertised,
} from "./native-build-refresh-tool.js";
import type {
  RpcHostToolCall,
  RpcHostToolDefinition,
  RpcHostToolResult,
} from "./rpc-worker.js";
import { record } from "./session-authority-helpers.js";
import type { SessionSandboxHandle } from "./session-sandbox.js";
import type { RunRepo, WorkspaceRepo } from "./store/repositories.js";
import {
  type makeT3DeviceBackup,
  t3DeviceBackupResult,
  t3DeviceBackupTool,
} from "./t3-device-backup.js";
import { parseRepositorySuggestionCandidate } from "./workspace.js";

type NativeBuilder = "primary" | "backup";
export const makeLinearHostToolsForRun = ({
  deviceBackup,
  config,
  owner,
  nativeFleet,
  withSessionMutationGate,
  runRepo,
  workspaceRepo,
  githubAppOption,
  runPromise,
  getNativeBuildClient,
  repositoryAgeIdentity,
  nativeBuildJobs,
  sandboxHandles,
  linearOption,
  reportedPullRequestUrlsRef,
}: {
  owner: string;
  nativeFleet?: NativeBuildFleet["Service"];
  deviceBackup: ReturnType<typeof makeT3DeviceBackup> | undefined;
  config: GatewayConfig["Service"];
  withSessionMutationGate: <A, E, R>(
    sessionId: SessionId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  runRepo: RunRepo["Service"];
  workspaceRepo: WorkspaceRepo["Service"];
  githubAppOption: Option.Option<GitHubApp["Service"]>;
  runPromise: ReturnType<typeof Effect.runPromiseWith<never>>;
  getNativeBuildClient: (
    builder: NativeBuilder,
  ) => ReturnType<typeof createNativeBuildClient>;
  repositoryAgeIdentity: (run: AgentRun) => string | undefined;
  nativeBuildJobs: Map<
    SessionId,
    Map<string, { builder: NativeBuilder; job: string }>
  >;
  sandboxHandles: Map<SessionId, SessionSandboxHandle>;
  linearOption: Option.Option<LinearGateway["Service"]>;
  reportedPullRequestUrlsRef: Ref.Ref<
    ReadonlyMap<SessionId, ReadonlySet<string>>
  >;
}) => {
  return (
    run: AgentRun,
    workspacePath: string,
    workerUid: string | undefined,
  ) => {
    const textResult = (
      text: string,
      details?: unknown,
      isError = false,
    ): RpcHostToolResult => ({
      content: [{ type: "text", text }],
      ...(details === undefined ? {} : { details }),
      ...(isError ? { isError: true } : {}),
    });
    const linearDefinitions: ReadonlyArray<RpcHostToolDefinition> = [
      ...LINEAR_WORKSPACE_TOOLS,
      {
        name: "linear_get_issue",
        label: "Linear: get issue",
        description:
          "Read a Linear issue visible to this installation, including state, team, and labels.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["issueId"],
          properties: { issueId: { type: "string", minLength: 1 } },
        },
      },
      {
        name: "linear_create_comment",
        label: "Linear: create comment",
        description: "Post a comment to the Linear issue for this run.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["body"],
          properties: { body: { type: "string", minLength: 1 } },
        },
      },
      {
        name: "linear_update_issue",
        label: "Linear: update issue",
        description:
          "Update the workflow state or delegation of this run's issue.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            stateId: { type: "string", minLength: 1 },
            delegateId: { type: ["string", "null"] },
          },
          anyOf: [{ required: ["stateId"] }, { required: ["delegateId"] }],
        },
      },
      {
        name: "linear_add_external_url",
        label: "Linear: add external URL",
        description:
          "Append an http(s) artifact URL to this run's Linear session.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["label", "url"],
          properties: {
            label: { type: "string", minLength: 1 },
            url: { type: "string", pattern: "^https?://" },
          },
        },
      },
    ];
    const definitions: ReadonlyArray<RpcHostToolDefinition> = [
      ...(nativeRefreshAdvertised(config, run.organizationId, nativeFleet)
        ? [nativeBuildRefreshTool]
        : []),
      ...linearDefinitions,
      githubCreatePullRequestToolDefinition,
      ...(deviceBackup === undefined ||
      config.t3DeviceBackup?.organizationHosts[run.organizationId] === undefined
        ? []
        : [t3DeviceBackupTool]),
      ...(config.nativeBuild === undefined
        ? []
        : ([
            {
              name: "native_build_start",
              label: "Native build: start",
              description:
                "Run the repository's .partitura/native-build.sh action in an isolated macOS VM for this commit and pull request. Select primary or the separately configured backup builder explicitly. No automatic failover. Use the same builder for later status, artifact and cancel calls.",
              parameters: {
                type: "object",
                additionalProperties: false,
                required: ["commit", "pullRequest", "action"],
                properties: {
                  builder: { type: "string", enum: ["primary", "backup"] },
                  commit: {
                    type: "string",
                    pattern: "^[a-f0-9]{40}$",
                  },
                  pullRequest: {
                    type: "integer",
                    minimum: 1,
                    maximum: 99999999,
                  },
                  action: {
                    type: "string",
                    pattern: "^[a-z][a-z0-9-]{0,63}$",
                  },
                },
              },
            },
            {
              name: "native_build_status",
              label: "Native build: status",
              description: "Read a native build job owned by this session.",
              parameters: {
                type: "object",
                additionalProperties: false,
                required: ["job"],
                properties: {
                  builder: { type: "string", enum: ["primary", "backup"] },
                  job: { type: "string", pattern: "^[a-f0-9]{32}$" },
                },
              },
            },
            {
              name: "native_build_artifact",
              label: "Native build: deliver artifact",
              description:
                "Copy a verified native build archive into this session workspace. After a workflow-failed job, the archive holds the repository build log (build.log, last 1 MiB) and guest runner stderr (runner.log).",
              parameters: {
                type: "object",
                additionalProperties: false,
                required: ["job"],
                properties: {
                  builder: { type: "string", enum: ["primary", "backup"] },
                  job: { type: "string", pattern: "^[a-f0-9]{32}$" },
                },
              },
            },
            {
              name: "native_build_cancel",
              label: "Native build: cancel",
              description: "Cancel a native build job owned by this session.",
              parameters: {
                type: "object",
                additionalProperties: false,
                required: ["job"],
                properties: {
                  builder: { type: "string", enum: ["primary", "backup"] },
                  job: { type: "string", pattern: "^[a-f0-9]{32}$" },
                },
              },
            },
          ] satisfies ReadonlyArray<RpcHostToolDefinition>)),
    ];

    const handler = (request: RpcHostToolCall) =>
      Effect.gen(function* () {
        const fail = (message: string) => textResult(message, undefined, true);
        const raw = request.arguments;
        if (request.toolName === "native_build_refresh")
          return yield* callNativeRefresh(
            {
              config,
              owner,
              fleet: nativeFleet,
              runRepo,
              withSessionMutationGate,
            },
            run,
            raw,
          );
        if (request.toolName === "t3_device_backup") {
          if (deviceBackup === undefined)
            return fail("T3 device backup is disabled");
          return yield* withSessionMutationGate(
            run.sessionId,
            Effect.gen(function* () {
              const current = yield* runRepo.get(run.sessionId);
              if (
                Option.isNone(current) ||
                current.value.desiredState === "canceled" ||
                ["succeeded", "failed", "canceled"].includes(
                  current.value.state,
                )
              )
                return fail("Run is finished; device operations are refused");
              const result = yield* deviceBackup.call(
                run.organizationId,
                run.sessionId,
                raw,
              );
              return t3DeviceBackupResult(result);
            }).pipe(
              Effect.catch(() =>
                Effect.succeed(
                  fail(
                    "T3 device backup failed. Check its configured host, device ownership, and server access. Inspect the device before retrying input because dispatch may have occurred.",
                  ),
                ),
              ),
            ),
          );
        }
        if (request.toolName === "github_create_pull_request") {
          return yield* withSessionMutationGate(
            run.sessionId,
            Effect.gen(function* () {
              const current = yield* runRepo.get(run.sessionId);
              if (Option.isNone(current)) return fail("Run no longer exists");
              const latest = current.value;
              if (
                latest.desiredState === "canceled" ||
                ["succeeded", "failed", "canceled"].includes(latest.state)
              )
                return fail(
                  "Run is finished; pull request creation is refused",
                );
              if (Option.isNone(latest.repositoryId))
                return fail("Run has no configured repository");
              const repository = yield* workspaceRepo.getRepository(
                latest.organizationId,
                latest.repositoryId.value,
              );
              if (Option.isNone(repository) || Option.isNone(githubAppOption))
                return fail("GitHub repository credentials are unavailable");
              const github = githubAppOption.value;
              const result = yield* Effect.tryPromise({
                try: (signal) =>
                  createGitHubPullRequest(
                    {
                      repository: repository.value,
                      getToken: (boundRepository) => {
                        const candidate = parseRepositorySuggestionCandidate(
                          boundRepository.url,
                        );
                        const [owner, name] =
                          candidate?.repositoryFullName.split("/") ?? [];
                        if (owner === undefined || name === undefined)
                          return Promise.reject(
                            new RpcProtocolError({
                              method: "github_create_pull_request",
                              message: "Invalid repository",
                            }),
                          );
                        return runPromise(
                          github.getInstallationToken(
                            owner,
                            name,
                            latest.organizationId,
                          ),
                          { signal },
                        );
                      },
                      signal,
                    },
                    raw,
                  ),
                catch: () =>
                  new RpcProtocolError({
                    method: "github_create_pull_request",
                    message: "Unable to create GitHub pull request",
                  }),
              });
              return textResult(JSON.stringify(result), result);
            }).pipe(
              Effect.catch(() =>
                Effect.succeed(fail("Unable to create GitHub pull request")),
              ),
            ),
          );
        }
        if (request.toolName.startsWith("native_build_")) {
          if (config.nativeBuild === undefined)
            return fail("Native build tools are disabled");
          if (
            raw.builder !== undefined &&
            raw.builder !== "primary" &&
            raw.builder !== "backup"
          )
            return fail("Invalid native builder");
          const builder = raw.builder === "backup" ? "backup" : "primary";
          if (builder === "backup" && config.nativeBuildBackup === undefined)
            return fail("The backup native builder is disabled");
          const job = raw.job;
          const nativeOperation = Effect.promise(async () => {
            try {
              if (workspacePath === undefined)
                return fail("Native build workspace is unavailable");
              const client = await getNativeBuildClient(builder);
              switch (request.toolName) {
                case "native_build_start": {
                  if (
                    typeof raw.commit !== "string" ||
                    typeof raw.pullRequest !== "number" ||
                    typeof raw.action !== "string" ||
                    !/^[a-z][a-z0-9-]{0,63}$/u.test(raw.action)
                  )
                    return fail("Invalid native build request");
                  const identity = repositoryAgeIdentity(run);
                  const started = await client.start({
                    sessionId: run.sessionId,
                    workspacePath,
                    ...(workerUid === undefined ? {} : { workerUid }),
                    ...(identity === undefined
                      ? {}
                      : {
                          secretFiles: {
                            "repository-age-identity": identity,
                          },
                        }),
                    commit: raw.commit,
                    pullRequest: raw.pullRequest,
                    action: raw.action,
                  });
                  const jobs =
                    nativeBuildJobs.get(run.sessionId) ??
                    new Map<string, { builder: NativeBuilder; job: string }>();
                  jobs.set(`${builder}:${started.job}`, {
                    builder,
                    job: started.job,
                  });
                  nativeBuildJobs.set(run.sessionId, jobs);
                  const result = { ...started, builder };
                  return textResult(JSON.stringify(result), result);
                }
                case "native_build_status": {
                  if (typeof job !== "string") return fail("job is required");
                  const status = await client.status(run.sessionId, job);
                  const result = { ...status, builder };
                  return textResult(JSON.stringify(result), result);
                }
                case "native_build_artifact": {
                  if (typeof job !== "string") return fail("job is required");
                  const artifact = await deliverNativeArtifact(client, {
                    sessionId: run.sessionId,
                    job,
                    workspacePath,
                    ...(workerUid === undefined ? {} : { workerUid }),
                  });
                  nativeBuildJobs
                    .get(run.sessionId)
                    ?.delete(`${builder}:${job}`);
                  const workerArtifact = {
                    builder,
                    path: sandboxHandles.has(run.sessionId)
                      ? `/workspace/.omp-home/native-build/${job}.tar`
                      : artifact.path,
                    sha256: artifact.sha256,
                    bytes: artifact.bytes,
                  };
                  return textResult(
                    JSON.stringify(workerArtifact),
                    workerArtifact,
                  );
                }
                case "native_build_cancel": {
                  if (typeof job !== "string") return fail("job is required");
                  await client.cancel(run.sessionId, job);
                  nativeBuildJobs
                    .get(run.sessionId)
                    ?.delete(`${builder}:${job}`);
                  return textResult("Native build canceled");
                }
                default:
                  return fail(`Unknown native build tool: ${request.toolName}`);
              }
            } catch {
              return fail("Native build operation failed");
            }
          });
          if (
            request.toolName === "native_build_start" ||
            request.toolName === "native_build_artifact" ||
            request.toolName === "native_build_cancel"
          )
            return yield* withSessionMutationGate(
              run.sessionId,
              Effect.gen(function* () {
                const latest = yield* runRepo.get(run.sessionId).pipe(
                  Effect.map((value) => ({ ok: true as const, value })),
                  Effect.catch(() =>
                    Effect.succeed({
                      ok: false as const,
                      result: fail("Unable to read run state"),
                    }),
                  ),
                );
                if (!latest.ok) return latest.result;
                if (Option.isNone(latest.value))
                  return fail("Run no longer exists");
                const current = latest.value.value;
                if (
                  current.desiredState === "canceled" ||
                  ["canceled", "failed", "succeeded"].includes(current.state)
                )
                  return fail("Run has stopped");
                return yield* nativeOperation;
              }),
            );
          return yield* nativeOperation;
        }
        if (Option.isNone(linearOption))
          return fail("Linear gateway is unavailable");
        // Host-tool callbacks intentionally turn infrastructure failures
        // into an isError result for the model; they must not masquerade
        // as an absent run.
        const current = yield* runRepo.get(run.sessionId).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              result: fail(`Unable to read run state: ${String(error)}`),
            }),
          ),
        );
        if (!current.ok) return current.result;
        if (Option.isNone(current.value)) return fail("Run no longer exists");
        const currentRun = current.value.value;
        const issueId = Option.isSome(currentRun.issueId)
          ? currentRun.issueId.value
          : null;
        const mutating =
          request.toolName === "linear_create_comment" ||
          request.toolName === "linear_update_issue" ||
          request.toolName === "linear_add_external_url" ||
          request.toolName === "linear_workspace_write";
        const linear = linearOption.value;
        const dispatch: Effect.Effect<RpcHostToolResult, never, never> =
          Effect.gen(function* () {
            switch (request.toolName) {
              case "linear_workspace_read": {
                const operation = raw.operation;
                if (typeof operation !== "string")
                  return fail("operation must be a string");
                if (!record(raw.input)) return fail("input must be an object");
                return yield* linear
                  .workspaceRead({
                    sessionId: run.sessionId,
                    operation,
                    input: raw.input,
                  })
                  .pipe(
                    Effect.map((data) =>
                      textResult(JSON.stringify(data), data),
                    ),
                    Effect.catch(() =>
                      Effect.succeed(fail("Unable to read Linear workspace")),
                    ),
                  );
              }
              case "linear_workspace_write": {
                const operation = raw.operation;
                if (
                  typeof operation !== "string" ||
                  !Object.hasOwn(LINEAR_WORKSPACE_MUTATIONS, operation)
                )
                  return fail(
                    "operation is not an allowed Linear workspace write",
                  );
                if (!record(raw.input)) return fail("input must be an object");
                return yield* linear
                  .workspaceWrite({
                    sessionId: run.sessionId,
                    operation: operation as LinearWorkspaceMutation,
                    ...(raw.id === undefined ? {} : { id: raw.id }),
                    input: raw.input,
                  })
                  .pipe(
                    Effect.map((data) =>
                      textResult(JSON.stringify(data), data),
                    ),
                    Effect.catch(() =>
                      Effect.succeed(fail("Unable to write Linear workspace")),
                    ),
                  );
              }
              case "linear_get_issue": {
                const requested = raw.issueId;
                if (
                  typeof requested !== "string" ||
                  requested.trim().length === 0
                )
                  return fail("issueId must be a non-empty string");
                return yield* linear
                  .getIssue({
                    sessionId: run.sessionId,
                    issueId: requested.trim(),
                  })
                  .pipe(
                    Effect.map((issue) =>
                      textResult(JSON.stringify(issue), issue),
                    ),
                    Effect.catch((error) =>
                      Effect.succeed(
                        fail(`Unable to read issue: ${String(error)}`),
                      ),
                    ),
                  );
              }
              case "linear_create_comment": {
                if (issueId === null) return fail("Run has no Linear issue");
                const body = raw.body;
                if (typeof body !== "string" || body.trim().length === 0)
                  return fail("body must be a non-empty string");
                return yield* linear
                  .createIssueComment({ sessionId: run.sessionId, body })
                  .pipe(
                    Effect.map((commentId) =>
                      textResult(`Created Linear comment ${commentId}`, {
                        commentId,
                      }),
                    ),
                    Effect.catch((error) =>
                      Effect.succeed(
                        fail(`Unable to create comment: ${String(error)}`),
                      ),
                    ),
                  );
              }
              case "linear_update_issue": {
                if (issueId === null) return fail("Run has no Linear issue");
                const stateId = raw.stateId;
                const delegateId = raw.delegateId;
                if (
                  stateId !== undefined &&
                  (typeof stateId !== "string" || stateId.trim().length === 0)
                )
                  return fail("stateId must be a non-empty string");
                if (
                  delegateId !== undefined &&
                  delegateId !== null &&
                  (typeof delegateId !== "string" ||
                    delegateId.trim().length === 0)
                )
                  return fail("delegateId must be a non-empty string or null");
                if (stateId === undefined && delegateId === undefined)
                  return fail("Provide stateId and/or delegateId");
                return yield* linear
                  .updateIssue({
                    sessionId: run.sessionId,
                    issueId,
                    ...(stateId === undefined ? {} : { stateId }),
                    ...(delegateId === undefined ? {} : { delegateId }),
                  })
                  .pipe(
                    Effect.map(() => textResult("Updated Linear issue")),
                    Effect.catch((error) =>
                      Effect.succeed(
                        fail(`Unable to update issue: ${String(error)}`),
                      ),
                    ),
                  );
              }
              case "linear_add_external_url": {
                if (issueId === null) return fail("Run has no Linear issue");
                const label = raw.label;
                const url = raw.url;
                if (typeof label !== "string" || label.trim().length === 0)
                  return fail("label must be a non-empty string");
                if (typeof url !== "string")
                  return fail("url must be an http(s) URL");
                const normalizedUrl = url.trim();
                try {
                  const parsed = new URL(normalizedUrl);
                  if (
                    parsed.protocol !== "http:" &&
                    parsed.protocol !== "https:"
                  )
                    return fail("url must be an http(s) URL");
                } catch {
                  return fail("url must be a valid http(s) URL");
                }
                return yield* linear
                  .addSessionExternalUrls({
                    sessionId: run.sessionId,
                    urls: [{ label: label.trim(), url: normalizedUrl }],
                  })
                  .pipe(
                    Effect.tap(() =>
                      Ref.update(reportedPullRequestUrlsRef, (current) => {
                        const next = new Map(current);
                        const urls = new Set(next.get(run.sessionId) ?? []);
                        urls.add(normalizedUrl);
                        next.set(run.sessionId, urls);
                        return next;
                      }),
                    ),
                    Effect.map(() =>
                      textResult("Added external URL to Linear session"),
                    ),
                    Effect.catch((error) =>
                      Effect.succeed(
                        fail(`Unable to add external URL: ${String(error)}`),
                      ),
                    ),
                  );
              }
              default:
                return fail(`Unknown host tool: ${request.toolName}`);
            }
          });
        if (!mutating) return yield* dispatch;
        // Serialize with cancel(): re-read the run inside the gate
        // immediately before any Linear mutation.
        return yield* withSessionMutationGate(
          run.sessionId,
          Effect.gen(function* () {
            const fresh = yield* runRepo.get(run.sessionId).pipe(
              Effect.map((value) => ({ ok: true as const, value })),
              Effect.catch((error) =>
                Effect.succeed({
                  ok: false as const,
                  result: fail(`Unable to read run state: ${String(error)}`),
                }),
              ),
            );
            if (!fresh.ok) return fresh.result;
            if (Option.isNone(fresh.value)) return fail("Run no longer exists");
            const freshRun = fresh.value.value;
            // Reject terminal runs too: the team-access-removal and
            // failure paths write terminal states without flipping
            // desiredState.
            if (
              freshRun.desiredState === "canceled" ||
              freshRun.state === "succeeded" ||
              freshRun.state === "failed" ||
              freshRun.state === "canceled"
            ) {
              return fail("Run is finished; mutating Linear tools are refused");
            }
            return yield* dispatch;
          }),
        );
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            content: [
              { type: "text", text: `Host tool failed: ${String(error)}` },
            ],
            isError: true,
          }),
        ),
      );
    return { definitions, handler };
  };
};
