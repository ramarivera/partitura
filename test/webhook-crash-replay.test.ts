import { it } from "@effect/vitest";
import { Clock, Effect, Option } from "effect";
import { describe, expect, vi } from "vitest";
import { recoverGateway } from "../src/conductor.js";
import {
  InstallationRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { SqliteClient } from "../src/services/store/sqlite-client.js";
import { WebhookPipeline } from "../src/services/webhook.js";
import {
  appUserNotificationPayload,
  config,
  createdPayload,
  install,
  issueId,
  organizationId,
  sessionId,
  suitePath,
  teamId,
  withWebhook,
} from "./webhook-fixtures.js";
import {
  auditCounts,
  crashWebhookProcess,
  replayStatus,
  setupReplayAudit,
} from "./webhook-replay-fixtures.js";

describe("Durable authenticated webhook replay", () => {
  it.live.each(["claim", "run", "enqueue", "processed"] as const)(
    "replays a process crash after %s exactly once before reconciliation",
    (checkpoint) =>
      Effect.gen(function* () {
        const databasePath = suitePath(`replay-${checkpoint}.db`);
        const fileConfig = { ...config, databasePath };
        yield* withWebhook(
          Effect.gen(function* () {
            yield* install();
            const { db } = yield* SqliteClient;
            setupReplayAudit(db);
          }),
          fileConfig,
        );
        const payload = createdPayload(yield* Clock.currentTimeMillis);
        yield* crashWebhookProcess(databasePath, checkpoint, payload);
        yield* withWebhook(
          Effect.gen(function* () {
            const { db } = yield* SqliteClient;
            expect(replayStatus(db).status).toBe("pending");
            const pipeline = yield* WebhookPipeline;
            const ingress = vi.spyOn(pipeline, "handle");
            yield* recoverGateway;
            yield* pipeline.recoverPendingDeliveries();
            expect(ingress).not.toHaveBeenCalled();
            ingress.mockRestore();
            const inputs = yield* RunInputRepo.use((repo) =>
              repo.pending(sessionId("session-1")),
            );
            expect(inputs).toHaveLength(1);
            expect(inputs[0]?.id).toBe("session-1:created");
            expect(inputs[0]?.body).toContain("Implement the issue");
            expect(replayStatus(db)).toEqual({
              status: "processed",
              error: null,
            });
            expect(auditCounts(db)).toEqual([{ operation: "input", count: 1 }]);
            // The stored timestamp is now older than ingress permits. Replay must
            // not synthesize a request or reapply the ingress freshness window.
          }),
          { ...fileConfig, webhookReplayWindowMs: 1 },
        );
      }),
    { timeout: 15_000 },
  );

  it.live.each(["enqueue", "processed"] as const)(
    "replays notification crash at %s without duplicated or cross-tenant stops",
    (checkpoint) =>
      Effect.gen(function* () {
        const databasePath = suitePath(`notification-${checkpoint}.db`);
        const fileConfig = { ...config, databasePath };
        yield* withWebhook(
          Effect.gen(function* () {
            yield* install();
            const runs = yield* RunRepo;
            for (const [sid, org] of [
              ["session-1", "org"],
              ["session-2", "org"],
              ["foreign-session", "other-org"],
            ]) {
              if (sid === undefined || org === undefined)
                throw new Error("Missing run fixture");
              yield* runs.create({
                sessionId: sessionId(sid),
                organizationId: organizationId(org),
                issueId: Option.some(issueId("issue-1")),
              });
            }
            setupReplayAudit((yield* SqliteClient).db);
          }),
          fileConfig,
        );
        yield* crashWebhookProcess(
          databasePath,
          checkpoint,
          appUserNotificationPayload(
            yield* Clock.currentTimeMillis,
            "issueUnassignedFromYou",
          ),
        );
        yield* withWebhook(
          Effect.gen(function* () {
            const pipeline = yield* WebhookPipeline;
            yield* pipeline.recoverPendingDeliveries();
            yield* pipeline.recoverPendingDeliveries();
            const inputs = yield* RunInputRepo;
            expect(yield* inputs.pending(sessionId("session-1"))).toHaveLength(
              1,
            );
            expect(yield* inputs.pending(sessionId("session-2"))).toHaveLength(
              1,
            );
            expect(
              yield* inputs.pending(sessionId("foreign-session")),
            ).toHaveLength(0);
            const { db } = yield* SqliteClient;
            expect(replayStatus(db).status).toBe("processed");
            expect(auditCounts(db)).toEqual([{ operation: "input", count: 2 }]);
          }),
          fileConfig,
        );
      }),
    { timeout: 15_000 },
  );

  it.live.each(["installation", "processed"] as const)(
    "replays permission crash at %s with one committed installation update",
    (checkpoint) =>
      Effect.gen(function* () {
        const databasePath = suitePath(`permission-${checkpoint}.db`);
        const fileConfig = { ...config, databasePath };
        yield* withWebhook(
          Effect.gen(function* () {
            yield* install();
            setupReplayAudit((yield* SqliteClient).db);
          }),
          fileConfig,
        );
        yield* crashWebhookProcess(databasePath, checkpoint, {
          type: "PermissionChange",
          action: "teamAccessChanged",
          organizationId: "org",
          appUserId: "app-user",
          oauthClientId: "client",
          webhookId: "permissions",
          webhookTimestamp: yield* Clock.currentTimeMillis,
          addedTeamIds: ["team-b"],
          removedTeamIds: ["team-a"],
          canAccessAllPublicTeams: false,
        });
        yield* withWebhook(
          Effect.gen(function* () {
            const pipeline = yield* WebhookPipeline;
            yield* pipeline.recoverPendingDeliveries();
            yield* pipeline.recoverPendingDeliveries();
            const installation = Option.getOrThrow(
              yield* InstallationRepo.use((repo) =>
                repo.get(organizationId("org")),
              ),
            );
            expect(installation.accessibleTeamIds).toEqual(
              Option.some([teamId("team-b")]),
            );
            const { db } = yield* SqliteClient;
            expect(replayStatus(db).status).toBe("processed");
            expect(auditCounts(db)).toEqual([
              { operation: "installation", count: 1 },
            ]);
          }),
          fileConfig,
        );
      }),
    { timeout: 15_000 },
  );
});
