import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  RepositoryRecord,
  type RepositoryRecord as RepositoryRecordType,
} from "../src/domain/models.js";
import {
  createGitHubPullRequest,
  type GitHubWorkspaceFetch,
} from "../src/services/github-workspace-tools.js";

const repository = Schema.decodeUnknownSync(RepositoryRecord)({
  id: "repository-one",
  organizationId: "org-one",
  url: "https://github.com/acme/widgets.git",
  ref: "main",
  teamIds: [],
  projectIds: [],
  nixPackages: [],
  labels: [],
  isDefault: false,
  createdAt: 0,
  updatedAt: 0,
});

const arguments_ = {
  head: "feature/fix-issue",
  base: "main",
  title: "Fix issue",
  body: "The issue is fixed.",
  draft: true,
};

const pullRequest = (
  overrides: {
    readonly number?: number;
    readonly url?: string;
    readonly head?: string;
    readonly base?: string;
    readonly headRepository?: string;
    readonly baseRepository?: string;
  } = {},
) => ({
  number: overrides.number ?? 42,
  html_url: overrides.url ?? "https://github.com/acme/widgets/pull/42",
  head: {
    ref: overrides.head ?? arguments_.head,
    repo: { full_name: overrides.headRepository ?? "acme/widgets" },
  },
  base: {
    ref: overrides.base ?? arguments_.base,
    repo: { full_name: overrides.baseRepository ?? "acme/widgets" },
  },
});

const token = "ghs_test_token_only_for_upstream";
const input = (
  fetchImpl: GitHubWorkspaceFetch,
  overrides: Partial<{
    readonly repository: RepositoryRecordType;
    readonly getToken: (value: RepositoryRecordType) => Promise<string>;
  }> = {},
) => ({
  repository: overrides.repository ?? repository,
  getToken: overrides.getToken ?? (async () => token),
  fetchImpl,
});

