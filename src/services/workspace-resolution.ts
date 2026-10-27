import { createHash } from "node:crypto";
import { Effect, Option } from "effect";
import type { DatabaseError, RowDecodeError } from "../domain/errors.js";
import type { OrganizationId } from "../domain/ids.js";
import type { RepositoryRecord } from "../domain/models.js";
import {
  buildGitHubExtraHeader,
  type GitHubAppTokenService,
} from "./github-app.js";
import { workspaceFailure } from "./workspace-git.js";

export type RepositoryResolution =
  | { readonly kind: "match"; readonly repository: RepositoryRecord }
  | { readonly kind: "none" }
  | {
      readonly kind: "ambiguous";
      readonly repositories: ReadonlyArray<RepositoryRecord>;
    };

export interface WorkspaceMarker {
  readonly repositoryId: string;
  readonly url: string;
  readonly ref: string;
}

export interface ResolveContext {
  readonly organizationId: string | null;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly repositoryId: string | null;
  readonly issueLabels: ReadonlyArray<string>;
  readonly projectLabels: ReadonlyArray<string>;
}

export interface WorkspaceRepoShape {
  readonly listRepositories: (
    organizationId: OrganizationId,
  ) => Effect.Effect<
    ReadonlyArray<RepositoryRecord>,
    DatabaseError | RowDecodeError
  >;
}

export function safeSessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

export function hasIntersection(
  haystack: ReadonlyArray<string>,
  needles: ReadonlyArray<string>,
): boolean {
  const set = new Set(haystack);
  for (const needle of needles) {
    if (set.has(needle)) return true;
  }
  return false;
}

export function parseMarker(value: unknown): Option.Option<WorkspaceMarker> {
  if (typeof value !== "object" || value === null) return Option.none();
  const record = value as Record<string, unknown>;
  if (
    typeof record.repositoryId === "string" &&
    typeof record.url === "string" &&
    typeof record.ref === "string"
  ) {
    return Option.some({
      repositoryId: record.repositoryId,
      url: record.url,
      ref: record.ref,
    });
  }
  return Option.none();
}

