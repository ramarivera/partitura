import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { writeOmpMcpConfig } from "../src/services/mcp-config.js";
import { materializeMcpAgentDb } from "../src/services/mcp-oauth.js";

import {
  clientSecret,
  id,
  refreshSecret,
  request,
  testPath,
  withGateway,
} from "./worker-mcp-refresh-helpers.js";

describe("gateway-mediated worker MCP refresh", () => {
  it("keeps the same worker configuration working after expiry without worker OAuth material", async () => {
    await withGateway(async (gateway) => {
      const proxy = gateway.createProxy();
      const workspace = testPath("worker");
      await Effect.runPromise(writeOmpMcpConfig(workspace, proxy.servers));
      const agentDir = await materializeMcpAgentDb(workspace, []);
      const config = await readFile(join(workspace, "mcp.json"), "utf8");
      const db = new Database(join(agentDir, "agent.db"));
      expect(db.query("SELECT * FROM auth_credentials").all()).toEqual([]);
      db.close();
      const payload = JSON.stringify(proxy.servers);
      for (const secret of [
        refreshSecret,
        clientSecret,
        "initial-access",
        "/token",
      ]) {
        expect(config).not.toContain(secret);
        expect(payload).not.toContain(secret);
        expect(
          (await readFile(join(agentDir, "agent.db"))).includes(
            Buffer.from(secret),
          ),
        ).toBe(false);
      }
      expect((await request(proxy)).status).toBe(200);
      gateway.advance();
      expect((await request(proxy)).status).toBe(200);
      gateway.advance();
      expect((await request(proxy)).status).toBe(200);
      expect(gateway.seen).toEqual([
        "Bearer initial-access",
        "Bearer fresh-1",
        "Bearer fresh-2",
      ]);
      expect(await readFile(join(workspace, "mcp.json"), "utf8")).toBe(config);
      expect(gateway.refreshes()).toBe(2);
    });
  });

  it("single-flights one installation credential across concurrent worker sessions", async () => {
    await withGateway(async (gateway) => {
      const first = gateway.createProxy();
      const second = gateway.createProxy();
      gateway.advance();
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, i) => request(i % 2 ? first : second)),
      );
      expect(responses.map((response) => response.status)).toEqual(
        Array(12).fill(200),
      );
      expect(gateway.refreshes()).toBe(1);
      expect(new Set(gateway.seen)).toEqual(new Set(["Bearer fresh-1"]));
    });
  });

  it("reports a sanitized renewal failure for each affected worker and never sends the expired token", async () => {
    await withGateway(async (gateway) => {
      const first = gateway.createProxy();
      const second = gateway.createProxy();
      gateway.advance();
      gateway.failRefresh();
      const responses = await Promise.all([request(first), request(second)]);
      expect(gateway.refreshes()).toBe(1);
      expect(gateway.failures).toEqual([id, id]);
      expect(gateway.seen).toEqual([]);
      for (const response of responses) {
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain(refreshSecret);
      }
    });
  });

  it("refreshes once on an early upstream 401 and strips worker-supplied credentials", async () => {
    await withGateway(async (gateway) => {
      const proxy = gateway.createProxy();
      gateway.rejectAccess();
      const response = await request(proxy, {
        cookie: "worker-cookie",
        "mcp-session-id": "session",
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("mcp-session-id")).toBe("upstream-session");
      expect(await response.json()).toEqual({ ok: true, session: "session" });
      expect(gateway.seen).toEqual(["Bearer initial-access", "Bearer fresh-1"]);
      expect(gateway.refreshes()).toBe(1);
    });
  });

  it("rejects absent and other-session bearers and revokes access on stop", async () => {
    await withGateway(async (gateway) => {
      const first = gateway.createProxy();
      const second = gateway.createProxy();
      expect((await request(first, { Authorization: "" })).status).toBe(401);
      expect((await request(first, second.servers[0]?.headers)).status).toBe(
        401,
      );
      const server = first.servers[0];
      if (server === undefined) throw new Error("Expected proxy server");
      expect(
        (
          await fetch(`${Option.getOrThrow(server.url)}?target=http://evil`, {
            headers: server.headers,
          })
        ).status,
      ).toBe(404);
      expect(gateway.seen).toEqual([]);
      first.stop();
      await expect(request(first)).rejects.toThrow();
    });
  });

  it("reports a sanitized failure when the refreshed credential is also rejected", async () => {
    await withGateway(async (gateway) => {
      const proxy = gateway.createProxy();
      gateway.rejectAllAccess();
      const response = await request(proxy);
      expect(response.status).toBe(502);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(await response.text()).toBe(
        "MCP gateway request failed; check run events",
      );
      expect(gateway.seen).toEqual(["Bearer initial-access", "Bearer fresh-1"]);
      expect(gateway.refreshes()).toBe(1);
      expect(gateway.failures).toEqual([id]);
    });
  });
});
