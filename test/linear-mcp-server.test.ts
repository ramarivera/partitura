import { describe, expect, it } from "vitest";
import { startLinearMcpServer } from "../src/services/linear-mcp-server.js";

const tools = [
  {
    name: "linear_read",
    label: "Linear: read",
    description: "Read a Linear value.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
];

const post = (url: string, authorization: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

describe("per-session Linear MCP server", () => {
  it("authenticates, lists tools, dispatches, and revokes the session", async () => {
    let received: unknown;
    const server = startLinearMcpServer({
      tools,
      call: async (request) => {
        received = request;
        return { content: [{ type: "text", text: "read complete" }] };
      },
    });
    try {
      expect(server.authorizationHeader).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/u);
      expect(
        (
          await post(server.url, "Bearer wrong", {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
          })
        ).status,
      ).toBe(401);

      const initialized = await post(server.url, server.authorizationHeader, {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      });
      expect(initialized.status).toBe(200);
      expect(await initialized.json()).toMatchObject({
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
        },
      });

      const listed = await post(server.url, server.authorizationHeader, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
      });
      expect(await listed.json()).toMatchObject({
        result: {
          tools: [{ name: "linear_read", inputSchema: tools[0]?.parameters }],
        },
      });

      const called = await post(server.url, server.authorizationHeader, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "linear_read", arguments: { id: "issue-1" } },
      });
      expect(await called.json()).toMatchObject({
        result: { content: [{ type: "text", text: "read complete" }] },
      });
      expect(received).toEqual({
        toolName: "linear_read",
        arguments: { id: "issue-1" },
      });
    } finally {
      server.stop();
    }
    await expect(
      fetch(server.url, {
        method: "POST",
        headers: { authorization: server.authorizationHeader },
        body: "{}",
      }),
    ).rejects.toThrow();
  });

  it("caps tool responses at 1 MiB", async () => {
    const server = startLinearMcpServer({
      tools,
      call: async () => ({
        content: [{ type: "text", text: "x".repeat(1_048_576) }],
      }),
    });
    try {
      const response = await post(server.url, server.authorizationHeader, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "linear_read", arguments: { id: "issue-1" } },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        error: { code: -32603, message: "Linear tool response exceeded 1 MiB" },
      });
    } finally {
      server.stop();
    }
  });
});