describe("GitHub workspace tools", () => {
  it("accepts structured installation tokens without exposing them", async () => {
    const structuredToken = "ghs_fixture.header.payload.signature";
    const authorization: Array<string | null> = [];
    const result = await createGitHubPullRequest(
      input(
        async (_url, init) => {
          authorization.push(new Headers(init?.headers).get("authorization"));
          return Response.json(init?.method === "POST" ? pullRequest() : [], {
            status: init?.method === "POST" ? 201 : 200,
          });
        },
        { getToken: async () => structuredToken },
      ),
      arguments_,
    );
    expect(result.created).toBe(true);
    expect(authorization).toEqual([
      `Bearer ${structuredToken}`,
      `Bearer ${structuredToken}`,
    ]);
    expect(JSON.stringify(result)).not.toContain(structuredToken);
  });

  it("rejects invalid bearer values before making any request", async () => {
    for (const invalid of [
      "",
      "token\r\nx-header: value",
      "token value",
      "token=middle",
      "x".repeat(8193),
    ]) {
      let requested = false;
      await expect(
        createGitHubPullRequest(
          input(
            async () => {
              requested = true;
              return Response.json([]);
            },
            { getToken: async () => invalid },
          ),
          arguments_,
        ),
      ).rejects.toThrow("GitHub request could not be completed");
      expect(requested).toBe(false);
    }
  });

  it("binds create requests to the configured repository and keeps auth upstream", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    let tokenRepository: RepositoryRecordType | undefined;
    const fetchImpl: GitHubWorkspaceFetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (init?.method === "POST")
        return new Response(JSON.stringify(pullRequest()), { status: 201 });
      return new Response("[]", { status: 200 });
    };
    const result = await createGitHubPullRequest(
      input(fetchImpl, {
        getToken: async (value) => {
          tokenRepository = value;
          return token;
        },
      }),
      arguments_,
    );

    expect(result).toEqual({
      number: 42,
      url: "https://github.com/acme/widgets/pull/42",
      head: arguments_.head,
      base: arguments_.base,
      created: true,
    });
    expect(requests).toHaveLength(2);
    expect(tokenRepository).toBe(repository);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/repos/acme/widgets/pulls",
    );
    const query = new URL(requests[0]?.url ?? "").searchParams;
    expect(query.get("head")).toBe(`acme:${arguments_.head}`);
    expect(query.get("base")).toBe(arguments_.base);
    expect(requests[0]?.init?.redirect).toBe("error");
    expect(requests[1]?.init?.redirect).toBe("error");
    for (const request of requests) {
      expect(new Headers(request.init?.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
    }
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual(arguments_);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("validates arguments before getting a token or making a request", async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    const fetchImpl: GitHubWorkspaceFetch = async () => {
      fetchCalls += 1;
      return new Response("[]", { status: 200 });
    };
    const service = input(fetchImpl, {
      getToken: async () => {
        tokenCalls += 1;
        return token;
      },
    });
    for (const value of [
      { ...arguments_, head: "acme:feature/fix-issue" },
      { ...arguments_, head: "-bad" },
      { ...arguments_, base: "main:other" },
      { ...arguments_, title: "  " },
      { ...arguments_, draft: "true" },
      { ...arguments_, owner: "attacker" },
      { ...arguments_, title: "t".repeat(257) },
    ]) {
      await expect(createGitHubPullRequest(service, value)).rejects.toThrow(
        "Invalid pull request arguments",
      );
    }
    await expect(
      createGitHubPullRequest(
        input(fetchImpl, {
          repository: {
            ...repository,
            url: "https://github.com/acme/../other",
          },
        }),
        arguments_,
      ),
    ).rejects.toThrow("configured GitHub repository");
    expect(tokenCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it("reuses an existing matching open pull request", async () => {
    const requests: string[] = [];
    const fetchImpl: GitHubWorkspaceFetch = async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify([pullRequest()]), { status: 200 });
    };
    const result = await createGitHubPullRequest(input(fetchImpl), arguments_);
    expect(result.created).toBe(false);
    expect(result.number).toBe(42);
    expect(requests).toHaveLength(1);
  });

  it("reconciles an ambiguous POST once without blindly retrying", async () => {
    const requests: string[] = [];
    const fetchImpl: GitHubWorkspaceFetch = async (url, init) => {
      requests.push(`${init?.method}:${String(url)}`);
      if (init?.method === "POST") throw new TypeError("connection reset");
      return new Response(
        JSON.stringify(requests.length === 1 ? [] : [pullRequest()]),
        { status: 200 },
      );
    };
    const result = await createGitHubPullRequest(input(fetchImpl), arguments_);
    expect(result.created).toBe(false);
    expect(result.number).toBe(42);
    expect(requests.map((request) => request.split(":", 1)[0])).toEqual([
      "GET",
      "POST",
      "GET",
    ]);
  });

  it("reconciles a concurrent 422 response through the same lookup", async () => {
    let getCount = 0;
    const fetchImpl: GitHubWorkspaceFetch = async (_url, init) => {
      if (init?.method === "POST") return new Response("{}", { status: 422 });
      getCount += 1;
      return new Response(
        JSON.stringify(getCount === 1 ? [] : [pullRequest()]),
        { status: 200 },
      );
    };
    const result = await createGitHubPullRequest(input(fetchImpl), arguments_);
    expect(result.created).toBe(false);
    expect(getCount).toBe(2);
  });

  it("rejects oversized responses and PRs outside the bound repository", async () => {
    const oversized: GitHubWorkspaceFetch = async () =>
      new Response("[]", {
        status: 200,
        headers: { "content-length": "1048577" },
      });
    await expect(
      createGitHubPullRequest(input(oversized), arguments_),
    ).rejects.toThrow("GitHub response is invalid");

    const oversizedStream: GitHubWorkspaceFetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            controller.close();
          },
        }),
        { status: 200 },
      );
    await expect(
      createGitHubPullRequest(input(oversizedStream), arguments_),
    ).rejects.toThrow("GitHub response is invalid");

    const foreign: GitHubWorkspaceFetch = async (_url, init) =>
      init?.method === "POST"
        ? new Response(
            JSON.stringify(pullRequest({ headRepository: "attacker/other" })),
            { status: 201 },
          )
        : new Response("[]", { status: 200 });
    await expect(
      createGitHubPullRequest(input(foreign), arguments_),
    ).rejects.toThrow("GitHub request could not be completed");
  });
});
