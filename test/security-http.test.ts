import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BodyTooLargeError,
  readBoundedBody,
} from "../src/services/bounded-body.js";
import { GatewayConfig } from "../src/services/config.js";
import {
  isPublicAddress,
  MCP_MAX_RESPONSE_BYTES,
  safeOAuthFetch,
} from "../src/services/safe-http.js";

const dnsLookup = vi.hoisted(() =>
  vi.fn<
    (
      hostname: string,
      options: { all: true; verbatim: true },
    ) => Promise<Array<{ address: string; family: number }>>
  >(async () => [{ address: "93.184.216.34", family: 4 }]),
);
vi.mock("node:dns/promises", () => ({ lookup: dnsLookup }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fchownSync: vi.fn(actual.fchownSync) };
});
const dirs: string[] = [];
// Scratch storage is mandated by the global AGENTS.md; /tmp can be shared tmpfs.
// Override the base for CI while keeping fixture paths canonical.

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const key = Buffer.alloc(32, 0x42).toString("base64");
const values = new Map([
  ["WORKER_SANDBOX_MODE", "native"],
  ["LINEAR_CLIENT_ID", "test"],
  ["LINEAR_CLIENT_SECRET", "test"],
  ["LINEAR_WEBHOOK_SECRET", "test"],
  ["TOKEN_ENCRYPTION_KEY", key],
  ["PUBLIC_URL", "http://localhost:3000"],
]);
const configLayer = (
  overrides: ReadonlyArray<readonly [string, string]> = [],
) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown(
      Object.fromEntries(new Map([...values, ...overrides])),
      { preserveEmptyStrings: true },
    ),
  );

