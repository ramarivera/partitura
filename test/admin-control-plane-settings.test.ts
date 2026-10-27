import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe, expect } from "vitest";
import type { TeamId } from "../src/domain/ids.js";
import {
  InstallationRepo,
  RunEventRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import {
  adminRequest,
  appUserId,
  createSession,
  fetchApp,
  issueId,
  organizationId,
  PUBLIC_URL,
  sessionId,
  sourceKey,
  teamId,
  withApp,
  workspaceId,
} from "./admin-control-plane-helpers.js";

describe("admin control plane", () => {
  it.live(
    "enforces admin authentication, CSRF, origin, and repository CRUD",
    () =>
      withApp(
        Effect.gen(function* () {
          const bootstrap = (organization: string, now: number) =>
            Effect.gen(function* () {
              const session = yield* createSession(organization, now);
              const response = yield* fetchApp(
                adminRequest("/api/admin/bootstrap", {
                  token: session.token,
                  origin: PUBLIC_URL,
                }),
              );
              expect(response.status).toBe(200);
              const body = (yield* Effect.promise(() => response.json())) as {
                readonly csrfToken: string;
              };
              expect(body.csrfToken).toBe(session.csrf);
              return session;
            });

          expect(
            (yield* fetchApp(adminRequest("/api/admin/bootstrap"))).status,
          ).toBe(401);
          expect(
            (yield* fetchApp(
              adminRequest("/api/admin/repositories", {
                method: "POST",
                body: {
                  id: "x",
                  url: "https://github.com/test/x.git",
                  ref: "main",
                },
              }),
            )).status,
          ).toBe(401);

          const now = Date.now();
          const { token, csrf } = yield* bootstrap("org-api", now);
          expect(
            (yield* fetchApp(
              adminRequest("/api/admin/repositories", {
                method: "POST",
                token,
                csrf,
                body: {
                  id: "x",
                  url: "https://github.com/test/x.git",
                  ref: "main",
                },
              }),
            )).status,
          ).toBe(403);
          expect(
            (yield* fetchApp(
              adminRequest("/api/admin/repositories", {
                method: "POST",
                token,
                origin: PUBLIC_URL,
                body: {
                  id: "x",
                  url: "https://github.com/test/x.git",
                  ref: "main",
                },
              }),
            )).status,
          ).toBe(403);

          const create = yield* fetchApp(
            adminRequest("/api/admin/repositories", {
              method: "POST",
              token,
              csrf,
              origin: PUBLIC_URL,
              body: {
                id: "api-repo",
                url: "https://github.com/test/api.git",
                ref: "main",
                teamIds: ["team-a"],
              },
            }),
          );
          expect(create.status).toBe(201);
          expect(yield* Effect.promise(() => create.json())).toMatchObject({
            repository: { id: "api-repo" },
          });

          const list = yield* fetchApp(
            adminRequest("/api/admin/repositories", {
              token,
              origin: PUBLIC_URL,
            }),
          );
          expect(list.status).toBe(200);
          expect(yield* Effect.promise(() => list.json())).toEqual({
            repositories: [
              expect.objectContaining({ id: "api-repo", teamIds: ["team-a"] }),
            ],
          });

          const update = yield* fetchApp(
            adminRequest("/api/admin/repositories/api-repo", {
              method: "PUT",
              token,
              csrf,
              origin: PUBLIC_URL,
              body: {
                id: "api-repo",
                url: "https://github.com/test/api.git",
                ref: "develop",
                labels: ["frontend"],
              },
            }),
          );
          expect(update.status).toBe(200);
          expect(yield* Effect.promise(() => update.json())).toMatchObject({
            repository: { ref: "develop", labels: ["frontend"] },
          });

          const deleted = yield* fetchApp(
            adminRequest("/api/admin/repositories/api-repo", {
              method: "DELETE",
              token,
              csrf,
              origin: PUBLIC_URL,
            }),
          );
          expect(deleted.status).toBe(204);
          expect(
            (yield* fetchApp(
              adminRequest("/api/admin/repositories/api-repo", {
                method: "DELETE",
                token,
                csrf,
                origin: PUBLIC_URL,
              }),
            )).status,
          ).toBe(404);
        }),
      ),
  );

  it.live(
    "authenticates run details, scopes them to their org, and redacts HTML and JSON",
    () =>
      withApp(
        Effect.gen(function* () {
          const now = Date.UTC(2026, 6, 31, 12, 0, 0);
          const runs = yield* RunRepo;
          const events = yield* RunEventRepo;
          const id = sessionId("session/private");
          yield* runs.create({
            sessionId: id,
            organizationId: organizationId("org-runs"),
            issueId: Option.some(issueId("issue-runs")),
            now,
          });
          yield* runs.update(id, {
            state: "succeeded",
            terminalReason: Option.some(
              "Authorization: Bearer terminal-secret https://example.test/?token=query-secret",
            ),
            lastActivityAt: Option.some(now + 1_000),
          });
          yield* events.upsert({
            sourceKey: sourceKey("input:run-created"),
            sessionId: id,
            kind: "input:created",
            level: "info",
            text: "Authorization: Bearer payload-secret https://example.test/?signature=payload-signature",
            payload: {
              accessToken: "payload-access-token",
              agentSession: {
                issue: {
                  identifier: "TEAM-123",
                  title: "Fix the run page",
                  url: "https://linear.app/issue/TEAM-123",
                },
              },
            },
            status: "completed",
            now,
          });
          const path = `/runs/${encodeURIComponent(id)}`;
          const { token } = yield* createSession("org-runs", Date.now());
          const { token: otherToken } = yield* createSession(
            "org-other",
            Date.now(),
          );
          const unauthenticated = yield* fetchApp(adminRequest(path));
          expect(unauthenticated.status).toBe(302);
          expect(unauthenticated.headers.get("location")).toContain(
            "returnTo=",
          );
          expect((yield* fetchApp(adminRequest(`${path}.json`))).status).toBe(
            401,
          );
          expect(
            (yield* fetchApp(adminRequest(path, { token: otherToken }))).status,
          ).toBe(404);
          expect(
            (yield* fetchApp(
              adminRequest(`${path}.json`, { token: otherToken }),
            )).status,
          ).toBe(404);

          const html = yield* fetchApp(adminRequest(path, { token }));
          expect(html.status).toBe(200);
          expect(html.headers.get("content-type")).toContain("text/html");
          const page = yield* Effect.promise(() => html.text());
          expect(page).toContain("Run details");
          expect(page).toContain("TEAM-123");
          expect(page).toContain('data-run-level-toggle="debug"');
          expect(page).toContain('data-run-level-toggle="error"');
          expect(page).toContain("ohmypi-admin-appearance");
          expect(page).toContain("redacted");
          expect(page).not.toContain("terminal-secret");
          expect(page).not.toContain("payload-secret");
          expect(page).not.toContain("payload-signature");
          expect(page).not.toContain("payload-access-token");

          const json = yield* fetchApp(
            new Request(new URL(path, PUBLIC_URL).toString(), {
              headers: {
                Accept: "application/json",
                Cookie: `omp_gateway_admin=${token}`,
              },
            }),
          );
          expect(json.status).toBe(200);
          expect(json.headers.get("content-type")).toContain(
            "application/json",
          );
          const detail = (yield* Effect.promise(() => json.json())) as {
            readonly sessionId: string;
            readonly state: string;
            readonly attempt: number;
            readonly run: { readonly terminalReason: string | null };
            readonly events: ReadonlyArray<{
              readonly sourceKey: string;
              readonly text: string | null;
            }>;
          };
          expect(detail).toMatchObject({
            sessionId: id,
            state: "succeeded",
            attempt: 0,
          });
          expect(detail.run.terminalReason).toContain(
            "Authorization: Bearer redacted",
          );
          expect(
            detail.events.find(
              (event) => event.sourceKey === "input:run-created",
            ),
          ).toMatchObject({
            sourceKey: "input:run-created",
            text: "Authorization: Bearer redacted https://example.test/?signature=redacted",
          });
          expect(JSON.stringify(detail)).not.toContain("query-secret");

          const suffix = yield* fetchApp(
            adminRequest(`${path}.json`, { token }),
          );
          expect(suffix.status).toBe(200);
          expect(suffix.headers.get("content-type")).toContain(
            "application/json",
          );
        }),
      ),
  );

  it.live("redacts installation secrets from bootstrap", () =>
    withApp(
      Effect.gen(function* () {
        const now = Date.now();
        const installations = yield* InstallationRepo;
        const { token } = yield* createSession("org-install", now);
        yield* installations.put({
          organizationId: organizationId("org-install"),
          appUserId: appUserId("app-user"),
          accessToken: "secret-access",
          refreshToken: "secret-refresh",
          expiresAt: now + 60_000,
          scopes: ["read"],
          revokedAt: Option.none(),
          accessibleTeamIds: Option.some([teamId("team-1")]),
          canAccessAllPublicTeams: Option.some(false),
        });
        const response = yield* fetchApp(
          adminRequest("/api/admin/bootstrap", { token, origin: PUBLIC_URL }),
        );
        expect(response.status).toBe(200);
        const body = (yield* Effect.promise(() => response.json())) as {
          readonly installation: Record<string, unknown>;
        };
        expect(body.installation).toMatchObject({
          organizationId: "org-install",
          appUserId: "app-user",
          scopes: ["read"],
          revokedAt: null,
          accessibleTeamIds: ["team-1"],
          canAccessAllPublicTeams: false,
        });
        expect(body.installation).not.toHaveProperty("accessToken");
        expect(body.installation).not.toHaveProperty("refreshToken");
      }),
    ),
  );

  it.live("previews matching, default, and ambiguous repositories", () =>
    withApp(
      Effect.gen(function* () {
        const now = Date.now();
        const repo = yield* WorkspaceRepo;
        const organization = organizationId("org-preview");
        const { token, csrf } = yield* createSession("org-preview", now);
        const createRepository = (
          id: string,
          options: {
            readonly labels?: ReadonlyArray<string>;
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
            projectIds: [],
            labels: options.labels ?? [],
            isDefault: options.isDefault ?? false,
            now,
          });
        yield* createRepository("default", { isDefault: true });
        yield* createRepository("issue", { labels: ["ui"] });
        yield* createRepository("team-1", { teamIds: [teamId("ops")] });
        yield* createRepository("team-2", { teamIds: [teamId("ops")] });

        const preview = (body: unknown) =>
          fetchApp(
            adminRequest("/api/admin/preview", {
              method: "POST",
              token,
              csrf,
              origin: PUBLIC_URL,
              body,
            }),
          );
        const match = yield* preview({ issueLabels: ["ui"] });
        expect(match.status).toBe(200);
        expect(yield* Effect.promise(() => match.json())).toMatchObject({
          kind: "match",
          repository: { id: "issue" },
        });
        const defaultPreview = yield* preview({});
        expect(defaultPreview.status).toBe(200);
        expect(
          yield* Effect.promise(() => defaultPreview.json()),
        ).toMatchObject({
          kind: "match",
          repository: { id: "default" },
        });
        const ambiguous = yield* preview({ teamId: "ops" });
        expect(ambiguous.status).toBe(200);
        const ambiguousBody = (yield* Effect.promise(() =>
          ambiguous.json(),
        )) as {
          readonly kind: string;
          readonly repositories: ReadonlyArray<{ readonly id: string }>;
        };
        expect(ambiguousBody.kind).toBe("ambiguous");
        expect(
          ambiguousBody.repositories.map((repository) => repository.id).sort(),
        ).toEqual(["team-1", "team-2"]);
      }),
    ),
  );
});
