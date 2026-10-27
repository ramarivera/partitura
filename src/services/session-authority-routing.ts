import { Effect, Option } from "effect";
import type { DatabaseError, RowDecodeError } from "../domain/errors.js";
import type { AgentRun } from "../domain/models.js";
import type { GatewayConfig } from "./config.js";
import type { LinearGateway, LinearIssue } from "./linear-gateway.js";
import {
  type InputContext,
  isAutomationDelegated,
} from "./session-authority-helpers.js";
import type { WorkspaceRepo } from "./store/repositories.js";
import {
  parseRepositorySuggestionCandidate,
  type RepositoryResolution,
} from "./workspace.js";

export const makeRepositoryRouting = (
  linearOption: Option.Option<LinearGateway["Service"]>,
  workspaceRepo: WorkspaceRepo["Service"],
  config: GatewayConfig["Service"],
) => {
  const ensureIssueLifecycle = (
    run: AgentRun,
    payload: unknown,
    installation: { readonly appUserId: string },
    issueSnapshot?: Option.Option<LinearIssue>,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (Option.isNone(linearOption)) return;
      const linear = linearOption.value;
      if (Option.isNone(run.issueId) || isAutomationDelegated(payload)) {
        return;
      }
      const runIssueId = run.issueId.value;
      const issue =
        issueSnapshot ??
        (yield* linear
          .getIssue({
            sessionId: run.sessionId,
            issueId: runIssueId,
          })
          .pipe(
            Effect.map(Option.some),
            Effect.catch((error) =>
              Effect.logWarning("issue.lifecycle_fetch_failed").pipe(
                Effect.annotateLogs({
                  event: "issue.lifecycle_fetch_failed",
                  sessionId: run.sessionId,
                  issueId: runIssueId,
                  error: error instanceof Error ? error.message : String(error),
                }),
                Effect.as(Option.none()),
              ),
            ),
          ));
      if (Option.isNone(issue)) return;

      const stateType = issue.value.stateType?.toLowerCase();
      if (
        stateType !== "started" &&
        stateType !== "completed" &&
        stateType !== "canceled"
      ) {
        const teamId =
          issue.value.teamId ?? Option.getOrElse(run.teamId, () => null);
        if (teamId !== null) {
          const states = yield* linear
            .teamStartedStates({ sessionId: run.sessionId, teamId })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("issue.lifecycle_states_failed").pipe(
                  Effect.annotateLogs({
                    event: "issue.lifecycle_states_failed",
                    sessionId: run.sessionId,
                    issueId: runIssueId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  }),
                  Effect.as([]),
                ),
              ),
            );
          const started = states[0];
          if (started !== undefined) {
            yield* linear
              .updateIssue({
                sessionId: run.sessionId,
                issueId: runIssueId,
                stateId: started.id,
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("issue.lifecycle_state_update_failed").pipe(
                    Effect.annotateLogs({
                      event: "issue.lifecycle_state_update_failed",
                      sessionId: run.sessionId,
                      issueId: runIssueId,
                      error:
                        error instanceof Error ? error.message : String(error),
                    }),
                  ),
                ),
              );
          }
        }
      }

      if (issue.value.delegateId === null || issue.value.delegateId === "") {
        yield* linear
          .updateIssue({
            sessionId: run.sessionId,
            issueId: runIssueId,
            delegateId: installation.appUserId,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("issue.lifecycle_delegate_update_failed").pipe(
                Effect.annotateLogs({
                  event: "issue.lifecycle_delegate_update_failed",
                  sessionId: run.sessionId,
                  issueId: runIssueId,
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            ),
          );
      }
    });

  const augmentResolution = (
    run: AgentRun,
    context: InputContext,
    resolution: RepositoryResolution,
  ): Effect.Effect<
    {
      readonly resolution: RepositoryResolution;
      readonly options: ReadonlyArray<string>;
    },
    DatabaseError | RowDecodeError
  > =>
    Effect.gen(function* () {
      if (Option.isNone(linearOption)) return { resolution, options: [] };
      const linear = linearOption.value;
      if (
        resolution.kind === "match" ||
        Option.isNone(run.issueId) ||
        context.organizationId === null
      ) {
        return { resolution, options: [] };
      }
      const runIssueId = run.issueId.value;
      const repositories = yield* workspaceRepo.listRepositories(
        run.organizationId,
      );
      if (repositories.length === 0) return { resolution, options: [] };
      const byKey = new Map<string, (typeof repositories)[number] | null>();
      const candidates = repositories.flatMap((repository) => {
        const candidate = parseRepositorySuggestionCandidate(repository.url);
        if (candidate === null) return [];
        const key =
          `${candidate.hostname}/${candidate.repositoryFullName}`.toLowerCase();
        if (byKey.has(key)) {
          byKey.set(key, null);
        } else {
          byKey.set(key, repository);
        }
        return [candidate];
      });
      if (candidates.length === 0) return { resolution, options: [] };
      const suggestions = yield* linear
        .repositorySuggestions({
          sessionId: run.sessionId,
          issueId: runIssueId,
          candidates,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logDebug("repository.suggestions_failed").pipe(
              Effect.annotateLogs({
                event: "repository.suggestions_failed",
                sessionId: run.sessionId,
                issueId: runIssueId,
                error: error instanceof Error ? error.message : String(error),
              }),
              Effect.as([]),
            ),
          ),
        );
      const ranked = suggestions
        .slice()
        .sort((a, b) => b.confidence - a.confidence);
      const mapped: Array<{
        readonly repository: (typeof repositories)[number];
        readonly confidence: number;
      }> = [];
      for (const suggestion of ranked) {
        const key =
          `${suggestion.hostname}/${suggestion.repositoryFullName}`.toLowerCase();
        const only = byKey.get(key) ?? undefined;
        if (
          only !== undefined &&
          !mapped.some((item) => item.repository.id === only.id)
        ) {
          mapped.push({
            repository: only,
            confidence: suggestion.confidence,
          });
        }
      }
      const firstMatch = mapped[0];
      if (
        mapped.length === 1 &&
        firstMatch !== undefined &&
        firstMatch.confidence >= config.repositorySuggestionConfidenceThreshold
      ) {
        yield* Effect.logInfo("repository.suggestion_auto_routed").pipe(
          Effect.annotateLogs({
            event: "repository.suggestion_auto_routed",
            sessionId: run.sessionId,
            issueId: run.issueId.value,
            repositoryId: firstMatch.repository.id,
            confidence: firstMatch.confidence,
          }),
        );
        return {
          resolution: { kind: "match", repository: firstMatch.repository },
          options: [],
        };
      }
      const options = mapped.map((item) => item.repository.id);
      if (resolution.kind === "ambiguous" && options.length > 0) {
        const staticById = new Map(
          resolution.repositories.map((repository) => [
            repository.id,
            repository,
          ]),
        );
        const ordered = [
          ...mapped
            .map((item) => staticById.get(item.repository.id))
            .filter(
              (repository): repository is (typeof repositories)[number] =>
                repository !== undefined,
            ),
          ...resolution.repositories.filter(
            (repository) => !options.includes(repository.id),
          ),
        ];
        return {
          resolution: { kind: "ambiguous", repositories: ordered },
          options,
        };
      }
      return { resolution, options };
    });

  return { ensureIssueLifecycle, augmentResolution };
};
