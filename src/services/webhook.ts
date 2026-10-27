import { randomUUID } from "node:crypto";
import {
  Cause,
  Context,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import {
  type DatabaseError,
  type RowDecodeError,
  type TokenCipherError,
  WebhookIdentityError,
  WebhookPayloadError,
} from "../domain/errors.js";
import type { DeliveryId } from "../domain/ids.js";
import { AgentSessionEvent } from "../domain/models.js";
import { BodyTooLargeError, readBoundedBody } from "./bounded-body.js";
import { GatewayConfig, organizationAllowed } from "./config.js";
import {
  isNumber,
  isRecord,
  isString,
  redactStringValues,
} from "./linear-helpers.js";
import {
  DeliveryRepo,
  InstallationRepo,
  PromptTemplateRepo,
  RunInputRepo,
  RunRepo,
} from "./store/repositories.js";
import {
  handleAgentSessionEvent,
  validateAgentSessionIdentity,
} from "./webhook-agent-session.js";
import {
  buildFallbackDeliveryId,
  payloadHash,
  verifySignature,
} from "./webhook-common.js";
import {
  decodeDeliveryId,
  handleAppUserNotification,
  handleOAuthAppRevoked,
  handlePermissionChange,
  validateAppUserNotification,
  validateOAuthAppPayload,
  validatePermissionChangePayload,
} from "./webhook-events.js";

export { buildCreatedInputBodyWithTemplate } from "./webhook-agent-session.js";
export { payloadHash, verifySignature } from "./webhook-common.js";

const LINEAR_SIGNATURE_HEADER = "linear-signature";
const LINEAR_TIMESTAMP_HEADER = "linear-timestamp";
const LINEAR_DELIVERY_HEADER = "linear-delivery";

type WebhookProcessingError =
  | DatabaseError
  | RowDecodeError
  | TokenCipherError
  | WebhookIdentityError
  | WebhookPayloadError;

export class WebhookPipeline extends Context.Service<WebhookPipeline>()(
  "WebhookPipeline",
  {
    make: Effect.gen(function* () {
      const config = yield* GatewayConfig;
      const installationRepo = yield* InstallationRepo;
      const runRepo = yield* RunRepo;
      const runInputRepo = yield* RunInputRepo;
      const deliveryRepo = yield* DeliveryRepo;
      const promptTemplateRepo = yield* PromptTemplateRepo;
      // Only authenticated ingress and validated persisted envelopes call this
      // boundary. Timestamp freshness belongs to ingress, tenant and event
      // identity validation is shared and runs again during replay.
      const processAuthenticatedEvent = Effect.fn(
        "WebhookPipeline.processAuthenticatedEvent",
      )(function* (
        parsed: Record<string, unknown>,
        id: DeliveryId,
        token: string,
      ): Effect.fn.Return<boolean, WebhookProcessingError> {
        const {
          organizationId,
          type: eventType,
          webhookTimestamp: timestamp,
        } = parsed;
        if (
          !isString(organizationId) ||
          !isString(eventType) ||
          !isString(parsed.webhookId) ||
          !isNumber(timestamp) ||
          !Number.isSafeInteger(timestamp) ||
          timestamp <= 0
        ) {
          return yield* Effect.fail(
            new WebhookPayloadError({
              message: "Stored webhook envelope is invalid",
              status: 400,
            }),
          );
        }
        if (!organizationAllowed(config, organizationId)) {
          return yield* Effect.fail(
            new WebhookIdentityError({
              message: "Organization is not allowed",
            }),
          );
        }
        const processing = Effect.gen(function* () {
          switch (eventType) {
            case "AgentSessionEvent": {
              const rawAgentSession = isRecord(parsed.agentSession)
                ? parsed.agentSession
                : undefined;
              const event = yield* Schema.decodeUnknownEffect(
                AgentSessionEvent,
              )(parsed).pipe(
                Effect.catchTag(
                  "SchemaError",
                  (error) =>
                    new WebhookPayloadError({
                      message: "AgentSessionEvent payload is invalid",
                      status: 400,
                      cause: String(error),
                    }),
                ),
              );
              yield* validateAgentSessionIdentity(
                event,
                config,
                installationRepo,
              );
              return yield* handleAgentSessionEvent(
                event,
                rawAgentSession,
                timestamp,
                runRepo,
                runInputRepo,
                promptTemplateRepo,
              );
            }
            case "OAuthApp": {
              const { action, organizationId: orgId } =
                yield* validateOAuthAppPayload(parsed, config);
              return yield* handleOAuthAppRevoked(
                action,
                orgId,
                installationRepo,
                timestamp,
              );
            }
            case "AppUserNotification": {
              const {
                payload,
                organizationId: orgId,
                issueId,
              } = yield* validateAppUserNotification(
                parsed,
                config,
                installationRepo,
              );
              return yield* handleAppUserNotification(
                payload,
                orgId,
                issueId,
                runRepo,
                runInputRepo,
                timestamp,
              );
            }
            case "PermissionChange": {
              const {
                action,
                organizationId: orgId,
                appUserId,
                addedTeamIds,
                removedTeamIds,
                canAccessAllPublicTeams,
              } = yield* validatePermissionChangePayload(parsed, config);

              const installation = yield* installationRepo.get(orgId);
              if (Option.isNone(installation)) {
                return yield* Effect.fail(
                  new WebhookIdentityError({
                    message: "No installation for organization",
                  }),
                );
              }
              if (Option.isSome(installation.value.revokedAt)) {
                return yield* Effect.fail(
                  new WebhookIdentityError({
                    message: "Installation is revoked",
                  }),
                );
              }
              if (installation.value.appUserId !== appUserId) {
                return yield* Effect.fail(
                  new WebhookIdentityError({
                    message: "App user mismatch",
                  }),
                );
              }

              return yield* handlePermissionChange(
                action,
                orgId,
                appUserId,
                addedTeamIds,
                removedTeamIds,
                canAccessAllPublicTeams,
                installationRepo,
                timestamp,
              );
            }
            default:
              return;
          }
        });
        return yield* deliveryRepo.processClaim(id, token, processing);
      });

      const recoverPendingDeliveries = Effect.fn(
        "WebhookPipeline.recoverPendingDeliveries",
      )(function* () {
        const pending = yield* deliveryRepo.pendingIds();
        for (const row of pending) {
          const token = randomUUID();
          let acquired = false;
          const replay = Effect.gen(function* () {
            const id = yield* decodeDeliveryId(row.delivery_id);
            const claimed = yield* deliveryRepo.claimReplay(id, token);
            if (Option.isNone(claimed)) return;
            acquired = true;
            const stored = claimed.value;
            if (
              stored.payload_version !== 1 ||
              !deliveryRepo.verifyReplay(stored)
            ) {
              return yield* Effect.fail(
                new WebhookPayloadError({
                  message: "Stored webhook integrity check failed",
                  status: 400,
                }),
              );
            }
            const parsed: unknown = yield* Effect.try({
              try: () => JSON.parse(stored.payload_json) as unknown,
              catch: () =>
                new WebhookPayloadError({
                  message: "Stored webhook JSON is invalid",
                  status: 400,
                }),
            });
            if (
              !isRecord(parsed) ||
              parsed.organizationId !== stored.organization_id
            ) {
              return yield* Effect.fail(
                new WebhookIdentityError({
                  message: "Stored webhook organization mismatch",
                }),
              );
            }
            const processed = yield* processAuthenticatedEvent(
              parsed,
              id,
              token,
            );
            yield* Effect.logInfo(
              processed ? "webhook.replayed" : "webhook.replay_superseded",
            ).pipe(Effect.annotateLogs({ deliveryId: id }));
          }).pipe(
            Effect.retry({
              times: 2,
              schedule: Schedule.exponential("25 millis"),
              while: (error) => error._tag === "@Gateway/DatabaseError",
            }),
          );
          yield* replay.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.failCause(cause)
                : Effect.gen(function* () {
                    // Never log schema causes, SQL errors, tokens, or stored payloads.
                    yield* Effect.logWarning("webhook.replay_failed").pipe(
                      Effect.annotateLogs({
                        deliveryId: row.delivery_id,
                        maxAttempts: 3,
                      }),
                    );
                    const id = yield* decodeDeliveryId(row.delivery_id).pipe(
                      Effect.option,
                    );
                    if (Option.isSome(id)) {
                      // Recovery must fail startup if storage cannot make an
                      // abandoned delivery retryable. Request cleanup can defer.
                      yield* acquired
                        ? deliveryRepo.mark(
                            id.value,
                            "failed",
                            "Stored webhook replay failed",
                            token,
                          )
                        : deliveryRepo.failReplayClaim(
                            id.value,
                            row.claim_token,
                          );
                    }
                  }),
            ),
            Effect.ensuring(deliveryRepo.releaseClaim(row.delivery_id, token)),
          );
        }
      });

      const failedCleanup = new Map<DeliveryId, string>();
      const markClaimFailed = (
        id: DeliveryId,
        token: string,
        reason = "Webhook processing interrupted or failed",
      ) =>
        deliveryRepo.mark(id, "failed", reason, token).pipe(
          Effect.tap(() => Effect.sync(() => failedCleanup.delete(id))),
          Effect.catch(() =>
            Effect.gen(function* () {
              failedCleanup.set(id, token);
              yield* Effect.logError("webhook.delivery_cleanup_failed").pipe(
                Effect.annotateLogs({ deliveryId: id }),
              );
            }),
          ),
        );

      const handle = Effect.fn("WebhookPipeline.handle")(function* (
        request: Request,
      ): Effect.fn.Return<Response, never> {
        let deliveryId: DeliveryId | undefined;
        let claimedDelivery = false;
        const claimToken = randomUUID();

        const process: Effect.Effect<Response, WebhookProcessingError, never> =
          Effect.gen(function* () {
            const url = new URL(request.url);

            yield* Effect.annotateCurrentSpan({
              "webhook.path": url.pathname,
              "webhook.method": request.method,
            });

            if (request.method !== "POST") {
              yield* Effect.logWarning("webhook.rejected").pipe(
                Effect.annotateLogs({
                  reason: "method not allowed",
                  method: request.method,
                  path: url.pathname,
                  status: 405,
                }),
              );
              return new Response("Method not allowed", { status: 405 });
            }

            if (
              Number(request.headers.get("content-length")) >
              MAX_WEBHOOK_BODY_BYTES
            )
              return new Response("Payload too large", { status: 413 });
            const rawBody = yield* Effect.tryPromise({
              try: () => readBoundedBody(request, MAX_WEBHOOK_BODY_BYTES),
              catch: (error) =>
                new WebhookPayloadError({
                  message:
                    error instanceof BodyTooLargeError
                      ? "Payload too large"
                      : "Unable to read body",
                  status: error instanceof BodyTooLargeError ? 413 : 400,
                  cause: String(error),
                }),
            });

            const signature = request.headers.get(LINEAR_SIGNATURE_HEADER);
            if (signature === null) {
              yield* Effect.logWarning("webhook.rejected").pipe(
                Effect.annotateLogs({
                  reason: "missing signature",
                  path: url.pathname,
                  status: 400,
                }),
              );
              return new Response("Missing signature", { status: 400 });
            }
            if (
              !verifySignature(rawBody, signature, config.linearWebhookSecret)
            ) {
              yield* Effect.logWarning("webhook.rejected").pipe(
                Effect.annotateLogs({
                  reason: "invalid signature",
                  path: url.pathname,
                  status: 401,
                }),
              );
              return new Response("Invalid signature", { status: 401 });
            }

            const parsed = yield* Effect.try({
              try: () => {
                const value = JSON.parse(new TextDecoder().decode(rawBody));
                return isRecord(value) ? value : null;
              },
              catch: () =>
                new WebhookPayloadError({
                  message: "Invalid JSON",
                  status: 400,
                }),
            });
            if (parsed === null) {
              yield* Effect.logWarning("webhook.rejected").pipe(
                Effect.annotateLogs({
                  reason: "payload is not an object",
                  path: url.pathname,
                  status: 400,
                }),
              );
              return new Response("Payload is not an object", { status: 400 });
            }

            const payloadTimestamp = parsed.webhookTimestamp;
            const timestampHeader = request.headers.get(
              LINEAR_TIMESTAMP_HEADER,
            );
            const timestamp = isNumber(payloadTimestamp)
              ? payloadTimestamp
              : timestampHeader !== null && timestampHeader.length > 0
                ? Number(timestampHeader)
                : NaN;
            if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
              yield* Effect.logWarning("webhook.rejected").pipe(
                Effect.annotateLogs({
                  reason: "invalid timestamp",
                  path: url.pathname,
                  status: 400,
                }),
              );
              return new Response("Invalid timestamp", { status: 400 });
            }

            const receivedAt = yield* Effect.clockWith(
              (clock) => clock.currentTimeMillis,
            );
            if (
              Math.abs(receivedAt - timestamp) > config.webhookReplayWindowMs
            ) {
              yield* Effect.logWarning("webhook.rejected").pipe(
                Effect.annotateLogs({
                  reason: "timestamp outside replay window",
                  path: url.pathname,
                  status: 401,
                  timestamp,
                  receivedAt,
                }),
              );
              return new Response("Webhook timestamp outside replay window", {
                status: 401,
              });
            }

            const organizationId = parsed.organizationId;
            const webhookId = parsed.webhookId;
            const eventType = parsed.type;
            if (
              !isString(organizationId) ||
              !isString(webhookId) ||
              !isString(eventType)
            ) {
              yield* Effect.logWarning("webhook.rejected").pipe(
                Effect.annotateLogs({
                  reason: "missing organizationId, webhookId, or type",
                  path: url.pathname,
                  status: 400,
                }),
              );
              return new Response(
                "Payload missing organizationId, webhookId, or type",
                { status: 400 },
              );
            }

            if (!organizationAllowed(config, organizationId))
              return new Response("Organization is not allowed", {
                status: 403,
              });

            const hash = payloadHash(rawBody);
            const rawDeliveryId =
              request.headers.get(LINEAR_DELIVERY_HEADER) ??
              buildFallbackDeliveryId(parsed, timestamp);
            const decodedDeliveryId = yield* decodeDeliveryId(rawDeliveryId);
            deliveryId = decodedDeliveryId;

            // Normalize webhookTimestamp on the decoded payload so the schema
            // sees a number even when the header was the source.
            parsed.webhookTimestamp = timestamp;

            yield* Effect.logInfo("webhook.received").pipe(
              Effect.annotateLogs({
                deliveryId,
                organizationId,
                webhookId,
                eventType,
                path: url.pathname,
              }),
            );
            yield* Effect.logDebug("webhook.payload").pipe(
              Effect.annotateLogs({
                deliveryId,
                organizationId,
                payload: redactStringValues(parsed),
              }),
            );

            // Retry a failed cleanup on redelivery before consulting the durable
            // dedupe status. Only this process's completed, failed claims enter
            // this map; an actively processing request is never reset here.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const failedToken = failedCleanup.get(decodedDeliveryId);
                if (failedToken !== undefined) {
                  failedCleanup.delete(decodedDeliveryId);
                  yield* deliveryRepo
                    .mark(
                      decodedDeliveryId,
                      "failed",
                      "Retry failed webhook cleanup",
                      failedToken,
                    )
                    .pipe(
                      Effect.onError(() =>
                        Effect.sync(() =>
                          failedCleanup.set(decodedDeliveryId, failedToken),
                        ),
                      ),
                    );
                }
              }),
            );

            // Keep the durable claim and its cleanup ownership hand-off atomic
            // with respect to request-fiber interruption.
            const claim = yield* deliveryRepo
              .claim({
                id: decodedDeliveryId,
                organizationId,
                payloadHash: hash,
                payload: parsed,
                receivedAt,
                claimToken,
                payloadVersion: 1,
              })
              .pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    claimedDelivery = result === "claimed";
                  }),
                ),
                Effect.uninterruptible,
              );
            if (claim === "duplicate") {
              yield* Effect.logInfo("webhook.deduplicated").pipe(
                Effect.annotateLogs({
                  deliveryId,
                  organizationId,
                  eventType,
                }),
              );
              return new Response("Duplicate delivery", { status: 200 });
            }
            if (claim === "conflict") {
              yield* Effect.logWarning("webhook.rejected").pipe(
                Effect.annotateLogs({
                  reason: "delivery id reused with different payload",
                  deliveryId,
                  organizationId,
                  eventType,
                  status: 409,
                }),
              );
              return new Response("Delivery id reused with different payload", {
                status: 409,
              });
            }

            yield* Effect.logInfo("webhook.verified").pipe(
              Effect.annotateLogs({
                deliveryId,
                organizationId,
                eventType,
              }),
            );

            const processed = yield* processAuthenticatedEvent(
              parsed,
              decodedDeliveryId,
              claimToken,
            );
            if (!processed)
              return new Response("Delivery claim superseded", { status: 503 });

            yield* Effect.logInfo("webhook.processed").pipe(
              Effect.annotateLogs({
                deliveryId,
                organizationId,
                eventType,
              }),
            );
            return new Response("OK", { status: 200 });
          });

        return yield* process.pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              deliveryId === undefined
                ? Effect.void
                : deliveryRepo.releaseClaim(deliveryId, claimToken),
            ),
          ),
          Effect.onError((cause) => {
            const failure = Cause.findErrorOption(cause);
            const reason =
              Option.isSome(failure) &&
              (failure.value._tag === "@Gateway/WebhookPayloadError" ||
                failure.value._tag === "@Gateway/WebhookIdentityError")
                ? failure.value.message
                    .replace(
                      /^OAuth client identity mismatch[\s\S]*$/u,
                      "OAuth client identity mismatch",
                    )
                    .replace(
                      /^Invalid (identifier|session id|organization id|input id|app user id|team id|issue id) [\s\S]*$/u,
                      "Invalid $1",
                    )
                    .replace(
                      /^AgentSessionEvent payload is invalid:[\s\S]*$/u,
                      "AgentSessionEvent payload is invalid",
                    )
                : "Webhook processing interrupted or failed";
            return claimedDelivery && deliveryId !== undefined
              ? markClaimFailed(deliveryId, claimToken, reason)
              : Effect.void;
          }),
          Effect.catchTags({
            "@Gateway/WebhookPayloadError": (error) =>
              Effect.succeed(
                new Response(error.message, { status: error.status }),
              ),
            "@Gateway/WebhookIdentityError": (error) =>
              Effect.succeed(new Response(error.message, { status: 401 })),
            "@Gateway/DatabaseError": () =>
              Effect.succeed(
                new Response("Webhook processing failed", { status: 500 }),
              ),
            "@Gateway/RowDecodeError": () =>
              Effect.succeed(
                new Response("Webhook processing failed", { status: 500 }),
              ),
            "@Gateway/TokenCipherError": () =>
              Effect.succeed(
                new Response("Webhook processing failed", { status: 500 }),
              ),
          }),
        );
      });

      return { handle, recoverPendingDeliveries };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide([
      GatewayConfig.layer,
      InstallationRepo.layer,
      RunRepo.layer,
      RunInputRepo.layer,
      DeliveryRepo.layer,
      PromptTemplateRepo.layer,
    ]),
  );
}

export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
