import type { RepositoryRecord } from "../domain/models.js";
import type { RpcHostToolDefinition } from "./rpc-worker.js";

const GITHUB_API = "https://api.github.com";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_TITLE_LENGTH = 256;
const MAX_BODY_LENGTH = 32_768;

export const githubCreatePullRequestToolDefinition: RpcHostToolDefinition = {
  name: "github_create_pull_request",
  label: "GitHub: create pull request",
  description:
    "Open a pull request in the repository assigned to this run, or return the matching open pull request.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["head", "base", "title"],
    properties: {
      head: { type: "string", minLength: 1, maxLength: 255 },
      base: { type: "string", minLength: 1, maxLength: 255 },
      title: { type: "string", minLength: 1, maxLength: MAX_TITLE_LENGTH },
      body: { type: "string", minLength: 1, maxLength: MAX_BODY_LENGTH },
      draft: { type: "boolean" },
    },
  },
};

export interface GitHubPullRequestResult {
  readonly number: number;
  readonly url: string;
  readonly head: string;
  readonly base: string;
  readonly created: boolean;
}

export type GitHubWorkspaceFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface CreateGitHubPullRequestInput {
  readonly repository: RepositoryRecord;
  readonly getToken: (repository: RepositoryRecord) => Promise<string>;
  readonly fetchImpl?: GitHubWorkspaceFetch;
  readonly signal?: AbortSignal;
}

interface PullRequestArguments {
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body?: string;
  readonly draft?: boolean;
}

interface GitHubRepositoryIdentity {
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidArguments = () => new Error("Invalid pull request arguments");

const repositoryIdentity = (
  repository: RepositoryRecord,
): GitHubRepositoryIdentity => {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)(?:\.git)?$/u.exec(
      repository.url,
    );
  const owner = match?.[1];
  const repo = match?.[2]?.replace(/\.git$/u, "");
  if (
    owner === undefined ||
    repo === undefined ||
    [".", "..", ".git"].includes(repo)
  )
    throw new Error("Pull requests require a configured GitHub repository");
  return { owner, repo, fullName: `${owner}/${repo}` };
};

const validGitRef = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".")
  )
    return false;
  return value
    .split("/")
    .every(
      (part) =>
        part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
    );
};

const validText = (
  value: unknown,
  maximum: number,
  allowNewlines: boolean,
): value is string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  )
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      code === 127 ||
      (code < 32 && !(allowNewlines && [9, 10, 13].includes(code)))
    )
      return false;
  }
  return true;
};

const parseArguments = (value: unknown): PullRequestArguments => {
  if (!isRecord(value)) throw invalidArguments();
  const allowed = new Set(["head", "base", "title", "body", "draft"]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw invalidArguments();
  if (
    !validGitRef(value.head) ||
    !validGitRef(value.base) ||
    value.head === value.base ||
    !validText(value.title, MAX_TITLE_LENGTH, false) ||
    (value.body !== undefined &&
      !validText(value.body, MAX_BODY_LENGTH, true)) ||
    (value.draft !== undefined && typeof value.draft !== "boolean")
  )
    throw invalidArguments();
  return {
    head: value.head,
    base: value.base,
    title: value.title,
    ...(value.body === undefined ? {} : { body: value.body }),
    ...(value.draft === undefined ? {} : { draft: value.draft }),
  };
};

const requestSignal = (signal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
};

const discardResponse = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Response stream failures must not surface upstream diagnostics.
  }
};

const responseJson = async (response: Response): Promise<unknown> => {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    await discardResponse(response);
    throw new Error("GitHub response is invalid");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("GitHub response is invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("GitHub response is invalid");
      }
      chunks.push(value);
    }
  } catch {
    throw new Error("GitHub response is invalid");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("GitHub response is invalid");
  }
};

const matchingRepository = (value: unknown, expected: string): boolean =>
  typeof value === "string" && value.toLowerCase() === expected.toLowerCase();

