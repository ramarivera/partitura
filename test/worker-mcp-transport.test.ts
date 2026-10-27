import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { McpServerRecord } from "../src/domain/models.js";
import { writeOmpMcpConfig } from "../src/services/mcp-config.js";
import { safeMcpFetch } from "../src/services/safe-http.js";
import { startWorkerMcpProxy } from "../src/services/worker-mcp-proxy.js";

import {
  id,
  org,
  request,
  testPath,
  withGateway,
  withSseProxy,
} from "./worker-mcp-refresh-helpers.js";

describe("worker MCP proxy transport boundary", () => {
  it.each(["close", "cancel", "error"] as const)(
    "releases legacy SSE routes on %s and supports repeated reconnects",
    async (termination) => {
      await withSseProxy(async ({ open, post }) => {
        const reconnects = termination === "error" ? 1 : 260;
        for (let index = 0; index < reconnects; index++) {
          const stream = await open();
          expect((await post(stream.path)).status).toBe(202);
          if (termination === "cancel") await stream.reader.cancel();
          else if (termination === "close") {
            stream.upstream.end();
            expect((await stream.reader.read()).done).toBe(true);
          } else {
            stream.upstream.destroy();
            // Bun may translate a reset after headers to EOF at its server
            // boundary. Result result must terminate the stream and its routes.
            await stream.reader.read().then(
              (next) => expect(next.done).toBe(true),
              (error: unknown) => expect(error).toBeInstanceOf(Error),
            );
          }
          await vi.waitFor(async () => {
            expect((await post(stream.path)).status).toBe(404);
          });
        }
      });
    },
    30_000,
  );

  it("evicts the oldest active SSE route at the cap and still accepts new endpoints", async () => {
    await withSseProxy(async ({ open, post }) => {
      const oldest = await open();
      let recent = oldest.path;
      for (let index = 1; index < 256; index++)
        recent = await oldest.advertise(`/messages?session=extra-${index}`);
      expect((await post(oldest.path)).status).toBe(202);
      const newest = await open();
      expect((await post(oldest.path)).status).toBe(404);
      expect((await post(newest.path)).status).toBe(202);
      await oldest.reader.cancel();
      expect((await post(newest.path)).status).toBe(202);
      await vi.waitFor(async () => {
        expect((await post(recent)).status).toBe(404);
      });
    });
  });

  it("keeps overlapping streams with the same upstream endpoint independently usable", async () => {
    await withSseProxy(async ({ open, post }) => {
      const first = await open();
      const second = await open();
      await first.reader.cancel();
      await vi.waitFor(async () => {
        expect((await post(first.path)).status).toBe(404);
      });
      expect((await post(second.path)).status).toBe(202);
      await second.reader.cancel();
      await vi.waitFor(async () => {
        expect((await post(second.path)).status).toBe(404);
      });
    }, true);
  });

  it("allows a real MCP tool to return headers after the OAuth five-second deadline", async () => {
    await withGateway(async (gateway) => {
      // Exercise the actual proxy and pinned HTTP socket, not a mocked fetch.
      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch() {
          await Bun.sleep(5500);
          return Response.json({ result: "slow tool completed" });
        },
      });
      const original = gateway.createProxy().servers[0];
      if (original === undefined) throw new Error("Expected proxy server");
      const proxy = startWorkerMcpProxy({
        servers: [
          {
            ...original,
            url: Option.some(`http://127.0.0.1:${upstream.port}/mcp`),
          },
        ],
        allowLoopbackHttp: true,
        accessToken: async () => "access",
        refreshFailed: async () => {
          throw new Error("Unexpected refresh failure");
        },
      });
      try {
        const response = await request(proxy);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          result: "slow tool completed",
        });
      } finally {
        proxy.stop();
        upstream.stop(true);
      }
    });
  }, 10_000);

  it("bounds MCP response headers independently and leaves established SSE streams alive", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/slow") {
          await Bun.sleep(200);
          return Response.json({ ok: true });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode("data: connected\n\n"),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const lifetime = new AbortController();
    try {
      const base = `http://127.0.0.1:${upstream.port}`;
      await expect(
        safeMcpFetch(`${base}/slow`, {}, { allowLoopbackHttp: true }, 50),
      ).rejects.toThrow();
      const response = await safeMcpFetch(
        `${base}/sse`,
        { signal: lifetime.signal },
        { allowLoopbackHttp: true },
        100,
      );
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("Expected SSE stream");
      expect((await reader.read()).done).toBe(false);
      await Bun.sleep(200);
      const pending = reader.read();
      const outcome = pending.then(
        () => "ended",
        () => "ended",
      );
      expect(
        await Promise.race([outcome, Bun.sleep(50).then(() => "open")]),
      ).toBe("open");
      lifetime.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      lifetime.abort();
      upstream.stop(true);
    }
  });

  it("streams legacy SSE, rewrites its POST endpoint and uses fresh authorization", async () => {
    const seen: string[] = [];
    let access = "first";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("authorization") ?? "");
        if (request.method === "GET")
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    "event: endpoint\r\ndata: /messages?session=private\r\n\r\n",
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        expect(new URL(request.url).pathname).toBe("/messages");
        expect(new URL(request.url).searchParams.get("session")).toBe(
          "private",
        );
        return new Response(null, { status: 202 });
      },
    });
    const server = Schema.decodeUnknownSync(McpServerRecord)({
      id,
      organizationId: org,
      name: "legacy",
      transport: "sse",
      command: null,
      args: [],
      url: `http://127.0.0.1:${upstream.port}/sse`,
      env: {},
      repositoryId: null,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const proxy = startWorkerMcpProxy({
      servers: [server],
      allowLoopbackHttp: true,
      accessToken: async () => access,
      refreshFailed: async () => {
        throw new Error("Unexpected refresh failure");
      },
    });
    try {
      const config = proxy.servers[0];
      if (config === undefined) throw new Error("Expected proxy server");
      const response = await fetch(Option.getOrThrow(config.url), {
        headers: config.headers,
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("Expected SSE stream");
      const chunk = await reader.read();
      const event = new TextDecoder().decode(chunk.value);
      expect(event).toMatch(
        /^event: endpoint\ndata: \/messages\/[a-f0-9]+\n\n$/u,
      );
      expect(event).not.toContain("private");
      const path = event.split("\n")[1]?.slice("data: ".length);
      if (path === undefined) throw new Error("Expected advertised endpoint");
      access = "second";
      const posted = await fetch(new URL(path, Option.getOrThrow(config.url)), {
        method: "POST",
        headers: config.headers,
        body: "{}",
      });
      expect(posted.status).toBe(202);
      expect(seen).toEqual(["Bearer first", "Bearer second"]);
      await reader.cancel();
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
  });

  it.each([true, false])(
    "rejects upstream redirects and enforces loopback opt-in with allowLoopbackHttp=%s",
    async (allowLoopbackHttp) => {
      let requests = 0;
      const upstream = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests++;
          expect(new URL(request.url).pathname).toBe("/redirect");
          return new Response(null, {
            status: 302,
            headers: { location: "/secret-target" },
          });
        },
      });
      const server = Schema.decodeUnknownSync(McpServerRecord)({
        id,
        organizationId: org,
        name: "redirect",
        transport: "http",
        command: null,
        args: [],
        url: `http://127.0.0.1:${upstream.port}/redirect`,
        env: {},
        repositoryId: null,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      });
      const proxy = startWorkerMcpProxy({
        servers: [server],
        allowLoopbackHttp,
        accessToken: async () => "access",
        refreshFailed: async () => {
          throw new Error("Unexpected refresh failure");
        },
      });
      try {
        const response = await request(proxy);
        expect(response.status).toBe(502);
        expect(response.headers.get("location")).toBeNull();
        expect(requests).toBe(allowLoopbackHttp ? 1 : 0);
      } finally {
        proxy.stop();
        upstream.stop(true);
      }
    },
  );

  it("refuses to skip a foreign configuration when a gateway proxy is required", async () => {
    const workspace = testPath("foreign-config");
    await writeFile(join(workspace, "mcp.json"), '{"foreign":true}');
    await expect(
      Effect.runPromise(writeOmpMcpConfig(workspace, [], "session", true)),
    ).rejects.toThrow("cannot replace foreign mcp.json");
    expect(await readFile(join(workspace, "mcp.json"), "utf8")).toBe(
      '{"foreign":true}',
    );
  });
});
