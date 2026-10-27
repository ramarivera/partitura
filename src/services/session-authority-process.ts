import { Cause, Clock, Effect, Option, Ref } from "effect";
import {
  type DatabaseError,
  type InstallationRevokedError,
  InterruptedRunNoActionableInputError,
  type LinearApiError,
  type NixEnvironmentError,
  type RowDecodeError,
  RpcProtocolError,
  type RpcSpawnError,
  type RpcTimeoutError,
  type RunLeaseError,
  type TokenCipherError,
  type TokenRefreshError,
  type WorkspaceError,
} from "../domain/errors.js";
import type { ProjectId, SessionId, SourceKey, TeamId } from "../domain/ids.js";
import type { AgentRun } from "../domain/models.js";
import type { GatewayConfig } from "./config.js";
import type { LinearGateway, LinearIssue } from "./linear-gateway.js";
import { removeMcpConfig } from "./mcp-config.js";
import type { ActivityProjector } from "./projector.js";
import type { RpcWorkerHandle } from "./rpc-worker.js";
import {
  inputContext,
  labelSet,
  linearWorkerPromptWithTemplate,
  record,
  workerContractFor,
} from "./session-authority-helpers.js";
import type { makeOpenWorker } from "./session-authority-launch.js";
import type { makeRepositoryRouting } from "./session-authority-routing.js";
import type { makePendingStopHandler } from "./session-authority-stops.js";
import type {
  InstallationRepo,
  PromptTemplateRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
} from "./store/repositories.js";
import type { WorkerIdentityRepo } from "./store/worker-identity-repo.js";
import type { makeWorkspace } from "./workspace.js";

type AuthorityError =
  | DatabaseError
  | RowDecodeError
  | RpcProtocolError
  | RpcSpawnError
  | RpcTimeoutError
  | RunLeaseError
  | TokenCipherError
  | TokenRefreshError
  | WorkspaceError
  | LinearApiError
  | InstallationRevokedError
  | InterruptedRunNoActionableInputError
  | NixEnvironmentError;

