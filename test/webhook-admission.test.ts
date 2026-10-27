import { it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Logger, Option, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, vi } from "vitest";
import { DatabaseError } from "../src/domain/errors.js";
import {
  DeliveryRepo,
  InstallationRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { WebhookPipeline } from "../src/services/webhook.js";

import {
  agentSessionBase,
  config,
  createdPayload,
  currentTime,
  install,
  oauthAppPayload,
  organizationId,
  sessionId,
  signedRequest,
  withWebhook,
} from "./webhook-fixtures.js";

describe("webhook replay, delivery, and identity invariants", () => {
  it.live(
    "replay-window boundaries accept exactly within the window and reject one millisecond outside",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          window: fc
            .integer({ min: 1, max: 10_000 })
            .filter(
              Schema.is(
                Schema.Number.pipe(
                  Schema.check(Schema.isInt()),
                  Schema.check(
                    Schema.isBetween({ minimum: 1, maximum: 10_000 }),
                  ),
                ),
              ),
            ),
          boundary: fc.constantFrom(
            ...["inside", "lower", "upper", "too-old", "too-new"],
          ),
        });
        const check = ({
          window,
          boundary,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withWebhook(
            Effect.gen(function* () {
              const now = 1_000_000;
              const timestamp =
                boundary === "inside"
                  ? now
                  : boundary === "lower"
                    ? now - window
                    : boundary === "upper"
                      ? now + window
                      : boundary === "too-old"
                        ? now - window - 1
                        : now + window + 1;
              const liveClock = yield* Clock.Clock;
              const clock = {
                currentTimeNanosUnsafe:
                  liveClock.currentTimeNanosUnsafe.bind(liveClock),
                currentTimeNanos: liveClock.currentTimeNanos,
                monotonicTimeNanosUnsafe:
                  liveClock.monotonicTimeNanosUnsafe.bind(liveClock),
                monotonicTimeNanos: liveClock.monotonicTimeNanos,
                sleep: liveClock.sleep.bind(liveClock),
                currentTimeMillisUnsafe: () => now,
                currentTimeMillis: Effect.succeed(now),
              };
              const response = yield* WebhookPipeline.use((service) =>
                service.handle(
                  signedRequest(
                    oauthAppPayload(timestamp, { action: "created" }),
                  ),
                ),
              ).pipe(Effect.provideService(Clock.Clock, clock));
              const accepted =
                boundary === "inside" ||
                boundary === "lower" ||
                boundary === "upper";
              expect(response.status).toBe(accepted ? 200 : 401);
            }),
            { ...config, webhookReplayWindowMs: window },
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

  it.live(
    "a repeated delivery id is idempotent after durable processing",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          delivery: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
        });
        const check = ({
          delivery,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withWebhook(
            Effect.gen(function* () {
              const now = yield* currentTime;
              yield* install();
              const payload = createdPayload(now);
              const first = yield* WebhookPipeline.use((service) =>
                service.handle(signedRequest(payload, { delivery })),
              );
              const second = yield* WebhookPipeline.use((service) =>
                service.handle(signedRequest(payload, { delivery })),
              );
              expect(first.status).toBe(200);
              expect(second.status).toBe(200);
              expect(yield* Effect.promise(() => second.text())).toBe(
                "Duplicate delivery",
              );
              expect(
                yield* RunInputRepo.use((service) =>
                  service.pending(sessionId("session-1")),
                ),
              ).toHaveLength(1);
            }),
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

  it.live(
    "all generated AgentSession installation identity mismatch forms are rejected",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          mismatch: fc.constantFrom(
            ...["organization", "embedded-app-user", "installation-app-user"],
          ),
        });
        const check = ({
          mismatch,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withWebhook(
            Effect.gen(function* () {
              const now = yield* currentTime;
              const payload =
                mismatch === "organization"
                  ? createdPayload(now, {
                      organizationId: "org-2",
                      agentSession: agentSessionBase({ organizationId: "org" }),
                    })
                  : mismatch === "embedded-app-user"
                    ? createdPayload(now, {
                        appUserId: "other-user",
                        agentSession: agentSessionBase({
                          appUserId: "app-user",
                        }),
                      })
                    : createdPayload(now, {
                        appUserId: "other-user",
                        agentSession: agentSessionBase({
                          appUserId: "other-user",
                        }),
                      });
              if (mismatch === "organization") {
                yield* install({ organizationId: organizationId("org-2") });
              } else {
                yield* install();
              }
              const response = yield* WebhookPipeline.use((service) =>
                service.handle(signedRequest(payload)),
              );
              expect(response.status).toBe(401);
              expect(
                yield* RunRepo.use((service) =>
                  service.get(sessionId("session-1")),
                ),
              ).toEqual(Option.none());
            }),
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

describe("webhook admission security", () => {
  it.live(
    "rejects a signed unadmitted org before delivery/run persistence",
    () =>
      withWebhook(
        Effect.gen(function* () {
          const now = yield* currentTime;
          yield* install();
          const req = signedRequest(createdPayload(now), {
            delivery: "denied-delivery",
          });
          const response = yield* WebhookPipeline.use((service) =>
            service.handle(req),
          );
          expect(response.status).toBe(403);
          expect(
            yield* RunRepo.use((service) =>
              service.get(sessionId("session-1")),
            ),
          ).toEqual(Option.none());
          expect(
            yield* RunInputRepo.use((service) =>
              service.pending(sessionId("session-1")),
            ),
          ).toHaveLength(0);
          expect(
            yield* DeliveryRepo.use((service) =>
              service.claim({
                id: "denied-delivery" as import("../src/domain/ids.js").DeliveryId,
                organizationId: "org",
                payloadHash: "different",
                payload: {},
              }),
            ),
          ).toBe("claimed");
        }),
        { ...config, allowedOrganizationIds: new Set(["other-org"]) },
      ),
  );
  it.live(
    "caps webhook bodies before HMAC verification even without Content-Length",
    () =>
      withWebhook(
        Effect.gen(function* () {
          const response = yield* WebhookPipeline.use((service) =>
            service.handle(
              new Request("https://gateway.example/webhooks/linear", {
                method: "POST",
                body: "x".repeat(1024 * 1024 + 1),
              }),
            ),
          );
          expect(response.status).toBe(413);
        }),
      ),
  );
});

describe("Interrupted webhook delivery recovery", () => {
  it.live("reclaims a delivery when its processing fiber was interrupted", () =>
    withWebhook(
      Effect.gen(function* () {
        yield* install();
        const installationRepo = yield* InstallationRepo;
        const pipeline = yield* WebhookPipeline;
        const entered = yield* Deferred.make<void>();
        const spy = vi
          .spyOn(installationRepo, "get")
          .mockImplementation(() =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          );
        const now = yield* Clock.currentTimeMillis;
        const payload = createdPayload(now);
        const fiber = yield* Effect.forkChild(
          pipeline.handle(
            signedRequest(payload, { delivery: "interrupted-webhook" }),
          ),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        spy.mockRestore();
        const response = yield* pipeline.handle(
          signedRequest(payload, { delivery: "interrupted-webhook" }),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe("OK");
        expect(
          Option.isSome(
            yield* RunRepo.use((service) =>
              service.get(sessionId("session-1")),
            ),
          ),
        ).toBe(true);
      }),
    ),
  );
});

describe("Webhook cleanup write failures", () => {
  it.live(
    "logs failed cleanup and retries it on redelivery without a restart",
    () =>
      withWebhook(
        Effect.gen(function* () {
          yield* install();
          const installations = yield* InstallationRepo;
          const deliveries = yield* DeliveryRepo;
          const pipeline = yield* WebhookPipeline;
          const entered = yield* Deferred.make<void>();
          const blocked = vi
            .spyOn(installations, "get")
            .mockImplementation(() =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
              ),
            );
          const mark = vi
            .spyOn(deliveries, "mark")
            .mockImplementation(() =>
              Effect.fail(new DatabaseError({ message: "disk unavailable" })),
            );
          const messages: string[] = [];
          const logger = Logger.make((options) => {
            messages.push(String(options.message));
          });
          const payload = createdPayload(yield* Clock.currentTimeMillis);
          const processing = yield* Effect.forkChild(
            pipeline
              .handle(
                signedRequest(payload, { delivery: "cleanup-write-failure" }),
              )
              .pipe(Effect.provide(Logger.layer([logger]))),
          );
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(processing);
          expect(messages).toContain("webhook.delivery_cleanup_failed");
          blocked.mockRestore();
          // Even when repair also fails, return a retryable error instead of a false duplicate success.
          const unavailable = yield* pipeline.handle(
            signedRequest(payload, { delivery: "cleanup-write-failure" }),
          );
          expect(unavailable.status).toBe(500);
          mark.mockRestore();
          const retried = yield* pipeline.handle(
            signedRequest(payload, { delivery: "cleanup-write-failure" }),
          );
          expect(retried.status).toBe(200);
          expect(yield* Effect.promise(() => retried.text())).toBe("OK");
          expect(
            Option.isSome(
              yield* RunRepo.use((service) =>
                service.get(sessionId("session-1")),
              ),
            ),
          ).toBe(true);
        }),
      ),
  );
});

describe("Webhook claim-owned failure marking", () => {
  it.live.each(["identity", "payload"] as const)(
    "persists a safe reason for a post-claim %s failure",
    (kind) =>
      withWebhook(
        Effect.gen(function* () {
          yield* install();
          const deliveries = yield* DeliveryRepo;
          const mark = yield* Effect.acquireRelease(
            Effect.sync(() => vi.spyOn(deliveries, "mark")),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
          const original = createdPayload(yield* Clock.currentTimeMillis);
          const payload =
            kind === "identity"
              ? { ...original, oauthClientId: "untrusted-client-value" }
              : { ...original, agentSession: "untrusted-session-value" };
          const response = yield* WebhookPipeline.use((service) =>
            service.handle(signedRequest(payload)),
          );
          expect(response.status).toBe(kind === "identity" ? 401 : 400);
          expect(mark).toHaveBeenCalledTimes(1);
          expect(mark.mock.calls[0]?.slice(1)).toEqual([
            "failed",
            kind === "identity"
              ? "OAuth client identity mismatch"
              : "AgentSessionEvent payload is invalid",
            expect.any(String),
          ]);
        }).pipe(Effect.scoped),
      ),
  );

  it.live(
    "does not overwrite a reclaimed delivery after a tagged processing failure",
    () =>
      withWebhook(
        Effect.gen(function* () {
          yield* install();
          const installations = yield* InstallationRepo;
          const deliveries = yield* DeliveryRepo;
          const pipeline = yield* WebhookPipeline;
          const claim = vi.spyOn(deliveries, "claim");
          const originalClaim = deliveries.claim.bind(deliveries);
          const originalMark = deliveries.mark.bind(deliveries);
          const failed = vi
            .spyOn(installations, "get")
            .mockImplementationOnce(() =>
              Effect.fail(new DatabaseError({ message: "processing failed" })),
            );
          const marks = vi
            .spyOn(deliveries, "mark")
            .mockImplementation((id, status, error) =>
              originalMark(id, status, error).pipe(
                Effect.tap(() =>
                  Effect.gen(function* () {
                    if (status !== "failed") return;
                    const input = claim.mock.calls[0]?.[0];
                    if (input === undefined)
                      throw new Error("claim input missing");
                    expect(yield* originalClaim(input).pipe(Effect.orDie)).toBe(
                      "claimed",
                    );
                  }),
                ),
              ),
            );
          yield* Effect.gen(function* () {
            const payload = createdPayload(yield* Clock.currentTimeMillis);
            const response = yield* pipeline.handle(
              signedRequest(payload, { delivery: "reclaimed-after-failure" }),
            );
            expect(response.status).toBe(500);
            expect(marks).toHaveBeenCalledTimes(1);
            const input = claim.mock.calls[0]?.[0];
            if (input === undefined) throw new Error("claim input missing");
            expect(yield* originalClaim(input)).toBe("duplicate");
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                claim.mockRestore();
                marks.mockRestore();
                failed.mockRestore();
              }),
            ),
          );
        }),
      ),
  );

  it.live("does not mark a delivery when the claim itself fails", () =>
    withWebhook(
      Effect.gen(function* () {
        yield* install();
        const deliveries = yield* DeliveryRepo;
        const claim = vi
          .spyOn(deliveries, "claim")
          .mockImplementation(() =>
            Effect.fail(new DatabaseError({ message: "claim unavailable" })),
          );
        const mark = vi.spyOn(deliveries, "mark");
        yield* Effect.gen(function* () {
          const payload = createdPayload(yield* Clock.currentTimeMillis);
          const response = yield* WebhookPipeline.use((service) =>
            service.handle(signedRequest(payload)),
          );
          expect(response.status).toBe(500);
          expect(mark).not.toHaveBeenCalled();
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              claim.mockRestore();
              mark.mockRestore();
            }),
          ),
        );
      }),
    ),
  );
});

// Closing and reopening file-backed layers plus abrupt child process exits
// exercise WAL recovery, not request-fiber finalizers or in-memory mock state.
