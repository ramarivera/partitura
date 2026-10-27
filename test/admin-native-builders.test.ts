import { expect, it } from "@effect/vitest";
import { Clock, Effect } from "effect";
import {
  adminRequest,
  createSession,
  fetchApp,
  PUBLIC_URL,
  withApp,
} from "./admin-control-plane-helpers.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { fleetFixture } from "./fixtures/native-build-fleet.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.live(
  "actual HTTP fleet controls require browser session, gateway grant, Origin and CSRF before any operation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("http-auth"));
        yield* withApp(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const admin = yield* createSession("org-admin", now);
            const ordinary = yield* createSession("ordinary", now);
            for (const endpoint of [
              "/api/admin/native-builders",
              `/api/admin/native-builders/refreshes/${"a".repeat(32)}`,
              "/admin/native-builders",
            ]) {
              const noSession = yield* fetchApp(adminRequest(endpoint));
              expect([401, 302]).toContain(noSession.status);
              const denied = yield* fetchApp(
                adminRequest(endpoint, { token: ordinary.token }),
              );
              expect(denied.status).toBe(403);
              expect(denied.headers.get("cache-control")).toBe("no-store");
            }
            for (const action of [
              "refresh",
              "check-health",
              "reconcile",
              "decommission",
            ]) {
              const url = `/api/admin/native-builders/primary/${action}`;
              for (const options of [
                { token: admin.token },
                {
                  token: admin.token,
                  csrf: admin.csrf,
                  origin: "https://evil.invalid",
                },
                {
                  token: ordinary.token,
                  csrf: ordinary.csrf,
                  origin: PUBLIC_URL,
                },
              ])
                expect(
                  (yield* fetchApp(
                    adminRequest(url, { method: "POST", ...options, body: {} }),
                  )).status,
                ).toBe(403);
            }
            const bearer = new Request(
              `${PUBLIC_URL}/api/admin/native-builders/refresh`,
              {
                method: "POST",
                headers: {
                  Authorization: "Bearer invented",
                  "Content-Type": "application/json",
                  Origin: PUBLIC_URL,
                },
                body: "{}",
              },
            );
            expect((yield* fetchApp(bearer)).status).toBe(401);
            expect(f.journal.snapshot().operations).toEqual([]);
            expect(f.reads).toEqual([]);
            const request = (body: unknown) =>
              adminRequest("/api/admin/native-builders/primary/refresh", {
                method: "POST",
                token: admin.token,
                csrf: admin.csrf,
                origin: PUBLIC_URL,
                body,
              });
            expect(
              (yield* fetchApp(request({ unexpected: true }))).status,
            ).toBe(400);
            expect(
              (yield* fetchApp(request({ padding: "x".repeat(4096) }))).status,
            ).toBe(400);
            const accepted = yield* fetchApp(request({}));
            expect(accepted.status).toBe(202);
            expect(accepted.headers.get("cache-control")).toBe("no-store");
            const value = yield* testAwait(accepted.json());
            const progress = yield* fetchApp(
              adminRequest(
                `/api/admin/native-builders/refreshes/${value.operationId}`,
                { token: admin.token },
              ),
            );
            expect(progress.status).toBe(200);
            expect(progress.headers.get("cache-control")).toBe("no-store");
            expect(yield* testAwait(progress.json())).toMatchObject({
              done: false,
            });
            const page = yield* fetchApp(
              adminRequest("/admin/native-builders", { token: admin.token }),
            );
            expect(page.status).toBe(200);
            expect(yield* testAwait(page.text())).toContain("window.confirm");
            const overview = yield* fetchApp(
              adminRequest("/admin", { token: admin.token }),
            );
            expect(yield* testAwait(overview.text())).toContain(
              'href="/admin/native-builders"',
            );
            const deniedOverview = yield* fetchApp(
              adminRequest("/admin", { token: ordinary.token }),
            );
            expect(yield* testAwait(deniedOverview.text())).not.toContain(
              'href="/admin/native-builders"',
            );
          }),
          { nativeBuilders: f.fleet, config: f.config },
        );
      }),
    ),
);
it.live(
  "production without registry assembly returns unavailable only after gateway authorization",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("disabled"));
        yield* withApp(
          Effect.gen(function* () {
            const session = yield* createSession(
              "org-admin",
              yield* Clock.currentTimeMillis,
            );
            const response = yield* fetchApp(
              adminRequest("/api/admin/native-builders", {
                token: session.token,
              }),
            );
            expect(response.status).toBe(503);
            expect(yield* testAwait(response.json())).toEqual({
              error: "fleet-disabled",
            });
            expect(response.headers.get("cache-control")).toBe("no-store");
            expect(
              (yield* fetchApp(new Request(`${PUBLIC_URL}/health`))).status,
            ).toBe(503); // The fixture reconciler has never completed a sweep.
          }),
          { config: f.config },
        );
      }),
    ),
);
