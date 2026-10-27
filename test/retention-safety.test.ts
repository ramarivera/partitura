import { existsSync, rmSync } from "node:fs";
import { link, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Result } from "effect";
import { afterEach, describe, expect, vi } from "vitest";
import { NixEnvironmentError } from "../src/domain/errors.js";
import { GatewayConfig } from "../src/services/config.js";
import { NixEnvironment } from "../src/services/nix-environment.js";
import {
  MAX_WORKSPACES_PER_SWEEP,
  makeRetention,
  Retention,
  type RetentionPolicy,
} from "../src/services/retention.js";
import {
  SqliteClient,
  SqliteClientLive,
} from "../src/services/store/sqlite-client.js";
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
  it.live("refuses root, external, shared and symlinked workspaces", () =>
    Effect.gen(function* () {
      const { db } = yield* SqliteClient;
      const root = testPath("root");
      const external = testPath("external");
      const shared = testPath("root/shared");
      const linked = join(root, "linked");
      yield* Effect.promise(() => symlink(external, linked));
      yield* Effect.promise(() =>
        writeFile(join(external, "sentinel"), "keep"),
      );
      insertRun(db, "root", "failed", root);
      insertRun(db, "external", "failed", external);
      insertRun(db, "shared", "failed", shared);
      insertRun(db, "shared-active", "running", shared);
      insertRun(db, "linked", "failed", linked);
      const result = yield* makeRetention({
        db,
        workspaceRoot: root,
        policy,
        webhookReplayWindowMs: 100,
      }).sweep(now);
      expect(result.workspaces).toBe(0);
      expect(result.skippedWorkspaces).toBe(4);
      expect(existsSync(join(external, "sentinel"))).toBe(true);
      expect(existsSync(shared)).toBe(true);
    }).pipe(withDatabase),
  );

  it.live(
    "removes nested workspace links without deleting or rewriting their external targets",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        const expired = testPath("root/expired");
        const external = testPath("external");
        const sentinel = join(external, "sentinel");
        yield* Effect.promise(async () => {
          await writeFile(sentinel, "keep");
          await symlink(external, join(expired, "directory-link"));
          await symlink(sentinel, join(expired, "file-link"));
          await link(sentinel, join(expired, "hardlink"));
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
        expect(existsSync(expired)).toBe(false);
        expect(yield* Effect.promise(() => readFile(sentinel, "utf8"))).toBe(
          "keep",
        );
      }).pipe(withDatabase),
  );

  it.live(
    "retains projections inside their TTL and delivery payloads inside replay window",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        insertRun(db, "terminal", "succeeded");
        db.query(
          "INSERT INTO run_event VALUES ('pending', 'terminal', 'rpc', 'info', NULL, '{}', 'pending', NULL, 1, 1)",
        ).run();
        db.query(
          "INSERT INTO activity_projection VALUES ('pending', 'terminal', 'thought', 'hash', NULL, 'pending', 1, 1)",
        ).run();
        db.query(
          "INSERT INTO webhook_delivery (delivery_id, organization_id, received_at, payload_hash, payload_json, status, error) VALUES ('old', 'org', 1, 'hash', '{}', 'processed', NULL)",
        ).run();
        const result = yield* makeRetention({
          db,
          workspaceRoot: testPath("root"),
          policy: { ...policy, projectionTtlMs: 2000 },
          webhookReplayWindowMs: 2000,
        }).sweep(now);
        expect(result.events).toBe(0);
        expect(result.projections).toBe(0);
        expect(result.deliveries).toBe(0);
      }).pipe(withDatabase),
  );

  it.live(
    "expires failed projections after their TTL but respects projector leases",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        insertRun(db, "terminal", "failed");
        for (const key of ["failed", "leased"]) {
          db.query(
            "INSERT INTO run_event VALUES (?, 'terminal', 'rpc', 'info', NULL, '{}', 'failed', NULL, 1, 1)",
          ).run(key);
          db.query(
            "INSERT INTO activity_projection VALUES (?, 'terminal', 'thought', 'hash', NULL, 'failed', 1, 1)",
          ).run(key);
          db.query(
            "INSERT INTO projection_outbox (source_key, session_id, activity_type, payload_json, status, created_at, updated_at) VALUES (?, 'terminal', 'thought', '{}', 'failed', 1, 1)",
          ).run(key);
        }
        db.query(
          "UPDATE projection_outbox SET status='processing', lease_expires_at=2000 WHERE source_key='leased'",
        ).run();
        const result = yield* makeRetention({
          db,
          workspaceRoot: testPath("root"),
          policy,
          webhookReplayWindowMs: 100,
        }).sweep(now);
        expect(result.projections).toBe(2);
        expect(result.events).toBe(1);
        expect(
          db.query("SELECT source_key FROM projection_outbox").all(),
        ).toEqual([{ source_key: "leased" }]);
      }).pipe(withDatabase),
  );

  it.live(
    "bounds successful removals without starving candidates behind skipped rows",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        for (let index = 0; index < MAX_WORKSPACES_PER_SWEEP + 1; index++)
          insertRun(
            db,
            `skipped-${index}`,
            "failed",
            testPath(`outside-${index}`),
          );
        const paths = Array.from(
          { length: MAX_WORKSPACES_PER_SWEEP + 2 },
          (_, index) => testPath(`root/expired-${index}`),
        );
        for (const [index, path] of paths.entries())
          insertRun(db, `expired-${index}`, "failed", path);
        const service = makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
        });
        const first = yield* service.sweep(now);
        expect(first.workspaces).toBe(MAX_WORKSPACES_PER_SWEEP);
        expect(first.skippedWorkspaces).toBe(MAX_WORKSPACES_PER_SWEEP + 1);
        expect(paths.filter(existsSync)).toHaveLength(2);
        expect((yield* service.sweep(now)).workspaces).toBe(2);
        expect(paths.some(existsSync)).toBe(false);
      }).pipe(withDatabase),
  );

  it.live(
    "keeps earlier deletion records and continues after a failed workspace removal",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        const paths = ["first", "blocked", "last"].map((id) =>
          testPath(`root/${id}`),
        );
        for (const [index, path] of paths.entries()) {
          insertRun(db, `run-${index}`, "failed", path);
          db.query(
            "UPDATE agent_run SET omp_session_file='old-session' WHERE session_id=?",
          ).run(`run-${index}`);
          db.query(
            "INSERT INTO workspace VALUES (?, ?, 'repo', 'url', 'main', 'ready', 1, 1)",
          ).run(`run-${index}`, path);
        }
        db.query(
          "INSERT INTO oauth_state VALUES ('expired', 1, 1, NULL)",
        ).run();
        const result = yield* makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
          removeWorkspace: (path) => {
            if (path.endsWith("/blocked"))
              throw Object.assign(new Error("permission denied"), {
                code: "EACCES",
              });
            rmSync(path, { recursive: true, force: true });
          },
        }).sweep(now);
        expect(result.workspaces).toBe(2);
        expect(result.skippedWorkspaces).toBe(1);
        expect(result.auth).toBe(1);
        expect(paths.map(existsSync)).toEqual([false, true, false]);
        expect(
          db
            .query(
              "SELECT session_id, workspace_path, omp_session_file FROM agent_run ORDER BY session_id",
            )
            .all(),
        ).toEqual([
          { session_id: "run-0", workspace_path: null, omp_session_file: null },
          {
            session_id: "run-1",
            workspace_path: paths[1],
            omp_session_file: "old-session",
          },
          { session_id: "run-2", workspace_path: null, omp_session_file: null },
        ]);
        expect(db.query("SELECT session_id FROM workspace").all()).toEqual([
          { session_id: "run-1" },
        ]);
      }).pipe(withDatabase),
  );

  it.live(
    "commits workspace cleanup even if subsequent data cleanup fails",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const path = testPath("root/expired");
        insertRun(db, "expired", "failed", path);
        db.query(
          "CREATE TRIGGER fail_auth BEFORE DELETE ON oauth_state BEGIN SELECT RAISE(ABORT, 'broken auth cleanup'); END",
        ).run();
        db.query(
          "INSERT INTO oauth_state VALUES ('expired', 1, 1, NULL)",
        ).run();
        expect(
          Result.isFailure(
            yield* Effect.result(
              makeRetention({
                db,
                workspaceRoot: testPath("root"),
                policy,
                webhookReplayWindowMs: 100,
              }).sweep(now),
            ),
          ),
        ).toBe(true);
        expect(existsSync(path)).toBe(false);
        expect(db.query("SELECT workspace_path FROM agent_run").get()).toEqual({
          workspace_path: null,
        });
      }).pipe(withDatabase),
  );

  it.live(
    "canonicalizes configured root ancestors but rejects candidate aliases",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const actual = testPath("actual");
        const root = testPath("actual/workspaces");
        const alias = join(testPath("parent"), "alias");
        yield* Effect.promise(() => symlink(actual, alias));
        const expired = testPath("actual/workspaces/expired");
        const keep = testPath("actual/workspaces/keep");
        const linked = join(root, "linked");
        yield* Effect.promise(() => symlink(keep, linked));
        insertRun(db, "expired", "failed", expired);
        insertRun(db, "linked", "failed", linked);
        const result = yield* makeRetention({
          db,
          workspaceRoot: join(alias, "workspaces"),
          policy,
          webhookReplayWindowMs: 100,
        }).sweep(now);
        expect(result.workspaces).toBe(1);
        expect(result.skippedWorkspaces).toBe(1);
        expect(existsSync(expired)).toBe(false);
        expect(existsSync(keep)).toBe(true);
      }).pipe(withDatabase),
  );

  it.live(
    "preserves active shared paths reached through symlinks and workspace metadata",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const root = testPath("root");
        const expired = testPath("root/expired");
        const child = testPath("root/expired/child");
        const alias = join(testPath("aliases"), "active");
        yield* Effect.promise(() => symlink(expired, alias));
        insertRun(db, "expired", "failed", expired);
        insertRun(db, "active", "running", join(alias, "child"));
        const service = makeRetention({
          db,
          workspaceRoot: root,
          policy,
          webhookReplayWindowMs: 100,
        });
        expect((yield* service.sweep(now)).workspaces).toBe(0);
        expect(existsSync(child)).toBe(true);
        db.query(
          "UPDATE agent_run SET workspace_path=NULL WHERE session_id='active'",
        ).run();
        db.query(
          "INSERT INTO workspace VALUES ('active', ?, 'repo', 'url', 'main', 'ready', 1, 1)",
        ).run(join(alias, "not-yet-created"));
        expect((yield* service.sweep(now)).workspaces).toBe(0);
        expect(existsSync(expired)).toBe(true);
        db.query("DELETE FROM workspace WHERE session_id='active'").run();
        expect((yield* service.sweep(now)).workspaces).toBe(1);
      }).pipe(withDatabase),
  );

  it.live(
    "continues enforcing the Nix budget across sweep and budget failures",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        db.query("DROP TABLE agent_run").run();
        let calls = 0;
        const retried = yield* Deferred.make<void>();
        const nix = NixEnvironment.of({
          prepare: () => Effect.die("Unexpected build"),
          list: () => Effect.succeed([]),
          prune: () => Effect.succeed(false),
          enforceBudget: (maxBytes) =>
            Effect.gen(function* () {
              expect(maxBytes).toBe(1000);
              calls++;
              if (calls === 1)
                return yield* Effect.fail(
                  new NixEnvironmentError({
                    reason: "gc_failed",
                    message: "Transient GC failure",
                  }),
                );
              yield* Deferred.succeed(retried, undefined);
              return { removed: 0, sizeBytes: 50, withinBudget: true };
            }),
        });
        const values = new Map([
          ["WORKER_SANDBOX_MODE", "native"],
          ["LINEAR_CLIENT_ID", "client"],
          ["LINEAR_CLIENT_SECRET", "secret"],
          ["LINEAR_WEBHOOK_SECRET", "secret"],
          ["TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64")],
          ["PUBLIC_URL", "http://localhost:3000"],
          ["RETENTION_INTERVAL_MS", "1"],
          ["NIX_STORE_MAX_BYTES", "1000"],
        ]);
        yield* Effect.gen(function* () {
          const retention = yield* Retention;
          const fiber = yield* Effect.forkScoped(retention.run);
          yield* Deferred.await(retried);
          yield* Fiber.interrupt(fiber);
        }).pipe(
          Effect.provide(
            Retention.layerWithoutDependencies.pipe(
              Layer.provide(
                Layer.mergeAll(
                  GatewayConfig.layer,
                  Layer.succeed(NixEnvironment, nix),
                ),
              ),
            ),
          ),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown(Object.fromEntries(values), {
              preserveEmptyStrings: true,
            }),
          ),
        );
        expect(calls).toBe(2);
      }).pipe(Effect.scoped, withDatabase),
  );
});
