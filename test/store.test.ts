import { Database } from "bun:sqlite";
import { it } from "@effect/vitest";
import {
  Clock,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
} from "effect";
import { describe, expect } from "vitest";
import type {
  AppUserId,
  DeliveryId,
  InputId,
  OrganizationId,
  SessionId,
} from "../src/domain/ids.js";
import type { Installation } from "../src/domain/models.js";
import {
  AdminSessionRepo,
  DeliveryRepo,
  InstallationRepo,
  ProjectionRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import {
  SqliteClientLive,
  transact,
} from "../src/services/store/sqlite-client.js";
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
const makeDeliveryId = (value: string): DeliveryId => value as DeliveryId;
const makeOrganizationId = (value: string): OrganizationId =>
  value as OrganizationId;

const makeAppUserId = (value: string): AppUserId => value as AppUserId;

const makeInputId = (value: string): InputId => value as InputId;

const makeInstallation = (
  overrides: Partial<Installation> = {},
): Installation => ({
  organizationId: makeOrganizationId("org-1"),
  appUserId: makeAppUserId("app-user-1"),
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiresAt: 1_000_000,
  scopes: ["read", "write"],
  revokedAt: Option.none(),
  accessibleTeamIds: Option.none(),
  canAccessAllPublicTeams: Option.none(),
  ...overrides,
});

describe("SQLite transactions", () => {
  it.live("rolls back when the transaction fiber is interrupted", () =>
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new Database(":memory:")),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => db.exec("CREATE TABLE item (value TEXT)"));
      const entered = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        transact(
          db,
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        ),
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);

      yield* transact(
        db,
        Effect.sync(() => db.exec("INSERT INTO item VALUES ('usable')")),
      );
      const row = db.query("SELECT COUNT(*) AS count FROM item").get() as {
        count: number;
      };
      expect(row.count).toBe(1);
    }),
  );
});

it("rolls back after a commit failure so the next write can proceed", async () => {
  const statements: string[] = [];
  let failCommit = true;
  const db = {
    exec: (statement: string) => {
      statements.push(statement);
      if (statement === "COMMIT" && failCommit) {
        failCommit = false;
        throw new Error("busy");
      }
    },
  } as unknown as Database;

  const first = await Effect.runPromiseExit(
    transact(db, Effect.succeed("first")),
  );
  expect(Exit.isFailure(first)).toBe(true);
  await Effect.runPromise(transact(db, Effect.succeed("second")));
  expect(statements).toEqual([
    "BEGIN IMMEDIATE",
    "COMMIT",
    "ROLLBACK",
    "BEGIN IMMEDIATE",
    "COMMIT",
  ]);
});

