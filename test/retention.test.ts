import * as fs from "node:fs";
import { existsSync, rmSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Logger, Result, Schema } from "effect";
import { afterEach, describe, expect, vi } from "vitest";
import { InputId, SessionId } from "../src/domain/ids.js";
import {
  makeRetention,
  type RetentionPolicy,
} from "../src/services/retention.js";
import { RunInputRepo } from "../src/services/store/run-input-repo.js";
import { RunRepo } from "../src/services/store/run-repo.js";
import {
  SqliteClient,
  SqliteClientLive,
} from "../src/services/store/sqlite-client.js";
import { makeWorkerIdentityRepo } from "../src/services/store/worker-identity-repo.js";
import { assertWorkspaceAvailable } from "../src/services/store/workspace-deletion.js";
import * as workerSecurity from "../src/services/worker-security.js";
import { testPaths } from "./fixtures/paths.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fchownSync: vi.fn(actual.fchownSync) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const testPath = testPaths();
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const policy: RetentionPolicy = {
  intervalMs: 100,
  workspaceTtlMs: 100,
  deliveryTtlMs: 100,
  eventTtlMs: 100,
  projectionTtlMs: 100,
  authGraceMs: 100,
  nixStoreMaxBytes: 1000,
};
const now = 1000;
const insertRun = (
  db: SqliteClient["Service"]["db"],
  id: string,
  state: string,
  path: string | null = null,
  updated = 1,
) => {
  db.query(
    "INSERT INTO agent_run (session_id, organization_id, state, workspace_path, created_at, updated_at) VALUES (?, 'org', ?, ?, 1, ?)",
  ).run(id, state, path, updated);
};

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqliteClient>) =>
  effect.pipe(Effect.provide(SqliteClientLive(":memory:")));

