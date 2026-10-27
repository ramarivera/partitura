import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { Clock, ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import { expect } from "vitest";
import { McpServerId, OrganizationId } from "../src/domain/ids.js";
import { McpServerRecord } from "../src/domain/models.js";
import { GatewayConfig } from "../src/services/config.js";
import {
  MCP_OAUTH_ENCRYPTED_PREFIX,
  McpOAuth,
} from "../src/services/mcp-oauth.js";
import { McpServerRepo } from "../src/services/store/repositories.js";
import {
  SqliteClient,
  SqliteClientLive,
} from "../src/services/store/sqlite-client.js";
import { TokenCrypto } from "../src/services/token-crypto.js";
import { tokenContext } from "../src/services/token-migration.js";
import {
  startWorkerMcpProxy,
  type WorkerMcpProxy,
} from "../src/services/worker-mcp-proxy.js";
import { testPaths } from "./fixtures/paths.js";

export const testPath = testPaths();
export const org = Schema.decodeUnknownSync(OrganizationId)("refresh-org");
export const id = Schema.decodeUnknownSync(McpServerId)("refresh-server");
export const refreshSecret = "gateway-only-refresh-secret";
export const clientSecret = "gateway-only-client-secret";

export const withGateway = async (
  run: (context: {
    readonly createProxy: () => WorkerMcpProxy;
    readonly advance: () => void;
    readonly failRefresh: () => void;
    readonly rejectAccess: () => void;
    readonly rejectAllAccess: () => void;
    readonly refreshes: () => number;
    readonly failures: string[];
    readonly seen: string[];
  }) => Promise<void>,
) => {
  let now = Date.now();
  let refreshed = 0;
  let fail = false;
  let reject = false;
  let rejectAll = false;
  const seen: string[] = [];
  const failures: string[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/token") {
        refreshed++;
        const form = new URLSearchParams(await request.text());
        expect(form.get("refresh_token")).toBe(
          refreshed === 1 ? refreshSecret : `rotated-${refreshed - 1}`,
        );
        expect(form.get("client_secret")).toBe(clientSecret);
        // Force competing sessions to overlap while the real refresh is in flight.
        await Bun.sleep(20);
        return fail
          ? Response.json({ error: refreshSecret }, { status: 400 })
          : Response.json({
              access_token: `fresh-${refreshed}`,
              refresh_token: `rotated-${refreshed}`,
              expires_in: 3600,
            });
      }
      const auth = request.headers.get("authorization") ?? "";
      seen.push(auth);
      expect(request.headers.get("cookie")).toBeNull();
      if (rejectAll || (reject && auth === "Bearer initial-access"))
        return new Response(null, { status: 401 });
      if (request.method === "GET") return new Response(null, { status: 405 });
      return Response.json(
        { ok: true, session: request.headers.get("mcp-session-id") },
        {
          headers: {
            "mcp-session-id": "upstream-session",
            "set-cookie": "private=secret",
          },
        },
      );
    },
  });
  const url = `http://127.0.0.1:${upstream.port}/mcp`;
  const provider = ConfigProvider.fromUnknown(
    Object.fromEntries(
      new Map([
        ["WORKER_SANDBOX_MODE", "native"],
        ["LINEAR_CLIENT_ID", "client"],
        ["LINEAR_CLIENT_SECRET", "secret"],
        ["LINEAR_WEBHOOK_SECRET", "webhook"],
        ["PUBLIC_URL", "http://localhost:3000"],
        ["TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64")],
        ["MCP_OAUTH_ALLOW_LOOPBACK_HTTP", "true"],
      ]),
    ),
    { preserveEmptyStrings: true },
  );
  const config = GatewayConfig.layer.pipe(
    Layer.provide(ConfigProvider.layer(provider)),
  );
  const sqlite = SqliteClientLive(":memory:");
  const crypto = TokenCrypto.layer.pipe(Layer.provide(config));
  const servers = McpServerRepo.layer.pipe(
    Layer.provide(Layer.mergeAll(sqlite, crypto)),
  );
  const oauth = McpOAuth.layer.pipe(
    Layer.provide(Layer.mergeAll(config, sqlite, crypto, servers)),
  );

  const liveClock = Effect.runSync(Clock.Clock);
  const clock = {
    currentTimeNanosUnsafe: liveClock.currentTimeNanosUnsafe.bind(liveClock),
    currentTimeNanos: liveClock.currentTimeNanos,
    monotonicTimeNanosUnsafe:
      liveClock.monotonicTimeNanosUnsafe.bind(liveClock),
    monotonicTimeNanos: liveClock.monotonicTimeNanos,
    sleep: liveClock.sleep.bind(liveClock),
    currentTimeMillis: Effect.sync(() => now),
    currentTimeMillisUnsafe: () => now,
  };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const repo = yield* McpServerRepo;
          const cipher = yield* TokenCrypto;
          const { db } = yield* SqliteClient;
          const service = yield* McpOAuth;
          yield* repo.createMcpServer({
            organizationId: org,
            id,
            name: "upstream",
            transport: "http",
            url,
            now,
          });
          const encrypted = (field: string, value: string) =>
            cipher.encrypt(
              value,
              tokenContext("mcp_oauth_credential", org, id, field),
            );
          const client = yield* encrypted(
            "client_json",
            JSON.stringify({
              clientId: "client",
              clientSecret,
              tokenEndpointAuthMethod: "client_secret_post",
              authorizationEndpoint: `http://127.0.0.1:${upstream.port}/authorize`,
              tokenEndpoint: `http://127.0.0.1:${upstream.port}/token`,
            }),
          );
          const access = yield* encrypted("access_token", "initial-access");
          const refresh = yield* encrypted("refresh_token", refreshSecret);
          db.query(
            "INSERT INTO mcp_oauth_credential (organization_id, server_id, server_url, client_json, access_token, refresh_token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            org,
            id,
            url,
            `${MCP_OAUTH_ENCRYPTED_PREFIX}${client}`,
            `${MCP_OAUTH_ENCRYPTED_PREFIX}${access}`,
            `${MCP_OAUTH_ENCRYPTED_PREFIX}${refresh}`,
            now + 120_000,
            now,
            now,
          );
          const server = Option.getOrThrow(yield* repo.getMcpServer(org, id));
          const runPromise = Effect.runPromiseWith(
            yield* Effect.context<never>(),
          );
          const proxies: WorkerMcpProxy[] = [];
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const proxy of proxies) proxy.stop();
            }),
          );
          yield* Effect.promise(() =>
            run({
              createProxy: () => {
                const proxy = startWorkerMcpProxy({
                  servers: [server],
                  allowLoopbackHttp: true,
                  accessToken: (entry, rejectedAccessToken) =>
                    runPromise(
                      service
                        .mintCredential(org, entry.id, {
                          serverUrl: url,
                          ...(rejectedAccessToken === undefined
                            ? {}
                            : { rejectedAccessToken }),
                        })
                        .pipe(
                          Effect.map(
                            (token) => Option.getOrThrow(token).accessToken,
                          ),
                        ),
                    ),
                  refreshFailed: async (entry) => {
                    failures.push(entry.id);
                  },
                });
                proxies.push(proxy);
                return proxy;
              },
              advance: () => {
                now += 3_600_001;
              },
              failRefresh: () => {
                fail = true;
              },
              rejectAccess: () => {
                reject = true;
              },
              rejectAllAccess: () => {
                rejectAll = true;
              },
              refreshes: () => refreshed,
              failures,
              seen,
            }),
          );
        }).pipe(
          Effect.provide(Layer.mergeAll(sqlite, crypto, servers, oauth)),
          Effect.provideService(Clock.Clock, clock),
        ),
      ),
    );
  } finally {
    upstream.stop(true);
  }
};

