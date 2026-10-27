import { Effect, Option, Schema } from "effect";
import {
  type DatabaseError,
  type RowDecodeError,
  type TokenCipherError,
  WebhookIdentityError,
  WebhookPayloadError,
} from "../domain/errors.js";
import {
  InputId,
  IssueId,
  OrganizationId,
  ProjectId,
  SessionId,
  TeamId,
} from "../domain/ids.js";
import type {
  AgentSessionActivity as AgentSessionActivityType,
  AgentSessionEvent as AgentSessionEventType,
  AgentSessionIssue as AgentSessionIssueType,
} from "../domain/models.js";
import { isRecord, isString } from "./linear-helpers.js";
import { substitutePromptTemplate } from "./prompt-templates.js";
import type {
  InstallationRepo,
  PromptTemplateRepo,
  RunInputRepo,
  RunRepo,
} from "./store/repositories.js";
import { clientIdMatches } from "./webhook-common.js";

export const extractPromptBody = (
  activity: AgentSessionActivityType,
): string => {
  const content = activity.content;
  if (!isRecord(content)) return "";
  const rawBody = content.body;
  const rawTitle = content.title;
  const body = isString(rawBody) ? rawBody : "";
  const title = isString(rawTitle) ? rawTitle : "";
  if (title && body) return `# ${title}\n\n${body}`;
  if (body) return body;
  if (title) return title;
  return "";
};

export const buildCreatedInputBody = (event: AgentSessionEventType): string => {
  const sections: string[] = [];

  const promptContext = event.promptContext.pipe(
    Option.map((s) => s.trim()),
    Option.flatMap((s) => (s.length > 0 ? Option.some(s) : Option.none())),
  );
  const summary = event.agentSession.summary.pipe(
    Option.map((s) => s.trim()),
    Option.flatMap((s) => (s.length > 0 ? Option.some(s) : Option.none())),
  );
  const userPrompt = Option.orElse(promptContext, () =>
    Option.orElse(summary, () => Option.none()),
  ).pipe(Option.getOrElse(() => ""));

  if (userPrompt) {
    sections.push(`User request:\n${userPrompt}`);
  } else if (
    Option.isSome(event.agentSession.issue) ||
    Option.isSome(event.agentSession.comment) ||
    Option.getOrElse(event.previousComments, () => []).length > 0 ||
    Option.getOrElse(event.guidance, () => []).length > 0
  ) {
    sections.push("User request:\nWork on the issue below.");
  }

  const issue = event.agentSession.issue.pipe(Option.getOrElse(() => null));
  if (issue) {
    const lines: string[] = [
      `Issue: ${issue.title}${issue.identifier ? ` (${issue.identifier})` : ""}`,
    ];
    if (issue.url) lines.push(`URL: ${issue.url}`);
    if (issue.teamId) lines.push(`Team: ${issue.teamId}`);
    if (issue.projectId) lines.push(`Project: ${issue.projectId}`);
    if (issue.description) lines.push(`\nDescription:\n${issue.description}`);
    sections.push(`Issue context:\n${lines.join("\n")}`);
  }

  const comment = event.agentSession.comment.pipe(Option.getOrElse(() => null));
  if (comment) {
    sections.push(`Thread comment:\n${comment.body}`);
  }

  const previousComments = Option.getOrElse(event.previousComments, () => []);
  if (previousComments.length > 0) {
    const list = previousComments
      .map((c, index) => `${index + 1}. ${c.body}`)
      .join("\n");
    sections.push(`Previous comments:\n${list}`);
  }

  const guidance = Option.getOrElse(event.guidance, () => []);
  if (guidance.length > 0) {
    const list = guidance
      .map((g, index) => `${index + 1}. ${g.body}`)
      .join("\n");
    sections.push(`Guidance:\n${list}`);
  }

  return sections.join("\n\n");
};
export const createdTemplateValues = (
  event: AgentSessionEventType,
): Readonly<Record<string, string>> => {
  const promptContext = event.promptContext.pipe(
    Option.map((s) => s.trim()),
    Option.flatMap((s) => (s.length > 0 ? Option.some(s) : Option.none())),
  );
  const summary = event.agentSession.summary.pipe(
    Option.map((s) => s.trim()),
    Option.flatMap((s) => (s.length > 0 ? Option.some(s) : Option.none())),
  );
  const userPrompt = Option.orElse(promptContext, () =>
    Option.orElse(summary, () => Option.none()),
  ).pipe(Option.getOrElse(() => ""));
  const previousComments = Option.getOrElse(event.previousComments, () => []);
  const guidance = Option.getOrElse(event.guidance, () => []);
  const issue = event.agentSession.issue.pipe(Option.getOrElse(() => null));
  const comment = event.agentSession.comment.pipe(Option.getOrElse(() => null));
  const hasContext =
    Boolean(userPrompt) ||
    issue !== null ||
    comment !== null ||
    previousComments.length > 0 ||
    guidance.length > 0;

  let issueContext = "";
  if (issue) {
    const lines: string[] = [
      `Issue: ${issue.title}${issue.identifier ? ` (${issue.identifier})` : ""}`,
    ];
    if (issue.url) lines.push(`URL: ${issue.url}`);
    if (issue.teamId) lines.push(`Team: ${issue.teamId}`);
    if (issue.projectId) lines.push(`Project: ${issue.projectId}`);
    if (issue.description) lines.push(`\nDescription:\n${issue.description}`);
    issueContext = lines.join("\n");
  }
  return {
    userRequest: userPrompt
      ? `User request:\n${userPrompt}`
      : hasContext
        ? "User request:\nWork on the issue below."
        : "",
    issueContext: issueContext ? `Issue context:\n${issueContext}` : "",
    threadComment: comment ? `Thread comment:\n${comment.body}` : "",
    previousComments:
      previousComments.length > 0
        ? `Previous comments:\n${previousComments
            .map((c, index) => `${index + 1}. ${c.body}`)
            .join("\n")}`
        : "",
    guidance:
      guidance.length > 0
        ? `Guidance:\n${guidance
            .map((g, index) => `${index + 1}. ${g.body}`)
            .join("\n")}`
        : "",
  };
};

