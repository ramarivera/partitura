import { it } from "@effect/vitest";
import { Clock, Effect, Logger, Option, Redacted, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect } from "vitest";
import { AgentSessionEvent } from "../src/domain/models.js";
import {
  InstallationRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { verifySignature, WebhookPipeline } from "../src/services/webhook.js";

import {
  agentSessionBase,
  appUserNotificationPayload,
  createdPayload,
  currentTime,
  expectSome,
  install,
  issueId,
  oauthAppPayload,
  organizationId,
  permissionChangePayload,
  projectId,
  sessionId,
  sign,
  signedRequest,
  teamId,
  withWebhook,
} from "./webhook-fixtures.js";

describe("Linear webhook input correctness", () => {
  it.live(
    "rejects stale and future timestamps with exact replay response",
    () =>
      withWebhook(
        Effect.gen(function* () {
          const now = yield* currentTime;
          yield* install();
          for (const timestamp of [now - 120_000, now + 120_000]) {
            const response = yield* WebhookPipeline.use((service) =>
              service.handle(
                signedRequest(createdPayload(timestamp), {
                  delivery: `outside-window-${timestamp}`,
                  includeTimestampHeader: true,
                }),
              ),
            );
            expect(response.status).toBe(401);
            expect(yield* Effect.promise(() => response.text())).toBe(
              "Webhook timestamp outside replay window",
            );
          }
          expect(
            yield* RunRepo.use((service) =>
              service.get(sessionId("session-1")),
            ),
          ).toEqual(Option.none());
        }),
      ),
  );

  it.live("rejects invalid and tampered HMACs without persistence", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const payload = createdPayload(now);
        const body = JSON.stringify(payload);
        for (const request of [
          signedRequest(payload, {
            delivery: "bad-signature",
            signature: "deadbeef",
          }),
          signedRequest(payload, {
            delivery: "tampered-body",
            body: body.replace("Fix the bug", "Fix the BUG"),
            signature: sign(body),
          }),
        ]) {
          const response = yield* WebhookPipeline.use((service) =>
            service.handle(request),
          );
          expect(response.status).toBe(401);
          expect(yield* Effect.promise(() => response.text())).toBe(
            "Invalid signature",
          );
        }
        expect(
          yield* RunRepo.use((service) => service.get(sessionId("session-1"))),
        ).toEqual(Option.none());
      }),
    ),
  );

  it.live("rejects missing signature and non-POST methods", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        const missing = signedRequest(createdPayload(now));
        missing.headers.delete("linear-signature");
        const missingResponse = yield* WebhookPipeline.use((service) =>
          service.handle(missing),
        );
        expect(missingResponse.status).toBe(400);
        expect(yield* Effect.promise(() => missingResponse.text())).toBe(
          "Missing signature",
        );

        const methodResponse = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(createdPayload(now), { method: "GET" })),
        );
        expect(methodResponse.status).toBe(405);
        expect(yield* Effect.promise(() => methodResponse.text())).toBe(
          "Method not allowed",
        );
      }),
    ),
  );

  it.live("rejects malformed AgentSessionEvent payloads", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(
            signedRequest(createdPayload(now, { agentSession: undefined })),
          ),
        );
        expect(response.status).toBe(400);
        expect(yield* Effect.promise(() => response.text())).toContain(
          "AgentSessionEvent payload is invalid",
        );
      }),
    ),
  );
  it.live(
    "keeps malformed session input out of webhook responses and logs",
    () =>
      withWebhook(
        Effect.gen(function* () {
          yield* install();
          const secret = "malformed-session-private-token";
          const logs: unknown[] = [];
          const logger = Logger.make((entry) => {
            logs.push({ message: entry.message, cause: entry.cause });
          });
          const now = yield* Clock.currentTimeMillis;
          const response = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(createdPayload(now, { agentSession: secret })),
            ),
          ).pipe(Effect.provide(Logger.layer([logger])));
          expect(response.status).toBe(400);
          expect(yield* Effect.promise(() => response.text())).toBe(
            "AgentSessionEvent payload is invalid",
          );
          expect(JSON.stringify(logs)).not.toContain(secret);
        }),
      ),
  );
  it.live("does not expose malformed notification payload details", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const secretContent = "notification-content-secret";
        const payload = {
          ...appUserNotificationPayload(now, "issueStatusChanged"),
          notification: secretContent,
        };
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(payload)),
        );
        const body = yield* Effect.promise(() => response.text());
        expect(response.status).toBe(400);
        expect(body).toBe("AppUserNotification payload is invalid");
        expect(body).not.toContain(secretContent);
      }),
    ),
  );

  it.live("rejects cross-tenant OAuth client identity", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(
            signedRequest(
              createdPayload(now, { oauthClientId: "other-client" }),
            ),
          ),
        );
        expect(response.status).toBe(401);
        expect(yield* Effect.promise(() => response.text())).toBe(
          "OAuth client identity mismatch (received other-client)",
        );
      }),
    ),
  );

  it.live("rejects absent and revoked installations", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        const absent = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(createdPayload(now))),
        );
        expect(absent.status).toBe(401);
        expect(yield* Effect.promise(() => absent.text())).toBe(
          "No installation for organization",
        );

        yield* install({ revokedAt: Option.some(now - 1_000) });
        const revoked = yield* WebhookPipeline.use((service) =>
          service.handle(
            signedRequest(
              createdPayload(now, { webhookId: "revoked-webhook" }),
            ),
          ),
        );
        expect(revoked.status).toBe(401);
        expect(yield* Effect.promise(() => revoked.text())).toBe(
          "Installation is revoked",
        );
      }),
    ),
  );

  it.live("OAuthApp revoked cancels runs and marks installation revoked", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        yield* RunRepo.use((service) =>
          service.create({
            sessionId: sessionId("session-1"),
            organizationId: organizationId("org"),
            issueId: Option.some(issueId("issue-1")),
            teamId: Option.some(teamId("team-a")),
            now,
          }),
        );

        const response = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(oauthAppPayload(now))),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe("OK");
        const installation = expectSome(
          yield* InstallationRepo.use((service) =>
            service.get(organizationId("org")),
          ),
        );
        expect(installation?.revokedAt).toEqual(Option.some(now));
        expect(
          expectSome(
            yield* RunRepo.use((service) =>
              service.get(sessionId("session-1")),
            ),
          )?.desiredState,
        ).toBe("canceled");
      }),
    ),
  );

  it.live("PermissionChange updates team access and cancels runs", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install({
          accessibleTeamIds: Option.some([teamId("team-a"), teamId("team-b")]),
        });
        yield* RunRepo.use((service) =>
          service.create({
            sessionId: sessionId("session-1"),
            organizationId: organizationId("org"),
            issueId: Option.some(issueId("issue-1")),
            teamId: Option.some(teamId("team-b")),
            now,
          }),
        );

        const response = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(permissionChangePayload(now))),
        );
        expect(response.status).toBe(200);
        const installation = expectSome(
          yield* InstallationRepo.use((service) =>
            service.get(organizationId("org")),
          ),
        );
        expect(installation?.accessibleTeamIds).toEqual(
          Option.some([teamId("team-a")]),
        );
        expect(
          expectSome(
            yield* RunRepo.use((service) =>
              service.get(sessionId("session-1")),
            ),
          )?.desiredState,
        ).toBe("canceled");
      }),
    ),
  );

  it.live("PermissionChange rejects mismatched app-user identity", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(
            signedRequest(
              permissionChangePayload(now, { appUserId: "other-user" }),
            ),
          ),
        );
        expect(response.status).toBe(401);
        expect(yield* Effect.promise(() => response.text())).toBe(
          "App user mismatch",
        );
        const installation = expectSome(
          yield* InstallationRepo.use((service) =>
            service.get(organizationId("org")),
          ),
        );
        expect(installation?.accessibleTeamIds).toEqual(
          Option.some([teamId("team-a")]),
        );
      }),
    ),
  );

  it.live(
    "PermissionChange accepts dashed and case variants of the client id",
    () =>
      withWebhook(
        Effect.gen(function* () {
          const now = yield* currentTime;
          yield* install();
          // Linear reports the OAuth client id in differing forms across
          // webhook categories (console hex vs dashed UUID); the comparison
          // is normalized, so both forms must pass.
          for (const oauthClientId of ["CLIENT", "c-l-i-e-n-t"]) {
            const response = yield* WebhookPipeline.use((service) =>
              service.handle(
                signedRequest(permissionChangePayload(now, { oauthClientId })),
              ),
            );
            expect(response.status, oauthClientId).toBe(200);
          }
        }),
      ),
  );

  it.live(
    "PermissionChange accepts the OAuth client UUID form Linear actually sends",
    () =>
      withWebhook(
        Effect.gen(function* () {
          const now = yield* currentTime;
          yield* install();
          // Live capture 2026-08-11: PermissionChange carries the OAuth
          // client's internal UUID (no shared hex with the console client_id).
          // HMAC is the auth boundary; org + appUserId pin tenant and app.
          const response = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(
                permissionChangePayload(now, {
                  oauthClientId: "c2e52980-f2d4-4ecf-bc59-06c73dfb42b3",
                }),
              ),
            ),
          );
          expect(response.status).toBe(200);
          const installation = expectSome(
            yield* InstallationRepo.use((service) =>
              service.get(organizationId("org")),
            ),
          );
          expect(installation?.accessibleTeamIds).toEqual(
            Option.some([teamId("team-a")]),
          );
        }),
      ),
  );
  it.live("acknowledges unknown event types without side effects", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(
            signedRequest(createdPayload(now, { type: "Unknown" })),
          ),
        );
        expect(response.status).toBe(200);
        expect(
          yield* RunRepo.use((service) => service.get(sessionId("session-1"))),
        ).toEqual(Option.none());
      }),
    ),
  );

  it.live("acknowledges unknown AgentSession actions without input", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(
            signedRequest(createdPayload(now, { action: "updated" })),
          ),
        );
        expect(response.status).toBe(200);
        expect(
          yield* RunInputRepo.use((service) =>
            service.pending(sessionId("session-1")),
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.live("resolves team and project from child objects", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(
            signedRequest(
              createdPayload(now, {
                agentSession: agentSessionBase({
                  issueId: "issue-1",
                  issue: {
                    id: "issue-1",
                    title: "Fix the bug",
                    team: { id: "team-child" },
                    project: { id: "project-child" },
                  },
                }),
              }),
            ),
          ),
        );
        expect(response.status).toBe(200);
        expect(
          expectSome(
            yield* RunRepo.use((service) =>
              service.get(sessionId("session-1")),
            ),
          ),
        ).toMatchObject({
          teamId: Option.some(teamId("team-child")),
          projectId: Option.some(projectId("project-child")),
        });
      }),
    ),
  );
});

