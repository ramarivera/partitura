import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";
import type { RepositoryRecord } from "../src/domain/models.js";
import { startGitHubGitBroker } from "../src/services/github-git-broker.js";

const repository = {
  id: "repo-id",
  organizationId: "org-id",
  url: "https://github.com/acme/widget.git",
} as RepositoryRecord;

const runGit = async (args: ReadonlyArray<string>, cwd: string) => {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr}`);
};

const gitHttpBackend = async (
  projectRoot: string,
  url: string | URL | Request,
  init: RequestInit | undefined,
  expectedAuthorization: string,
) => {
  const headers = new Headers(init?.headers);
  if (headers.get("authorization") !== expectedAuthorization)
    return new Response("GitHub authentication required", { status: 401 });
  const requestUrl = new URL(String(url));
  const body = init?.body;
  const bytes =
    body === undefined ? Buffer.alloc(0) : Buffer.from(body as Buffer);
  const child = Bun.spawn(["git", "http-backend"], {
    env: {
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: requestUrl.pathname,
      QUERY_STRING: requestUrl.search.slice(1),
      REQUEST_METHOD: init?.method ?? "GET",
      CONTENT_TYPE: headers.get("content-type") ?? "",
      CONTENT_LENGTH: String(bytes.byteLength),
      REMOTE_USER: "partitura-test-app[bot]",
      REMOTE_ADDR: "127.0.0.1",
      SERVER_PROTOCOL: "HTTP/1.1",
      REQUEST_URI: `${requestUrl.pathname}${requestUrl.search}`,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(bytes);
  child.stdin.end();
  const [exitCode, output, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0)
    throw new Error(`git http-backend failed: ${stderr.trim()}`);
  const raw = Buffer.from(output);
  const separator = raw.indexOf(Buffer.from("\r\n\r\n"));
  if (separator < 0) throw new Error("git http-backend omitted CGI headers");
  const responseHeaders = new Headers();
  let status = 200;
  for (const line of raw
    .subarray(0, separator)
    .toString("utf8")
    .split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number(value.slice(0, 3));
    else responseHeaders.set(name, value);
  }
  return new Response(raw.subarray(separator + 4), {
    status,
    headers: responseHeaders,
  });
};

describe("GitHub Git broker", () => {
  it.live("lets real Git push through the configured broker rewrite", () =>
    Effect.promise(async () => {
      const root = await mkdtemp(join(tmpdir(), "partitura-git-broker-"));
      const projects = join(root, "projects");
      const bare = join(projects, "acme", "widget.git");
      const checkout = join(root, "checkout");
      await mkdir(join(projects, "acme"), { recursive: true });
      try {
        const init = Bun.spawn(
          ["git", "init", "--bare", "--initial-branch=main", bare],
          {
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [initCode, initError] = await Promise.all([
          init.exited,
          new Response(init.stderr).text(),
        ]);
        if (initCode !== 0) throw new Error(`git init failed: ${initError}`);
        await runGit(
          ["--git-dir", bare, "config", "http.receivepack", "true"],
          root,
        );
        await mkdir(checkout);
        await runGit(["init", "--initial-branch=main"], checkout);
        await runGit(["config", "user.name", "Partitura test"], checkout);
        await runGit(
          ["config", "user.email", "partitura@example.test"],
          checkout,
        );
        await writeFile(join(checkout, "README.md"), "private push\n");
        await runGit(["add", "README.md"], checkout);
        await runGit(["commit", "-m", "test push"], checkout);
        await runGit(
          ["remote", "add", "origin", "https://github.com/acme/widget.git"],
          checkout,
        );

        const expectedAuthorization = `Basic ${Buffer.from("x-access-token:private-installation-token").toString("base64")}`;
        const upstream = vi.fn(
          (url: string | URL | Request, init?: RequestInit) =>
            gitHttpBackend(projects, url, init, expectedAuthorization),
        );
        const broker = startGitHubGitBroker({
          repository,
          token: "private-installation-token",
          fetch: upstream,
        });
        try {
          const rewrite = {
            key: broker.gitConfigKey,
            value: broker.gitConfigValue,
          };
          await runGit(
            ["config", "--local", rewrite.key, rewrite.value],
            checkout,
          );
          await runGit(
            ["push", "origin", "HEAD:refs/heads/worker-test"],
            checkout,
          );
          const ref = Bun.spawn(
            ["git", "--git-dir", bare, "rev-parse", "refs/heads/worker-test"],
            {
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const [refCode, refOutput, refError] = await Promise.all([
            ref.exited,
            new Response(ref.stdout).text(),
            new Response(ref.stderr).text(),
          ]);
          if (refCode !== 0) throw new Error(`pushed ref missing: ${refError}`);
          expect(refOutput.trim()).toMatch(/^[0-9a-f]{40,64}$/u);
          expect(upstream.mock.calls.length).toBeGreaterThan(0);
        } finally {
          broker.stop();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }),
  );

  it.live(
    "renews upstream credentials between Git requests without changing the session URL",
    () =>
      Effect.promise(async () => {
        let token = "first-token";
        const upstream = vi.fn(
          async (_url: string | URL | Request, _init?: RequestInit) =>
            new Response("pack"),
        );
        const broker = startGitHubGitBroker({
          repository,
          tokenForRequest: async () => token,
          fetch: upstream,
        });
        try {
          const url = `${broker.baseUrl}/info/refs?service=git-upload-pack`;
          expect((await fetch(url)).status).toBe(200);
          token = "renewed-token";
          expect((await fetch(url)).status).toBe(200);
          expect(
            upstream.mock.calls.map(([, init]) =>
              new Headers(init?.headers).get("authorization"),
            ),
          ).toEqual([
            `Basic ${Buffer.from("x-access-token:first-token").toString("base64")}`,
            `Basic ${Buffer.from("x-access-token:renewed-token").toString("base64")}`,
          ]);
        } finally {
          broker.stop();
        }
      }),
  );

  it.live(
    "binds smart HTTP to one repo and puts installation auth only upstream",
    () =>
      Effect.promise(async () => {
        const upstream = vi.fn(
          async (_url: string | URL | Request, _init?: RequestInit) =>
            new Response("000eversion 2\n", {
              status: 200,
              headers: {
                "content-type": "application/x-git-upload-pack-advertisement",
              },
            }),
        );
        const broker = startGitHubGitBroker({
          repository,
          token: "private-installation-token",
          fetch: upstream,
        });
        try {
          const response = await fetch(
            `${broker.baseUrl}/info/refs?service=git-upload-pack`,
            { headers: { "git-protocol": "version=2" } },
          );
          expect(response.status).toBe(200);
          expect(await response.text()).toContain("version 2");
          expect(upstream).toHaveBeenCalledTimes(1);
          const [url, init] = upstream.mock.calls[0] ?? [];
          expect(String(url)).toBe(
            "https://github.com/acme/widget/info/refs?service=git-upload-pack",
          );
          expect(new Headers(init?.headers).get("authorization")).toBe(
            `Basic ${Buffer.from("x-access-token:private-installation-token").toString("base64")}`,
          );
          expect(new Headers(init?.headers).get("git-protocol")).toBe(
            "version=2",
          );
          const compressedBody = gzipSync(Buffer.from("pack-data"));
          const pushed = await fetch(`${broker.baseUrl}/git-receive-pack`, {
            method: "POST",
            headers: {
              "content-type": "application/x-git-receive-pack-request",
              "content-encoding": " GZip ",
              authorization: "Bearer worker-supplied-value",
              "x-untrusted-header": "worker-value",
            },
            body: compressedBody,
          });
          expect(pushed.status).toBe(200);
          expect(upstream).toHaveBeenCalledTimes(2);
          const [pushUrl, pushInit] = upstream.mock.calls[1] ?? [];
          expect(String(pushUrl)).toBe(
            "https://github.com/acme/widget/git-receive-pack",
          );
          expect(pushInit?.body).toEqual(compressedBody);
          expect(new Headers(pushInit?.headers).get("content-encoding")).toBe(
            "gzip",
          );
          expect(
            new Headers(pushInit?.headers).get("x-untrusted-header"),
          ).toBeNull();
          expect(new Headers(pushInit?.headers).get("authorization")).toBe(
            `Basic ${Buffer.from("x-access-token:private-installation-token").toString("base64")}`,
          );
          expect(broker.gitConfigFor("http://git-relay:8080")).toEqual({
            key: expect.stringMatching(
              /^url\.http:\/\/git-relay:8080\/git\/[A-Za-z0-9_-]+\/acme\/widget\.insteadOf$/u,
            ),
            value: "https://github.com/acme/widget.git",
          });
        } finally {
          broker.stop();
        }
      }),
  );

  it.live(
    "refuses another repository and arbitrary paths while validating Git methods",
    () =>
      Effect.promise(async () => {
        const upstream = vi.fn(async () => new Response("unused"));
        const broker = startGitHubGitBroker({
          repository,
          token: "private-token",
          fetch: upstream,
        });
        try {
          expect(
            (
              await fetch(
                `${broker.baseUrl.replace("/acme/widget", "/acme/other")}/info/refs?service=git-upload-pack`,
              )
            ).status,
          ).toBe(404);
          expect(
            (
              await fetch(
                `${broker.baseUrl}/../../other/info/refs?service=git-upload-pack`,
              )
            ).status,
          ).toBe(404);
          expect(
            (
              await fetch(
                `${broker.baseUrl}/info/refs?service=git-receive-pack`,
              )
            ).status,
          ).toBe(200);
          expect(
            (
              await fetch(`${broker.baseUrl}/git-receive-pack`, {
                method: "GET",
              })
            ).status,
          ).toBe(405);
          expect(upstream).toHaveBeenCalledTimes(1);
        } finally {
          broker.stop();
        }
      }),
  );

  it.live("rejects redirects and revokes its session path", () =>
    Effect.promise(async () => {
      const upstream = vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/steal" },
          }),
      );
      const broker = startGitHubGitBroker({
        repository,
        token: "private-token",
        fetch: upstream,
      });
      const response = await fetch(
        `${broker.baseUrl}/info/refs?service=git-upload-pack`,
      );
      expect(response.status).toBe(502);
      broker.stop();
      await expect(
        fetch(`${broker.baseUrl}/info/refs?service=git-upload-pack`),
      ).rejects.toThrow();
      expect(upstream).toHaveBeenCalledTimes(1);
    }),
  );
});