export const buildCreatedInputBodyWithTemplate = (
  event: AgentSessionEventType,
  template: string | undefined,
): string =>
  template === undefined
    ? buildCreatedInputBody(event)
    : substitutePromptTemplate(template, createdTemplateValues(event));

export const buildInputId = (
  event: AgentSessionEventType,
  kind: "created" | "prompted" | "stop",
): string => {
  const activityId = event.agentActivity.pipe(
    Option.map((a) => a.id),
    Option.getOrElse(() => ""),
  );
  if (activityId) return `${event.agentSession.id}:${kind}:${activityId}`;
  return `${event.agentSession.id}:${kind}`;
};

export const resolveRawTeamProjectIds = (
  rawIssue: unknown,
): { teamId: string | null; projectId: string | null } => {
  if (!isRecord(rawIssue)) return { teamId: null, projectId: null };
  const teamValue = rawIssue.team;
  const projectValue = rawIssue.project;
  const teamId =
    isRecord(teamValue) && isString(teamValue.id) ? teamValue.id : null;
  const projectId =
    isRecord(projectValue) && isString(projectValue.id)
      ? projectValue.id
      : null;
  return { teamId, projectId };
};

export const decodeOptionalBrand = <A>(
  value: string | null,
  schema: Schema.Codec<A, string, never>,
): Effect.Effect<Option.Option<A>, WebhookPayloadError> => {
  if (value === null) return Effect.succeed(Option.none());
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.map((v) => Option.some(v)),
    Effect.catchTag(
      "SchemaError",
      () =>
        new WebhookPayloadError({
          message: `Invalid identifier ${value}`,
          status: 400,
        }),
    ),
  );
};