describe("Store repositories", () => {
  it.live("encrypts tokens at rest and round-trips installations", () =>
    withRepos(
      Effect.gen(function* () {
        const repo = yield* InstallationRepo;
        const expected = makeInstallation();
        yield* repo.put(expected);

        const raw = yield* repo.getRawEncryptedAccessToken(
          expected.organizationId,
        );
        if (Option.isSome(raw)) {
          expect(raw.value).not.toContain("access-secret");
        }

        const actual = yield* repo.get(expected.organizationId);
        expect(actual).toEqual(Option.some(expected));
      }),
    ),
  );

  it.live("consumes OAuth state exactly once before expiry", () =>
    withRepos(
      Effect.gen(function* () {
        const repo = yield* InstallationRepo;
        yield* repo.createOAuthState("hash", 2_000, 1_000);
        expect(yield* repo.consumeOAuthState("hash", 1_500)).toBe(true);
        expect(yield* repo.consumeOAuthState("hash", 1_600)).toBe(false);
        yield* repo.createOAuthState("expired", 2_000, 1_000);
        expect(yield* repo.consumeOAuthState("expired", 2_001)).toBe(false);
      }),
    ),
  );

  it.live("deduplicates webhook delivery IDs", () =>
    withRepos(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepo;
        const delivery = {
          id: makeDeliveryId("delivery-1"),
          organizationId: makeOrganizationId("org-1"),
          payloadHash: "hash",
          payload: { type: "AgentSessionEvent" },
        };
        expect(yield* repo.accept(delivery)).toBe(true);
        expect(yield* repo.accept(delivery)).toBe(false);
      }),
    ),
  );

  it.live("reclaims a delivery interrupted before durable processing", () =>
    withRepos(
      Effect.gen(function* () {
        const repo = yield* DeliveryRepo;
        const delivery = {
          id: makeDeliveryId("delivery-1"),
          organizationId: makeOrganizationId("org-1"),
          payloadHash: "hash",
          payload: { type: "AgentSessionEvent" },
        };
        expect(yield* repo.claim(delivery)).toBe("claimed");
        expect(yield* repo.claim(delivery)).toBe("duplicate");
        expect(yield* repo.recoverPendingDeliveries()).toBe(1);
        expect(yield* repo.claim(delivery)).toBe("claimed");
      }),
    ),
  );

  it.live("enforces one lease and permits takeover only after expiry", () =>
    withRepos(
      Effect.gen(function* () {
        const repo = yield* RunRepo;
        yield* repo.create({
          sessionId: makeSessionId("session-1"),
          organizationId: makeOrganizationId("org-1"),
          issueId: Option.none(),
          now: 1_000,
        });
        expect(
          yield* repo.claimLease(
            makeSessionId("session-1"),
            "worker-a",
            1_000,
            1_000,
          ),
        ).toBe(true);
        expect(
          yield* repo.claimLease(
            makeSessionId("session-1"),
            "worker-b",
            1_000,
            1_500,
          ),
        ).toBe(false);
        expect(
          yield* repo.claimLease(
            makeSessionId("session-1"),
            "worker-b",
            1_000,
            2_001,
          ),
        ).toBe(true);
      }),
    ),
  );
  it.live(
    "catch-up candidates include live runs despite leases and retry delays",
    () =>
      withRepos(
        Effect.gen(function* () {
          const repo = yield* RunRepo;
          const sessionId = makeSessionId("catchup-leased");
          yield* repo.create({
            sessionId,
            organizationId: makeOrganizationId("org-1"),
            issueId: Option.none(),
            now: 1_000,
          });
          yield* repo.update(sessionId, {
            state: "running",
            nextAttemptAt: Option.some(9_000),
          });
          expect(
            yield* repo.claimLease(sessionId, "worker-a", 60_000, 1_000),
          ).toBe(true);

          const candidates = yield* repo.listCatchupCandidates(2_000);
          expect(candidates.map((run) => run.sessionId)).toEqual([sessionId]);
        }),
      ),
  );
  it.live("keeps canceled catch-up candidates for seven days", () =>
    withRepos(
      Effect.gen(function* () {
        const repo = yield* RunRepo;
        const sessionId = makeSessionId("catchup-canceled");
        yield* repo.create({
          sessionId,
          organizationId: makeOrganizationId("org-1"),
          issueId: Option.none(),
          now: 0,
        });
        yield* repo.update(sessionId, { state: "canceled" });
        const updatedAt = yield* Clock.currentTimeMillis;
        const sixDays = 6 * 24 * 60 * 60_000;
        const eightDays = 8 * 24 * 60 * 60_000;
        expect(
          (yield* repo.listCatchupCandidates(updatedAt + sixDays)).some(
            (run) => run.sessionId === sessionId,
          ),
        ).toBe(true);
        expect(
          (yield* repo.listCatchupCandidates(updatedAt + eightDays)).some(
            (run) => run.sessionId === sessionId,
          ),
        ).toBe(false);
      }),
    ),
  );

  it.live("startup preserves another gateway's live lease", () =>
    withRepos(
      Effect.gen(function* () {
        const repo = yield* RunRepo;
        const sid = makeSessionId("live-gateway");
        yield* repo.create({
          sessionId: sid,
          organizationId: makeOrganizationId("org"),
          issueId: Option.none(),
          now: 1000,
        });
        yield* repo.update(sid, { state: "starting" });
        yield* repo.claimLease(sid, "live-owner", 60000, 1000);
        expect(yield* repo.recoverInterruptedRuns(2000)).toBe(0);
        const preserved = Option.getOrThrow(yield* repo.get(sid));
        expect(preserved.state).toBe("starting");
        expect(preserved.leaseOwner).toEqual(Option.some("live-owner"));
        expect(yield* repo.claimLease(sid, "new-owner", 60000, 2000)).toBe(
          false,
        );
        expect(yield* repo.recoverInterruptedRuns(61001)).toBe(1);
        expect(yield* repo.claimLease(sid, "new-owner", 60000, 61001)).toBe(
          true,
        );
      }),
    ),
  );

  it.live(
    "only schedules canceled sessions for prompts received after stop",
    () =>
      withRepos(
        Effect.gen(function* () {
          const runs = yield* RunRepo;
          const inputs = yield* RunInputRepo;
          const sessionId = makeSessionId("stopped-scheduler");
          yield* runs.create({
            sessionId,
            organizationId: makeOrganizationId("org-1"),
            issueId: Option.none(),
          });
          for (const [id, kind] of [
            ["old-prompt", "prompted"],
            ["stop", "stop"],
          ] as const) {
            yield* inputs.enqueue({
              id: makeInputId(id),
              sessionId,
              kind,
              body: id,
              payload: {},
              createdAt: 100,
            });
          }
          yield* runs.update(sessionId, { state: "canceled" });
          yield* inputs.markProcessed(makeInputId("stop"));
          expect(yield* inputs.listSessionsWithPendingInputs()).toEqual([]);
          yield* inputs.enqueue({
            id: makeInputId("new-prompt"),
            sessionId,
            kind: "prompted",
            body: "continue",
            payload: {},
            createdAt: 100,
          });
          expect(yield* inputs.listSessionsWithPendingInputs()).toEqual([
            sessionId,
          ]);
          expect(
            (yield* inputs.pending(sessionId)).map((input) => input.id),
          ).toEqual([makeInputId("old-prompt"), makeInputId("new-prompt")]);
          expect(yield* inputs.latestActionableInput(sessionId)).toMatchObject(
            Option.some({ id: makeInputId("new-prompt") }),
          );
          yield* inputs.markProcessed(makeInputId("new-prompt"));
          expect(yield* inputs.listSessionsWithPendingInputs()).toEqual([]);
          const revoked = makeSessionId("access-revoked");
          yield* runs.create({
            sessionId: revoked,
            organizationId: makeOrganizationId("org-1"),
            issueId: Option.none(),
          });
          yield* inputs.enqueue({
            id: makeInputId("revoked-prompt"),
            sessionId: revoked,
            kind: "prompted",
            body: "continue",
            payload: {},
          });
          yield* runs.update(revoked, { state: "canceled" });
          expect(yield* inputs.listSessionsWithPendingInputs()).toEqual([]);
        }),
      ),
  );

  it.live(
    "ignores historical catch-up prompts across cancellation without dropping fresh follow-ups",
    () =>
      withRepos(
        Effect.gen(function* () {
          const runs = yield* RunRepo;
          const inputs = yield* RunInputRepo;
          const sessionId = makeSessionId("historical-catchup");
          yield* runs.create({
            sessionId,
            organizationId: makeOrganizationId("org-1"),
            issueId: Option.none(),
          });
          yield* inputs.enqueue({
            id: makeInputId("stop-catchup"),
            sessionId,
            kind: "stop",
            body: "stop",
            payload: {},
            createdAt: 100,
          });
          const recover = (id: string, createdAt: number) =>
            inputs.enqueue({
              id: makeInputId(id),
              sessionId,
              kind: "prompted",
              body: "continue",
              payload: { source: "reconciler.catchup" },
              createdAt,
            });
          // Protect the interval between accepting a stop and completing cleanup.
          expect(yield* recover("before-stop", 99)).toBe(false);
          expect(yield* recover("at-stop", 100)).toBe(false);
          yield* runs.update(sessionId, { state: "canceled" });
          expect(yield* recover("late-original-delegation", 99)).toBe(false);
          expect(yield* recover("at-cancellation", 100)).toBe(false);
          expect(yield* recover("fresh-resume", 101)).toBe(true);
          // A live webhook keeps its arrival-order semantics, even at equal timestamps.
          expect(
            yield* inputs.enqueue({
              id: makeInputId("live-followup"),
              sessionId,
              kind: "prompted",
              body: "continue",
              payload: {},
              createdAt: 100,
            }),
          ).toBe(true);
          expect(
            (yield* inputs.pending(sessionId)).map((input) => input.id),
          ).toEqual([
            makeInputId("stop-catchup"),
            makeInputId("fresh-resume"),
            makeInputId("live-followup"),
          ]);
        }),
      ),
  );
});