export const makeProcessSession = ({
  processingSessions,
  runRepo,
  runInputRepo,
  cancel,
  owner,
  leaseDurationMs,
  leasedSessions,
  handlePendingStops,
  runEventRepo,
  getWorker,
  workerSlots,
  config,
  installationRepo,
  updateRun,
  clearWorkspaceCredentials,
  projector,
  releaseMutationGate,
  clearSessionStopDeferrals,
  maxAttempts,
  ensureIssueLifecycle,
  startWorker,
  promptTemplateRepo,
  finishLocalCommand,
  runUrlForSession,
  linearOption,
  workspace,
  augmentResolution,
  workerIdentities,
  sandboxMode,
  pendingUiRef,
  handleFailure,
  failureMessage,
  releaseIfNoWorker,
  withSessionProcessing,
}: {
  processingSessions: Ref.Ref<ReadonlySet<SessionId>>;
  runRepo: RunRepo["Service"];
  runInputRepo: RunInputRepo["Service"];
  cancel: (
    run: AgentRun,
  ) => Effect.Effect<void, DatabaseError | RowDecodeError>;
  owner: string;
  leaseDurationMs: number;
  leasedSessions: Ref.Ref<ReadonlySet<SessionId>>;
  handlePendingStops: ReturnType<typeof makePendingStopHandler>;
  runEventRepo: RunEventRepo["Service"];
  getWorker: (
    id: SessionId,
  ) => Effect.Effect<Option.Option<{ readonly worker: RpcWorkerHandle }>>;
  workerSlots: Ref.Ref<ReadonlySet<SessionId>>;
  config: GatewayConfig["Service"];
  installationRepo: InstallationRepo["Service"];
  updateRun: RunRepo["Service"]["update"];
  clearWorkspaceCredentials: (run: AgentRun) => Effect.Effect<void>;
  projector: ActivityProjector["Service"];
  releaseMutationGate: (id: SessionId) => Effect.Effect<void>;
  clearSessionStopDeferrals: (id: SessionId) => Effect.Effect<void>;
  maxAttempts: number;
  ensureIssueLifecycle: ReturnType<
    typeof makeRepositoryRouting
  >["ensureIssueLifecycle"];
  startWorker: ReturnType<typeof makeOpenWorker>;
  promptTemplateRepo: PromptTemplateRepo["Service"];
  finishLocalCommand: (
    id: SessionId,
    worker: RpcWorkerHandle,
    source: string,
  ) => Effect.Effect<
    void,
    DatabaseError | RowDecodeError | RpcProtocolError | RpcTimeoutError
  >;
  runUrlForSession: ((id: SessionId) => string) | null;
  linearOption: Option.Option<LinearGateway["Service"]>;
  workspace: Effect.Success<ReturnType<typeof makeWorkspace>>;
  augmentResolution: ReturnType<
    typeof makeRepositoryRouting
  >["augmentResolution"];
  workerIdentities: WorkerIdentityRepo["Service"];
  sandboxMode: NonNullable<GatewayConfig["Service"]["workerSandboxMode"]>;
  pendingUiRef: Ref.Ref<
    ReadonlyMap<SessionId, { readonly id: string; readonly method: string }>
  >;
  handleFailure: (
    id: SessionId,
    error: { readonly message: string },
    incrementAttempt?: boolean,
  ) => Effect.Effect<void, DatabaseError | RowDecodeError>;
  failureMessage: <E>(cause: Cause.Cause<E>) => string;
  releaseIfNoWorker: (id: SessionId) => Effect.Effect<void>;
  withSessionProcessing: <A, E, R>(
    id: SessionId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}) => {
  return Effect.fn("SessionAuthority.processSession")(function* (
    sessionId: SessionId,
  ): Effect.fn.Return<void, AuthorityError> {
    yield* Effect.annotateCurrentSpan("sessionId", sessionId);
    const entered = yield* Ref.modify(processingSessions, (sessions) => {
      if (sessions.has(sessionId)) return [false, sessions] as const;
      return [true, new Set(sessions).add(sessionId)] as const;
    });
    if (!entered) return;
    let initialAttempt = 0;
    return yield* Effect.gen(function* () {
      const initial = yield* runRepo.get(sessionId);
      if (Option.isSome(initial)) initialAttempt = initial.value.attempt;
      const inputs = yield* runInputRepo.pending(sessionId);
      if (Option.isSome(initial) && initial.value.desiredState === "canceled") {
        // A pending follow-up prompt resumes a user-stopped run.
        // reopen only fires from state='canceled'; anything else
        // (mid-flight 'stopping', externally canceled active runs)
        // keeps honoring the cancellation.
        const hasActionableInput = inputs.some(
          (input) => input.kind !== "stop",
        );
        const resumed =
          hasActionableInput && (yield* runRepo.reopen(sessionId));
        if (!resumed) {
          yield* cancel(initial.value);
          // The cancellation honors pending stops and supersedes older
          // prompts, while later prompts remain eligible to resume.
          yield* Effect.forEach(
            inputs.slice(
              0,
              inputs.findLastIndex((input) => input.kind === "stop") + 1,
            ),
            (input) => runInputRepo.markProcessed(input.id),
            { discard: true },
          );
          return;
        }
        yield* Effect.logInfo("run.resumed").pipe(
          Effect.annotateLogs({
            event: "run.resumed",
            sessionId,
          }),
        );
      }
      if (yield* handlePendingStops(sessionId, initial, inputs)) return;
      if (
        Option.isSome(initial) &&
        Option.isSome(initial.value.nextAttemptAt) &&
        initial.value.nextAttemptAt.value > (yield* Clock.currentTimeMillis)
      ) {
        const nextAttemptAt = initial.value.nextAttemptAt.value;
        const retryEvent = yield* runEventRepo.getBySourceKey(
          `retry:${sessionId}:${initial.value.attempt}` as SourceKey,
        );
        const scheduledAt = Option.match(retryEvent, {
          onNone: () => undefined,
          onSome: (event) =>
            event.kind === "retry" &&
            record(event.payload) &&
            event.payload.nextAttemptAt === nextAttemptAt &&
            typeof event.payload.scheduledAt === "number"
              ? event.payload.scheduledAt
              : undefined,
        });
        if (
          scheduledAt === undefined ||
          !inputs.some(
            (input) => input.kind !== "stop" && input.createdAt > scheduledAt,
          )
        )
          return;
      }
      const workerState = yield* getWorker(sessionId);
      if (Option.isNone(workerState)) {
        const reserved = yield* Ref.modify(workerSlots, (slots) => {
          if (slots.has(sessionId)) return [true, slots] as const;
          if (slots.size >= (config.maxConcurrentWorkers ?? 4))
            return [false, slots] as const;
          return [true, new Set(slots).add(sessionId)] as const;
        });
        if (!reserved) return;
      }
      const leased = Option.isSome(workerState)
        ? yield* runRepo.renewLease(sessionId, owner, leaseDurationMs)
        : yield* runRepo.claimLease(sessionId, owner, leaseDurationMs);
      if (!leased) return;
      yield* Ref.update(leasedSessions, (sessions) =>
        new Set(sessions).add(sessionId),
      );
      const runOption = yield* runRepo.get(sessionId);
      if (Option.isNone(runOption)) return;
      const run = runOption.value;
      yield* Effect.logInfo("work.assigned").pipe(
        Effect.annotateLogs({
          event: "work.assigned",
          sessionId,
          attempt: run.attempt,
          state: run.state,
        }),
      );
      if (run.desiredState === "canceled") {
        yield* cancel(run);
        return;
      }
      const installation = yield* installationRepo.get(run.organizationId);
      if (
        Option.isNone(installation) ||
        Option.isSome(installation.value.revokedAt)
      ) {
        if (Option.isSome(run.workspacePath)) {
          yield* removeMcpConfig(run.workspacePath.value);
        }
        yield* updateRun(sessionId, {
          state: "failed",
          terminalReason: Option.some("Linear installation is unavailable"),
        });
        yield* clearWorkspaceCredentials(run);
        yield* projector.terminal(
          sessionId,
          `installation-unavailable:${run.organizationId}`,
          "error",
          "The Linear installation is unavailable. Reinstall or reauthorize the app, then try again.",
        );
        yield* releaseMutationGate(sessionId);
        yield* clearSessionStopDeferrals(sessionId);
        return;
      }
      // A null snapshot means "unknown" (installation predates the
      // snapshot or no PermissionChange has arrived yet), not "no
      // access". Denying on unknown cancels every teamed run forever
      // even though Linear allows the calls — Linear enforces access
      // server-side, so unknown snapshots warn and proceed; only a
      // KNOWN snapshot that excludes the team cancels.
      const snapshotKnown =
        Option.isSome(installation.value.accessibleTeamIds) ||
        Option.isSome(installation.value.canAccessAllPublicTeams);
      if (!snapshotKnown && Option.isSome(run.teamId)) {
        yield* Effect.logWarning("authority.team_access_unknown").pipe(
          Effect.annotateLogs({
            event: "authority.team_access_unknown",
            sessionId,
            teamId: run.teamId.value,
          }),
        );
      }
      const teamAccess = Option.match(installation.value.accessibleTeamIds, {
        onNone: () => [] as ReadonlyArray<string>,
        onSome: (ids) => ids,
      });
      const canAccessAll = Option.match(
        installation.value.canAccessAllPublicTeams,
        {
          onNone: () => false,
          onSome: (value) => value,
        },
      );
      const teamDenied = (teamId: string): boolean =>
        snapshotKnown &&
        !canAccessAll &&
        !teamAccess.some((id) => id === teamId);
      const cancelForTeamAccess = (teamId: string) =>
        Effect.gen(function* () {
          if (Option.isSome(run.workspacePath)) {
            yield* removeMcpConfig(run.workspacePath.value);
          }
          yield* updateRun(sessionId, {
            state: "canceled",
            terminalReason: Option.some("Linear team access was removed"),
          });
          yield* clearWorkspaceCredentials(run);
          yield* projector.terminal(
            sessionId,
            `team-access-removed:${teamId}`,
            "response",
            "Stopped because this Linear installation no longer has access to the issue's team.",
          );
          yield* releaseMutationGate(sessionId);
          yield* clearSessionStopDeferrals(sessionId);
        });
      if (Option.isSome(run.teamId) && teamDenied(run.teamId.value)) {
        yield* cancelForTeamAccess(run.teamId.value);
        return;
      }
      let worker: RpcWorkerHandle | undefined = Option.getOrElse(
        Option.map(workerState, (state) => state.worker),
        () => undefined,
      );
      if (worker === undefined && run.attempt >= maxAttempts) {
        return yield* Effect.fail(
          new RpcProtocolError({
            method: "recovery",
            message: "Run exhausted its worker attempts",
          }),
        );
      }
      if (inputs.length === 0) {
        if (
          worker === undefined &&
          (["orphaned", "starting", "running"].includes(run.state) ||
            (run.state === "waiting" && Option.isSome(run.workspacePath)))
        ) {
          yield* updateRun(sessionId, {
            state: "starting",
            incrementAttempt: true,
            nextAttemptAt: Option.none(),
          });
          if (Option.isNone(run.workspacePath)) {
            return yield* Effect.fail(
              new InterruptedRunNoActionableInputError({
                sessionId,
                message:
                  "Interrupted run has no workspace or pending input to resume",
              }),
            );
          }
          const resumedOption = yield* runRepo.get(sessionId);
          if (Option.isNone(resumedOption)) return;
          const resumed = resumedOption.value;
          const latestActionable =
            yield* runInputRepo.latestActionableInput(sessionId);
          const retryPayload = Option.isSome(latestActionable)
            ? latestActionable.value.payload
            : null;
          // Projections use a global key, and attempt numbers reset on
          // reopening. Scope notices and driver commands to this input.
          const retryKey = `retry:${sessionId}:${Option.isSome(latestActionable) ? latestActionable.value.id : "saved"}:${resumed.attempt}`;
          let retryInput:
            | {
                readonly kind: "created" | "prompted" | "stop";
                readonly body: string;
              }
            | undefined;
          if (Option.isNone(resumed.ompSessionFile)) {
            if (Option.isNone(latestActionable)) {
              return yield* Effect.fail(
                new InterruptedRunNoActionableInputError({
                  sessionId,
                  message: "Interrupted run has no actionable input to resume",
                }),
              );
            }
            retryInput = latestActionable.value;
          }
          yield* ensureIssueLifecycle(
            resumed,
            retryPayload,
            installation.value,
          );
          yield* Effect.logInfo("run.retried").pipe(
            Effect.annotateLogs({
              event: "run.retried",
              sessionId,
              attempt: resumed.attempt,
              workspacePath: run.workspacePath.value,
            }),
          );
          worker = yield* startWorker(resumed, run.workspacePath.value, true);
          yield* projector.thought(
            sessionId,
            retryKey,
            `Retrying the interrupted Partitura run (attempt ${resumed.attempt}).`,
          );
          if (Option.isSome(resumed.ompSessionFile)) {
            yield* worker.followUp(
              "Continue the interrupted Linear task from the saved session state.",
              retryKey,
            );
          } else {
            if (retryInput === undefined) {
              return yield* Effect.fail(
                new InterruptedRunNoActionableInputError({
                  sessionId,
                  message: "Interrupted run has no actionable input to resume",
                }),
              );
            }
            const retryPrompt = yield* linearWorkerPromptWithTemplate(
              promptTemplateRepo,
              resumed.organizationId,
              retryInput.kind,
              retryInput.body,
              workerContractFor(worker, config.t3Driver?.connection._tag),
              worker.driverSession?.ref.driver !== "t3",
            );
            const agentInvoked = yield* worker.prompt(retryPrompt, retryKey);
            if (!agentInvoked) {
              yield* finishLocalCommand(sessionId, worker, retryKey);
            }
          }
        }
        return;
      }
      for (const input of inputs.filter((input) => input.kind !== "stop")) {
        const latestOption = yield* runRepo.get(sessionId);
        let latest = Option.isSome(latestOption) ? latestOption.value : run;
        if (latest.desiredState === "canceled") {
          // A follow-up prompt on a user-stopped session resumes the
          // run; any other input on a canceled run still honors the
          // cancellation. reopen refuses mid-flight cancellations
          // (state='stopping'), which fall through to cancel.
          const reopened =
            input.kind === "prompted"
              ? yield* runRepo.reopen(sessionId)
              : false;
          if (!reopened) {
            yield* cancel(latest);
            yield* runInputRepo.markProcessed(input.id);
            break;
          }
          yield* Effect.logInfo("run.resumed").pipe(
            Effect.annotateLogs({
              event: "run.resumed",
              sessionId,
              inputId: input.id,
            }),
          );
          const reopenedOption = yield* runRepo.get(sessionId);
          latest = Option.isSome(reopenedOption)
            ? reopenedOption.value
            : latest;
        }
        if (worker === undefined) {
          if (runUrlForSession !== null) {
            yield* projector.externalUrls(
              sessionId,
              `partitura-run-url:${sessionId}`,
              [
                {
                  // Use a new key to preserve immutable legacy payloads.
                  label: "Partitura run",
                  url: runUrlForSession(sessionId),
                },
              ],
            );
          }
          yield* projector.thought(
            sessionId,
            `accepted:${input.id}`,
            "Request accepted; preparing the worker.",
          );
          const existingWorkspacePath =
            Option.isSome(latest.repositoryId) &&
            Option.isSome(latest.workspacePath)
              ? latest.workspacePath
              : Option.none<string>();
          if (Option.isSome(existingWorkspacePath)) {
            // Resume path (mirrors the orphan retry): repository and
            // workspace were resolved by an earlier attempt, and
            // startWorker reattaches the persisted OMP session via
            // --session when one was captured.
            yield* updateRun(sessionId, {
              state: "starting",
              incrementAttempt: true,
              nextAttemptAt: Option.none(),
            });
            const updatedOption = yield* runRepo.get(sessionId);
            if (Option.isNone(updatedOption)) return;
            yield* ensureIssueLifecycle(
              updatedOption.value,
              input.payload,
              installation.value,
            );
            worker = yield* startWorker(
              updatedOption.value,
              existingWorkspacePath.value,
              true,
            );
          } else {
            const issueSnapshot =
              Option.isSome(latest.issueId) && Option.isSome(linearOption)
                ? yield* linearOption.value
                    .getIssue({
                      sessionId,
                      issueId: latest.issueId.value,
                    })
                    .pipe(
                      Effect.map(Option.some),
                      Effect.catch(() =>
                        Effect.logWarning(
                          "repository.routing_issue_fetch_failed",
                        ).pipe(
                          Effect.annotateLogs({
                            event: "repository.routing_issue_fetch_failed",
                            sessionId,
                          }),
                          Effect.as(Option.none<LinearIssue>()),
                        ),
                      ),
                    )
                : Option.none<LinearIssue>();
            const webhookContext = inputContext(input.payload);
            // Unavailable metadata never clears ids the run already knows.
            const knownTeamId = Option.getOrNull(latest.teamId) as
              | string
              | null;
            const knownProjectId = Option.getOrNull(latest.projectId) as
              | string
              | null;
            const enrichedContext = Option.isSome(issueSnapshot)
              ? {
                  ...webhookContext,
                  teamId: issueSnapshot.value.teamId ?? webhookContext.teamId,
                  projectId:
                    issueSnapshot.value.projectId ?? webhookContext.projectId,
                  issueLabels: labelSet(issueSnapshot.value.labels),
                  projectLabels: labelSet(issueSnapshot.value.projectLabels),
                }
              : webhookContext;
            const baseContext = {
              ...enrichedContext,
              teamId: enrichedContext.teamId ?? knownTeamId,
              projectId: enrichedContext.projectId ?? knownProjectId,
            };
            yield* updateRun(sessionId, {
              teamId: Option.fromNullishOr(baseContext.teamId as TeamId | null),
              projectId: Option.fromNullishOr(
                baseContext.projectId as ProjectId | null,
              ),
            });
            // Sparse webhooks can omit the team, so the gate above may not
            // have seen it; recheck once the Linear issue supplied it.
            if (baseContext.teamId !== null && teamDenied(baseContext.teamId)) {
              yield* cancelForTeamAccess(baseContext.teamId);
              return;
            }
            const resolvedContext = {
              ...baseContext,
              organizationId:
                baseContext.organizationId ?? (run.organizationId as string),
            };
            const context =
              input.kind === "prompted" &&
              latest.state === "waiting" &&
              resolvedContext.repositoryId === null
                ? {
                    ...resolvedContext,
                    repositoryId: input.body.trim(),
                  }
                : resolvedContext;
            const staticResolution = yield* workspace.resolve(context);
            const augmented = yield* augmentResolution(
              run,
              context,
              staticResolution,
            );
            const resolution = augmented.resolution;
            if (resolution.kind === "none") {
              yield* projector.elicitation(
                sessionId,
                `repo:none:${input.id}`,
                "No repository is configured for this Linear issue.",
                augmented.options.length > 0 ? augmented.options : undefined,
              );
              yield* updateRun(sessionId, { state: "waiting" });
              return;
            }
            if (resolution.kind === "ambiguous") {
              yield* projector.elicitation(
                sessionId,
                `repo:ambiguous:${input.id}`,
                "Select the repository for this issue.",
                resolution.repositories.map((r) => r.id),
              );
              yield* updateRun(sessionId, { state: "waiting" });
              return;
            }
            yield* updateRun(sessionId, { incrementAttempt: true });
            const workspacePath = yield* workspace.materialize(
              sessionId,
              resolution.repository,
              yield* workerIdentities.acquire(sessionId, config.workspaceRoot, {
                retireTerminal: sandboxMode === "native",
              }),
            );
            yield* updateRun(sessionId, {
              state: "starting",
              repositoryId: Option.some(resolution.repository.id),
              workspacePath: Option.some(workspacePath),
            });
            const updatedOption = yield* runRepo.get(sessionId);
            if (Option.isNone(updatedOption)) return;
            yield* ensureIssueLifecycle(
              updatedOption.value,
              input.payload,
              installation.value,
              issueSnapshot,
            );
            worker = yield* startWorker(
              updatedOption.value,
              workspacePath,
              false,
              issueSnapshot,
            );
          }
          const agentInvoked = yield* worker.prompt(
            yield* linearWorkerPromptWithTemplate(
              promptTemplateRepo,
              latest.organizationId,
              input.kind,
              input.body,
              workerContractFor(worker, config.t3Driver?.connection._tag),
              worker.driverSession?.ref.driver !== "t3",
            ),
            input.id,
          );
          if (!agentInvoked) {
            yield* finishLocalCommand(sessionId, worker, input.id);
          }
        } else if (input.kind === "prompted") {
          const pendingUi = yield* Ref.get(pendingUiRef).pipe(
            Effect.map((m) => m.get(sessionId)),
          );
          if (pendingUi !== undefined) {
            const normalized = input.body.trim().toLowerCase();
            const response =
              pendingUi.method === "confirm"
                ? {
                    confirmed: /^(?:y|yes|true|confirm|confirmed)$/u.test(
                      normalized,
                    ),
                  }
                : { value: input.body };
            yield* worker.respondToUi(pendingUi.id, response);
            yield* Ref.update(pendingUiRef, (m) => {
              const next = new Map(m);
              next.delete(sessionId);
              return next;
            });
          } else {
            // Render the prompted template at send time: input.body
            // stays raw for repo-selection/UI-answer paths.
            const rendered = yield* linearWorkerPromptWithTemplate(
              promptTemplateRepo,
              latest.organizationId,
              "prompted",
              input.body,
            );
            if (yield* worker.isStreaming) {
              yield* worker.steer(rendered, input.id);
            } else {
              yield* worker.followUp(rendered, input.id);
            }
          }
          yield* updateRun(sessionId, { state: "running" });
        }
        yield* runInputRepo.markProcessed(input.id);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              const current = yield* runRepo.get(sessionId);
              yield* handleFailure(
                sessionId,
                { message: failureMessage(cause) },
                Option.isSome(current) &&
                  current.value.attempt === initialAttempt,
              );
              return yield* Effect.failCause(cause);
            }),
      ),
      Effect.ensuring(releaseIfNoWorker(sessionId)),
      (effect) => withSessionProcessing(sessionId, effect),
      Effect.ensuring(
        Ref.update(processingSessions, (sessions) => {
          const next = new Set(sessions);
          next.delete(sessionId);
          return next;
        }),
      ),
    );
  });
};