const parsePullRequest = (
  value: unknown,
  repository: GitHubRepositoryIdentity,
): Omit<GitHubPullRequestResult, "created"> => {
  if (!isRecord(value)) throw new Error("GitHub response is invalid");
  const number = value.number;
  const url = value.html_url;
  const head = value.head;
  const base = value.base;
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof url !== "string" ||
    !isRecord(head) ||
    !isRecord(base) ||
    typeof head.ref !== "string" ||
    typeof base.ref !== "string" ||
    !isRecord(head.repo) ||
    !isRecord(base.repo) ||
    !matchingRepository(head.repo.full_name, repository.fullName) ||
    !matchingRepository(base.repo.full_name, repository.fullName)
  )
    throw new Error("GitHub response is invalid");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("GitHub response is invalid");
  }
  const expectedPath = `/${repository.owner}/${repository.repo}/pull/${number}`;
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com" ||
    parsedUrl.port !== "" ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== "" ||
    parsedUrl.search !== "" ||
    parsedUrl.hash !== "" ||
    parsedUrl.pathname.toLowerCase() !== expectedPath.toLowerCase()
  )
    throw new Error("GitHub response is invalid");
  return { number, url, head: head.ref, base: base.ref };
};

/** Creates or reuses an open PR, with every request scoped to the configured repo. */
export async function createGitHubPullRequest(
  input: CreateGitHubPullRequestInput,
  rawArguments: unknown,
): Promise<GitHubPullRequestResult> {
  const identity = repositoryIdentity(input.repository);
  const args = parseArguments(rawArguments);
  let token: string;
  try {
    token = await input.getToken(input.repository);
  } catch {
    throw new Error("GitHub request could not be completed");
  }
  if (!/^[A-Za-z0-9_-]{1,8192}$/u.test(token))
    throw new Error("GitHub request could not be completed");

  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = `${GITHUB_API}/repos/${encodeURIComponent(identity.owner)}/${encodeURIComponent(identity.repo)}/pulls`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const getOpenPullRequest = async (): Promise<
    Omit<GitHubPullRequestResult, "created"> | undefined
  > => {
    const query = new URLSearchParams({
      state: "open",
      head: `${identity.owner}:${args.head}`,
      base: args.base,
    });
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}?${query}`, {
        method: "GET",
        headers,
        redirect: "error",
        signal: requestSignal(input.signal),
      });
    } catch {
      throw new Error("GitHub request could not be completed");
    }
    if (!response.ok) throw new Error("GitHub request could not be completed");
    const value = await responseJson(response);
    if (!Array.isArray(value)) throw new Error("GitHub response is invalid");
    const pullRequests = value.map((item) => parsePullRequest(item, identity));
    return pullRequests.find(
      (pullRequest) =>
        pullRequest.head === args.head && pullRequest.base === args.base,
    );
  };
  const existing = await getOpenPullRequest();
  if (existing !== undefined) return { ...existing, created: false };

  const reconcileAmbiguousPost = async (): Promise<GitHubPullRequestResult> => {
    const reconciled = await getOpenPullRequest();
    if (reconciled !== undefined) return { ...reconciled, created: false };
    throw new Error("GitHub request could not be completed");
  };

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        head: args.head,
        base: args.base,
        title: args.title,
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.draft === undefined ? {} : { draft: args.draft }),
      }),
      redirect: "error",
      signal: requestSignal(input.signal),
    });
  } catch {
    if (input.signal?.aborted)
      throw new Error("GitHub request could not be completed");
    return reconcileAmbiguousPost();
  }
  if (response.status === 422 || response.status >= 500) {
    await discardResponse(response);
    return reconcileAmbiguousPost();
  }
  if (response.status !== 201)
    throw new Error("GitHub request could not be completed");
  try {
    const created = parsePullRequest(await responseJson(response), identity);
    if (created.head !== args.head || created.base !== args.base)
      throw new Error("GitHub response is invalid");
    return { ...created, created: true };
  } catch {
    return reconcileAmbiguousPost();
  }
}
