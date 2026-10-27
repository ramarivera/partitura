import * as fs from "node:fs";
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { link, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, describe, expect, vi } from "vitest";
import {
  makeRetention,
  type RetentionPolicy,
} from "../src/services/retention.js";
import {
  SqliteClient,
  SqliteClientLive,
} from "../src/services/store/sqlite-client.js";
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
    "reclaims a terminal allocation left by a crash with no published workspace",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        insertRun(db, "failed-clone", "failed");
        insertRun(db, "leased", "failed");
        insertRun(db, "running", "running");
        db.query(
          "UPDATE agent_run SET lease_expires_at=2000 WHERE session_id='leased'",
        ).run();
        for (const [id, uid] of [
          ["failed-clone", 21001],
          ["leased", 21002],
          ["running", 21003],
        ] as const)
          db.query("INSERT INTO worker_identity VALUES (?, ?, 1)").run(id, uid);
        yield* makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
        }).sweep(now);
        expect(
          db
            .query(
              "SELECT session_id, active FROM worker_identity ORDER BY session_id",
            )
            .all(),
        ).toEqual([
          { session_id: "failed-clone", active: 0 },
          { session_id: "leased", active: 1 },
          { session_id: "running", active: 1 },
        ]);
      }).pipe(withDatabase),
  );

  it.live(
    "keeps a failed identity reserved without aborting other retirement or deleted-workspace records",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        const expired = testPath("root/expired");
        insertRun(db, "failed", "failed", expired);
        insertRun(db, "healthy", "failed");
        db.query(
          "INSERT INTO worker_identity VALUES ('failed', 21001, 1), ('healthy', 21002, 1)",
        ).run();
        const seal = workerSecurity.sealWorkerUidWorkspacesSync;
        vi.spyOn(
          workerSecurity,
          "sealWorkerUidWorkspacesSync",
        ).mockImplementation((path, uid) => {
          if (uid === 21001) throw new Error("injected seal failure");
          seal(path, uid);
        });
        const result = yield* makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
          removeWorkspace: (path) => rmSync(path, { recursive: true }),
        }).sweep(now);
        expect(result.skippedWorkspaces).toBe(1);
        expect(existsSync(expired)).toBe(false);
        expect(
          db
            .query(
              "SELECT session_id, active FROM worker_identity ORDER BY session_id",
            )
            .all(),
        ).toEqual([
          { session_id: "failed", active: 1 },
          { session_id: "healthy", active: 0 },
        ]);
        expect(
          db
            .query(
              "SELECT workspace_path FROM agent_run WHERE session_id='failed'",
            )
            .get(),
        ).toEqual({ workspace_path: expired });
        expect(
          db
            .query("SELECT kind FROM run_event WHERE session_id='failed'")
            .get(),
        ).toEqual({ kind: "worker_uid_quarantined" });
      }).pipe(withDatabase),
  );

  it.live(
    "doesn't reopen a retired workspace while its uid serves another session",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        const expired = testPath("root/expired");
        insertRun(db, "expired", "succeeded", expired);
        insertRun(db, "active", "running");
        db.query(
          "INSERT INTO worker_identity VALUES ('expired', 21001, 0), ('active', 21001, 1)",
        ).run();
        const removeWorkspace = vi.fn();
        const result = yield* makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
          removeWorkspace,
        }).sweep(now);
        expect(result.skippedWorkspaces).toBe(1);
        expect(removeWorkspace).not.toHaveBeenCalled();
        expect(
          db
            .query(
              "SELECT workspace_path FROM agent_run WHERE session_id='expired'",
            )
            .get(),
        ).toEqual({ workspace_path: expired });
      }).pipe(withDatabase),
  );

  it.live(
    "keeps a busy uid fenced even when the retired workspace is missing",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        const missing = join(root, "missing");
        insertRun(db, "expired", "succeeded", missing);
        insertRun(db, "active", "running");
        db.query(
          "INSERT INTO worker_identity VALUES ('expired', 21001, 0), ('active', 21001, 1)",
        ).run();
        const result = yield* makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
        }).sweep(now);
        expect(result.skippedWorkspaces).toBe(1);
        expect(
          db
            .query(
              "SELECT workspace_path FROM agent_run WHERE session_id='expired'",
            )
            .get(),
        ).toEqual({ workspace_path: missing });
        expect(
          db
            .query(
              "SELECT active FROM worker_identity WHERE session_id='active'",
            )
            .get(),
        ).toEqual({ active: 1 });
      }).pipe(withDatabase),
  );

  it.live(
    "migrates legacy ownership asynchronously under a durable reopen fence without following symlinks",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        const expired = testPath("root/expired");
        const nested = testPath("root/expired/nested");
        const file = join(nested, "legacy.txt");
        const sentinel = join(testPath("external"), "sentinel");
        yield* Effect.promise(async () => {
          await writeFile(file, "legacy");
          await writeFile(sentinel, "keep");
          await symlink(sentinel, join(expired, "file-link"));
          await symlink(testPath("external"), join(expired, "directory-link"));
        });
        const before = statSync(sentinel);
        const workerUid = statSync(expired).uid + 1;
        vi.stubEnv("WORKER_UID", String(workerUid));
        const migrated: string[] = [];
        // Exercise real inode inspection and traversal, stubbing only the
        // privileged syscall unavailable to the native test uid.
        const open = vi.mocked(filesystem.open).getMockImplementation();
        if (open === undefined) throw new Error("Filesystem open missing");
        vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          vi.spyOn(handle, "chown").mockImplementation(async (uid, gid) => {
            expect(db.inTransaction).toBe(false);
            expect(
              db
                .query("SELECT state FROM workspace WHERE session_id='expired'")
                .get(),
            ).toEqual({ state: "deleting" });
            expect([uid, gid]).toEqual([workerUid, workerUid]);
            migrated.push(realpathSync(`/proc/self/fd/${handle.fd}`));
          });
          return handle;
        });
        const spawn = Bun.spawn;
        const worker = vi
          .spyOn(Bun, "spawn")
          .mockImplementation((command, options) => {
            if (
              Array.isArray(command) &&
              command.includes("remove-workspace-contents")
            ) {
              expect(db.inTransaction).toBe(false);
              expect(migrated.sort()).toEqual([expired, nested, file].sort());
              return spawn(command.slice(command.indexOf("--") + 1), options);
            }
            return spawn(command, options);
          });
        insertRun(db, "expired", "succeeded", expired);
        const result = yield* makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
        }).sweep(now);
        expect(result.workspaces).toBe(1);
        expect(result.skippedWorkspaces).toBe(0);
        const workerCalls = worker.mock.calls.filter(
          ([command]) =>
            Array.isArray(command) &&
            command.includes("remove-workspace-contents"),
        );
        expect(workerCalls).toHaveLength(1);
        expect(workerCalls[0]).toEqual([
          expect.arrayContaining([
            "--reuid",
            String(workerUid),
            "--config=/dev/null",
            "--no-env-file",
            "--no-install",
            "remove-workspace-contents",
            expired,
          ]),
          expect.objectContaining({ cwd: expect.not.stringContaining(root) }),
        ]);
        expect(existsSync(expired)).toBe(false);
        expect(statSync(sentinel)).toMatchObject({
          uid: before.uid,
          gid: before.gid,
          mode: before.mode,
        });
        expect(yield* Effect.promise(() => readFile(sentinel, "utf8"))).toBe(
          "keep",
        );
        expect(db.query("SELECT workspace_path FROM agent_run").get()).toEqual({
          workspace_path: null,
        });
      }).pipe(withDatabase),
  );

  it.live(
    "preserves workspace records when legacy ownership migration rejects an external hardlink",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        const expired = testPath("root/expired");
        const sentinel = join(testPath("external"), "sentinel");
        yield* Effect.promise(async () => {
          await writeFile(sentinel, "keep");
          await link(sentinel, join(expired, "hardlink"));
        });
        const before = statSync(sentinel);
        vi.stubEnv("WORKER_UID", String(before.uid + 1));
        vi.spyOn(fs, "fchownSync").mockReturnValue(undefined);
        const worker = vi.spyOn(Bun, "spawnSync");
        insertRun(db, "expired", "succeeded", expired);
        db.query(
          "INSERT INTO workspace VALUES ('expired', ?, 'repo', 'url', 'main', 'ready', 1, 1)",
        ).run(expired);
        const result = yield* makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
        }).sweep(now);
        expect(result.workspaces).toBe(0);
        expect(result.skippedWorkspaces).toBe(1);
        expect(worker).not.toHaveBeenCalled();
        expect(existsSync(expired)).toBe(true);
        expect(statSync(sentinel).uid).toBe(before.uid);
        expect(db.query("SELECT workspace_path FROM agent_run").get()).toEqual({
          workspace_path: expired,
        });
        expect(db.query("SELECT canonical_path FROM workspace").get()).toEqual({
          canonical_path: expired,
        });
      }).pipe(withDatabase),
  );

  it.live(
    "deletes expired terminal workspaces and data while preserving active runs and recent data",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("workspaces");
        const expired = testPath("workspaces/expired");
        const active = testPath("workspaces/active");
        const recent = testPath("workspaces/recent");
        const orphaned = testPath("workspaces/orphaned");
        const leased = testPath("workspaces/leased");
        for (const [id, state, path, updated] of [
          ["expired", "succeeded", expired, 1],
          ["active", "running", active, 1],
          ["recent", "failed", recent, 950],
          ["orphaned", "orphaned", orphaned, 1],
          ["leased", "failed", leased, 1],
        ] as const)
          insertRun(db, id, state, path, updated);
        db.query(
          "UPDATE agent_run SET lease_expires_at=2000 WHERE session_id='leased'",
        ).run();
        for (const id of [
          "expired",
          "active",
          "recent",
          "orphaned",
          "leased",
        ]) {
          db.query(
            "INSERT INTO run_event VALUES (?, ?, 'rpc', 'info', NULL, '{}', NULL, NULL, 1, 1)",
          ).run(id, id);
          db.query(
            "INSERT INTO activity_projection VALUES (?, ?, 'thought', 'hash', NULL, 'completed', 1, 1)",
          ).run(id, id);
          db.query(
            "INSERT INTO projection_outbox (source_key, session_id, activity_type, payload_json, status, created_at, updated_at) VALUES (?, ?, 'thought', '{}', 'completed', 1, 1)",
          ).run(id, id);
          db.query(
            "INSERT INTO run_input VALUES (?, ?, 'prompted', 'body', '{}', 1, 2)",
          ).run(id, id);
        }
        db.query(
          "INSERT INTO webhook_delivery (delivery_id, organization_id, received_at, payload_hash, payload_json, status, error) VALUES ('old', 'org', 1, 'hash', '{}', 'processed', NULL), ('pending', 'org', 1, 'hash', '{}', 'pending', NULL), ('failed', 'org', 1, 'hash', '{}', 'failed', 'error'), ('new', 'org', 950, 'hash', '{}', 'processed', NULL)",
        ).run();
        db.query(
          "INSERT INTO oauth_state VALUES ('old', 1, 1, NULL), ('new', 1, 950, NULL)",
        ).run();
        db.query(
          "INSERT INTO mcp_oauth_state VALUES ('old', 'org', 'server', 'url', NULL, 'verifier', 'redirect', '{}', 1, NULL)",
        ).run();
        db.query(
          "INSERT INTO admin_session VALUES ('old', 'org', 'csrf', 1, 1), ('valid', 'org', 'csrf', 2000, 1)",
        ).run();
        const service = makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
        });
        const result = yield* service.sweep(now);
        expect(result).toEqual({
          workspaces: 1,
          skippedWorkspaces: 0,
          events: 1,
          projections: 2,
          inputs: 0,
          deliveries: 2,
          auth: 3,
        });
        expect(existsSync(expired)).toBe(false);
        for (const path of [active, recent, orphaned, leased])
          expect(existsSync(path)).toBe(true);
        for (const table of [
          "run_event",
          "activity_projection",
          "projection_outbox",
        ]) {
          expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({
            n: 4,
          });
        }
        expect(
          db
            .query(
              "SELECT workspace_path, omp_session_file FROM agent_run WHERE session_id='expired'",
            )
            .get(),
        ).toEqual({ workspace_path: null, omp_session_file: null });
        expect(
          db
            .query(
              "SELECT payload_json FROM webhook_delivery WHERE delivery_id='old'",
            )
            .get(),
        ).toEqual({ payload_json: "null" });
        expect(
          db
            .query(
              "SELECT payload_json FROM webhook_delivery WHERE delivery_id='pending'",
            )
            .get(),
        ).toEqual({ payload_json: "{}" });
        expect(
          db
            .query(
              "SELECT payload_json, payload_hash, status FROM webhook_delivery WHERE delivery_id='failed'",
            )
            .get(),
        ).toEqual({
          payload_json: "null",
          payload_hash: "hash",
          status: "failed",
        });
        expect(db.query("SELECT COUNT(*) AS n FROM run_input").get()).toEqual({
          n: 5,
        });
        expect((yield* service.sweep(now)).workspaces).toBe(0);
      }).pipe(withDatabase),
  );
});
