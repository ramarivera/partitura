import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DatabaseError } from "../src/domain/errors.js";
import { McpServerRecord } from "../src/domain/models.js";
import {
  type AdminDeps,
  createAdminHandle,
  deriveCsrfToken,
} from "../src/services/admin.js";
import {
  InstallationRepo,
  McpServerRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import {
  config,
  deps,
  organizationId,
  request,
  token,
  unreachable,
} from "./admin-service-helpers.js";

describe("MCP admin endpoints", () => {
  it("requires CSRF and masks secret environment values", async () => {
    const server = Schema.decodeUnknownSync(McpServerRecord)({
      id: "mcp-admin",
      organizationId,
      name: "github",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      url: null,
      env: { API_TOKEN: "super-secret" },
      headers: { Authorization: "header-secret" },
      repositoryId: null,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const mcpServerRepo = McpServerRepo.of({
      createMcpServer: unreachable,
      getMcpServer: () => Effect.succeed(Option.some(server)),
      listMcpServers: () => Effect.succeed([server]),
      updateMcpServer: unreachable,
      deleteMcpServer: unreachable,
    });
    const mcpHandle = createAdminHandle({
      ...deps,
      installationRepo: InstallationRepo.of({
        ...deps.installationRepo,
        get: () => Effect.succeed(Option.none()),
      }),
      workspaceRepo: WorkspaceRepo.of({
        ...deps.workspaceRepo,
        listRepositories: () => Effect.succeed([]),
      }),
      mcpServerRepo,
    });
    const noCsrf = await Effect.runPromise(
      mcpHandle(
        new Request(new URL("/api/admin/mcp-servers", config.publicUrl), {
          method: "POST",
          headers: {
            Cookie: `omp_gateway_admin=${token}`,
            Origin: config.publicUrl.toString(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: "mcp-new",
            name: "new",
            transport: "stdio",
            command: "node",
            args: [],
            env: {},
          }),
        }),
      ),
    );
    expect(Option.getOrElse(noCsrf, () => null)?.status).toBe(403);

    const bootstrap = Option.getOrThrow(
      await Effect.runPromise(
        mcpHandle(
          new Request(new URL("/api/admin/bootstrap", config.publicUrl), {
            headers: { Cookie: `omp_gateway_admin=${token}` },
          }),
        ),
      ),
    );
    const bootstrapBody = await bootstrap.json();
    expect(bootstrapBody.mcpServers[0].env).toEqual({ API_TOKEN: "•••" });
    expect(bootstrapBody.mcpServers[0].headers).toEqual({
      Authorization: "•••",
    });
    expect(JSON.stringify(bootstrapBody)).not.toContain("super-secret");

    const detail = Option.getOrThrow(
      await Effect.runPromise(
        mcpHandle(
          new Request(
            new URL("/api/admin/mcp-servers/mcp-admin", config.publicUrl),
            {
              headers: { Cookie: `omp_gateway_admin=${token}` },
            },
          ),
        ),
      ),
    );
    const detailBody = await detail.json();
    expect(detailBody.mcpServer.env).toEqual({ API_TOKEN: "•••" });
    expect(detailBody.mcpServer.headers).toEqual({
      Authorization: "•••",
    });
    expect(JSON.stringify(detailBody)).not.toContain("super-secret");
  });
  it("preserves masked headers on update and clears them with an explicit empty map", async () => {
    const server = Schema.decodeUnknownSync(McpServerRecord)({
      id: "mcp-headers",
      organizationId,
      name: "remote",
      transport: "http",
      command: null,
      args: [],
      url: "https://mcp.example.test",
      env: { API_TOKEN: "super-secret" },
      headers: { Authorization: "header-secret" },
      repositoryId: null,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    let received: Record<string, unknown> | undefined;
    const mcpServerRepo = McpServerRepo.of({
      listMcpServers: () => Effect.succeed([server]),
      createMcpServer: unreachable,
      getMcpServer: () => Effect.succeed(Option.some(server)),
      updateMcpServer: (_org, _id, input) => {
        received = input as Record<string, unknown>;
        return Effect.succeed(server);
      },
      deleteMcpServer: unreachable,
    });
    const handle = createAdminHandle({ ...deps, mcpServerRepo });
    const put = (headers: Record<string, string>) =>
      Effect.runPromise(
        handle(
          new Request(
            new URL("/api/admin/mcp-servers/mcp-headers", config.publicUrl),
            {
              method: "PUT",
              headers: {
                Cookie: `omp_gateway_admin=${token}`,
                Origin: config.publicUrl.toString(),
                "Content-Type": "application/json",
                "X-CSRF-Token": deriveCsrfToken(token),
              },
              body: JSON.stringify({
                id: "mcp-headers",
                name: "remote",
                transport: "http",
                command: null,
                args: [],
                url: "https://mcp.example.test",
                env: { API_TOKEN: "•••" },
                headers,
                repositoryId: null,
                enabled: true,
              }),
            },
          ),
        ),
      );
    await put({ Authorization: "•••", "X-Trace": "trace-secret" });
    expect(received?.headers).toEqual({
      Authorization: "header-secret",
      "X-Trace": "trace-secret",
    });
    await put({});
    expect(received?.headers).toEqual({});
  });
  it("rejects non-string repository ids before persistence", async () => {
    let called = false;
    const mcpServerRepo = McpServerRepo.of({
      ...deps.mcpServerRepo,
      createMcpServer: (..._args: ReadonlyArray<unknown>) => {
        called = true;
        return Effect.never;
      },
    });
    const handle = createAdminHandle({ ...deps, mcpServerRepo });
    const response = Option.getOrThrow(
      await Effect.runPromise(
        handle(
          new Request(new URL("/api/admin/mcp-servers", config.publicUrl), {
            method: "POST",
            headers: {
              Cookie: `omp_gateway_admin=${token}`,
              Origin: config.publicUrl.toString(),
              "Content-Type": "application/json",
              "X-CSRF-Token": deriveCsrfToken(token),
            },
            body: JSON.stringify({
              id: "numeric-repository",
              name: "numeric-repository",
              transport: "stdio",
              command: "node",
              repositoryId: 42,
            }),
          }),
        ),
      ),
    );
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });
  it("accepts OAuth scope without a client id for dynamic registration", async () => {
    let called = false;
    const mcpServerRepo = {
      ...deps.mcpServerRepo,
      createMcpServer: () => {
        called = true;
        return Effect.fail(new DatabaseError({ message: "sentinel" }));
      },
    } as AdminDeps["mcpServerRepo"];
    const handle = createAdminHandle({ ...deps, mcpServerRepo });
    const response = Option.getOrThrow(
      await Effect.runPromise(
        handle(
          new Request(new URL("/api/admin/mcp-servers", config.publicUrl), {
            method: "POST",
            headers: {
              Cookie: `omp_gateway_admin=${token}`,
              Origin: config.publicUrl.toString(),
              "Content-Type": "application/json",
              "X-CSRF-Token": deriveCsrfToken(token),
            },
            body: JSON.stringify({
              id: "scope-without-client",
              name: "scope-without-client",
              transport: "stdio",
              args: [],
              command: "node",
              oauthScope: "read",
            }),
          }),
        ),
      ),
    );
    expect(response.status).toBe(500);
    expect(called).toBe(true);
  });
  it("drops the previous OAuth secret when replacing the client id", async () => {
    const server = Schema.decodeUnknownSync(McpServerRecord)({
      id: "mcp-oauth-replace",
      organizationId,
      name: "oauth replace",
      transport: "http",
      command: null,
      args: [],
      url: "https://mcp.example.test",
      env: {},
      headers: {},
      oauthClient: {
        clientId: "old-client",
        clientSecret: "old-secret",
        scope: "read",
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      repositoryId: null,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    let received: Record<string, unknown> | undefined;
    let disconnected = false;
    const mcpServerRepo = McpServerRepo.of({
      ...deps.mcpServerRepo,
      getMcpServer: () => Effect.succeed(Option.some(server)),
      updateMcpServer: (_org, _id, input) => {
        received = input as Record<string, unknown>;
        return Effect.succeed(server);
      },
    });
    const handle = createAdminHandle({
      ...deps,
      mcpServerRepo,
      mcpOAuth: {
        ...deps.mcpOAuth,
        disconnect: () => {
          disconnected = true;
          return Effect.void;
        },
      } as AdminDeps["mcpOAuth"],
    });
    const response = Option.getOrThrow(
      await Effect.runPromise(
        handle(
          new Request(
            new URL(
              "/api/admin/mcp-servers/mcp-oauth-replace",
              config.publicUrl,
            ),
            {
              method: "PUT",
              headers: {
                Cookie: `omp_gateway_admin=${token}`,
                Origin: config.publicUrl.toString(),
                "Content-Type": "application/json",
                "X-CSRF-Token": deriveCsrfToken(token),
              },
              body: JSON.stringify({
                id: "mcp-oauth-replace",
                name: "oauth replace",
                transport: "http",
                command: null,
                args: [],
                url: "https://mcp.example.test",
                env: {},
                headers: {},
                repositoryId: null,
                enabled: true,
                oauthClientId: "new-client",
                oauthTokenEndpointAuthMethod: "client_secret_post",
              }),
            },
          ),
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(received?.oauthClient).toEqual({
      clientId: "new-client",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(disconnected).toBe(true);
    const scopeOnlyResponse = Option.getOrThrow(
      await Effect.runPromise(
        handle(
          new Request(
            new URL(
              "/api/admin/mcp-servers/mcp-oauth-replace",
              config.publicUrl,
            ),
            {
              method: "PUT",
              headers: {
                Cookie: `omp_gateway_admin=${token}`,
                Origin: config.publicUrl.toString(),
                "Content-Type": "application/json",
                "X-CSRF-Token": deriveCsrfToken(token),
              },
              body: JSON.stringify({
                id: "mcp-oauth-replace",
                name: "oauth replace",
                transport: "http",
                command: null,
                args: [],
                url: "https://mcp.example.test",
                env: {},
                headers: {},
                repositoryId: null,
                enabled: true,
                oauthClientId: null,
                oauthScope: "read",
              }),
            },
          ),
        ),
      ),
    );
    expect(scopeOnlyResponse.status).toBe(200);
    expect(received?.oauthClient).toEqual({ scope: "read" });
  });
  it("requires enabled to be a boolean and defaults omitted to true", async () => {
    const server = Schema.decodeUnknownSync(McpServerRecord)({
      id: "mcp-enabled",
      organizationId,
      name: "enabled",
      transport: "stdio",
      command: "node",
      args: [],
      url: null,
      env: {},
      headers: {},
      repositoryId: null,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    let receivedEnabled: boolean | undefined;
    let receivedArgs: ReadonlyArray<string> | undefined;
    const mcpServerRepo = {
      ...deps.mcpServerRepo,
      createMcpServer: (
        input: Parameters<AdminDeps["mcpServerRepo"]["createMcpServer"]>[0],
      ) => {
        receivedEnabled = input.enabled;
        receivedArgs = input.args;
        return Effect.succeed(server);
      },
    } as AdminDeps["mcpServerRepo"];
    const handle = createAdminHandle({ ...deps, mcpServerRepo });
    const runLocal = async (requestValue: Request) =>
      Option.getOrThrow(await Effect.runPromise(handle(requestValue)));
    const post = (
      enabled: unknown,
      includeEnabled = true,
      args: ReadonlyArray<string> = [],
    ) =>
      runLocal(
        request("/api/admin/mcp-servers", {
          id: "mcp-enabled",
          name: "enabled",
          transport: "stdio",
          command: "node",
          args,
          ...(includeEnabled ? { enabled } : {}),
        }),
      );
    expect((await post("false")).status).toBe(400);
    const commaArgs = ["--filter=a,b", '{"query":"x,y"}'];
    expect((await post(true, true, commaArgs)).status).toBe(201);
    expect(receivedArgs).toEqual(commaArgs);
    expect(receivedEnabled).toBe(true);
    expect((await post(false)).status).toBe(201);
    expect(receivedEnabled).toBe(false);
    expect((await post(undefined, false)).status).toBe(201);
    expect(receivedEnabled).toBe(true);
  });

  it("rejects invalid MCP header names and accepts RFC token names", async () => {
    const server = Schema.decodeUnknownSync(McpServerRecord)({
      id: "mcp-header-validation",
      organizationId,
      name: "header-validation",
      transport: "http",
      command: null,
      args: [],
      url: "https://mcp.example.test",
      env: {},
      headers: {},
      repositoryId: null,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const mcpServerRepo = {
      ...deps.mcpServerRepo,
      createMcpServer: () => Effect.succeed(server),
    } as AdminDeps["mcpServerRepo"];
    const handle = createAdminHandle({ ...deps, mcpServerRepo });
    const runLocal = async (requestValue: Request) =>
      Option.getOrThrow(await Effect.runPromise(handle(requestValue)));
    const post = (headers: Record<string, string>) =>
      runLocal(
        request("/api/admin/mcp-servers", {
          id: "mcp-header-validation",
          name: "header-validation",
          transport: "http",
          command: null,
          args: [],
          url: "https://mcp.example.test",
          headers,
        }),
      );
    for (const name of ["Bad:Name", "Bad,Name", "Bad Name"]) {
      const response = await post({ [name]: "secret" });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(name);
    }
    expect(
      (await post({ Authorization: "secret", "X-Trace_2": "ok" })).status,
    ).toBe(201);
  });
});
