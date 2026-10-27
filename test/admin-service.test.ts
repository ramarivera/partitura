import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DatabaseError } from "../src/domain/errors.js";
import { OrganizationId } from "../src/domain/ids.js";
import { RepositoryRecord } from "../src/domain/models.js";
import {
  createAdminHandle,
  csrfHash,
  deriveCsrfToken,
} from "../src/services/admin.js";
import { validateAgentSettings } from "../src/services/agent-settings.js";
import { NixEnvironment } from "../src/services/nix-environment.js";
import {
  AdminSessionRepo,
  AgentSettingsRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import {
  config,
  deps,
  handle,
  organizationId,
  request,
  run,
  token,
  unreachable,
} from "./admin-service-helpers.js";

describe("service Admin request validation", () => {
  const putAgentSettings = (
    handleValue: typeof handle,
    input: {
      readonly body?: unknown;
      readonly cookie?: string;
      readonly csrf?: string;
      readonly origin?: string;
    } = {},
  ) =>
    handleValue(
      new Request(new URL("/api/admin/agent-settings", config.publicUrl), {
        method: "PUT",
        headers: {
          ...(input.cookie === undefined
            ? { Cookie: `omp_gateway_admin=${token}` }
            : { Cookie: input.cookie }),
          ...(input.origin === undefined
            ? { Origin: config.publicUrl.toString() }
            : { Origin: input.origin }),
          ...(input.csrf === undefined
            ? { "X-CSRF-Token": deriveCsrfToken(token) }
            : { "X-CSRF-Token": input.csrf }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input.body ?? { defaults: { driver: "t3" } }),
      }),
    );

  it("protects organization settings with session, origin, and CSRF checks", async () => {
    let upsertOrganization: string | undefined;
    const settingsHandle = createAdminHandle({
      ...deps,
      agentSettingsRepo: AgentSettingsRepo.of({
        ...deps.agentSettingsRepo,
        upsert: (organization, settings) => {
          upsertOrganization = organization;
          return Effect.succeed(validateAgentSettings(settings));
        },
      }),
    });
    const noSession = await Effect.runPromise(
      putAgentSettings(settingsHandle, { cookie: "" }),
    );
    expect(Option.getOrElse(noSession, () => null)?.status).toBe(401);

    const wrongCsrf = await Effect.runPromise(
      putAgentSettings(settingsHandle, { csrf: "wrong" }),
    );
    expect(Option.getOrElse(wrongCsrf, () => null)?.status).toBe(403);

    const wrongOrganization = OrganizationId.make(
      "22222222-2222-4222-8222-222222222222",
    );
    const foreignHandle = createAdminHandle({
      ...deps,
      adminSessionRepo: AdminSessionRepo.of({
        ...deps.adminSessionRepo,
        get: () =>
          Effect.succeed(
            Option.some({
              organizationId: wrongOrganization,
              csrfTokenHash: csrfHash(deriveCsrfToken(token)),
            }),
          ),
      }),
    });
    const foreign = await Effect.runPromise(putAgentSettings(foreignHandle));
    expect(Option.getOrElse(foreign, () => null)?.status).toBe(401);
    expect(upsertOrganization).toBeUndefined();

    const allowed = await Effect.runPromise(putAgentSettings(settingsHandle));
    expect(Option.getOrElse(allowed, () => null)?.status).toBe(200);
    expect(upsertOrganization).toBe(organizationId);
  });

  it("separates settings validation failures from persistence failures", async () => {
    const invalid = await Effect.runPromise(
      putAgentSettings(handle, {
        body: { modelAliases: { unsafe: { omp: "../../provider/model" } } },
      }),
    );
    expect(Option.getOrElse(invalid, () => null)?.status).toBe(400);

    const failingHandle = createAdminHandle({
      ...deps,
      agentSettingsRepo: AgentSettingsRepo.of({
        ...deps.agentSettingsRepo,
        upsert: () =>
          Effect.fail(new DatabaseError({ message: "database unavailable" })),
      }),
    });
    const failedWrite = await Effect.runPromise(
      putAgentSettings(failingHandle),
    );
    expect(Option.getOrElse(failedWrite, () => null)?.status).toBe(500);
  });

  it("returns 400 for malformed optional repository arrays", async () => {
    for (const field of ["teamIds", "projectIds", "labels"]) {
      const response = await run(
        request("/api/admin/repositories", {
          id: `repo-${field}`,
          url: "https://github.com/test/repo.git",
          ref: "main",
          [field]: "not-an-array",
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  it("measures prompt template size in UTF-8 bytes", async () => {
    const body = "😀".repeat(8_192);
    expect(body.length).toBe(16_384);
    expect(new TextEncoder().encode(body).byteLength).toBe(32_768);
    const response = await run(
      new Request(new URL("/api/admin/prompt-templates", config.publicUrl), {
        method: "PUT",
        headers: {
          Cookie: `omp_gateway_admin=${token}`,
          Origin: config.publicUrl.toString(),
          "X-CSRF-Token": deriveCsrfToken(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ kind: "created", body }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Prompt template body exceeds the 16 KiB limit",
    );
  });

  it("normalizes valid packages and rejects invalid Nix package names", async () => {
    const valid = {
      id: "repo-nix",
      url: "https://github.com/test/repo.git",
      ref: "main",
      nixPackages: ["nodejs_22", "git", "nodejs_22"],
    };
    const invalid = await run(
      request("/api/admin/repositories", {
        ...valid,
        nixPackages: ["git;rm"],
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toBe("Invalid Nix package name");
  });

  it("rejects invalid repository drivers before persistence", async () => {
    const response = await run(
      request("/api/admin/repositories", {
        id: "repo-driver",
        url: "https://github.com/test/repo.git",
        ref: "main",
        defaultDriver: "shell",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("defaultDriver must be omp or t3");
  });

  it("updates repository packages as normalized values", async () => {
    let updatedPackages: ReadonlyArray<string> = [];
    let updatedDriver: string | undefined;
    const repository = Schema.decodeUnknownSync(RepositoryRecord)({
      id: "repo-nix",
      organizationId,
      url: "https://github.com/test/repo.git",
      ref: "main",
      teamIds: [],
      projectIds: [],
      labels: [],
      nixPackages: ["git", "nodejs_22"],
      isDefault: false,
      createdAt: 1,
      updatedAt: 2,
    });
    const updateHandle = createAdminHandle({
      ...deps,
      workspaceRepo: WorkspaceRepo.of({
        setWorkspace: unreachable,
        getDriverSession: unreachable,
        setDriverSession: unreachable,
        createRepository: unreachable,
        getRepository: unreachable,
        listRepositories: () => Effect.succeed([]),
        updateRepository: (_organizationId, _id, update) => {
          updatedPackages = (update.nixPackages ?? []).map(String);
          updatedDriver = update.defaultDriver;
          return Effect.succeed(repository);
        },
        deleteRepository: unreachable,
        getDefaultRepository: unreachable,
      }),
    });
    const result = await Effect.runPromise(
      updateHandle(
        new Request(
          new URL("/api/admin/repositories/repo-nix", config.publicUrl),
          {
            method: "PUT",
            headers: {
              Cookie: `omp_gateway_admin=${token}`,
              Origin: config.publicUrl.toString(),
              "X-CSRF-Token": deriveCsrfToken(token),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              id: "repo-nix",
              url: "https://github.com/test/repo.git",
              ref: "main",
              nixPackages: ["nodejs_22", "git", "nodejs_22"],
              defaultDriver: "t3",
            }),
          },
        ),
      ),
    );
    expect(Option.getOrElse(result, () => null)?.status).toBe(200);
    expect(updatedPackages).toEqual(["git", "nodejs_22"]);
    expect(updatedDriver).toBe("t3");
  });

  it("requires an admin session for the cache list", async () => {
    const response = await run(
      new Request(new URL("/api/admin/nix-cache", config.publicUrl), {
        method: "GET",
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects cache pruning without CSRF and invalid cache keys", async () => {
    const withoutCsrf = new Request(
      new URL(`/api/admin/nix-cache/${"a".repeat(64)}/prune`, config.publicUrl),
      {
        method: "POST",
        headers: {
          Cookie: `omp_gateway_admin=${token}`,
          Origin: config.publicUrl.toString(),
        },
      },
    );
    expect((await run(withoutCsrf)).status).toBe(403);

    const invalid = await run(
      request("/api/admin/nix-cache/not-a-key/prune", {}),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toBe("Invalid Nix cache key");
  });

  it("lists and prunes Nix cache entries with an authenticated CSRF mutation", async () => {
    const cacheKey = "a".repeat(64);
    const pruned: Array<string> = [];
    const cacheHandle = createAdminHandle({
      ...deps,
      nixEnvironment: NixEnvironment.of({
        enforceBudget: () =>
          Effect.succeed({ removed: 0, sizeBytes: 0, withinBudget: true }),
        prepare: unreachable,
        list: () =>
          Effect.succeed([
            {
              cacheKey,
              nixpkgsFlakeRef:
                "github:NixOS/nixpkgs/0123456789abcdef0123456789abcdef01234567",
              packages: [],
              storePaths: [],
              pathEntries: [],
              sizeBytes: 4096,
              createdAt: 1,
              updatedAt: 2,
            },
          ]),
        prune: (key) => {
          pruned.push(key);
          return Effect.succeed(true);
        },
      }),
    });
    const cacheRun = async (requestValue: Request): Promise<Response> => {
      const result = await Effect.runPromise(cacheHandle(requestValue));
      return Option.match(result, {
        onNone: () => {
          throw new Error("expected an admin response");
        },
        onSome: (response) => response,
      });
    };

    const listed = await cacheRun(
      new Request(new URL("/api/admin/nix-cache", config.publicUrl), {
        headers: { Cookie: `omp_gateway_admin=${token}` },
      }),
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()).entries[0]).toMatchObject({
      cacheKey,
      status: "ready",
      sizeBytes: 4096,
      lastUsedAt: 2,
    });

    const prunedResponse = await cacheRun(
      request(`/api/admin/nix-cache/${cacheKey}/prune`, {}),
    );
    expect(prunedResponse.status).toBe(200);
    expect(pruned).toEqual([cacheKey]);
  });

  it("returns 400 for malformed optional preview arrays", async () => {
    for (const field of ["issueLabels", "projectLabels"]) {
      const response = await run(
        request("/api/admin/preview", { [field]: "not-an-array" }),
      );
      expect(response.status).toBe(400);
    }
  });
});