export const request = (
  proxy: WorkerMcpProxy,
  headers: Record<string, string> = {},
) => {
  const server = proxy.servers[0];
  if (server === undefined) throw new Error("Expected proxy server");
  return fetch(Option.getOrThrow(server.url), {
    method: "POST",
    headers: { ...server.headers, ...headers },
    body: "{}",
  });
};

export const withSseProxy = async (
  run: (fixture: {
    readonly open: () => Promise<{
      readonly reader: ReadableStreamDefaultReader<Uint8Array>;
      readonly path: string;
      readonly upstream: ServerResponse;
      readonly advertise: (endpoint: string) => Promise<string>;
    }>;
    readonly post: (path: string) => Promise<Response>;
  }) => Promise<void>,
  sharedEndpoint = false,
) => {
  const streams: ServerResponse[] = [];
  const upstream = createServer((request, response) => {
    if (request.method === "POST") {
      response.writeHead(202);
      response.end();
      return;
    }
    streams.push(response);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `event: endpoint\ndata: /messages?session=${sharedEndpoint ? 0 : streams.length}\n\n`,
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected upstream address");
  const server = Schema.decodeUnknownSync(McpServerRecord)({
    id,
    organizationId: org,
    name: "legacy-lifetime",
    transport: "sse",
    command: null,
    args: [],
    url: `http://127.0.0.1:${address.port}/sse`,
    env: {},
    repositoryId: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  });
  const proxy = startWorkerMcpProxy({
    servers: [server],
    allowLoopbackHttp: true,
    accessToken: async () => "access",
    refreshFailed: async () => {
      throw new Error("Unexpected refresh failure");
    },
  });
  try {
    const config = proxy.servers[0];
    if (config === undefined) throw new Error("Expected proxy server");
    const url = Option.getOrThrow(config.url);
    const readEndpoint = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
    ) => {
      const chunk = await reader.read();
      const event = new TextDecoder().decode(chunk.value);
      expect(event).toMatch(
        /^event: endpoint\ndata: \/messages\/[a-f0-9]+\n\n$/u,
      );
      const path = event.split("\n")[1]?.slice("data: ".length);
      if (path === undefined) throw new Error("Expected endpoint");
      return path;
    };
    await run({
      async open() {
        const response = await new Promise<IncomingMessage>(
          (resolve, reject) => {
            const request = httpRequest(
              url,
              { headers: config.headers, agent: false },
              resolve,
            );
            request.on("error", reject);
            request.end();
          },
        );
        const reader = (
          Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>
        ).getReader();
        const path = await readEndpoint(reader);
        const stream = streams.at(-1);
        if (path === undefined || stream === undefined)
          throw new Error("Expected endpoint and upstream stream");
        return {
          reader,
          path,
          upstream: stream,
          advertise: async (endpoint) => {
            stream.write(`event: endpoint\ndata: ${endpoint}\n\n`);
            return readEndpoint(reader);
          },
        };
      },
      post: (path) =>
        fetch(new URL(path, url), {
          method: "POST",
          headers: config.headers,
          body: "{}",
        }),
    });
  } finally {
    proxy.stop();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
      upstream.closeAllConnections();
    });
  }
};