export const resolveTeamAndProject = (
  issue: AgentSessionIssueType | null,
  rawIssue: unknown,
): { teamId: string | null; projectId: string | null } => {
  const fallback = resolveRawTeamProjectIds(rawIssue);
  const teamId = issue?.teamId ?? fallback.teamId ?? null;
  const projectId = issue?.projectId ?? fallback.projectId ?? null;
  return { teamId, projectId };
};
export const automationDelegatedPayload = (
  event: AgentSessionEventType,
  rawAgentSession: unknown,
): AgentSessionEventType & { readonly automationDelegated: boolean } => {
  const raw = isRecord(rawAgentSession) ? rawAgentSession : {};
  const creator = raw.creator;
  const creatorPresent =
    (isString(raw.creatorId) && raw.creatorId.length > 0) ||
    (isRecord(creator) && isString(creator.id) && creator.id.length > 0);
  return { ...event, automationDelegated: !creatorPresent };
};

export const validateAgentSessionIdentity = (
  event: AgentSessionEventType,
  config: { readonly linearClientId: string },
  installationRepo: InstallationRepo["Service"],
): Effect.Effect<
  void,
  WebhookIdentityError | DatabaseError | TokenCipherError | RowDecodeError,
  never
> =>
  Effect.gen(function* () {
    if (!clientIdMatches(event.oauthClientId, config.linearClientId)) {
      return yield* Effect.fail(
        new WebhookIdentityError({
          message: `OAuth client identity mismatch (received ${event.oauthClientId})`,
        }),
      );
    }
    if (event.organizationId !== event.agentSession.organizationId) {
      return yield* Effect.fail(
        new WebhookIdentityError({ message: "Organization identity mismatch" }),
      );
    }
    if (event.appUserId !== event.agentSession.appUserId) {
      return yield* Effect.fail(
        new WebhookIdentityError({ message: "App user identity mismatch" }),
      );
    }

    const organizationId = yield* Schema.decodeUnknownEffect(OrganizationId)(
      event.organizationId,
    ).pipe(
      Effect.catchTag(
        "SchemaError",
        () =>
          new WebhookIdentityError({
            message: "Organization identity is not a valid identifier",
          }),
      ),
    );

    const installation = yield* installationRepo.get(organizationId);
    if (Option.isNone(installation)) {
      return yield* Effect.fail(
        new WebhookIdentityError({
          message: "No installation for organization",
        }),
      );
    }
    if (Option.isSome(installation.value.revokedAt)) {
      return yield* Effect.fail(
        new WebhookIdentityError({ message: "Installation is revoked" }),
      );
    }
    if (installation.value.appUserId !== event.appUserId) {
      return yield* Effect.fail(
        new WebhookIdentityError({
          message: "Installation app user mismatch",
        }),
      );
    }
  });

export const handleAgentSessionEvent = (
  event: AgentSessionEventType,
  rawAgentSession: unknown,
  timestamp: number,
  runRepo: RunRepo["Service"],
  runInputRepo: RunInputRepo["Service"],
  promptTemplateRepo: PromptTemplateRepo["Service"],
): Effect.Effect<
  void,
  WebhookPayloadError | WebhookIdentityError | DatabaseError | RowDecodeError,
  never