describe("retention", () => {
  it.live(
    "keeps SQLite available while deletion fences reopen, path sharing and uid reuse",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const runs = yield* RunRepo;
        const inputs = yield* RunInputRepo;
        const root = testPath("root");
        const expired = testPath("root/expired");
        const session = Schema.decodeUnknownSync(SessionId)("expired");
        insertRun(db, session, "canceled", expired);
        insertRun(db, "another", "queued");
        vi.stubEnv("WORKER_UID_BASE", "31001");
        vi.stubEnv("WORKER_UID_COUNT", "1");
        db.query(
          "INSERT INTO worker_identity VALUES ('expired',31001,1)",
        ).run();
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const deletion = yield* makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
          removeWorkspace: async (path) => {
            started.resolve();
            await release.promise;
            rmSync(path, { recursive: true, force: true });
          },
        })
          .sweep(now)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.gen(function* () {
          yield* Effect.promise(() => started.promise);
          expect(db.inTransaction).toBe(false);
          expect(yield* runs.reopen(session)).toBe(false);
          expect(
            Result.isFailure(
              yield* inputs
                .enqueue({
                  id: Schema.decodeUnknownSync(InputId)("new-input"),
                  sessionId: session,
                  kind: "prompted",
                  body: "resume",
                  payload: {},
                })
                .pipe(Effect.result),
            ),
          ).toBe(true);
          expect(
            db.query("SELECT COUNT(*) AS count FROM run_input").get(),
          ).toEqual({ count: 0 });
          expect(
            Result.isFailure(
              yield* makeWorkerIdentityRepo(db)
                .acquire("another", root)
                .pipe(Effect.result),
            ),
          ).toBe(true);
          expect(() =>
            assertWorkspaceAvailable(db, "another", join(expired, "child")),
          ).toThrow("deletion");
          const alias = join(root, "alias");
          yield* Effect.promise(() => symlink(expired, alias));
          expect(() =>
            assertWorkspaceAvailable(db, "another", join(alias, "new-child")),
          ).toThrow("deletion");
          // A second sweeper can't race the in-flight filesystem removal.
          expect(
            (yield* makeRetention({
              db,
              workspaceRoot: root,
              policy,
              webhookReplayWindowMs: 100,
            }).sweep(now)).workspaces,
          ).toBe(0);
        }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())));
        expect((yield* Fiber.join(deletion)).workspaces).toBe(1);
        expect(yield* runs.reopen(session)).toBe(true);
        expect(yield* makeWorkerIdentityRepo(db).acquire("another", root)).toBe(
          "31001",
        );
      }).pipe(
        Effect.provide(Layer.mergeAll(RunRepo.layer, RunInputRepo.layer)),
        withDatabase,
      ),
  );

  it.live(
    "recovers a durable deletion claim after closing and reopening SQLite",
    () =>
      Effect.gen(function* () {
        const database = testPath("retention.sqlite");
        const root = testPath("root");
        const expired = testPath("root/expired");
        yield* Effect.gen(function* () {
          const { db } = yield* SqliteClient;
          insertRun(db, "expired", "failed", expired);
          const result = yield* makeRetention({
            db,
            workspaceRoot: root,
            policy,
            webhookReplayWindowMs: 100,
            removeWorkspace: async () => {
              throw new Error("simulated crash before removal");
            },
          }).sweep(now);
          expect(result.workspaces).toBe(0);
          expect(db.query("SELECT state FROM workspace").get()).toEqual({
            state: "deleting",
          });
          // A later stop mustn't postpone recovery behind the workspace TTL.
          db.query("UPDATE agent_run SET updated_at=?").run(now);
        }).pipe(Effect.provide(SqliteClientLive(database)));
        yield* Effect.gen(function* () {
          const { db } = yield* SqliteClient;
          expect(db.query("SELECT state FROM workspace").get()).toEqual({
            state: "deleting",
          });
          expect(
            (yield* makeRetention({
              db,
              workspaceRoot: root,
              policy,
              webhookReplayWindowMs: 100,
            }).sweep(now)).workspaces,
          ).toBe(1);
          expect(existsSync(expired)).toBe(false);
          expect(
            db.query("SELECT workspace_path FROM agent_run").get(),
          ).toEqual({ workspace_path: null });
          expect(db.query("SELECT * FROM workspace").all()).toEqual([]);
        }).pipe(Effect.provide(SqliteClientLive(database)));
      }),
  );

  it.live(
    "keeps sandbox workspaces and identities fenced until teardown succeeds",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        const workspace = join(root, "sandbox");
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(join(workspace, "retained"), "keep");
        insertRun(db, "sandbox", "failed", workspace);
        insertRun(db, "orphan", "failed");
        db.query(
          "INSERT INTO worker_identity VALUES ('sandbox', 21001, 1), ('orphan', 21002, 1)",
        ).run();
        let unavailable = true;
        const retention = makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
          beforeRetireSession: async () => {
            if (unavailable) throw new Error("sandbox still running");
          },
        });
        expect((yield* retention.sweep(now)).workspaces).toBe(0);
        expect(existsSync(join(workspace, "retained"))).toBe(true);
        expect(
          db
            .query("SELECT state FROM workspace WHERE session_id='sandbox'")
            .get(),
        ).toEqual({ state: "deleting" });
        expect(
          db
            .query("SELECT active FROM worker_identity ORDER BY session_id")
            .all(),
        ).toEqual([{ active: 1 }, { active: 1 }]);
        unavailable = false;
        expect((yield* retention.sweep(now)).workspaces).toBe(1);
        expect(existsSync(workspace)).toBe(false);
        expect(
          db
            .query(
              "SELECT session_id, active FROM worker_identity ORDER BY session_id",
            )
            .all(),
        ).toEqual([
          { session_id: "orphan", active: 0 },
          { session_id: "sandbox", active: 0 },
        ]);
      }).pipe(withDatabase),
  );

  it.live(
    "fences an unpublished sandbox identity when broker cleanup fails",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        insertRun(db, "orphan", "failed");
        db.query(
          "INSERT INTO worker_identity VALUES ('orphan', 21002, 1)",
        ).run();
        const privatePath = join(root, "private-workspace");
        const secret = "retention-private-token";
        const logs: Array<string> = [];
        const logger = Logger.make((entry) => logs.push(JSON.stringify(entry)));
        const beforeRetireSession = vi.fn(async () => {
          throw new Error(`failed at ${privatePath} with token=${secret}`);
        });
        const result = yield* makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
          beforeRetireSession,
        })
          .sweep(now)
          .pipe(Effect.provide(Logger.layer([logger])));
        expect(beforeRetireSession).toHaveBeenCalledWith("orphan");
        expect(result.skippedWorkspaces).toBe(1);
        const logged = logs.join("\n");
        expect(logged).toContain("retention.deletion_claim_retained");
        expect(logged).toContain("orphan");
        expect(logged).toContain("Error");
        expect(logged).not.toContain(privatePath);
        expect(logged).not.toContain(secret);
        expect(
          db
            .query(
              "SELECT state, canonical_path FROM workspace WHERE session_id='orphan'",
            )
            .get(),
        ).toMatchObject({ state: "deleting" });
        const claim = db
          .query<{ canonical_path: string }, []>(
            "SELECT canonical_path FROM workspace WHERE session_id='orphan'",
          )
          .get();
        expect(claim?.canonical_path).not.toContain(`${root}/`);
        expect(
          db
            .query(
              "SELECT active FROM worker_identity WHERE session_id='orphan'",
            )
            .get(),
        ).toEqual({ active: 1 });
      }).pipe(withDatabase),
  );

  it.live("retires a published workspace whose run path wasn't persisted", () =>
    Effect.gen(function* () {
      const { db } = yield* SqliteClient;
      const root = testPath("root");
      const workspace = testPath("root/published");
      insertRun(db, "published", "failed");
      db.query(
        "INSERT INTO workspace VALUES ('published', ?, 'repo-id', 'https://example.test/repo', 'main', 'ready', 1, 1)",
      ).run(workspace);
      db.query(
        "INSERT INTO worker_identity VALUES ('published', 21002, 1)",
      ).run();
      const beforeRetireSession = vi.fn(async () => {
        expect(db.inTransaction).toBe(false);
        expect(
          db
            .query(
              "SELECT canonical_path, repository_id, state FROM workspace WHERE session_id='published'",
            )
            .get(),
        ).toEqual({
          canonical_path: workspace,
          repository_id: "repo-id",
          state: "deleting",
        });
      });
      const removeWorkspace = vi.fn((path: string) => {
        expect(path).toBe(workspace);
      });
      const result = yield* makeRetention({
        db,
        workspaceRoot: root,
        policy,
        webhookReplayWindowMs: 100,
        beforeRetireSession,
        removeWorkspace,
      }).sweep(now);
      expect(result.workspaces).toBe(1);
      expect(beforeRetireSession).toHaveBeenCalledOnce();
      expect(removeWorkspace).toHaveBeenCalledOnce();
      expect(
        db.query("SELECT * FROM workspace WHERE session_id='published'").all(),
      ).toEqual([]);
      expect(
        db
          .query(
            "SELECT active FROM worker_identity WHERE session_id='published'",
          )
          .get(),
      ).toEqual({ active: 0 });
    }).pipe(withDatabase),
  );

  it.live(
    "keeps an orphan identity fenced when uid cleanup fails, then retries it",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        insertRun(db, "orphan", "failed");
        db.query(
          "INSERT INTO worker_identity VALUES ('orphan', 21002, 1)",
        ).run();
        const seal = vi
          .spyOn(workerSecurity, "sealWorkerUidWorkspacesSync")
          .mockImplementation(() => {
            throw new Error("injected uid seal failure");
          });
        const retention = makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
          beforeRetireSession: async () => {},
        });
        expect((yield* retention.sweep(now)).skippedWorkspaces).toBe(1);
        expect(
          db
            .query(
              "SELECT active FROM worker_identity WHERE session_id='orphan'",
            )
            .get(),
        ).toEqual({ active: 1 });
        expect(
          db
            .query("SELECT state FROM workspace WHERE session_id='orphan'")
            .get(),
        ).toEqual({ state: "deleting" });
        seal.mockRestore();
        expect((yield* retention.sweep(now)).skippedWorkspaces).toBe(0);
        expect(
          db
            .query(
              "SELECT active FROM worker_identity WHERE session_id='orphan'",
            )
            .get(),
        ).toEqual({ active: 0 });
        expect(
          db.query("SELECT * FROM workspace WHERE session_id='orphan'").all(),
        ).toEqual([]);
      }).pipe(withDatabase),
  );

  it.live(
    "prevents a concurrent resume while an orphan sandbox is being destroyed",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const runs = yield* RunRepo;
        const root = testPath("root");
        const session = Schema.decodeUnknownSync(SessionId)("orphan");
        insertRun(db, "orphan", "canceled");
        db.query(
          "INSERT INTO worker_identity VALUES ('orphan', 21002, 1)",
        ).run();
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const retention = makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
          beforeRetireSession: async () => {
            started.resolve();
            await release.promise;
          },
        });
        const deletion = yield* retention
          .sweep(now)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.gen(function* () {
          yield* Effect.promise(() => started.promise);
          expect(yield* runs.reopen(session)).toBe(false);
          expect(
            db
              .query(
                "SELECT active FROM worker_identity WHERE session_id='orphan'",
              )
              .get(),
          ).toEqual({ active: 1 });
        }).pipe(Effect.ensuring(Effect.sync(() => release.resolve())));
        expect((yield* Fiber.join(deletion)).workspaces).toBe(0);
        expect(
          db
            .query(
              "SELECT active FROM worker_identity WHERE session_id='orphan'",
            )
            .get(),
        ).toEqual({ active: 0 });
        expect(
          db.query("SELECT * FROM workspace WHERE session_id='orphan'").all(),
        ).toEqual([]);
        expect(yield* runs.reopen(session)).toBe(true);
      }).pipe(Effect.provide(RunRepo.layer), withDatabase),
  );
});
