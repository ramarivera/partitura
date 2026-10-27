import { it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect } from "vitest";
import { routes } from "../src/http/router.js";
import { csrfHash, deriveCsrfToken, tokenHash } from "../src/services/admin.js";
import {
  AdminSessionRepo,
  InstallationRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { Workspace } from "../src/services/workspace.js";
import {
  adminRequest,
  createSession,
  fetchApp,
  organizationId,
  withApp,
  workspaceId,
} from "./admin-control-plane-helpers.js";

describe("admin session and routing invariants", () => {
  it("token and CSRF derivations are deterministic and separate input domains", () =>
    fc.assert(
      fc.property(
        fc.record({
          rawA: fc.string(),
          rawB: fc.string(),
          csrfA: fc.string(),
          csrfB: fc.string(),
        }),
        ({ rawA, rawB, csrfA, csrfB }) => {
          expect(tokenHash(rawA)).toBe(tokenHash(rawA));
          expect(deriveCsrfToken(rawA)).toBe(deriveCsrfToken(rawA));
          expect(csrfHash(csrfA)).toBe(csrfHash(csrfA));
          if (rawA !== rawB)
            expect(deriveCsrfToken(rawA)).not.toBe(deriveCsrfToken(rawB));
          if (csrfA !== csrfB)
            expect(csrfHash(csrfA)).not.toBe(csrfHash(csrfB));
        },
      ),
    ));

  it.effect(
    "repository resolution never returns a repository owned by another organization",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          owner: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(
                  Schema.check(
                    Schema.makeFilter((value) => value.trim().length > 0),
                  ),
                ),
              ),
            ),
          label: fc.string(),
        });
        const check = ({
          owner,
          label,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          Effect.scoped(
            withApp(
              Effect.gen(function* () {
                const repo = yield* WorkspaceRepo;
                const workspace = yield* Workspace;
                yield* repo.createRepository({
                  organizationId: organizationId(owner),
                  id: workspaceId("private-repository"),
                  url: "https://github.com/test/private.git",
                  ref: "main",
                  labels: [label],
                  isDefault: true,
                });
                expect(
                  yield* workspace.resolve({
                    organizationId: organizationId(`${owner}:other`),
                    repositoryId: null,
                    issueLabels: [label],
                    projectLabels: [],
                    projectId: null,
                    teamId: null,
                  }),
                ).toEqual({ kind: "none" });
              }),
            ),
          );
        const context =
          yield* Effect.context<Effect.Services<ReturnType<typeof check>>>();
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(cases, (sample) =>
              Effect.runPromiseWith(context)(check(sample)),
            ),
            { numRuns: 20 },
          ),
        );
      }),
    { timeout: 15_000 },
  );
});

describe("route authentication inventory", () => {
  it.live(
    "requires login for every registered route outside the explicit protocol exemptions",
    () =>
      withApp(
        Effect.gen(function* () {
          const publicRoutes = new Set([
            "GET /",
            "GET /health",
            "GET /oauth/start",
            "GET /oauth/callback",
            "POST /webhooks/linear",
          ]);
          const encountered = new Set<string>();
          for (const route of routes) {
            const methods =
              route.method === "*"
                ? ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
                : [route.method];
            const path = route.path
              .replace(":id.json", "example.json")
              .replace(":id", "example")
              .replace("*", "example");
            for (const method of methods) {
              const key = `${method} ${path}`;
              if (publicRoutes.has(key)) {
                encountered.add(key);
                continue;
              }
              const response = yield* fetchApp(adminRequest(path, { method }));
              expect([401, 302], key).toContain(response.status);
              if (response.status === 302)
                expect(response.headers.get("location"), key).toContain(
                  "/oauth/start?returnTo=",
                );
            }
          }
          expect([...encountered].sort()).toEqual([...publicRoutes].sort());
        }),
      ),
  );
  it.live("deletes all admin sessions when their installation is revoked", () =>
    withApp(
      Effect.gen(function* () {
        const { token } = yield* createSession("org-revoked", Date.now());
        expect(
          (yield* fetchApp(adminRequest("/admin", { token }))).status,
        ).toBe(200);
        yield* InstallationRepo.use((service) =>
          service.revoke(organizationId("org-revoked"), Date.now()),
        );
        expect(
          (yield* fetchApp(adminRequest("/api/admin/bootstrap", { token })))
            .status,
        ).toBe(401);
        expect(
          yield* AdminSessionRepo.use((service) =>
            service.get(tokenHash(token)),
          ),
        ).toEqual(Option.none());
      }),
    ),
  );
});
