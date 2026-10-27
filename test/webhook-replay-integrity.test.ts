import { it } from "@effect/vitest";
import {
  Cause,
  Clock,
  Effect,
  Logger,
  Option,
  Redacted,
  References,
  Schema,
} from "effect";
import { describe, expect } from "vitest";
import { recoverGateway } from "../src/conductor.js";
import { DeliveryId } from "../src/domain/ids.js";
import { deliveryReplayMac } from "../src/services/store/delivery-repo.js";
import {
  DeliveryRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { SqliteClient } from "../src/services/store/sqlite-client.js";
import { payloadHash, WebhookPipeline } from "../src/services/webhook.js";
import {
  agentSessionBase,
  config,
  createdPayload,
  install,
  organizationId,
  secret,
  sessionId,
  withWebhook,
} from "./webhook-fixtures.js";
import {
  crashDeliveryId,
  replayStatus,
  storeReplay,
} from "./webhook-replay-fixtures.js";

describe("Webhook replay integrity and fencing", () => {
  it.live.each(["organization", "hash", "version", "json"] as const)(
    "rejects stored %s tampering and still replays the next delivery",
    (field) =>
      withWebhook(
        Effect.gen(function* () {
          yield* install();
          const payload = createdPayload(yield* Clock.currentTimeMillis);
          yield* storeReplay(payload);
          const deliveries = yield* DeliveryRepo;
          const next = createdPayload(yield* Clock.currentTimeMillis, {
            agentSession: agentSessionBase({ id: "next-session" }),
          });
          yield* deliveries.claim({
            id: Schema.decodeUnknownSync(DeliveryId)("next-delivery"),
            organizationId: "org",
            payload: next,
            payloadHash: payloadHash(
              new TextEncoder().encode(JSON.stringify(next)),
            ),
            payloadVersion: 1,
          });
          const { db } = yield* SqliteClient;
          switch (field) {
            case "organization": {
              const altered = JSON.stringify({
                ...payload,
                organizationId: "other-org",
              });
              // A valid checksum alone cannot authorize a tenant mismatch.
              const hash = payloadHash(
                new TextEncoder().encode(JSON.stringify(payload)),
              );
              db.query(
                "UPDATE webhook_delivery SET payload_json=?, replay_hash=? WHERE delivery_id=?",
              ).run(
                altered,
                deliveryReplayMac(
                  Redacted.make(secret),
                  "org",
                  hash,
                  altered,
                  1,
                ),
                crashDeliveryId,
              );
              break;
            }
            case "hash":
              db.query(
                "UPDATE webhook_delivery SET payload_hash='tampered' WHERE delivery_id=?",
              ).run(crashDeliveryId);
              break;
            case "version":
              db.query(
                "UPDATE webhook_delivery SET payload_version=99 WHERE delivery_id=?",
              ).run(crashDeliveryId);
              break;
            case "json":
              db.query(
                "UPDATE webhook_delivery SET payload_json='not JSON', replay_hash=? WHERE delivery_id=?",
              ).run(
                deliveryReplayMac(
                  Redacted.make(secret),
                  "org",
                  payloadHash(
                    new TextEncoder().encode(JSON.stringify(payload)),
                  ),
                  "not JSON",
                  1,
                ),
                crashDeliveryId,
              );
              break;
          }
          const messages: string[] = [];
          const logger = Logger.make((options) =>
            messages.push(
              JSON.stringify({
                message: options.message,
                cause:
                  options.cause === undefined
                    ? undefined
                    : Cause.pretty(options.cause),
                annotations: options.fiber.getRef(
                  References.CurrentLogAnnotations,
                ),
              }),
            ),
          );
          yield* WebhookPipeline.use((pipeline) =>
            pipeline.recoverPendingDeliveries(),
          ).pipe(Effect.provide(Logger.layer([logger])));
          expect(replayStatus(db)).toEqual({
            status: "failed",
            error: "Stored webhook replay failed",
          });
          expect(
            yield* RunInputRepo.use((repo) =>
              repo.pending(sessionId("session-1")),
            ),
          ).toHaveLength(0);
          expect(
            yield* RunInputRepo.use((repo) =>
              repo.pending(sessionId("next-session")),
            ),
          ).toHaveLength(1);
          expect(messages.join("\n")).toContain("webhook.replay_failed");
          expect(messages.join("\n")).not.toContain("Implement the issue");
          expect(messages.join("\n")).not.toContain(secret);
          expect(messages.join("\n")).not.toContain("client-secret");
          expect(messages.join("\n")).not.toContain("original-owner");
        }),
      ),
  );

  it.live.each([
    "unadmitted",
    "revoked",
    "app-user",
    "client",
    "nested-org",
    "existing-run",
  ] as const)("rechecks %s identity on replay", (failure) =>
    withWebhook(
      Effect.gen(function* () {
        yield* install({
          revokedAt: failure === "revoked" ? Option.some(1) : Option.none(),
        });
        const payload = createdPayload(yield* Clock.currentTimeMillis, {
          ...(failure === "app-user"
            ? {
                appUserId: "wrong-user",
                agentSession: agentSessionBase({ appUserId: "wrong-user" }),
              }
            : {}),
          ...(failure === "client" ? { oauthClientId: "wrong-client" } : {}),
          ...(failure === "nested-org"
            ? {
                agentSession: agentSessionBase({ organizationId: "other-org" }),
              }
            : {}),
        });
        if (failure === "existing-run") {
          yield* RunRepo.use((repo) =>
            repo.create({
              sessionId: sessionId("session-1"),
              organizationId: organizationId("other-org"),
              issueId: Option.none(),
            }),
          );
        }
        yield* storeReplay(payload);
        yield* recoverGateway;
        expect(replayStatus((yield* SqliteClient).db).status).toBe("failed");
        expect(
          yield* RunInputRepo.use((repo) =>
            repo.pending(sessionId("session-1")),
          ),
        ).toHaveLength(0);
      }),
      failure === "unadmitted"
        ? { ...config, allowedOrganizationIds: new Set(["other-org"]) }
        : config,
    ),
  );

  it.live(
    "fences both stale writes and stale failure cleanup after replay takes ownership",
    () =>
      withWebhook(
        Effect.gen(function* () {
          yield* install();
          yield* storeReplay(createdPayload(yield* Clock.currentTimeMillis));
          const deliveries = yield* DeliveryRepo;
          const takeover = yield* deliveries.claimReplay(
            crashDeliveryId,
            "recovery-owner",
          );
          expect(Option.isSome(takeover)).toBe(true);
          let staleEffectRan = false;
          expect(
            yield* deliveries.processClaim(
              crashDeliveryId,
              "original-owner",
              Effect.sync(() => {
                staleEffectRan = true;
              }),
            ),
          ).toBe(false);
          yield* deliveries.mark(
            crashDeliveryId,
            "failed",
            "stale cleanup",
            "original-owner",
          );
          expect(staleEffectRan).toBe(false);
          expect(replayStatus((yield* SqliteClient).db).status).toBe("pending");
          yield* recoverGateway;
          yield* deliveries.mark(
            crashDeliveryId,
            "failed",
            "stale cleanup",
            "recovery-owner",
          );
          expect(replayStatus((yield* SqliteClient).db)).toEqual({
            status: "processed",
            error: null,
          });
          expect(
            yield* RunInputRepo.use((repo) =>
              repo.pending(sessionId("session-1")),
            ),
          ).toHaveLength(1);
        }),
      ),
  );

  it.live.each(["run", "enqueued", "consumed"] as const)(
    "repairs a preexisting partial %s write without omitting or reactivating the input",
    (partial) =>
      withWebhook(
        Effect.gen(function* () {
          yield* install();
          const timestamp = yield* Clock.currentTimeMillis;
          yield* storeReplay(createdPayload(timestamp));
          yield* RunRepo.use((repo) =>
            repo.create({
              sessionId: sessionId("session-1"),
              organizationId: organizationId("org"),
              issueId: Option.none(),
            }),
          );
          const { db } = yield* SqliteClient;
          if (partial !== "run") {
            db.query(
              "INSERT INTO run_input (id, session_id, kind, body, payload_json, created_at, processed_at) VALUES (?, ?, 'created', 'original input', '{}', ?, ?)",
            ).run(
              "session-1:created",
              "session-1",
              timestamp,
              partial === "consumed" ? timestamp : null,
            );
          }
          yield* recoverGateway;
          yield* recoverGateway;
          expect(replayStatus(db).status).toBe("processed");
          expect(
            db
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM run_input WHERE session_id='session-1'",
              )
              .get()?.count,
          ).toBe(1);
          const inputs = yield* RunInputRepo.use((repo) =>
            repo.pending(sessionId("session-1")),
          );
          expect(inputs).toHaveLength(partial === "consumed" ? 0 : 1);
          if (partial === "enqueued")
            expect(inputs[0]?.body).toBe("original input");
        }),
      ),
  );
});
