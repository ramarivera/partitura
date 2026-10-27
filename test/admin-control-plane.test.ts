import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe, expect } from "vitest";
import type { McpServerId, ProjectId, TeamId } from "../src/domain/ids.js";
import { tokenHash } from "../src/services/admin.js";
import { GatewayConfig } from "../src/services/config.js";
import {
  AdminSessionRepo,
  McpServerRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { Workspace } from "../src/services/workspace.js";
import {
  adminRequest,
  createSession,
  fetchApp,
  organizationId,
  PUBLIC_URL,
  projectId,
  requireSome,
  teamId,
  withApp,
  workspaceId,
} from "./admin-control-plane-helpers.js";

describe("admin control plane", () => {
  it.live("removes repository map path from config", () =>
    withApp(
      Effect.gen(function* () {
        const config = yield* GatewayConfig;
        expect(config).not.toHaveProperty("repositoryMapPath");
      }),
    ),
  );

  it.live("creates and isolates repositories by organization", () =>
    withApp(
      Effect.gen(function* () {
        const repo = yield* WorkspaceRepo;
        const a = yield* repo.createRepository({
          organizationId: organizationId("org-a"),
          id: workspaceId("repo"),
          url: "https://github.com/test/a.git",
          ref: "main",
          teamIds: [],
          projectIds: [],
          labels: [],
          isDefault: false,
        });
        const b = yield* repo.createRepository({
          organizationId: organizationId("org-b"),
          id: workspaceId("repo"),
          url: "https://github.com/test/b.git",
          ref: "main",
          teamIds: [],
          projectIds: [],
          labels: [],
          isDefault: false,
        });
        expect(a.organizationId).toBe(organizationId("org-a"));
        expect(b.organizationId).toBe(organizationId("org-b"));
        expect(
          (yield* repo.listRepositories(organizationId("org-a"))).map(
            (r) => r.url,
          ),
        ).toEqual(["https://github.com/test/a.git"]);
        expect(
          (yield* repo.listRepositories(organizationId("org-b"))).map(
            (r) => r.url,
          ),
        ).toEqual(["https://github.com/test/b.git"]);
      }),
    ),
  );

  it.live("enforces only one default repository per organization", () =>
    withApp(
      Effect.gen(function* () {
        const repo = yield* WorkspaceRepo;
        const organization = organizationId("org-default");
        const first = yield* repo.createRepository({
          organizationId: organization,
          id: workspaceId("first"),
          url: "https://github.com/test/first.git",
          ref: "main",
          teamIds: [],
          projectIds: [],
          labels: [],
          isDefault: true,
        });
        expect(first.isDefault).toBe(true);
        const second = yield* repo.createRepository({
          organizationId: organization,
          id: workspaceId("second"),
          url: "https://github.com/test/second.git",
          ref: "main",
          teamIds: [],
          projectIds: [],
          labels: [],
          isDefault: true,
        });
        expect(second.isDefault).toBe(true);
        expect(
          requireSome(yield* repo.getDefaultRepository(organization)).id,
        ).toBe(workspaceId("second"));
        const updated = yield* repo.updateRepository(
          organization,
          workspaceId("first"),
          { isDefault: true },
        );
        expect(updated.isDefault).toBe(true);
        expect(
          requireSome(yield* repo.getDefaultRepository(organization)).id,
        ).toBe(workspaceId("first"));
      }),
    ),
  );

  it.live("updates and deletes repositories", () =>
    withApp(
      Effect.gen(function* () {
        const repo = yield* WorkspaceRepo;
        const organization = organizationId("org-crud");
        const id = workspaceId("repo");
        yield* repo.createRepository({
          organizationId: organization,
          id,
          url: "https://github.com/test/repo.git",
          ref: "main",
          teamIds: [teamId("team")],
          projectIds: [],
          labels: [],
          isDefault: false,
        });
        const mcp = yield* McpServerRepo;
        yield* mcp.createMcpServer({
          organizationId: organization,
          id: "mcp-scoped" as McpServerId,
          name: "repo-only",
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          repositoryId: Option.some(id),
          now: 1,
        });
        const updated = yield* repo.updateRepository(organization, id, {
          ref: "develop",
          labels: ["frontend"],
        });
        expect(updated.ref).toBe("develop");
        expect(updated.labels).toEqual(["frontend"]);
        expect(
          requireSome(yield* repo.getRepository(organization, id)).ref,
        ).toBe("develop");
        expect(yield* repo.deleteRepository(organization, id)).toBe(true);
        expect(Option.isNone(yield* repo.getRepository(organization, id))).toBe(
          true,
        );
        expect(yield* mcp.listMcpServers(organization)).toHaveLength(0);
      }),
    ),
  );

  it.live("resolves repositories with correct precedence and ambiguity", () =>
    withApp(
      Effect.gen(function* () {
        const repo = yield* WorkspaceRepo;
        const workspace = yield* Workspace;
        const organization = organizationId("routing");
        const now = Date.now();
        const createRepository = (
          id: string,
          options: {
            readonly labels?: ReadonlyArray<string>;
            readonly projectIds?: ReadonlyArray<ProjectId>;
            readonly teamIds?: ReadonlyArray<TeamId>;
            readonly isDefault?: boolean;
          } = {},
        ) =>
          repo.createRepository({
            organizationId: organization,
            id: workspaceId(id),
            url: `https://github.com/test/${id}.git`,
            ref: "main",
            teamIds: options.teamIds ?? [],
            projectIds: options.projectIds ?? [],
            labels: options.labels ?? [],
            isDefault: options.isDefault ?? false,
            now,
          });
        yield* createRepository("default-repo", { isDefault: true });
        yield* createRepository("issue-labels", { labels: ["ui"] });
        yield* createRepository("project-labels", { labels: ["platform"] });
        yield* createRepository("project-id", {
          projectIds: [projectId("project-x")],
        });
        yield* createRepository("team-id", { teamIds: [teamId("ops")] });
        yield* createRepository("ambiguous-team", {
          teamIds: [teamId("ops")],
        });

        expect(
          yield* workspace.resolve({
            organizationId: organization,
            repositoryId: workspaceId("project-id"),
            issueLabels: [],
            projectLabels: [],
            projectId: null,
            teamId: null,
          }),
        ).toMatchObject({
          kind: "match",
          repository: { id: workspaceId("project-id") },
        });
        expect(
          yield* workspace.resolve({
            organizationId: organization,
            repositoryId: null,
            issueLabels: ["ui"],
            projectLabels: [],
            projectId: null,
            teamId: null,
          }),
        ).toMatchObject({
          kind: "match",
          repository: { id: workspaceId("issue-labels") },
        });
        expect(
          yield* workspace.resolve({
            organizationId: organization,
            repositoryId: null,
            issueLabels: [],
            projectLabels: ["platform"],
            projectId: projectId("project-x"),
            teamId: null,
          }),
        ).toMatchObject({
          kind: "match",
          repository: { id: workspaceId("project-labels") },
        });
        expect(
          yield* workspace.resolve({
            organizationId: organization,
            repositoryId: null,
            issueLabels: [],
            projectLabels: [],
            projectId: projectId("project-x"),
            teamId: null,
          }),
        ).toMatchObject({
          kind: "match",
          repository: { id: workspaceId("project-id") },
        });
        expect(
          yield* workspace.resolve({
            organizationId: organization,
            repositoryId: null,
            issueLabels: [],
            projectLabels: [],
            projectId: null,
            teamId: teamId("ops"),
          }),
        ).toMatchObject({ kind: "ambiguous" });
        expect(
          yield* workspace.resolve({
            organizationId: organization,
            repositoryId: null,
            issueLabels: [],
            projectLabels: [],
            projectId: null,
            teamId: null,
          }),
        ).toMatchObject({
          kind: "match",
          repository: { id: workspaceId("default-repo") },
        });
      }),
    ),
  );

  it.live(
    "creates opaque sessions, serves public routes, and protects admin routes",
    () =>
      withApp(
        Effect.gen(function* () {
          const now = Date.now();
          const sessions = yield* AdminSessionRepo;
          const { token } = yield* createSession("org-oauth", now);
          const session = yield* sessions.get(tokenHash(token), now);
          expect(requireSome(session).organizationId).toBe(
            organizationId("org-oauth"),
          );

          const root = yield* fetchApp(adminRequest("/", { token }));
          expect(root.status).toBe(302);
          expect(root.headers.get("location")).toBe("/admin");
          expect(
            (yield* fetchApp(adminRequest("/admin", { token }))).status,
          ).toBe(200);

          expect((yield* fetchApp(adminRequest("/"))).status).toBe(200);
          const dashboard = yield* fetchApp(adminRequest("/admin"));
          expect(dashboard.status).toBe(302);
          expect(dashboard.headers.get("location")).toContain(
            "/oauth/start?returnTo=",
          );
        }),
      ),
  );

  it.live("revokes sessions and clears the admin cookie on logout", () =>
    withApp(
      Effect.gen(function* () {
        const now = Date.now();
        const sessions = yield* AdminSessionRepo;
        const { token, csrf } = yield* createSession("org-logout", now);
        const logout = yield* fetchApp(
          adminRequest("/api/admin/logout", {
            method: "POST",
            token,
            csrf,
            origin: PUBLIC_URL,
          }),
        );
        expect(logout.status).toBe(302);
        expect(logout.headers.get("location")).toBe("/");
        const clearCookie = logout.headers.get("set-cookie") ?? "";
        expect(clearCookie).toContain("omp_gateway_admin=");
        expect(clearCookie).toContain("Max-Age=0");
        expect(Option.isNone(yield* sessions.get(tokenHash(token), now))).toBe(
          true,
        );
      }),
    ),
  );
});