describe("webhook signature invariants", () => {
  it("HMAC-SHA256 verification accepts matching bytes and rejects tampered bytes or secrets", () =>
    fc.assert(
      fc.property(
        fc.record({
          body: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
          otherBody: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
          secret1: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
          secret2: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
        }),
        ({ body, otherBody, secret1, secret2 }) => {
          const bytes = new TextEncoder().encode(body);
          const signature = sign(body, secret1);
          expect(
            verifySignature(bytes, signature, Redacted.make(secret1)),
          ).toBe(true);
          expect(
            verifySignature(bytes, signature, Redacted.make(secret2)),
          ).toBe(secret1 === secret2);
          expect(
            verifySignature(
              new TextEncoder().encode(otherBody),
              signature,
              Redacted.make(secret1),
            ),
          ).toBe(otherBody === body);
        },
      ),
    ));

  it("AgentSessionEvent schemas preserve decoded nullable fields through encode/decode", () =>
    fc.assert(
      fc.property(
        fc.record({
          prompt: fc.string(),
          guidance: fc.string(),
          summary: fc.string(),
        }),
        ({ prompt, guidance, summary }) => {
          const raw = createdPayload(1_000, {
            promptContext: prompt,
            guidance: [{ body: guidance }],
            agentSession: agentSessionBase({ summary }),
          });
          const decoded = Schema.decodeUnknownSync(AgentSessionEvent)(raw);
          const encoded = Schema.encodeUnknownSync(AgentSessionEvent)(decoded);
          expect(Schema.decodeUnknownSync(AgentSessionEvent)(encoded)).toEqual(
            decoded,
          );
        },
      ),
    ));
});