describe("security boundaries", () => {
  it("enforces body caps for declared and streamed bodies, cancelling on overflow", async () => {
    await expect(
      readBoundedBody(
        new Request("http://example.test", {
          method: "POST",
          headers: { "content-length": "100" },
          body: "x",
        }),
        4,
      ),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readBoundedBody(new Response(stream), 4),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "100.100.100.200",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fd00:ec2::254",
    "fe80::1",
    "64:ff9b::a00:1",
  ])("blocks private or metadata address %s", (address) =>
    expect(isPublicAddress(address)).toBe(false),
  );
  it("blocks DNS with a private answer, cross-origin redirects, POST redirects, and oversized metadata", async () => {
    const lookupMock = dnsLookup;
    lookupMock.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    const transport = vi.fn<typeof fetch>();
    await expect(
      safeOAuthFetch("https://private.example", {}, {}, transport),
    ).rejects.toThrow("forbidden address");
    expect(transport).not.toHaveBeenCalled();
    transport.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest" },
      }),
    );
    await expect(
      safeOAuthFetch("https://public.example", {}, {}, transport),
    ).rejects.toThrow("redirect");
    transport.mockResolvedValueOnce(
      new Response(null, { status: 307, headers: { location: "/other" } }),
    );
    await expect(
      safeOAuthFetch(
        "https://public.example",
        { method: "POST", body: "client_secret=secret" },
        {},
        transport,
      ),
    ).rejects.toThrow("redirect");
    transport.mockResolvedValueOnce(
      new Response("x".repeat(MCP_MAX_RESPONSE_BYTES + 1)),
    );
    await expect(
      safeOAuthFetch("https://public.example", {}, {}, transport),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(
      transport.mock.calls.every(([, init]) => init?.redirect === "manual"),
    ).toBe(true);
  });
  it("revalidates DNS on same-origin redirects and gates loopback HTTP explicitly", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "/next" } }),
      );
    dnsLookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      safeOAuthFetch("https://rebinding.example", {}, {}, transport),
    ).rejects.toThrow("forbidden address");
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(
      safeOAuthFetch("http://127.0.0.1", {}, {}, transport),
    ).rejects.toThrow("HTTPS");
    transport.mockResolvedValueOnce(new Response("ok"));
    expect(
      (
        await safeOAuthFetch(
          "http://127.0.0.1",
          {},
          { allowLoopbackHttp: true },
          transport,
        )
      ).status,
    ).toBe(200);
  });

  it("uses the pinned HTTP transport for explicitly enabled local development", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("pinned-connection"),
    });
    try {
      const response = await safeOAuthFetch(
        `http://127.0.0.1:${server.port}/metadata`,
        {},
        { allowLoopbackHttp: true },
      );
      expect(await response.text()).toBe("pinned-connection");
    } finally {
      await server.stop(true);
    }
  });

  it.each([
    ["gzip", gzipSync],
    ["x-gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const)("decodes %s OAuth JSON responses", async (encoding, compress) => {
    const metadata = { token_endpoint: "https://issuer.example/token" };
    const compressed = compress(JSON.stringify(metadata));
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (request.headers.get("x-check-encoding") === "true")
          expect(request.headers.get("accept-encoding")).toBe(
            "gzip, deflate, br",
          );
        return new Response(compressed, {
          headers: {
            "content-type": "application/json",
            "content-encoding": encoding,
            "content-length": String(compressed.byteLength),
          },
        });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/metadata`;
      if (encoding === "gzip")
        expect(await (await fetch(url)).json()).toEqual(metadata);
      const response = await safeOAuthFetch(
        url,
        {
          headers: {
            "accept-encoding": "unsupported",
            "x-check-encoding": "true",
          },
        },
        { allowLoopbackHttp: true },
      );
      expect(await response.json()).toEqual(metadata);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(response.headers.has("content-length")).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  it("rejects a decompression bomb and cancels the unfinished upstream body", async () => {
    const compressed = gzipSync("x".repeat(MCP_MAX_RESPONSE_BYTES + 1));
    expect(compressed.byteLength).toBeLessThan(MCP_MAX_RESPONSE_BYTES);
    let cancelled = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(compressed);
              // Leave the response open to prove overflow stops upstream input.
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-encoding": "gzip" } },
        ),
    });
    try {
      await expect(
        safeOAuthFetch(
          `http://127.0.0.1:${server.port}/metadata`,
          {},
          { allowLoopbackHttp: true },
        ),
      ).rejects.toBeInstanceOf(BodyTooLargeError);
      await vi.waitFor(() => expect(cancelled).toBe(true));
    } finally {
      await server.stop(true);
    }
  });

  it.each(["zstd", "gzip, br", "identity, gzip"])(
    "rejects unsupported or stacked OAuth content encoding %s",
    async (encoding) => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response('{"ok":true}', {
            headers: { "content-encoding": encoding },
          }),
      });
      try {
        await expect(
          safeOAuthFetch(
            `http://127.0.0.1:${server.port}/metadata`,
            {},
            { allowLoopbackHttp: true },
          ),
        ).rejects.toThrow("Unsupported OAuth content encoding");
      } finally {
        await server.stop(true);
      }
    },
  );

  it("rejects invalid upstream statuses without an uncaught callback exception", async () => {
    const server = createServer((socket) => {
      socket.once("data", () =>
        socket.end(
          "HTTP/1.1 600 Invalid\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
    try {
      await expect(
        safeOAuthFetch(
          `http://127.0.0.1:${address.port}`,
          {},
          { allowLoopbackHttp: true },
        ),
      ).rejects.toThrow("Invalid OAuth HTTP response status");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("fails closed in production and reads organization/owner policy", async () => {
    const load = (overrides: ReadonlyArray<readonly [string, string]>) =>
      Effect.runPromise(
        Effect.result(
          Effect.gen(function* () {
            return yield* GatewayConfig;
          }).pipe(
            Effect.provide(
              GatewayConfig.layer.pipe(Layer.provide(configLayer(overrides))),
            ),
          ),
        ),
      );
    expect(Result.isFailure(await load([["NODE_ENV", "production"]]))).toBe(
      true,
    );
    const admitted = await load([
      ["NODE_ENV", "production"],
      ["LINEAR_ALLOWED_ORGANIZATION_IDS", "org-a,org-b"],
      ["GITHUB_APP_ALLOWED_OWNERS_JSON", '{"org-a":["Alice"]}'],
    ]);
    expect(
      Result.isSuccess(admitted) &&
        admitted.success.allowedOrganizationIds?.has("org-b"),
    ).toBe(true);
    expect(
      Result.isSuccess(admitted) && admitted.success.githubAppAllowedOwners,
    ).toEqual({ "org-a": ["alice"] });
  });
});
