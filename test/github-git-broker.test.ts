import { describe, expect, it, vi } from "vitest";
import type { RepositoryRecord } from "../src/domain/models.js";
import { startGitHubGitBroker } from "../src/services/github-git-broker.js";

const repository = {
  id: "repo-id",
  organizationId: "org-id",
  url: "https://github.com/acme/widget.git",
} as RepositoryRecord;

describe("GitHub Git broker", () => {
  it("binds smart HTTP to one repo and puts installation auth only upstream", async () => {
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
      const pushed = await fetch(`${broker.baseUrl}/git-receive-pack`, {
        method: "POST",
        headers: {
          "content-type": "application/x-git-receive-pack-request",
          authorization: "Bearer worker-supplied-value",
        },
        body: "pack-data",
      });
      expect(pushed.status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(2);
      const [pushUrl, pushInit] = upstream.mock.calls[1] ?? [];
      expect(String(pushUrl)).toBe(
        "https://github.com/acme/widget/git-receive-pack",
      );
      expect(pushInit?.body).toEqual(Buffer.from("pack-data"));
      expect(new Headers(pushInit?.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("x-access-token:private-installation-token").toString("base64")}`,
      );
      expect(broker.gitConfigFor("http://git-relay:8080")).toEqual({
        key: expect.stringMatching(
          /^url\.http:\/\/git-relay:8080\/git\/[A-Za-z0-9_-]+\/acme\/widget\.insteadOf$/u,
        ),
        value: "https://github.com/acme/widget",
      });
    } finally {
      broker.stop();
    }
  });

  it("refuses another repository and arbitrary paths while validating Git methods", async () => {
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
        (await fetch(`${broker.baseUrl}/info/refs?service=git-receive-pack`))
          .status,
      ).toBe(200);
      expect(
        (await fetch(`${broker.baseUrl}/git-receive-pack`, { method: "GET" }))
          .status,
      ).toBe(405);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally {
      broker.stop();
    }
  });

  it("rejects redirects and revokes its session path", async () => {
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
  });
});
