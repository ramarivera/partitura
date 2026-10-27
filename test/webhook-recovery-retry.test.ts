import { createHash } from "node:crypto";
import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { expect, vi } from "vitest";
import { recoverGateway } from "../src/conductor.js";
import { DatabaseError } from "../src/domain/errors.js";
import {
  DeliveryRepo,
  InstallationRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { SqliteClient } from "../src/services/store/sqlite-client.js";
import { payloadHash, WebhookPipeline } from "../src/services/webhook.js";
import {
  appUserNotificationPayload,
  config,
  createdPayload,
  install,
  issueId,
  oauthAppPayload,
  organizationId,
  sessionId,
  signedRequest,
  suitePath,
  withWebhook,
} from "./webhook-fixtures.js";
import {
  auditCounts,
  crashDeliveryId,
  crashWebhookProcess,
  replayStatus,
  setupReplayAudit,
  storeReplay,
} from "./webhook-replay-fixtures.js";

it.live.each([false, true])(
  "uses bounded replay backoff and signed retry recovery, exhausted=%s",
  (exhausted) =>
    withWebhook(
      Effect.gen(function* () {
        yield* install();
        const payload = createdPayload(yield* Clock.currentTimeMillis);
        yield* storeReplay(payload);
        const deliveries = yield* DeliveryRepo;
        const processClaim = deliveries.processClaim;
        const times: number[] = [];
        const spy = vi
          .spyOn(deliveries, "processClaim")
          .mockImplementation((id, token, effect) =>
            Effect.gen(function* () {
              times.push(yield* Clock.currentTimeMillis);
              if (exhausted || times.length <= 2)
                return yield* Effect.fail(
                  new DatabaseError({ message: "sensitive storage details" }),
                );
              return yield* processClaim(id, token, effect);
            }),
          );
        yield* WebhookPipeline.use((pipeline) =>
          pipeline.recoverPendingDeliveries(),
        );
        spy.mockRestore();
        expect(times).toHaveLength(3);
        const [first, second, third] = times;
        if (first === undefined || second === undefined || third === undefined)
          throw new Error("Missing retry attempts");
        expect(second - first).toBeGreaterThanOrEqual(25);
        expect(third - second).toBeGreaterThanOrEqual(50);
        const { db } = yield* SqliteClient;
        expect(replayStatus(db).status).toBe(
          exhausted ? "failed" : "processed",
        );
        if (exhausted) {
          const response = yield* WebhookPipeline.use((pipeline) =>
            pipeline.handle(
              signedRequest(payload, { delivery: "crash-delivery" }),
            ),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.text())).toBe("OK");
        }
        expect(replayStatus(db)).toEqual({ status: "processed", error: null });
        expect(
          yield* RunInputRepo.use((repo) =>
            repo.pending(sessionId("session-1")),
          ),
        ).toHaveLength(1);
      }),
    ),
);

it.live("concurrent startup recoveries commit only one actionable input", () =>
  withWebhook(
    Effect.gen(function* () {
      yield* install();
      yield* storeReplay(createdPayload(yield* Clock.currentTimeMillis));
      const pipeline = yield* WebhookPipeline;
      yield* Effect.all(
        [
          pipeline.recoverPendingDeliveries(),
          pipeline.recoverPendingDeliveries(),
        ],
        { concurrency: 2 },
      );
      expect(replayStatus((yield* SqliteClient).db).status).toBe("processed");
      expect(
        yield* RunInputRepo.use((repo) => repo.pending(sessionId("session-1"))),
      ).toHaveLength(1);
    }),
  ),
);

