import { randomBytes, timingSafeEqual } from "node:crypto";
import { readBoundedBody } from "./bounded-body.js";
import type { RpcHostToolDefinition, RpcHostToolResult } from "./rpc-worker.js";
import { MCP_MAX_RESPONSE_BYTES } from "./safe-http.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_NAME = "partitura-linear";

export interface LinearMcpServer {
  readonly url: string;
  readonly authorizationHeader: string;
  readonly stop: () => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorResponse = (id: unknown, code: number, message: string): Response =>
  Response.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { headers: { "cache-control": "no-store" } },
  );

/** One revocable HTTP MCP endpoint for one worker session. */
export const startLinearMcpServer = (input: {
  readonly tools: ReadonlyArray<RpcHostToolDefinition>;
  readonly call: (request: {
    readonly toolName: string;
    readonly arguments: Record<string, unknown>;
  }) => Promise<RpcHostToolResult>;
}): LinearMcpServer => {
  const bearer = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${bearer}`);
  const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
  const lifetime = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    maxRequestBodySize: MCP_MAX_RESPONSE_BYTES,
    async fetch(request) {
      if (request.signal.aborted || lifetime.signal.aborted)
        return new Response("Gone", { status: 410 });
      const supplied = Buffer.from(request.headers.get("authorization") ?? "");
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return new Response("Unauthorized", { status: 401 });
      const url = new URL(request.url);
      if (url.pathname !== "/mcp" || url.search || url.hash)
        return new Response("Not found", { status: 404 });
      if (request.method !== "POST")
        return new Response("Method not allowed", {
          status: 405,
          headers: { allow: "POST" },
        });

      let body: unknown;
      try {
        body = JSON.parse(
          new TextDecoder().decode(
            await readBoundedBody(request, MCP_MAX_RESPONSE_BYTES),
          ),
        );
      } catch {
        return errorResponse(
          null,
          -32700,
          "Invalid or oversized JSON-RPC body",
        );
      }
      if (
        !isRecord(body) ||
        body.jsonrpc !== "2.0" ||
        typeof body.method !== "string"
      )
        return errorResponse(
          isRecord(body) ? (body.id ?? null) : null,
          -32600,
          "Invalid JSON-RPC request",
        );

      const id = body.id;
      const hasId = Object.hasOwn(body, "id");
      const params = isRecord(body.params) ? body.params : {};
      let result: unknown;
      try {
        switch (body.method) {
          case "initialize":
            result = {
              protocolVersion:
                typeof params.protocolVersion === "string"
                  ? params.protocolVersion
                  : PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: SERVER_NAME, version: "1.0.0" },
            };
            break;
          case "notifications/initialized":
          case "notifications/cancelled":
            if (!hasId) return new Response(null, { status: 202 });
            result = {};
            break;
          case "ping":
            result = {};
            break;
          case "tools/list":
            result = {
              tools: [...tools.values()].map((tool) => ({
                name: tool.name,
                ...(tool.label === undefined ? {} : { title: tool.label }),
                description: tool.description,
                inputSchema: tool.parameters,
              })),
            };
            break;
          case "tools/call": {
            const name = params.name;
            if (typeof name !== "string" || !tools.has(name))
              return errorResponse(id ?? null, -32602, "Unknown Linear tool");
            const args = params.arguments ?? {};
            if (!isRecord(args))
              return errorResponse(
                id ?? null,
                -32602,
                "Tool arguments must be an object",
              );
            const result = await input.call({
              toolName: name,
              arguments: args,
            });
            const payload = {
              content: result.content,
              ...(result.isError === true ? { isError: true } : {}),
            };
            const encoded = JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: payload,
            });
            if (Buffer.byteLength(encoded) > MCP_MAX_RESPONSE_BYTES)
              return errorResponse(
                id ?? null,
                -32603,
                "Linear tool response exceeded 1 MiB",
              );
            return new Response(encoded, {
              headers: {
                "cache-control": "no-store",
                "content-type": "application/json",
              },
            });
          }
          default:
            if (!hasId) return new Response(null, { status: 202 });
            return errorResponse(id ?? null, -32601, "Method not found");
        }
      } catch {
        if (!hasId) return new Response(null, { status: 202 });
        return errorResponse(id ?? null, -32603, "Linear MCP request failed");
      }
      if (!hasId) return new Response(null, { status: 202 });
      const encoded = JSON.stringify({ jsonrpc: "2.0", id, result });
      if (Buffer.byteLength(encoded) > MCP_MAX_RESPONSE_BYTES)
        return errorResponse(id ?? null, -32603, "MCP response exceeded 1 MiB");
      return new Response(encoded, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/json",
        },
      });
    },
    error: () => new Response("Linear MCP request failed", { status: 502 }),
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    authorizationHeader: `Bearer ${bearer}`,
    stop: () => {
      lifetime.abort();
      server.stop(true);
      tools.clear();
      expected.fill(0);
    },
  };
};
