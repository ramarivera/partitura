import { Effect, Option } from "effect";
import type { AgentRun } from "../domain/models.js";
import { resolveRunSettings } from "./agent-settings.js";
import type { GatewayConfig } from "./config.js";
import type { LinearGateway, LinearIssue } from "./linear-gateway.js";
import { inputContext } from "./session-authority-helpers.js";
import type {
  AgentSettingsRepo,
  RunInputRepo,
  WorkspaceRepo,
} from "./store/repositories.js";

export const makeRunSettings =
  ({
    workspaceRepo,
    agentSettingsRepo,
    runInputRepo,
    linearOption,
    config,
  }: {
    workspaceRepo: WorkspaceRepo["Service"];
    agentSettingsRepo: AgentSettingsRepo["Service"];
    runInputRepo: RunInputRepo["Service"];
    linearOption: Option.Option<LinearGateway["Service"]>;
    config: GatewayConfig["Service"];
  }) =>
  (run: AgentRun, issueSnapshot?: Option.Option<LinearIssue>) =>
    Effect.gen(function* () {
      const saved = yield* workspaceRepo.getDriverSession(run.sessionId);
      let snapshot = yield* agentSettingsRepo.getSnapshot(
        run.sessionId,
        run.organizationId,
      );
      const latestInput = yield* runInputRepo.latestActionableInput(
        run.sessionId,
      );
      let labels = Option.isSome(latestInput)
        ? inputContext(latestInput.value.payload).issueLabels
        : [];
      let projectLabels = Option.isSome(latestInput)
        ? inputContext(latestInput.value.payload).projectLabels
        : [];
      if (issueSnapshot !== undefined && Option.isSome(issueSnapshot)) {
        labels = issueSnapshot.value.labels;
        projectLabels = issueSnapshot.value.projectLabels;
      }
      if (
        issueSnapshot === undefined &&
        Option.isNone(saved) &&
        Option.isSome(run.issueId) &&
        Option.isSome(linearOption)
      ) {
        const currentIssue = yield* linearOption.value
          .getIssue({ sessionId: run.sessionId, issueId: run.issueId.value })
          .pipe(Effect.option);
        if (Option.isSome(currentIssue)) {
          labels = currentIssue.value.labels;
          projectLabels = currentIssue.value.projectLabels;
        }
      }
      const repository = Option.isSome(run.repositoryId)
        ? yield* workspaceRepo.getRepository(
            run.organizationId,
            run.repositoryId.value,
          )
        : Option.none();
      if (Option.isNone(snapshot)) {
        const organizationSettings = yield* agentSettingsRepo.get(
          run.organizationId,
        );
        const t3Config = config.t3Driver;
        const legacySessionLabels = Option.isSome(saved);
        const effectiveSettings = legacySessionLabels
          ? {
              ...organizationSettings,
              defaults: {
                ...organizationSettings.defaults,
                driver: saved.value.driver,
              },
            }
          : organizationSettings;
        const settingsIssueLabels = legacySessionLabels
          ? labels.filter(
              (label) =>
                !label
                  .trim()
                  .toLowerCase()
                  .startsWith(organizationSettings.labelPrefixes.driver),
            )
          : labels;
        const settingsProjectLabels = legacySessionLabels
          ? projectLabels.filter(
              (label) =>
                !label
                  .trim()
                  .toLowerCase()
                  .startsWith(organizationSettings.labelPrefixes.driver),
            )
          : projectLabels;
        const resolved = resolveRunSettings({
          settings: effectiveSettings,
          issueLabels: settingsIssueLabels,
          projectLabels: settingsProjectLabels,
          environment: {
            driver: Option.isSome(saved)
              ? saved.value.driver
              : Option.isSome(repository)
                ? (repository.value.defaultDriver ?? "omp")
                : "omp",
            ompModel: config.workerDefaultModel ?? null,
            t3Model:
              t3Config === undefined
                ? null
                : {
                    instanceId: t3Config.providerInstanceId,
                    model: t3Config.model,
                    ...(t3Config.modelOptions.length === 0
                      ? {}
                      : { options: t3Config.modelOptions }),
                  },
            effort: null,
            mode: t3Config?.runtimeMode ?? "auto",
          },
        });
        const frozen = legacySessionLabels
          ? {
              ...resolved,
              driver: saved.value.driver,
              sources: {
                ...resolved.sources,
                driver: "environment" as const,
              },
            }
          : resolved;
        snapshot = Option.some(
          yield* agentSettingsRepo.saveSnapshot(
            run.sessionId,
            run.organizationId,
            frozen,
          ),
        );
        if (
          resolved.warnings.length > 0 &&
          Option.isSome(run.issueId) &&
          Option.isSome(linearOption)
        ) {
          const body = `Partitura ignored run setting label(s): ${resolved.warnings.join(" ")} The run will use the next valid settings tier.`;
          yield* linearOption.value
            .createIssueComment({ sessionId: run.sessionId, body })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "run_settings.label_warning_comment_failed",
                ).pipe(
                  Effect.annotateLogs({
                    sessionId: run.sessionId,
                    error:
                      error instanceof Error ? error.message : String(error),
                  }),
                  Effect.asVoid,
                ),
              ),
            );
        }
      }
      const effective = Option.getOrThrow(snapshot).settings;
      return { saved, repository, effective };
    });
