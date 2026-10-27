import { Writable } from "node:stream";
import { it } from "@effect/vitest";
import { Effect, Logger, Option } from "effect";
import pino from "pino";
import { describe, expect } from "vitest";
import { makePinoEffectLogger } from "../src/services/logger.js";
import {
  PromptTemplateRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { WebhookPipeline } from "../src/services/webhook.js";

import {
  agentSessionBase,
  appUserNotificationPayload,
  createdPayload,
  currentTime,
  expectSome,
  install,
  issueId,
  organizationId,
  projectId,
  promptedPayload,
  sessionId,
  sign,
  signedRequest,
  stopPayload,
  teamId,
  withWebhook,
} from "./webhook-fixtures.js";

describe("WebhookPipeline Pino lifecycle logs", () => {
  it.live(
    "emits correlated success and controlled-rejection logs through the gateway graph",
    () => {
      const chunks: string[] = [];
      const stream = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk.toString());
          callback();
        },
      });
      const pinoLoggerLive = Logger.layer([
        makePinoEffectLogger(pino({ base: null, level: "info" }, stream)),
      ]);

      return withWebhook(
        Effect.gen(function* () {
          const now = yield* currentTime;
          yield* install();
          const accepted = yield* WebhookPipeline.use((service) =>
            service.handle(signedRequest(createdPayload(now))),
          );
          const rejected = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(createdPayload(now), { method: "GET" }),
            ),
          );
          expect(accepted.status).toBe(200);
          expect(rejected.status).toBe(405);

          const lines = chunks.map(
            (chunk) => JSON.parse(chunk) as Record<string, unknown>,
          );
          const success = lines.find(
            (line) => line.msg === "webhook.processed",
          );
          const failure = lines.find(
            (line) =>
              line.msg === "webhook.rejected" &&
              line.reason === "method not allowed",
          );
          expect(success).toMatchObject({
            level: 30,
            span_name: "WebhookPipeline.handle",
          });
          expect(failure).toMatchObject({
            level: 40,
            span_name: "WebhookPipeline.handle",
            reason: "method not allowed",
          });
          expect(typeof success?.trace_id).toBe("string");
          expect(typeof failure?.trace_id).toBe("string");
        }),
      ).pipe(Effect.provide(pinoLoggerLive));
    },
  );
});

