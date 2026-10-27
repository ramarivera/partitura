import { Cause, Effect, Logger, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RowDecodeError } from "../src/domain/errors.js";
import { McpServerRecord } from "../src/domain/models.js";
import {
  type AdminDeps,
  createAdminHandle,
  deriveCsrfToken,
} from "../src/services/admin.js";
import { McpServerRepo } from "../src/services/store/repositories.js";
import { decodeRow } from "../src/services/store/sqlite-client.js";
import {
  config,
  deps,
  organizationId,
  token,
  unreachable,
} from "./admin-service-helpers.js";

describe("Executor admin endpoints", () => {
  const mutation = (path: string, method: string, body: unknown) =>
    new Request(new URL(path, config.publicUrl), {
      method,
      headers: {
        Cookie: `omp_gateway_admin=${token}`,
        Origin: config.publicUrl.toString(),
        "Content-Type": "application/json",
        "X-CSRF-Token": deriveCsrfToken(token),
      },
      body: JSON.stringify(body),
    });

  it("rejects endpoint credentials, queries, and fragments before persistence", async () => {
    let puts = 0;
    const executorInstanceRepo = {
      get: () => Effect.succeed(Option.none()),
      put: () => {
        puts += 1;
        return Effect.never;
      },
      remove: unreachable,
    } as unknown as AdminDeps["executorInstanceRepo"];
    const handle = createAdminHandle({ ...deps, executorInstanceRepo });
    for (const endpoint of [
      "https://user:pass@executor.example",
      "https://executor.example?tenant=one",
      "https://executor.example/#fragment",
    ]) {
      const response = Option.getOrThrow(
        await Effect.runPromise(
          handle(
            mutation("/api/admin/executor-instance", "PUT", {
              endpoint,
              token: "secret",
            }),
          ),
        ),
      );
      expect(response.status).toBe(400);
    }
    expect(puts).toBe(0);
  });

  it("rotates credentials and URLs for attached Executor MCP rows", async () => {
    const attached = Schema.decodeUnknownSync(McpServerRecord)({
      id: "executor-toolkit",
      organizationId,
      name: "executor:toolkit:Toolkit",
      transport: "http",
      command: null,
      args: [],
      url: "https://old.example/mcp/toolkits/toolkit",
      env: {},
      headers: { Authorization: "Bearer old-token" },
      repositoryId: null,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    let persisted = {
      organizationId,
      endpoint: "https://old.example",
      token: "old-token",
      updatedAt: 1,
    };
    let updateInput: Record<string, unknown> | undefined;
    const executorInstanceRepo = {
      get: () => Effect.succeed(Option.some(persisted)),
      put: (input: typeof persisted) => {
        persisted = input;
        return Effect.succeed(persisted);
      },
      remove: () => Effect.succeed(true),
    } as unknown as AdminDeps["executorInstanceRepo"];
    const mcpServerRepo = McpServerRepo.of({
      listMcpServers: () => Effect.succeed([attached]),
      createMcpServer: unreachable,
      getMcpServer: () => Effect.succeed(Option.some(attached)),
      updateMcpServer: (_org, _id, input) => {
        updateInput = input as Record<string, unknown>;
        return Effect.succeed(attached);
      },
      deleteMcpServer: unreachable,
    });
    const handle = createAdminHandle({
      ...deps,
      executorInstanceRepo,
      mcpServerRepo,
    });
    const response = Option.getOrThrow(
      await Effect.runPromise(
        handle(
          mutation("/api/admin/executor-instance", "PUT", {
            endpoint: "https://new.example/base",
            token: "new-token",
          }),
        ),
      ),
    );
    expect(response.status).toBe(200);
    expect(updateInput).toMatchObject({
      url: "https://new.example/base/mcp/toolkits/toolkit",
      headers: { Authorization: "Bearer new-token" },
    });
  });

  it("disables attached rows when Executor credentials are removed", async () => {
    const attached = Schema.decodeUnknownSync(McpServerRecord)({
      id: "executor-toolkit",
      organizationId,
      name: "executor:toolkit:Toolkit",
      transport: "http",
      command: null,
      args: [],
      url: "https://old.example/mcp/toolkits/toolkit",
      env: {},
      headers: { Authorization: "Bearer old-token" },
      repositoryId: null,
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    let enabled: boolean | undefined;
    const mcpServerRepo = McpServerRepo.of({
      listMcpServers: () => Effect.succeed([attached]),
      createMcpServer: unreachable,
      getMcpServer: () => Effect.succeed(Option.some(attached)),
      updateMcpServer: (_org, _id, input) => {
        enabled = input.enabled;
        return Effect.succeed(attached);
      },
      deleteMcpServer: unreachable,
    });
    const executorInstanceRepo = {
      get: () =>
        Effect.succeed(
          Option.some({
            organizationId,
            endpoint: "https://old.example",
            token: "old-token",
            updatedAt: 1,
          }),
        ),
      put: unreachable,
      remove: () => Effect.succeed(true),
    } as unknown as AdminDeps["executorInstanceRepo"];
    const handle = createAdminHandle({
      ...deps,
      executorInstanceRepo,
      mcpServerRepo,
    });
    const response = Option.getOrThrow(
      await Effect.runPromise(
        handle(mutation("/api/admin/executor-instance", "DELETE", {})),
      ),
    );
    expect(response.status).toBe(204);
    expect(enabled).toBe(false);
  });
});

it("denies shared Nix cache inspection and pruning to tenant admins", async () => {
  const handle = createAdminHandle({
    ...deps,
    config: { ...config, gatewayAdminOrganizationIds: new Set() },
  });
  for (const [path, method] of [
    ["/api/admin/nix-cache", "GET"],
    [`/api/admin/nix-cache/${"a".repeat(64)}/prune`, "POST"],
  ] as const) {
    const response = await Effect.runPromise(
      handle(
        new Request(new URL(path, config.publicUrl), {
          method,
          headers: {
            Cookie: `omp_gateway_admin=${token}`,
            Origin: config.publicUrl.origin,
            "X-CSRF-Token": deriveCsrfToken(token),
          },
        }),
      ),
    );
    expect(Option.getOrThrow(response).status).toBe(403);
  }
});

describe("v4 cause and schema boundaries", () => {
  const permutations = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  it.each(permutations)(
    "preserves typed failure precedence for cause order %s,%s,%s",
    async (...order) => {
      const reasons = [
        Cause.makeFailReason(
          new RowDecodeError({ message: "typed row", entity: "run" }),
        ),
        Cause.makeDieReason(
          new RowDecodeError({ message: "defect row", entity: "run" }),
        ),
        Cause.makeInterruptReason(0),
      ];
      const cause = Cause.fromReasons(
        order.map((index) => {
          const reason = reasons[index];
          if (reason === undefined) throw new Error("Missing cause fixture");
          return reason;
        }),
      );
      const local = createAdminHandle({
        ...deps,
        runRepo: { ...deps.runRepo, get: () => Effect.failCause(cause) },
      });
      const response = Option.getOrThrow(
        await Effect.runPromise(
          local(
            new Request("http://localhost:3000/runs/session.json", {
              headers: { cookie: `omp_gateway_admin=${token}` },
            }),
          ),
        ),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe("typed row");
    },
  );

  it("keeps malformed row input out of public errors and logs", async () => {
    const secret = "malformed-row-private-token";
    const logs: unknown[] = [];
    const logger = Logger.make((entry) => {
      logs.push({ message: entry.message, cause: entry.cause });
    });
    const local = createAdminHandle({
      ...deps,
      runRepo: {
        ...deps.runRepo,
        get: () =>
          decodeRow(
            Schema.Struct({ accessToken: Schema.Number }),
            { accessToken: secret },
            "run",
          ).pipe(Effect.as(Option.none())),
      },
    });
    const result = await Effect.runPromise(
      local(
        new Request("http://localhost:3000/runs/session.json", {
          headers: { cookie: `omp_gateway_admin=${token}` },
        }),
      ).pipe(Effect.provide(Logger.layer([logger]))),
    );
    const response = Option.getOrThrow(result);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Stored data is invalid");
    expect(JSON.stringify(logs)).not.toContain(secret);
  });
});