> =>
  Effect.gen(function* () {
    const issue = event.agentSession.issue.pipe(Option.getOrElse(() => null));
    const rawIssue =
      isRecord(rawAgentSession) && isRecord(rawAgentSession.issue)
        ? rawAgentSession.issue
        : undefined;
    const { teamId, projectId } = resolveTeamAndProject(issue, rawIssue);

    const sessionId = yield* Schema.decodeUnknownEffect(SessionId)(
      event.agentSession.id,
    ).pipe(
      Effect.catchTag(
        "SchemaError",
        () =>
          new WebhookPayloadError({
            message: `Invalid session id ${event.agentSession.id}`,
            status: 400,
          }),
      ),
    );
    const organizationId = yield* Schema.decodeUnknownEffect(OrganizationId)(
      event.agentSession.organizationId,
    ).pipe(
      Effect.catchTag(
        "SchemaError",
        () =>
          new WebhookPayloadError({
            message: `Invalid organization id ${event.agentSession.organizationId}`,
            status: 400,
          }),
      ),
    );
    const issueId = yield* decodeOptionalBrand(
      event.agentSession.issueId.pipe(Option.getOrElse(() => null)),
      IssueId,
    );
    const teamIdOption = yield* decodeOptionalBrand(teamId, TeamId);
    const projectIdOption = yield* decodeOptionalBrand(projectId, ProjectId);
    const persistedPayload = automationDelegatedPayload(event, rawAgentSession);

    const run = yield* runRepo.create({
      sessionId,
      organizationId,
      issueId,
      teamId: teamIdOption,
      projectId: projectIdOption,
      now: timestamp,
    });

    if (run.organizationId !== organizationId) {
      return yield* Effect.fail(
        new WebhookIdentityError({ message: "Session organization mismatch" }),
      );
    }

    if (event.action === "created") {
      const configured = yield* promptTemplateRepo.get(
        organizationId,
        "created",
      );
      const body = buildCreatedInputBodyWithTemplate(
        event,
        Option.isSome(configured) ? configured.value.body : undefined,
      );
      const id = yield* Schema.decodeUnknownEffect(InputId)(
        buildInputId(event, "created"),
      ).pipe(
        Effect.catchTag(
          "SchemaError",
          () =>
            new WebhookPayloadError({
              message: `Invalid input id ${buildInputId(event, "created")}`,
              status: 400,
            }),
        ),
      );
      yield* runInputRepo.enqueue({
        id,
        sessionId,
        kind: "created",
        body,
        payload: persistedPayload,
        createdAt: timestamp,
      });
      return;
    }

    if (event.action === "prompted") {
      const activity = event.agentActivity.pipe(Option.getOrElse(() => null));
      if (activity === null) {
        return yield* Effect.fail(
          new WebhookPayloadError({
            message: "AgentSessionEvent prompted missing agentActivity",
            status: 400,
          }),
        );
      }
      if (activity.agentSessionId !== event.agentSession.id) {
        return yield* Effect.fail(
          new WebhookIdentityError({
            message: "AgentSessionEvent prompted activity session mismatch",
          }),
        );
      }
      const kind: "prompted" | "stop" =
        Option.getOrElse(activity.signal, () => "") === "stop"
          ? "stop"
          : "prompted";
      // Store the RAW body. The prompted template is applied at prompt
      // construction (session-authority), because input.body is also read
      // by repository selection and UI-answer paths that expect the user's
      // literal text.
      const body = extractPromptBody(activity);
      const id = yield* Schema.decodeUnknownEffect(InputId)(
        buildInputId(event, kind),
      ).pipe(
        Effect.catchTag(
          "SchemaError",
          () =>
            new WebhookPayloadError({
              message: `Invalid input id ${buildInputId(event, kind)}`,
              status: 400,
            }),
        ),
      );
      yield* runInputRepo.enqueue({
        id,
        sessionId,
        kind,
        body,
        payload: persistedPayload,
        createdAt: timestamp,
      });
      return;
    }

    if (event.action === "stop") {
      const body = event.agentActivity.pipe(
        Option.map(extractPromptBody),
        Option.getOrElse(() => ""),
      );
      const id = yield* Schema.decodeUnknownEffect(InputId)(
        buildInputId(event, "stop"),
      ).pipe(
        Effect.catchTag(
          "SchemaError",
          () =>
            new WebhookPayloadError({
              message: `Invalid input id ${buildInputId(event, "stop")}`,
              status: 400,
            }),
        ),
      );
      yield* runInputRepo.enqueue({
        id,
        sessionId,
        kind: "stop",
        body,
        payload: persistedPayload,
        createdAt: timestamp,
      });
      return;
    }
  });