describe("Linear webhook input correctness", () => {
  it.live("created event is durably stored and acknowledged", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(createdPayload(now))),
        );

        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.text())).toBe("OK");
        const run = expectSome(
          yield* RunRepo.use((service) => service.get(sessionId("session-1"))),
        );
        expect(run).toMatchObject({
          organizationId: organizationId("org"),
          issueId: Option.some(issueId("issue-1")),
          teamId: Option.some(teamId("team-a")),
          projectId: Option.some(projectId("project-1")),
          desiredState: "running",
        });
        const inputs = yield* RunInputRepo.use((service) =>
          service.pending(sessionId("session-1")),
        );
        expect(inputs).toHaveLength(1);
        expect(inputs[0]).toMatchObject({
          id: "session-1:created",
          kind: "created",
        });
        const body = inputs[0]?.body ?? "";
        for (const text of [
          "User request:",
          "Implement the issue",
          "Fix the bug",
          "TEAM-123",
          "The bug description",
          "A thread comment",
          "Earlier comment",
          "Guidance:",
          "Use TypeScript",
          "Write tests",
        ]) {
          expect(body).toContain(text);
        }
      }),
    ),
  );

  it.live(
    "created input uses structured context and guidance, not tracker text as policy",
    () =>
      withWebhook(
        Effect.gen(function* () {
          const now = yield* currentTime;
          yield* install();
          const response = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(
                createdPayload(now, {
                  promptContext: "Please resolve this",
                  guidance: [{ body: "Use idiomatic TypeScript" }],
                }),
              ),
            ),
          );

          expect(response.status).toBe(200);
          const [input] = yield* RunInputRepo.use((service) =>
            service.pending(sessionId("session-1")),
          );
          const body = input?.body ?? "";
          expect(body.startsWith("User request:\nPlease resolve this")).toBe(
            true,
          );
          expect(body).toContain("Issue context:");
          expect(body).toContain("Guidance:");
          expect(body).toContain("Use idiomatic TypeScript");
          expect(body.indexOf("Guidance:")).toBeGreaterThan(
            body.indexOf("Issue context:"),
          );
        }),
      ),
  );

  it.live("created handles nullable fields and falls back to summary", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(
            signedRequest(
              createdPayload(now, {
                promptContext: null,
                guidance: null,
                previousComments: null,
                agentSession: agentSessionBase({
                  summary: "Summary of direct chat",
                  issueId: null,
                  issue: null,
                  comment: null,
                }),
              }),
            ),
          ),
        );

        expect(response.status).toBe(200);
        const run = expectSome(
          yield* RunRepo.use((service) => service.get(sessionId("session-1"))),
        );
        expect(run).toMatchObject({
          issueId: Option.none(),
          teamId: Option.none(),
          projectId: Option.none(),
        });
        const [input] = yield* RunInputRepo.use((service) =>
          service.pending(sessionId("session-1")),
        );
        expect(input).toMatchObject({
          kind: "created",
          body: "User request:\nSummary of direct chat",
        });
      }),
    ),
  );

  it.live(
    "accepts real Linear AgentSessionEvent created payload with null guidance and no agentSession.type",
    () =>
      withWebhook(
        Effect.gen(function* () {
          const now = yield* currentTime;
          yield* install();
          const response = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(
                createdPayload(now, {
                  webhookId: "webhook-uuid",
                  createdAt: "2024-01-01T00:00:00.000Z",
                  guidance: null,
                  previousComments: [
                    {
                      id: "prev-1",
                      body: "Earlier comment",
                      userId: "user-1",
                      issueId: "issue-1",
                    },
                  ],
                  agentSession: agentSessionBase({
                    commentId: "comment-1",
                    sourceCommentId: null,
                    issueId: "issue-1",
                    pullRequestId: null,
                    slugId: "slug-1",
                    archivedAt: null,
                    startedAt: null,
                    endedAt: null,
                    dismissedAt: null,
                    dismissedById: null,
                    externalLink: null,
                    summary: null,
                    url: "https://linear.app/issue/TEAM-123/session-1",
                    externalUrls: [],
                    context: [],
                    sourceMetadata: { source: "linear" },
                    plan: null,
                    workspaceDiff: null,
                    creatorId: "user-1",
                    creator: {
                      id: "user-1",
                      name: "Test User",
                      email: "test@example.com",
                      avatarUrl: "https://example.com/avatar.png",
                      url: "https://linear.app/user/user-1",
                    },
                    comment: {
                      id: "comment-1",
                      body: "A thread comment",
                      userId: "user-1",
                      issueId: "issue-1",
                    },
                    issue: {
                      id: "issue-1",
                      title: "Fix the bug",
                      description: "The bug description",
                      identifier: "TEAM-123",
                      url: "https://linear.app/issue/TEAM-123",
                      teamId: "team-a",
                      team: { id: "team-a" },
                    },
                  }),
                }),
              ),
            ),
          );

          expect(response.status).toBe(200);
          const run = expectSome(
            yield* RunRepo.use((service) =>
              service.get(sessionId("session-1")),
            ),
          );
          expect(run).toMatchObject({
            organizationId: organizationId("org"),
            issueId: Option.some(issueId("issue-1")),
            teamId: Option.some(teamId("team-a")),
          });
          const [input] = yield* RunInputRepo.use((service) =>
            service.pending(sessionId("session-1")),
          );
          expect(input?.kind).toBe("created");
          expect(input?.body).not.toContain("Guidance:");
        }),
      ),
  );

  it.live("prompted event appends agent activity body", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        expect(
          (yield* WebhookPipeline.use((service) =>
            service.handle(signedRequest(createdPayload(now))),
          )).status,
        ).toBe(200);
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(promptedPayload(now))),
        );

        expect(response.status).toBe(200);
        const inputs = yield* RunInputRepo.use((service) =>
          service.pending(sessionId("session-1")),
        );
        expect(inputs).toHaveLength(2);
        expect(inputs.find((input) => input.kind === "prompted")).toMatchObject(
          {
            id: "session-1:prompted:activity-prompt-1",
            body: expect.stringContaining("# Follow-up prompt"),
          },
        );
        expect(
          inputs.find((input) => input.kind === "prompted")?.body,
        ).toContain("Please add more tests");
      }),
    ),
  );
  it.live("prompted inputs store the raw activity body", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        yield* PromptTemplateRepo.use((service) =>
          service.upsert({
            organizationId: organizationId("org"),
            kind: "prompted",
            body: "Follow-up:\n{{userRequest}}",
            updatedAt: now,
          }),
        );
        yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(createdPayload(now))),
        );
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(
            signedRequest(
              promptedPayload(now, { webhookId: "prompt-template" }),
            ),
          ),
        );
        expect(response.status).toBe(200);
        const inputs = yield* RunInputRepo.use((service) =>
          service.pending(sessionId("session-1")),
        );
        // Raw body is stored even with a template configured: rendering
        // happens at prompt construction so repository selection and UI
        // answers see the user's literal text.
        expect(inputs.find((input) => input.kind === "prompted")?.body).toBe(
          "# Follow-up prompt\n\nPlease add more tests",
        );
      }),
    ),
  );

  it.live("prompted with stop signal cancels the run", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const payload = promptedPayload(now, {
          agentActivity: {
            id: "activity-prompt-stop",
            agentSessionId: "session-1",
            content: { type: "prompt", body: "Never mind" },
            signal: "stop",
          },
        });
        yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(createdPayload(now))),
        );
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(payload)),
        );

        expect(response.status).toBe(200);
        const inputs = yield* RunInputRepo.use((service) =>
          service.pending(sessionId("session-1")),
        );
        expect(inputs.find((input) => input.kind === "stop")).toBeDefined();
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

  it.live("stop action cancels the run", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(createdPayload(now))),
        );
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(stopPayload(now))),
        );

        expect(response.status).toBe(200);
        expect(
          expectSome(
            yield* RunRepo.use((service) =>
              service.get(sessionId("session-1")),
            ),
          )?.desiredState,
        ).toBe("canceled");
        const inputs = yield* RunInputRepo.use((service) =>
          service.pending(sessionId("session-1")),
        );
        expect(inputs).toHaveLength(2);
        expect(inputs[1]).toMatchObject({ kind: "stop", body: "Stop" });
      }),
    ),
  );

  it.live("prompted events after stop are accepted for resume", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(createdPayload(now))),
        );
        yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(stopPayload(now))),
        );
        const response = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(promptedPayload(now))),
        );

        // The prompt is enqueued alongside the stop; the session authority
        // decides between honoring the cancellation and resuming the run.
        expect(response.status).toBe(200);
        expect(
          yield* RunInputRepo.use((service) =>
            service.pending(sessionId("session-1")),
          ),
        ).toHaveLength(3);
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

  it.live(
    "AppUserNotification unassignment stops every non-terminal issue run idempotently",
    () =>
      withWebhook(
        Effect.gen(function* () {
          const now = yield* currentTime;
          yield* install();
          for (const id of ["session-a", "session-b", "session-terminal"]) {
            yield* RunRepo.use((service) =>
              service.create({
                sessionId: sessionId(id),
                organizationId: organizationId("org"),
                issueId: Option.some(issueId("issue-1")),
                now,
              }),
            );
          }
          yield* RunRepo.use((service) =>
            service.update(sessionId("session-terminal"), {
              state: "succeeded",
            }),
          );
          const payload = appUserNotificationPayload(
            now,
            "issueUnassignedFromYou",
          );
          const first = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(payload, { delivery: "notification-delivery-1" }),
            ),
          );
          const second = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(payload, { delivery: "notification-delivery-2" }),
            ),
          );

          expect(first.status).toBe(200);
          expect(second.status).toBe(200);
          for (const id of ["session-a", "session-b"]) {
            expect(
              expectSome(
                yield* RunRepo.use((service) => service.get(sessionId(id))),
              )?.desiredState,
            ).toBe("canceled");
            const inputs = yield* RunInputRepo.use((service) =>
              service.pending(sessionId(id)),
            );
            expect(inputs).toHaveLength(1);
            expect(inputs[0]).toMatchObject({
              id: `${id}:stop:notification-1`,
              kind: "stop",
            });
          }
          expect(
            expectSome(
              yield* RunRepo.use((service) =>
                service.get(sessionId("session-terminal")),
              ),
            )?.desiredState,
          ).toBe("running");
          expect(
            yield* RunInputRepo.use((service) =>
              service.pending(sessionId("session-terminal")),
            ),
          ).toHaveLength(0);
        }),
      ),
  );

  it.live(
    "AppUserNotification status changes enqueue a deferred stop and ignore non-cancel actions",
    () =>
      withWebhook(
        Effect.gen(function* () {
          const now = yield* currentTime;
          yield* install();
          yield* RunRepo.use((service) =>
            service.create({
              sessionId: sessionId("session-a"),
              organizationId: organizationId("org"),
              issueId: Option.some(issueId("issue-1")),
              now,
            }),
          );
          const status = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(
                appUserNotificationPayload(now, "issueStatusChanged"),
              ),
            ),
          );
          expect(status.status).toBe(200);
          expect(
            expectSome(
              yield* RunRepo.use((service) =>
                service.get(sessionId("session-a")),
              ),
            )?.desiredState,
          ).toBe("running");
          const inputs = yield* RunInputRepo.use((service) =>
            service.pending(sessionId("session-a")),
          );
          expect(inputs).toHaveLength(1);
          expect(inputs[0]?.payload).toMatchObject({
            type: "AppUserNotification",
            action: "issueStatusChanged",
            notification: { issueId: "issue-1" },
          });

          const ignored = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(
                appUserNotificationPayload(now, "issueCommentMention", {
                  webhookId: "notification-webhook-ignored",
                }),
              ),
            ),
          );
          expect(ignored.status).toBe(200);
          expect(
            yield* RunInputRepo.use((service) =>
              service.pending(sessionId("session-a")),
            ),
          ).toHaveLength(1);
        }),
      ),
  );

  it.live("dedupes by Linear-Delivery id", () =>
    withWebhook(
      Effect.gen(function* () {
        const now = yield* currentTime;
        yield* install();
        const payload = createdPayload(now);
        const response1 = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(payload, { delivery: "d1" })),
        );
        const response2 = yield* WebhookPipeline.use((service) =>
          service.handle(signedRequest(payload, { delivery: "d1" })),
        );

        expect(response1.status).toBe(200);
        expect(response2.status).toBe(200);
        expect(yield* Effect.promise(() => response2.text())).toBe(
          "Duplicate delivery",
        );
        expect(
          yield* RunInputRepo.use((service) =>
            service.pending(sessionId("session-1")),
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.live(
    "dedupes logical input on replay with a different Linear-Delivery id",
    () =>
      withWebhook(
        Effect.gen(function* () {
          const now = yield* currentTime;
          yield* install();
          const payload = createdPayload(now);
          const body = JSON.stringify(payload);
          const signature = sign(body);
          const response1 = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(payload, { delivery: "d1", body, signature }),
            ),
          );
          const response2 = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(payload, { delivery: "d2", body, signature }),
            ),
          );

          expect(response1.status).toBe(200);
          expect(response2.status).toBe(200);
          expect(
            yield* RunInputRepo.use((service) =>
              service.pending(sessionId("session-1")),
            ),
          ).toHaveLength(1);
        }),
      ),
  );
});