it.live(
  "replays an OAuth revocation crash atomically with cancellation and admin-session invalidation",
  () =>
    Effect.gen(function* () {
      const databasePath = suitePath("oauth-replay.db");
      const fileConfig = { ...config, databasePath };
      yield* withWebhook(
        Effect.gen(function* () {
          yield* install();
          yield* RunRepo.use((repo) =>
            repo.create({
              sessionId: sessionId("session-1"),
              organizationId: organizationId("org"),
              issueId: Option.none(),
            }),
          );
          const { db } = yield* SqliteClient;
          db.exec(
            "INSERT INTO admin_session VALUES ('admin-token-hash', 'org', 'csrf-hash', 9999999999999, 1)",
          );
          setupReplayAudit(db);
        }),
        fileConfig,
      );
      yield* crashWebhookProcess(
        databasePath,
        "processed",
        oauthAppPayload(yield* Clock.currentTimeMillis),
      );
      yield* withWebhook(
        Effect.gen(function* () {
          const { db } = yield* SqliteClient;
          expect(
            db
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM admin_session",
              )
              .get()?.count,
          ).toBe(1);
          yield* recoverGateway;
          yield* recoverGateway;
          expect(replayStatus(db).status).toBe("processed");
          expect(
            db
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM admin_session",
              )
              .get()?.count,
          ).toBe(0);
          const run = Option.getOrThrow(
            yield* RunRepo.use((repo) => repo.get(sessionId("session-1"))),
          );
          expect(run.desiredState).toBe("canceled");
          const installation = Option.getOrThrow(
            yield* InstallationRepo.use((repo) =>
              repo.get(organizationId("org")),
            ),
          );
          expect(Option.isSome(installation.revokedAt)).toBe(true);
          expect(auditCounts(db)).toEqual([
            { operation: "installation", count: 1 },
          ]);
        }),
        fileConfig,
      );
    }),
  { timeout: 15_000 },
);

it.live(
  "replays normalized header-only timestamps while preserving raw-byte dedupe",
  () =>
    Effect.gen(function* () {
      const databasePath = suitePath("header-timestamp-replay.db");
      const fileConfig = { ...config, databasePath };
      yield* withWebhook(install(), fileConfig);
      const payload = createdPayload(yield* Clock.currentTimeMillis);
      delete payload.webhookTimestamp;
      yield* crashWebhookProcess(databasePath, "claim", payload);
      yield* withWebhook(
        Effect.gen(function* () {
          const { db } = yield* SqliteClient;
          const stored = db
            .query<{ payload_hash: string; payload_json: string }, []>(
              "SELECT payload_hash, payload_json FROM webhook_delivery",
            )
            .get();
          if (stored === null) throw new Error("Missing stored envelope");
          expect(stored.payload_hash).toBe(
            payloadHash(new TextEncoder().encode(JSON.stringify(payload))),
          );
          expect(stored.payload_json).toContain("webhookTimestamp");
          yield* recoverGateway;
          expect(replayStatus(db).status).toBe("processed");
          expect(
            yield* RunInputRepo.use((repo) =>
              repo.pending(sessionId("session-1")),
            ),
          ).toHaveLength(1);
          const request = signedRequest(payload, {
            delivery: "crash-delivery",
          });
          request.headers.set(
            "linear-timestamp",
            String(yield* Clock.currentTimeMillis),
          );
          const retry = yield* WebhookPipeline.use((pipeline) =>
            pipeline.handle(request),
          );
          expect(retry.status).toBe(200);
          expect(yield* Effect.promise(() => retry.text())).toBe(
            "Duplicate delivery",
          );
        }),
        fileConfig,
      );
    }),
  { timeout: 15_000 },
);

it.live("completion cannot be demoted even by its former claim owner", () =>
  withWebhook(
    Effect.gen(function* () {
      yield* install();
      yield* storeReplay(createdPayload(yield* Clock.currentTimeMillis));
      const deliveries = yield* DeliveryRepo;
      expect(
        yield* deliveries.processClaim(
          crashDeliveryId,
          "original-owner",
          Effect.void,
        ),
      ).toBe(true);
      yield* deliveries.mark(
        crashDeliveryId,
        "failed",
        "late cleanup",
        "original-owner",
      );
      expect(replayStatus((yield* SqliteClient).db)).toEqual({
        status: "processed",
        error: null,
      });
    }),
  ),
);

