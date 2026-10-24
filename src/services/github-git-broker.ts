import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RepositoryRecord } from "../domain/models.js";
import { isHttpsGitHubRepositoryUrl } from "./workspace.js";

const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

export interface GitBrokerHandle {
  readonly port: number;
  readonly bindHost: string;
  readonly baseUrl: string;
  readonly gitConfigKey: string;
  readonly gitConfigValue: string;
  readonly gitConfigFor: (relayBaseUrl: string) => {
    readonly key: string;
    readonly value: string;
  };
  readonly stop: () => void;
}

const boundedBody = async (
  request: Request,
  limit: number,
): Promise<Uint8Array> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit)
    throw new Error("Git request body is too large");
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("Git request body is too large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

const readBounded = async (response: Response, limit: number) => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new Error("GitHub response is too large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("GitHub response is too large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

/** A worker can use its session URL only for one fixed GitHub repository. */
export const startGitHubGitBroker = (input: {
  readonly repository: RepositoryRecord;
  readonly token?: string;
  readonly tokenForRequest?: (
    signal: AbortSignal,
  ) => Promise<string | undefined>;
  readonly bindHost?: string;
  readonly fetch?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}): GitBrokerHandle => {
  if (!isHttpsGitHubRepositoryUrl(input.repository.url))
    throw new Error("Git broker requires a canonical GitHub repository URL");
  if (input.token !== undefined && input.token.length === 0)
    throw new Error("Git broker token must be non-empty");
  const parsed = new URL(input.repository.url);
  const [owner, rawName] = parsed.pathname.replace(/^\//u, "").split("/");
  const repository = (rawName ?? "").replace(/\.git$/u, "");
  if (!owner || !repository) throw new Error("Invalid GitHub repository URL");

  const bearer = randomBytes(32).toString("base64url");
  const upstreamFetch = input.fetch ?? globalThis.fetch;
  const bindHost = input.bindHost ?? "127.0.0.1";
  const expected = Buffer.from(bearer);
  const lifetime = new AbortController();
  let revoked = false;
  const server = Bun.serve({
    hostname: bindHost,
    port: 0,
    idleTimeout: 0,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    async fetch(request) {
      if (revoked) return new Response("Gone", { status: 410 });
      const pathname = new URL(request.url).pathname;
      if (pathname.includes("%"))
        return new Response("Not found", { status: 404 });
      const route = /^\/git\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/u.exec(pathname);
      const supplied = Buffer.from(route?.[1] ?? "");
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return new Response("Unauthorized", { status: 401 });
      if (route?.[2] !== owner || route[3] !== repository)
        return new Response("Not found", { status: 404 });
      const endpoint = route[4] ?? "";
      const url = new URL(request.url);
      const isAdvertisement = endpoint === "info/refs";
      const isUpload = endpoint === "git-upload-pack";
      const isReceive = endpoint === "git-receive-pack";
      const advertisedService = url.searchParams.get("service");
      const allowedQuery = isAdvertisement
        ? url.searchParams.size === 1 &&
          ["git-upload-pack", "git-receive-pack"].includes(
            advertisedService ?? "",
          )
        : url.search === "";
      if (!allowedQuery || !(isAdvertisement || isUpload || isReceive))
        return new Response("Not found", { status: 404 });
      if (
        (isAdvertisement && request.method !== "GET") ||
        (!isAdvertisement && request.method !== "POST")
      )
        return new Response("Method not allowed", {
          status: 405,
          headers: { allow: isAdvertisement ? "GET" : "POST" },
        });
      if (
        !isAdvertisement &&
        request.headers.get("content-type") !==
          (isUpload
            ? "application/x-git-upload-pack-request"
            : "application/x-git-receive-pack-request")
      )
        return new Response("Unsupported Git content type", { status: 415 });
      const upstreamPath = isAdvertisement ? "info/refs" : endpoint;
      const upstream = new URL(
        `https://github.com/${owner}/${repository}/${upstreamPath}`,
      );
      if (isAdvertisement && advertisedService)
        upstream.searchParams.set("service", advertisedService);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120_000);
      const signal = AbortSignal.any([
        controller.signal,
        lifetime.signal,
        request.signal,
      ]);
      try {
        const body =
          request.method === "POST"
            ? await boundedBody(request, MAX_REQUEST_BYTES)
            : undefined;
        const gitProtocol = request.headers.get("git-protocol");
        const contentEncoding = request.headers
          .get("content-encoding")
          ?.trim()
          .toLowerCase();
        const token = input.tokenForRequest
          ? await input.tokenForRequest(signal)
          : input.token;
        signal.throwIfAborted();
        const response = await upstreamFetch(upstream, {
          method: request.method,
          redirect: "manual",
          signal,
          headers: {
            accept:
              "application/x-git-upload-pack-advertisement, application/x-git-upload-pack-result, application/x-git-receive-pack-result, */*",
            ...(gitProtocol === "version=2"
              ? { "git-protocol": gitProtocol }
              : {}),
            ...(token === undefined
              ? {}
              : {
                  authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
                }),
            ...(request.method === "POST"
              ? {
                  "content-type":
                    request.headers.get("content-type") ??
                    "application/x-git-upload-pack-request",
                  ...(contentEncoding === "gzip"
                    ? { "content-encoding": "gzip" }
                    : {}),
                }
              : {}),
          },
          ...(body === undefined ? {} : { body: Buffer.from(body) }),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          return new Response("GitHub redirects are forbidden", {
            status: 502,
          });
        }
        const responseBody = await readBounded(response, MAX_RESPONSE_BYTES);
        const headers = new Headers();
        const contentType = response.headers.get("content-type");
        if (contentType) headers.set("content-type", contentType);
        headers.set("cache-control", "no-store");
        return new Response(responseBody, { status: response.status, headers });
      } catch {
        return new Response("Git broker request failed", { status: 502 });
      } finally {
        clearTimeout(timer);
      }
    },
  });
  const port = server.port;
  if (port === undefined) {
    server.stop(true);
    throw new Error("Git broker did not bind a port");
  }
  const host = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
  const baseUrl = `http://${host}:${port}/git/${bearer}/${owner}/${repository}`;
  // Match the repository's configured URL exactly. Rewriting the prefix
  // without a trailing .git leaves that suffix in the broker path, where it
  // looks like a different repository.
  const remote = input.repository.url;
  const gitConfigFor = (relayBaseUrl: string) => {
    const endpoint = new URL(relayBaseUrl);
    if (
      endpoint.protocol !== "http:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("Git broker relay URL must be a plain HTTP base URL");
    const root = `${endpoint.toString().replace(/\/$/u, "")}/git/${bearer}/${owner}/${repository}`;
    return {
      key: `url.${root}.insteadOf`,
      value: remote,
    };
  };
  return {
    port,
    bindHost,
    baseUrl,
    gitConfigKey: `url.${baseUrl}.insteadOf`,
    gitConfigValue: remote,
    gitConfigFor,
    stop: () => {
      revoked = true;
      lifetime.abort();
      expected.fill(0);
      server.stop(true);
    },
  };
};