export function normalizeLabels(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseContext(context: unknown): Option.Option<ResolveContext> {
  if (typeof context !== "object" || context === null) return Option.none();
  const record = context as Record<string, unknown>;
  return Option.some({
    organizationId: optionalString(record.organizationId),
    teamId: optionalString(record.teamId),
    projectId: optionalString(record.projectId),
    repositoryId: optionalString(record.repositoryId),
    issueLabels: normalizeLabels(record.issueLabels),
    projectLabels: normalizeLabels(record.projectLabels),
  });
}

export interface RepositorySuggestionCandidate {
  readonly hostname: string;
  readonly repositoryFullName: string;
}

export const parseRepositorySuggestionCandidate = (
  repositoryUrl: string,
): RepositorySuggestionCandidate | null => {
  let hostname: string;
  let pathname: string;
  try {
    const parsed = new URL(repositoryUrl);
    hostname = parsed.hostname;
    pathname = parsed.pathname;
  } catch {
    const scp = /^git@([^:]+):(.+)$/u.exec(repositoryUrl);
    const scpHost = scp?.[1];
    const scpPath = scp?.[2];
    if (scpHost === undefined || scpPath === undefined) return null;
    hostname = scpHost;
    pathname = `/${scpPath}`;
  }
  const repositoryFullName = pathname
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  if (
    hostname.length === 0 ||
    !/^[^/]+(?:\/[^/]+)+$/u.test(repositoryFullName)
  ) {
    return null;
  }
  return { hostname, repositoryFullName };
};

export const isHttpsGitHubRepositoryUrl = (repositoryUrl: string): boolean => {
  if (repositoryUrl.startsWith("-") || repositoryUrl.includes("\\"))
    return false;
  // Match the raw string too: URL canonicalization must not hide traversal,
  // credentials, encoded path separators, explicit ports, queries or fragments.
  return (
    /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+(?:\.git)?$/u.test(
      repositoryUrl,
    ) && ![".", "..", ".git"].includes(repositoryUrl.split("/").at(-1) ?? "")
  );
};

export const mintGitHubExtraHeader = (
  githubApp: GitHubAppTokenService,
  repository: RepositoryRecord,
  sessionId: string,
) =>
  Effect.gen(function* () {
    const candidate = parseRepositorySuggestionCandidate(repository.url);
    if (
      candidate === null ||
      candidate.hostname.toLowerCase() !== "github.com" ||
      !isHttpsGitHubRepositoryUrl(repository.url)
    ) {
      return undefined;
    }
    const [owner, repositoryName] = candidate.repositoryFullName.split("/");
    if (owner === undefined || repositoryName === undefined) {
      return yield* Effect.fail(
        workspaceFailure(
          "Repository URL did not yield an owner and name",
          "git_failed",
          sessionId,
        )(new Error("invalid repository full name")),
      );
    }
    const token = yield* githubApp
      .getInstallationToken(owner, repositoryName, repository.organizationId)
      .pipe(
        // App not installed on this repo: clone anonymously instead of
        // failing (public repos, or repos outside the App's installations).
        Effect.catchIf(
          (error) =>
            error._tag === "@Gateway/GitHubAppError" &&
            error.reason === "not_installed",
          (_error) =>
            Effect.logInfo("workspace.github_credentials_not_installed").pipe(
              Effect.annotateLogs({
                event: "workspace.github_credentials_not_installed",
                sessionId,
                repositoryId: repository.id,
              }),
              Effect.as(undefined),
            ),
        ),
        Effect.mapError(
          workspaceFailure(
            "GitHub credentials could not be minted",
            "git_failed",
            sessionId,
          ),
        ),
      );
    if (token === undefined) return undefined;
    return buildGitHubExtraHeader(token);
  });
export function onlyItem<A>(items: ReadonlyArray<A>): A | undefined {
  return items.length === 1 ? items[0] : undefined;
}

export function resolveFromRepositories(
  context: ResolveContext,
  repositories: ReadonlyArray<RepositoryRecord>,
): RepositoryResolution {
  if (context.organizationId === null || repositories.length === 0) {
    return { kind: "none" };
  }

  const repositoryId = context.repositoryId;
  if (repositoryId !== null) {
    const match = repositories.find(
      (repository) =>
        repository.id.toLowerCase() === repositoryId.toLowerCase(),
    );
    return match ? { kind: "match", repository: match } : { kind: "none" };
  }

  if (context.issueLabels.length > 0) {
    const matches = repositories.filter((repository) =>
      hasIntersection(repository.labels, context.issueLabels),
    );
    const match = onlyItem(matches);
    if (match !== undefined) return { kind: "match", repository: match };
    if (matches.length > 1) return { kind: "ambiguous", repositories: matches };
  }

  if (context.projectLabels.length > 0) {
    const matches = repositories.filter((repository) =>
      hasIntersection(repository.labels, context.projectLabels),
    );
    const match = onlyItem(matches);
    if (match !== undefined) return { kind: "match", repository: match };
    if (matches.length > 1) return { kind: "ambiguous", repositories: matches };
  }

  const projectId =
    context.projectId !== null ? context.projectId.toLowerCase() : null;
  if (projectId !== null) {
    const matches = repositories.filter((repository) =>
      repository.projectIds.some((id) => id.toLowerCase() === projectId),
    );
    const match = onlyItem(matches);
    if (match !== undefined) return { kind: "match", repository: match };
    if (matches.length > 1) return { kind: "ambiguous", repositories: matches };
  }

  const teamId = context.teamId !== null ? context.teamId.toLowerCase() : null;
  if (teamId !== null) {
    const matches = repositories.filter((repository) =>
      repository.teamIds.some((id) => id.toLowerCase() === teamId),
    );
    const match = onlyItem(matches);
    if (match !== undefined) return { kind: "match", repository: match };
    if (matches.length > 1) return { kind: "ambiguous", repositories: matches };
  }

  const defaultRepository = repositories.find(
    (repository) => repository.isDefault,
  );
  if (defaultRepository)
    return { kind: "match", repository: defaultRepository };
  return { kind: "none" };
}