it.live(
  "returns a retryable response when recovery supersedes fresh ingress",
  () =>
    withWebhook(
      Effect.gen(function* () {
        yield* install();
        const deliveries = yield* DeliveryRepo;
        const processClaim = vi
          .spyOn(deliveries, "processClaim")
          .mockImplementation((id) =>
            deliveries.claimReplay(id, "takeover-owner").pipe(Effect.as(false)),
          );
        const payload = createdPayload(yield* Clock.currentTimeMillis);
        const response = yield* WebhookPipeline.use((pipeline) =>
          pipeline.handle(
            signedRequest(payload, { delivery: "crash-delivery" }),
          ),
        );
        processClaim.mockRestore();
        expect(response.status).toBe(503);
        expect(yield* Effect.promise(() => response.text())).toBe(
          "Delivery claim superseded",
        );
        expect(replayStatus((yield* SqliteClient).db).status).toBe("pending");
        yield* recoverGateway;
        expect(replayStatus((yield* SqliteClient).db).status).toBe("processed");
        expect(
          yield* RunInputRepo.use((repo) =>
            repo.pending(sessionId("session-1")),
          ),
        ).toHaveLength(1);
      }),
    ),
);

it.live.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
] as const)(
  "claim acquisition write failure is retryable or fails startup, cleanup blocked=%s, null token=%s",
  ([cleanupBlocked, nullToken]) =>
    Effect.gen(function* () {
      const databasePath = suitePath(
        `claim-write-failure-${cleanupBlocked}-${nullToken}.db`,
      );
      const fileConfig = { ...config, databasePath };
      const payload = createdPayload(yield* Clock.currentTimeMillis);
      yield* withWebhook(
        Effect.gen(function* () {
          yield* install();
          yield* storeReplay(payload);
          const { db } = yield* SqliteClient;
          if (nullToken)
            db.query(
              "UPDATE webhook_delivery SET claim_token=NULL WHERE delivery_id=?",
            ).run(crashDeliveryId);
          db.exec(
            `CREATE TRIGGER fail_replay_write BEFORE UPDATE ${cleanupBlocked ? "" : "OF claim_token"} ON webhook_delivery BEGIN SELECT RAISE(ABORT, 'simulated unavailable storage'); END;`,
          );
        }),
        fileConfig,
      );
      // A new service layer models restart: the original request no longer owns
      // the durable token. Real SQLite writes fail, not just a mock claim call.
      yield* withWebhook(
        Effect.gen(function* () {
          const deliveries = yield* DeliveryRepo;
          const attempts = vi.spyOn(deliveries, "claimReplay");
          const recovered = yield* Effect.exit(recoverGateway);
          expect(Exit.isFailure(recovered)).toBe(cleanupBlocked);
          expect(attempts).toHaveBeenCalledTimes(3);
          attempts.mockRestore();
          const { db } = yield* SqliteClient;
          expect(replayStatus(db).status).toBe(
            cleanupBlocked ? "pending" : "failed",
          );
          db.exec("DROP TRIGGER fail_replay_write");
          const pipeline = yield* WebhookPipeline;
          const request = () =>
            signedRequest(payload, { delivery: "crash-delivery" });
          const response = yield* pipeline.handle(request());
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.text())).toBe("OK");
          expect(replayStatus(db)).toEqual({
            status: "processed",
            error: null,
          });
          const duplicate = yield* pipeline.handle(request());
          expect(yield* Effect.promise(() => duplicate.text())).toBe(
            "Duplicate delivery",
          );
          expect(
            yield* RunInputRepo.use((repo) =>
              repo.pending(sessionId("session-1")),
            ),
          ).toHaveLength(1);
        }),
        fileConfig,
      );
    }),
);

it.live("signed redelivery preserves a genuinely in-flight claim", () =>
  withWebhook(
    Effect.gen(function* () {
      yield* install();
      const deliveries = yield* DeliveryRepo;
      const pipeline = yield* WebhookPipeline;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const processClaim = deliveries.processClaim;
      const paused = vi
        .spyOn(deliveries, "processClaim")
        .mockImplementation((id, token, effect) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(resume);
            return yield* processClaim(id, token, effect);
          }),
        );
      const payload = createdPayload(yield* Clock.currentTimeMillis);
      const request = () =>
        signedRequest(payload, { delivery: "crash-delivery" });
      const original = yield* pipeline.handle(request()).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const duplicate = yield* pipeline.handle(request());
      expect(yield* Effect.promise(() => duplicate.text())).toBe(
        "Duplicate delivery",
      );
      expect(paused).toHaveBeenCalledTimes(1);
      yield* Deferred.succeed(resume, undefined);
      expect((yield* Fiber.join(original)).status).toBe(200);
      paused.mockRestore();
      expect(
        yield* RunInputRepo.use((repo) => repo.pending(sessionId("session-1"))),
      ).toHaveLength(1);
    }),
  ),
);

