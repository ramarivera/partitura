import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Effect, Option } from "effect";
import type { DatabaseError, RowDecodeError } from "../domain/errors.js";
import { rpcAssistantText } from "../drivers/events.js";
import type { WorkerSandboxMode } from "./config.js";
import {
  LINEAR_WORKER_CONTRACT,
  substitutePromptTemplate,
  T3_SHARED_WORKER_CONTRACT,
  T3_WORKER_CONTRACT,
} from "./prompt-templates.js";
import type { RpcEvent, RpcWorkerHandle } from "./rpc-worker.js";
import type { PromptTemplateRepo } from "./store/repositories.js";

export interface InputContext {
  readonly organizationId: string | null;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly repositoryId: string | null;
  readonly issueLabels: ReadonlyArray<string>;
  readonly projectLabels: ReadonlyArray<string>;
}

export { LINEAR_WORKER_CONTRACT };

export const linearWorkerPrompt = (
  kind: "created" | "prompted" | "stop",
  body: string,
  contract = LINEAR_WORKER_CONTRACT,
): string =>
  kind === "created" ? `${contract}\n\nLinear task:\n${body}` : body;

/** The built-in contract names tools and credentials the runtime really has. */
export const workerContractFor = (
  worker: RpcWorkerHandle,
  t3Connection: "Launch" | "Remote" | undefined,
): string =>
  worker.driverSession?.ref.driver !== "t3"
    ? LINEAR_WORKER_CONTRACT
    : t3Connection === "Launch"
      ? T3_WORKER_CONTRACT
      : T3_SHARED_WORKER_CONTRACT;

export const linearWorkerPromptWithTemplate = (
  repo: PromptTemplateRepo["Service"],
  organizationId: string,
  kind: "created" | "prompted" | "stop",
  body: string,
  defaultContract = LINEAR_WORKER_CONTRACT,
  allowOrganizationContract = true,
): Effect.Effect<string, DatabaseError | RowDecodeError> => {
  if (kind === "prompted") {
    return repo.get(organizationId, "prompted").pipe(
      Effect.map((template) =>
        Option.isSome(template)
          ? substitutePromptTemplate(template.value.body, {
              userRequest: body,
            })
          : linearWorkerPrompt(kind, body),
      ),
    );
  }
  if (!allowOrganizationContract)
    return Effect.succeed(linearWorkerPrompt(kind, body, defaultContract));
  return kind !== "created"
    ? Effect.succeed(linearWorkerPrompt(kind, body))
    : repo
        .get(organizationId, "contract")
        .pipe(
          Effect.map((template) =>
            linearWorkerPrompt(
              kind,
              body,
              Option.isSome(template)
                ? substitutePromptTemplate(template.value.body, {})
                : defaultContract,
            ),
          ),
        );
};

export const resolveDeviationExtensionPath = (
  sandboxMode: WorkerSandboxMode = "native",
): string | null => {
  if (sandboxMode !== "native")
    return "/app/dist/extensions/report-deviation.js";
  const candidates = [
    fileURLToPath(
      new URL("../extensions/report-deviation.ts", import.meta.url),
    ),

    fileURLToPath(new URL("./extensions/report-deviation.js", import.meta.url)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};
const PULL_REQUEST_URL_RE =
  /\bhttps:\/\/(?:github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*(?![A-Za-z0-9_-])(?:[/?#][^\s<>"']*)?|gitlab\.com\/(?:[A-Za-z0-9_.-]+\/)+-\/merge_requests\/[1-9]\d*(?![A-Za-z0-9_-])(?:[/?#][^\s<>"']*)?)/gi;

export const extractPullRequestUrls = (
  text: string,
  maxCount = 16,
): ReadonlyArray<string> => {
  const urls = new Set<string>();
  for (const match of text.matchAll(PULL_REQUEST_URL_RE)) {
    const url = match[0]?.replace(/[.,;:!?)}\]]+$/g, "");
    if (url) urls.add(url);
    if (urls.size >= maxCount) break;
  }
  return [...urls];
};
export const assistantResponseTextFromRpcEvent = rpcAssistantText;

export const deviationFromRpcEvent = (event: RpcEvent): string | null => {
  if (event.type !== "tool_execution_start") return null;
  const toolName = event.toolName ?? event.tool;
  if (toolName !== "rromp_report_deviation" || !record(event.args)) return null;
  const deviation = event.args.deviation;
  return typeof deviation === "string" && deviation.trim().length > 0
    ? deviation.trim()
    : null;
};
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function jsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  return JSON.stringify(value);
}

export function labelSet(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    let raw: string | null = null;
    if (typeof item === "string") {
      raw = item;
    } else if (record(item) && typeof item.name === "string") {
      raw = item.name;
    }
    if (!raw) continue;
    const normalized = raw.trim().toLowerCase();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.sort();
}

export function inputContext(payload: unknown): InputContext {
  if (!record(payload)) {
    return {
      organizationId: null,
      teamId: null,
      projectId: null,
      repositoryId: null,
      issueLabels: [],
      projectLabels: [],
    };
  }
  const session = record(payload.agentSession) ? payload.agentSession : null;
  const issue = session && record(session.issue) ? session.issue : null;
  const project = issue && record(issue.project) ? issue.project : null;
  return {
    organizationId:
      nullableString(payload.organizationId) ??
      (session ? nullableString(session.organizationId) : null),
    teamId: issue ? nullableString(issue.teamId) : null,
    projectId: issue
      ? (nullableString(issue.projectId) ??
        (project ? nullableString(project.id) : null))
      : null,
    repositoryId: nullableString(payload.repositoryId),
    issueLabels: issue ? labelSet(issue.labels) : [],
    projectLabels: project ? labelSet(project.labels) : [],
  };
}
export function isAutomationDelegated(payload: unknown): boolean {
  return record(payload) && payload.automationDelegated === true;
}

export function planItems(value: unknown): Array<{
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}> {
  if (!Array.isArray(value)) return [];
  const candidates = value.flatMap((phase) =>
    record(phase) && Array.isArray(phase.tasks) ? phase.tasks : [phase],
  );
  const items: Array<{
    content: string;
    status: "pending" | "inProgress" | "completed" | "canceled";
  }> = [];
  for (const candidate of candidates) {
    if (!record(candidate) || typeof candidate.content !== "string") continue;
    const status =
      candidate.status === "in_progress" || candidate.status === "inProgress"
        ? "inProgress"
        : candidate.status === "completed"
          ? "completed"
          : candidate.status === "canceled" || candidate.status === "cancelled"
            ? "canceled"
            : "pending";
    items.push({ content: candidate.content, status });
  }
  return items;
}

export function failureCorrelationId(
  sessionId: string,
  attempt: number,
  message: string,
): string {
  return createHash("sha256")
    .update(`${sessionId}\0${attempt}\0${message}`)
    .digest("hex")
    .slice(0, 12);
}
