import { Database } from "bun:sqlite";
import { it } from "@effect/vitest";
import {
  Clock,
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Result,
} from "effect";
import { describe, expect } from "vitest";
import type { OrganizationId, SessionId } from "../src/domain/ids.js";
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
  SqliteClient,
  SqliteClientLive,
  transact,
  tryDb,
} from "../src/services/store/sqlite-client.js";
import { TokenCrypto } from "../src/services/token-crypto.js";

import { suitePaths } from "./fixtures/paths.js";

const storeSuitePath = suitePaths();

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

describe("Lease-fenced run writes", () => {
  it.live(
    "rejects completion and metadata writes from a replaced lease owner",
    () =>
      withRepos(
        Effect.gen(function* () {
          const repo = yield* RunRepo;
          const sid = makeSessionId("lease-fence");
          const now = yield* Clock.currentTimeMillis;
          yield* repo.create({
            sessionId: sid,
            organizationId: makeOrganizationId("org"),
            issueId: Option.none(),
          });
          yield* repo.claimLease(sid, "old-owner", 10, now - 100);
          expect(yield* repo.claimLease(sid, "new-owner", 60_000, now)).toBe(
            true,
          );
          for (const patch of [
            { state: "succeeded" as const },
            { ompSessionId: Option.some("stale-session") },
          ]) {
            const result = yield* repo
              .update(sid, { ...patch, leaseOwner: "old-owner" })
              .pipe(Effect.result);
            expect(Result.isFailure(result)).toBe(true);
          }
          const run = Option.getOrThrow(yield* repo.get(sid));
          expect(run.state).toBe("queued");
          expect(run.ompSessionId).toEqual(Option.none());
          expect(
            yield* RunEventRepo.use((service) => service.list(sid)),
          ).toEqual([]);
          yield* repo.update(sid, {
            leaseOwner: "new-owner",
            state: "succeeded",
          });
          expect(Option.getOrThrow(yield* repo.get(sid)).state).toBe(
            "succeeded",
          );
        }),
      ),
  );

  it.live("rejects writes after expiry even before another owner claims", () =>
    withRepos(
      Effect.gen(function* () {
        const sid = makeSessionId("expired-write");
        yield* RunRepo.use((service) =>
          service.create({
            sessionId: sid,
            organizationId: makeOrganizationId("org"),
            issueId: Option.none(),
          }),
        );
        const now = yield* Clock.currentTimeMillis;
        yield* RunRepo.use((service) =>
          service.claimLease(sid, "expired-owner", 10, now - 100),
        );
        expect(
          Result.isFailure(
            yield* RunRepo.use((service) =>
              service.update(sid, {
                leaseOwner: "expired-owner",
                state: "succeeded",
              }),
            ).pipe(Effect.result),
          ),
        ).toBe(true);
      }),
    ),
  );
});

it.live(
  "nested repository writes roll back together and exclude unrelated fibers",
  () =>
    Effect.gen(function* () {
      const db = yield* Effect.acquireRelease(
        Effect.sync(() => new Database(":memory:")),
        (database) => Effect.sync(() => database.close()),
      );
      db.exec("CREATE TABLE atomic_write (value TEXT)");
      const entered = yield* Deferred.make<void>();
      const outsideStarted = yield* Deferred.make<void>();
      const inside = yield* Effect.forkChild(
        transact(
          db,
          Effect.gen(function* () {
            yield* transact(
              db,
              tryDb(
                () =>
                  db.exec("INSERT INTO atomic_write VALUES ('rolled-back')"),
                "nested insert",
              ),
            );
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
        ),
      );
      yield* Deferred.await(entered);
      const outside = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Deferred.succeed(outsideStarted, undefined);
          yield* tryDb(
            () => db.exec("INSERT INTO atomic_write VALUES ('survived')"),
            "outside insert",
          );
        }),
      );
      yield* Deferred.await(outsideStarted);
      yield* Fiber.interrupt(inside);
      yield* Fiber.join(outside);
      expect(
        db.query<{ value: string }, []>("SELECT value FROM atomic_write").all(),
      ).toEqual([{ value: "survived" }]);
    }),
);

it.live(
  "additive delivery migration preserves legacy rows and is safe to reopen",
  () =>
    Effect.gen(function* () {
      const path = storeSuitePath("legacy-webhook.db");
      const legacy = new Database(path, { create: true, strict: true });
      legacy.exec(`
      CREATE TABLE webhook_delivery (
        delivery_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
        received_at INTEGER NOT NULL, payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT
      );
      INSERT INTO webhook_delivery VALUES ('legacy', 'org', 1, 'original-hash', '{"type":"AgentSessionEvent"}', 'pending', NULL);
    `);
      legacy.close();
      for (let open = 0; open < 2; open++) {
        yield* Effect.gen(function* () {
          const { db } = yield* SqliteClient;
          expect(
            db
              .query<
                {
                  payload_hash: string;
                  payload_json: string;
                  payload_version: number;
                  replay_hash: string | null;
                  claim_token: string | null;
                },
                []
              >(
                "SELECT payload_hash, payload_json, payload_version, replay_hash, claim_token FROM webhook_delivery",
              )
              .get(),
          ).toEqual({
            payload_hash: "original-hash",
            payload_json: '{"type":"AgentSessionEvent"}',
            payload_version: 0,
            replay_hash: null,
            claim_token: null,
          });
        }).pipe(Effect.provide(SqliteClientLive(path)));
      }
    }),
);