it.live.each(["replay", "delayed ingress"] as const)(
  "old stop excludes newer runs on %s",
  (mode) =>
    Effect.gen(function* () {
      const databasePath = suitePath(`stop-cutoff-${mode}.db`);
      const fileConfig = { ...config, databasePath };
      const notificationAt = (yield* Clock.currentTimeMillis) - 200;
      const payload = appUserNotificationPayload(
        notificationAt,
        "issueUnassignedFromYou",
      );
      yield* withWebhook(
        Effect.gen(function* () {
          yield* install();
          const runs = yield* RunRepo;
          yield* runs.create({
            sessionId: sessionId("old-session"),
            organizationId: organizationId("org"),
            issueId: Option.some(issueId("issue-1")),
            now: notificationAt,
          });
          if (mode === "replay") yield* storeReplay(payload);
          yield* runs.create({
            sessionId: sessionId("new-session"),
            organizationId: organizationId("org"),
            issueId: Option.some(issueId("issue-1")),
            now: notificationAt + 100,
          });
        }),
        fileConfig,
      );
      yield* withWebhook(
        Effect.gen(function* () {
          const pipeline = yield* WebhookPipeline;
          if (mode === "replay") {
            yield* recoverGateway;
            yield* recoverGateway;
          } else {
            expect(
              (yield* pipeline.handle(signedRequest(payload))).status,
            ).toBe(200);
          }
          const inputs = yield* RunInputRepo;
          expect(yield* inputs.pending(sessionId("old-session"))).toHaveLength(
            1,
          );
          expect(yield* inputs.pending(sessionId("new-session"))).toHaveLength(
            0,
          );
          const runs = yield* RunRepo;
          expect(
            Option.getOrThrow(yield* runs.get(sessionId("old-session")))
              .desiredState,
          ).toBe("canceled");
          expect(
            Option.getOrThrow(yield* runs.get(sessionId("new-session")))
              .desiredState,
          ).toBe("running");
        }),
        fileConfig,
      );
    }),
);

it.live(
  "rejects a forged payload with a recomputed unkeyed hash and accepts signed retry",
  () =>
    withWebhook(
      Effect.gen(function* () {
        yield* install();
        const payload = createdPayload(yield* Clock.currentTimeMillis);
        yield* storeReplay(payload);
        const forged = JSON.stringify({
          ...payload,
          type: "OAuthApp",
          action: "revoked",
        });
        const ingressHash = payloadHash(
          new TextEncoder().encode(JSON.stringify(payload)),
        );
        const unkeyedHash = createHash("sha256")
          .update(JSON.stringify([1, "org", ingressHash, forged]))
          .digest("hex");
        const { db } = yield* SqliteClient;
        db.query(
          "UPDATE webhook_delivery SET payload_json=?, replay_hash=? WHERE delivery_id=?",
        ).run(forged, unkeyedHash, crashDeliveryId);
        const pipeline = yield* WebhookPipeline;
        yield* pipeline.recoverPendingDeliveries();
        expect(replayStatus(db)).toEqual({
          status: "failed",
          error: "Stored webhook replay failed",
        });
        const installation = Option.getOrThrow(
          yield* InstallationRepo.use((repo) =>
            repo.get(organizationId("org")),
          ),
        );
        expect(Option.isNone(installation.revokedAt)).toBe(true);
        expect(
          yield* RunInputRepo.use((repo) =>
            repo.pending(sessionId("session-1")),
          ),
        ).toHaveLength(0);
        const response = yield* pipeline.handle(
          signedRequest(payload, { delivery: "crash-delivery" }),
        );
        expect(yield* Effect.promise(() => response.text())).toBe("OK");
        expect(replayStatus(db).status).toBe("processed");
        expect(
          yield* RunInputRepo.use((repo) =>
            repo.pending(sessionId("session-1")),
          ),
        ).toHaveLength(1);
      }),
    ),
);
