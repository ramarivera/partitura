import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { describe, expect } from "vitest";
import type {
  ActivityId,
  InputId,
  OrganizationId,
  SessionId,
  SourceKey,
} from "../src/domain/ids.js";
import {
  AdminSessionRepo,
  DeliveryRepo,
  InstallationRepo,
  ProjectionRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { SqliteClientLive } from "../src/services/store/sqlite-client.js";
import { TokenCrypto } from "../src/services/token-crypto.js";

const testKeyBase64 = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const configProvider = ConfigProvider.fromUnknown(
  Object.fromEntries(
    new Map([
      ["WORKER_SANDBOX_MODE", "native"],
      ["LINEAR_CLIENT_ID", "test"],
      ["LINEAR_CLIENT_SECRET", "test"],
      ["LINEAR_WEBHOOK_SECRET", "test"],
      ["PUBLIC_URL", "http://localhost:3000"],
      ["TOKEN_ENCRYPTION_KEY", testKeyBase64],
    ]),
  ),
  { preserveEmptyStrings: true },
);

type RepoServices =
  | AdminSessionRepo
  | InstallationRepo
  | DeliveryRepo
  | RunRepo
  | RunInputRepo
  | RunEventRepo
  | ProjectionRepo
  | TokenCrypto;

const withRepos = <A, E>(effect: Effect.Effect<A, E, RepoServices>) =>
  Effect.gen(function* () {
    yield* Effect.scope;
    const sqlite = SqliteClientLive(":memory:");
    const repos = Layer.mergeAll(
      AdminSessionRepo.layer,
      InstallationRepo.layer,
      DeliveryRepo.layer,
      RunRepo.layer,
      RunInputRepo.layer,
      RunEventRepo.layer,
      ProjectionRepo.layer,
      TokenCrypto.layer,
    ).pipe(
      Layer.provide(
        Layer.mergeAll(sqlite, ConfigProvider.layer(configProvider)),
      ),
    );
    return yield* effect.pipe(Effect.provide(repos));
  });

const makeSessionId = (value: string): SessionId => value as SessionId;

const makeOrganizationId = (value: string): OrganizationId =>
  value as OrganizationId;

const makeSourceKey = (value: string): SourceKey => value as SourceKey;
const makeInputId = (value: string): InputId => value as InputId;
const makeActivityId = (value: string): ActivityId => value as ActivityId;

describe("Store repositories", () => {
  it.live("reserves each projection and terminal outcome once", () =>
    withRepos(
      Effect.gen(function* () {
        const runRepo = yield* RunRepo;
        const projectionRepo = yield* ProjectionRepo;

        yield* runRepo.create({
          sessionId: makeSessionId("session-1"),
          organizationId: makeOrganizationId("org-1"),
          issueId: Option.none(),
        });

        const projection = {
          sourceKey: makeSourceKey("event-1"),
          sessionId: makeSessionId("session-1"),
          activityType: "response",
          payloadHash: "hash",
          payload: { body: "done" },
        };

        expect(yield* projectionRepo.enqueue(projection)).toBe(true);
        expect(yield* projectionRepo.enqueue(projection)).toBe(false);

        const job = yield* projectionRepo.claim(
          projection.sourceKey,
          "test-owner",
          60_000,
        );
        expect(job).not.toEqual(Option.none());

        yield* projectionRepo.complete(
          projection.sourceKey,
          "test-owner",
          Option.some(makeActivityId("linear-activity-1")),
        );
        expect(
          yield* projectionRepo.projectionCount(
            makeSessionId("session-1"),
            "response",
          ),
        ).toBe(1);
      }),
    ),
  );

  it.live("persist inputs and projections as chronological run events", () =>
    withRepos(
      Effect.gen(function* () {
        const runRepo = yield* RunRepo;
        const inputRepo = yield* RunInputRepo;
        const projectionRepo = yield* ProjectionRepo;
        const eventRepo = yield* RunEventRepo;

        yield* runRepo.create({
          sessionId: makeSessionId("session-1"),
          organizationId: makeOrganizationId("org-1"),
          issueId: Option.none(),
        });

        yield* inputRepo.enqueue({
          id: makeInputId("input-1"),
          sessionId: makeSessionId("session-1"),
          kind: "created",
          body: "Implement the issue",
          payload: { agentSession: { issue: { teamId: "team" } } },
          createdAt: 1_000,
        });

        yield* projectionRepo.enqueue({
          sourceKey: makeSourceKey("event-1"),
          sessionId: makeSessionId("session-1"),
          activityType: "thought",
          payloadHash: "hash",
          payload: {
            request: { content: { type: "thought", body: "Thinking..." } },
          },
          now: 2_000,
        });

        const events = yield* eventRepo.list(makeSessionId("session-1"));
        expect(events.length).toBe(2);
        expect(events[0]).toMatchObject({
          sourceKey: makeSourceKey("input:input-1"),
          sessionId: makeSessionId("session-1"),
          kind: "input:created",
          level: "info",
          text: Option.some("Implement the issue"),
          status: Option.none(),
          createdAt: 1_000,
        });
        expect(events[1]).toMatchObject({
          sourceKey: makeSourceKey("event-1"),
          sessionId: makeSessionId("session-1"),
          kind: "thought",
          level: "debug",
          text: Option.some("Thinking..."),
          status: Option.some("pending"),
          createdAt: 2_000,
        });
      }),
    ),
  );

  it.live("records state transitions with a stable source key", () =>
    withRepos(
      Effect.gen(function* () {
        const runRepo = yield* RunRepo;
        const eventRepo = yield* RunEventRepo;

        yield* runRepo.create({
          sessionId: makeSessionId("session-transition"),
          organizationId: makeOrganizationId("org-1"),
          issueId: Option.none(),
        });
        yield* runRepo.update(makeSessionId("session-transition"), {
          state: "failed",
          terminalReason: Option.some("Worker exited"),
        });

        const events = yield* eventRepo.list(
          makeSessionId("session-transition"),
        );
        const transition = events.find((event) => event.kind === "state");
        expect(transition).toMatchObject({
          sourceKey: makeSourceKey("state:session-transition:0:failed"),
          level: "error",
          text: Option.some("queued → failed"),
          status: Option.some("observed"),
          error: Option.some("Worker exited"),
        });
      }),
    ),
  );

  it.live(
    "deduplicates run events by source key and preserves created at",
    () =>
      withRepos(
        Effect.gen(function* () {
          const runRepo = yield* RunRepo;
          const eventRepo = yield* RunEventRepo;

          yield* runRepo.create({
            sessionId: makeSessionId("session-1"),
            organizationId: makeOrganizationId("org-1"),
            issueId: Option.none(),
          });

          yield* eventRepo.upsert({
            sourceKey: makeSourceKey("rpc:session-1:1:agent_start"),
            sessionId: makeSessionId("session-1"),
            kind: "agent_start",
            level: "info",
            text: "Worker started",
            payload: { type: "agent_start" },
            status: "observed",
            now: 1_000,
          });
          yield* eventRepo.upsert({
            sourceKey: makeSourceKey("rpc:session-1:1:agent_start"),
            sessionId: makeSessionId("session-1"),
            kind: "thought",
            level: "debug",
            text: "Worker started",
            payload: {
              request: { content: { type: "thought", body: "Worker started" } },
            },
            status: "pending",
            now: 2_000,
          });

          const events = yield* eventRepo.list(makeSessionId("session-1"));
          expect(events.length).toBe(1);
          expect(events[0]).toMatchObject({
            sourceKey: makeSourceKey("rpc:session-1:1:agent_start"),
            kind: "thought",
            level: "debug",
            status: Option.some("pending"),
            createdAt: 1_000,
            updatedAt: 2_000,
          });
        }),
      ),
  );

  it.live(
    "reads one event by source key and seeds RPC sequence numerically within a session",
    () =>
      withRepos(
        Effect.gen(function* () {
          const sid = makeSessionId("targeted-events-🚀");
          const other = makeSessionId("targeted-events-other");
          for (const sessionId of [sid, other])
            yield* RunRepo.use((service) =>
              service.create({
                sessionId,
                organizationId: makeOrganizationId("org-1"),
                issueId: Option.none(),
              }),
            );
          expect(
            yield* RunEventRepo.use((service) => service.maxRpcSequence(sid)),
          ).toBe(0);
          const key = makeSourceKey(`retry:${sid}:3`);
          yield* RunEventRepo.use((service) =>
            service.upsert({
              sourceKey: key,
              sessionId: sid,
              kind: "retry",
              level: "info",
              payload: { nextAttemptAt: 900, scheduledAt: 500 },
            }),
          );
          const event = Option.getOrThrow(
            yield* RunEventRepo.use((service) => service.getBySourceKey(key)),
          );
          expect(event.sourceKey).toBe(key);
          expect(event.payload).toEqual({
            nextAttemptAt: 900,
            scheduledAt: 500,
          });
          expect(
            yield* RunEventRepo.use((service) =>
              service.getBySourceKey(makeSourceKey("absent")),
            ),
          ).toEqual(Option.none());
          for (const sourceKey of [
            `rpc:${sid}:2:progress`,
            `rpc:${sid}:10:progress`,
            `rpc:${sid}:9:progress`,
            `rpc:${sid}:99garbage:progress`,
            `rpc:${sid}:9007199254740992:progress`,
            `rpc:${sid}:500`,
            `rpc:${sid}:1e4:progress`,
            `rpc:${sid}extra:1000:progress`,
          ])
            yield* RunEventRepo.use((service) =>
              service.upsert({
                sourceKey: makeSourceKey(sourceKey),
                sessionId: sid,
                kind: "progress",
                level: "info",
              }),
            );
          yield* RunEventRepo.use((service) =>
            service.upsert({
              sourceKey: makeSourceKey(`rpc:${other}:2000:progress`),
              sessionId: other,
              kind: "progress",
              level: "info",
            }),
          );
          expect(
            yield* RunEventRepo.use((service) => service.maxRpcSequence(sid)),
          ).toBe(10);
          expect(
            yield* RunEventRepo.use((service) => service.maxRpcSequence(other)),
          ).toBe(2000);
        }),
      ),
  );

  it.live("tracks projection lifecycle status and errors", () =>
    withRepos(
      Effect.gen(function* () {
        const runRepo = yield* RunRepo;
        const projectionRepo = yield* ProjectionRepo;
        const eventRepo = yield* RunEventRepo;

        yield* runRepo.create({
          sessionId: makeSessionId("session-1"),
          organizationId: makeOrganizationId("org-1"),
          issueId: Option.none(),
        });

        yield* projectionRepo.enqueue({
          sourceKey: makeSourceKey("event-1"),
          sessionId: makeSessionId("session-1"),
          activityType: "action",
          payloadHash: "hash",
          payload: {
            request: {
              content: {
                type: "action",
                action: "git",
                parameter: "status",
              },
            },
          },
        });
        const events1 = yield* eventRepo.list(makeSessionId("session-1"));
        expect(events1[0]?.status).toEqual(Option.some("pending"));

        const job = yield* projectionRepo.claim(
          makeSourceKey("event-1"),
          "owner",
          60_000,
        );
        expect(job).not.toEqual(Option.none());
        const events2 = yield* eventRepo.list(makeSessionId("session-1"));
        expect(events2[0]?.status).toEqual(Option.some("pending"));

        yield* projectionRepo.complete(
          makeSourceKey("event-1"),
          "owner",
          Option.some(makeActivityId("linear-1")),
        );
        const events3 = yield* eventRepo.list(makeSessionId("session-1"));
        const event1 = events3[0];
        expect(event1?.status).toEqual(Option.some("completed"));
        expect(event1?.error).toEqual(Option.none());

        yield* projectionRepo.enqueue({
          sourceKey: makeSourceKey("event-2"),
          sessionId: makeSessionId("session-1"),
          activityType: "response",
          payloadHash: "hash",
          payload: { request: { content: { type: "response", body: "Done" } } },
        });
        yield* projectionRepo.claim(makeSourceKey("event-2"), "owner", 60_000);
        yield* projectionRepo.fail(
          makeSourceKey("event-2"),
          "owner",
          "Linear API error",
          0,
        );

        const events4 = yield* eventRepo.list(makeSessionId("session-1"));
        const event2 = events4.find(
          (e) => e.sourceKey === makeSourceKey("event-2"),
        );
        expect(event2?.status).toEqual(Option.some("failed"));
        expect(event2?.error).toEqual(Option.some("Linear API error"));
      }),
    ),
  );

  it.live("does not overwrite completed run events on re-enqueue", () =>
    withRepos(
      Effect.gen(function* () {
        const runRepo = yield* RunRepo;
        const projectionRepo = yield* ProjectionRepo;
        const eventRepo = yield* RunEventRepo;

        yield* runRepo.create({
          sessionId: makeSessionId("session-1"),
          organizationId: makeOrganizationId("org-1"),
          issueId: Option.none(),
        });

        yield* projectionRepo.enqueue({
          sourceKey: makeSourceKey("terminal:session-1:stop"),
          sessionId: makeSessionId("session-1"),
          activityType: "response",
          payloadHash: "first-hash",
          payload: {
            request: {
              content: { type: "response", body: "Stopped as requested." },
            },
          },
          now: 1_000,
        });
        yield* projectionRepo.claim(
          makeSourceKey("terminal:session-1:stop"),
          "owner",
          60_000,
          1_000,
        );
        yield* projectionRepo.complete(
          makeSourceKey("terminal:session-1:stop"),
          "owner",
          Option.some(makeActivityId("linear-1")),
        );

        const requeued = yield* projectionRepo.enqueue({
          sourceKey: makeSourceKey("terminal:session-1:stop"),
          sessionId: makeSessionId("session-1"),
          activityType: "response",
          payloadHash: "other-hash",
          payload: {
            request: { content: { type: "response", body: "Other" } },
          },
          firstWriteWins: true,
          now: 2_000,
        });
        expect(requeued).toBe(false);

        const events = yield* eventRepo.list(makeSessionId("session-1"));
        const event = events[0];
        expect(event?.text).toEqual(Option.some("Stopped as requested."));
        expect(event?.status).toEqual(Option.some("completed"));
        expect(event?.createdAt).toBe(1_000);
        expect(event?.updatedAt).toBeGreaterThanOrEqual(2_000);
      }),
    ),
  );
});
