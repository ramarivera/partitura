import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Effect, Result } from "effect";
import { DatabaseError } from "../domain/errors.js";
import { canonicalReference, isWithin } from "../util/paths.js";
import { acquireCloneLock } from "./clone-lock.js";
import { tryDb } from "./store/sqlite-client.js";
import { retireWorkerIdentitySync } from "./store/worker-identity-repo.js";
import {
  stopWorkerUidProcessesSync,
  workerUidRange,
} from "./worker-security.js";
import { removeWorkerWorkspace } from "./workspace-process.js";

const terminal = "state IN ('succeeded','failed','canceled')";
const safeFailureCause = (error: unknown): string => {
  if (!(error instanceof Error)) return `non-error rejection (${typeof error})`;
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(error.name)
    ? error.name
    : "Error";
  const code =
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Za-z0-9_.-]{1,64}$/u.test(error.code)
      ? error.code
      : undefined;
  return code === undefined ? name : `${name} (${code})`;
};
const orphanFencePath = (root: string, sessionId: string) =>
  resolve(
    root,
    "..",
    `.retention-orphan-${createHash("sha256").update(sessionId).digest("hex")}`,
  );

export const makeWorkspaceRetention = (input: {
  readonly db: Database;
  readonly workspaceRoot: string;
  readonly workspaceTtlMs: number;
  readonly maxWorkspaces: number;
  readonly beforeRetireSession?:
    | ((sessionId: string) => Promise<void>)
    | undefined;
  readonly removeWorkspace?:
    | ((path: string) => void | Promise<void>)
    | undefined;
}) => {
  const { db } = input;
  return (now: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        let canonicalRoot: string | undefined;
        try {
          canonicalRoot = realpathSync(resolve(input.workspaceRoot));
        } catch {
          canonicalRoot = undefined;
        }
        if (canonicalRoot !== undefined) {
          const root = canonicalRoot;
          const lock = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                acquireCloneLock(
                  root,
                  createHash("sha256")
                    .update("retention")
                    .digest("hex")
                    .slice(0, 32),
                ),
              catch: () =>
                new DatabaseError({ message: "Retention ownership failed" }),
            }),
            (lock) =>
              lock === undefined
                ? Effect.void
                : Effect.promise(() => lock.release()),
          );
          if (lock === undefined)
            return {
              workspaces: 0,
              skippedWorkspaces: 0,
            };
        }
        const claimed = yield* tryDb(
          () =>
            db
              .transaction(() => {
                let skippedWorkspaces = 0;
                const jobs: Array<{
                  sessionId: string;
                  path: string;
                  root: string;
                  uid: number | undefined;
                  identityUid: number | undefined;
                }> = [];
                const orphanJobs: Array<{
                  sessionId: string;
                  uid: number;
                  root: string;
                  fencePath: string;
                }> = [];
                // Match Workspace.materialize, which persists canonical paths. A missing
                // root means there is no workspace to remove, but data may still expire.
                let root: string | undefined;
                try {
                  root = realpathSync(resolve(input.workspaceRoot));
                } catch {
                  root = undefined;
                }
                const references = db
                  .query<
                    {
                      session_id: string;
                      workspace_path: string | null;
                      canonical_path: string | null;
                    },
                    []
                  >(
                    `SELECT r.session_id, r.workspace_path, w.canonical_path FROM agent_run r LEFT JOIN workspace w ON w.session_id=r.session_id`,
                  )
                  .all();
                const referencePaths = references.map((reference) => ({
                  sessionId: reference.session_id,
                  paths: [
                    reference.workspace_path,
                    reference.canonical_path,
                  ].flatMap((path) => {
                    if (path === null) return [];
                    const absolute = resolve(path);
                    return [absolute, canonicalReference(absolute)];
                  }),
                }));
                const candidates = db.query<
                  { session_id: string; workspace_path: string },
                  [number, number]
                >(
                  `SELECT r.session_id, COALESCE(r.workspace_path, w.canonical_path) AS workspace_path
                   FROM agent_run r LEFT JOIN workspace w ON w.session_id=r.session_id
                   WHERE r.${terminal}
                   AND (r.updated_at<? OR w.state='deleting')
                   AND COALESCE(r.workspace_path, w.canonical_path) IS NOT NULL
                   AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=?)`,
                );
                // Bind both cutoffs explicitly; the workspace grace is based on terminal update time.
                const rows = candidates.all(now - input.workspaceTtlMs, now);
                for (const row of rows) {
                  const path = resolve(row.workspace_path);
                  // Synthetic orphan claims are retried by the identity path
                  // below, not treated as filesystem workspaces.
                  if (
                    root !== undefined &&
                    path === orphanFencePath(root, row.session_id)
                  )
                    continue;
                  if (jobs.length >= input.maxWorkspaces) break;
                  const shared = referencePaths.some(
                    (reference) =>
                      reference.sessionId !== row.session_id &&
                      reference.paths.some(
                        (other) =>
                          other === undefined ||
                          isWithin(path, other) ||
                          isWithin(other, path),
                      ),
                  );
                  if (
                    root === undefined ||
                    !isAbsolute(row.workspace_path) ||
                    path === root ||
                    !isWithin(root, path) ||
                    shared
                  ) {
                    skippedWorkspaces++;
                    continue;
                  }
                  const identity = db
                    .query<{ uid: number }, [string]>(
                      "SELECT uid FROM worker_identity WHERE session_id=?",
                    )
                    .get(row.session_id);
                  const uid =
                    identity?.uid ?? workerUidRange(process.env)?.base;
                  // A released uid may be serving another session. Never reopen an
                  // old workspace to that worker, even briefly during deletion.
                  if (
                    uid !== undefined &&
                    db
                      .query(
                        "SELECT 1 FROM worker_identity WHERE uid=? AND active=1 AND session_id<>?",
                      )
                      .get(uid, row.session_id) !== null
                  ) {
                    skippedWorkspaces++;
                    continue;
                  }

                  try {
                    const stat = lstatSync(path);
                    if (
                      !stat.isDirectory() ||
                      stat.isSymbolicLink() ||
                      realpathSync(path) !== path
                    ) {
                      skippedWorkspaces++;
                      continue;
                    }
                  } catch (error) {
                    if (
                      !(
                        error instanceof Error &&
                        "code" in error &&
                        error.code === "ENOENT"
                      )
                    ) {
                      skippedWorkspaces++;
                      continue;
                    }
                  }
                  if (uid !== undefined)
                    db.query(
                      "INSERT INTO worker_identity(session_id, uid, active) VALUES (?, ?, 1) ON CONFLICT(session_id) DO UPDATE SET active=1",
                    ).run(row.session_id, uid);
                  // Existing workspace.state is a durable deletion claim. No schema
                  // change is needed. Reopen, lease acquisition and uid recycling
                  // refuse this state until removal and finalization succeed.
                  db.query(`INSERT INTO workspace(session_id, canonical_path, repository_id, repository_url, repository_ref, state, created_at, updated_at)
              VALUES (?, ?, '', '', '', 'deleting', ?, ?)
              ON CONFLICT(session_id) DO UPDATE SET state='deleting', updated_at=excluded.updated_at`).run(
                    row.session_id,
                    path,
                    now,
                    now,
                  );
                  jobs.push({
                    sessionId: row.session_id,
                    path,
                    root,
                    uid,
                    identityUid: uid,
                  });
                }
                // A sandboxed identity can be allocated before its workspace is
                // published. Give those sessions the same durable resume fence as
                // workspace deletion, using a per-session path outside the root so
                // it can't fence unrelated workspaces.
                if (
                  input.beforeRetireSession !== undefined &&
                  root !== undefined
                ) {
                  const orphans = db
                    .query<{ session_id: string; uid: number }, [number]>(
                      `SELECT i.session_id, i.uid FROM worker_identity i JOIN agent_run r ON r.session_id=i.session_id
                       WHERE i.active=1 AND r.${terminal}
                       AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=?)
                       AND r.workspace_path IS NULL
                       AND (NOT EXISTS (SELECT 1 FROM workspace w WHERE w.session_id=i.session_id)
                            OR EXISTS (SELECT 1 FROM workspace w WHERE w.session_id=i.session_id AND w.state='deleting'))`,
                    )
                    .all(now);
                  for (const orphan of orphans) {
                    const fencePath = orphanFencePath(root, orphan.session_id);
                    const existingFence = db
                      .query<
                        { canonical_path: string; state: string },
                        [string]
                      >(
                        "SELECT canonical_path, state FROM workspace WHERE session_id=?",
                      )
                      .get(orphan.session_id);
                    // A workspace row with its own real path is handled by the
                    // workspace deletion job above. Retry only our synthetic
                    // orphan fence here, preserving any published path/metadata.
                    if (
                      existingFence !== null &&
                      (existingFence.state !== "deleting" ||
                        existingFence.canonical_path !== fencePath)
                    )
                      continue;
                    db.query(`INSERT INTO workspace(session_id, canonical_path, repository_id, repository_url, repository_ref, state, created_at, updated_at)
                        VALUES (?, ?, '', '', '', 'deleting', ?, ?)
                        ON CONFLICT(session_id) DO UPDATE SET state='deleting', updated_at=excluded.updated_at`).run(
                      orphan.session_id,
                      fencePath,
                      now,
                      now,
                    );
                    orphanJobs.push({
                      sessionId: orphan.session_id,
                      uid: orphan.uid,
                      root,
                      fencePath,
                    });
                  }
                }
                return { jobs, orphanJobs, skippedWorkspaces };
              })
              .immediate(),
          "Retention.claim",
        );
        let workspaces = 0;
        let skippedWorkspaces = claimed.skippedWorkspaces;
        for (const job of claimed.jobs) {
          const removed = yield* Effect.tryPromise({
            try: async () => {
              await input.beforeRetireSession?.(job.sessionId);
              if (job.uid !== undefined) stopWorkerUidProcessesSync(job.uid);
              if (input.removeWorkspace === undefined)
                await removeWorkerWorkspace(
                  job.path,
                  job.root,
                  job.uid === undefined ? undefined : String(job.uid),
                );
              else await input.removeWorkspace(job.path);
            },
            catch: (error) =>
              new DatabaseError({
                message: "Retention workspace removal failed",
                cause: safeFailureCause(error),
              }),
          }).pipe(Effect.uninterruptible, Effect.result);
          if (Result.isFailure(removed)) {
            yield* Effect.logWarning(
              "Retention cleanup failed; deletion claim retained",
            ).pipe(
              Effect.annotateLogs({
                event: "retention.deletion_claim_retained",
                sessionId: job.sessionId,
                cause: removed.failure.cause ?? "unknown",
              }),
            );
            skippedWorkspaces++;
            continue;
          }
          const finalized = yield* tryDb(
            () =>
              db
                .transaction(() => {
                  // Failure keeps the deletion claim and uid reserved for recovery.
                  if (
                    job.identityUid !== undefined &&
                    !retireWorkerIdentitySync(
                      db,
                      job.sessionId,
                      job.identityUid,
                      job.root,
                      true,
                    )
                  )
                    return false;
                  db.query(
                    "DELETE FROM workspace WHERE session_id=? AND state='deleting'",
                  ).run(job.sessionId);
                  db.query("DELETE FROM driver_session WHERE session_id=?").run(
                    job.sessionId,
                  );
                  db.query(
                    "UPDATE agent_run SET workspace_path=NULL, omp_session_file=NULL WHERE session_id=?",
                  ).run(job.sessionId);
                  return true;
                })
                .immediate(),
            "Retention.finalize",
          );
          if (finalized) workspaces++;
          else skippedWorkspaces++;
        }
        for (const job of claimed.orphanJobs) {
          const cleaned = yield* Effect.tryPromise({
            try: () =>
              input.beforeRetireSession?.(job.sessionId) ?? Promise.resolve(),
            catch: (error) =>
              new DatabaseError({
                message: "Retention sandbox cleanup failed",
                cause: safeFailureCause(error),
              }),
          }).pipe(Effect.uninterruptible, Effect.result);
          if (Result.isFailure(cleaned)) {
            yield* Effect.logWarning(
              "Retention cleanup failed; deletion claim retained",
            ).pipe(
              Effect.annotateLogs({
                event: "retention.deletion_claim_retained",
                sessionId: job.sessionId,
                cause: cleaned.failure.cause ?? "unknown",
              }),
            );
            skippedWorkspaces++;
            continue;
          }
          const finalized = yield* tryDb(
            () =>
              db
                .transaction(() => {
                  const current = db
                    .query<
                      {
                        uid: number;
                        state: string;
                        lease_expires_at: number | null;
                        workspace_path: string | null;
                      },
                      [string]
                    >(
                      `SELECT i.uid, r.state, r.lease_expires_at, r.workspace_path
                       FROM worker_identity i JOIN agent_run r ON r.session_id=i.session_id
                       WHERE i.session_id=? AND i.active=1`,
                    )
                    .get(job.sessionId);
                  if (
                    current === null ||
                    current.uid !== job.uid ||
                    !["succeeded", "failed", "canceled"].includes(
                      current.state,
                    ) ||
                    (current.lease_expires_at !== null &&
                      current.lease_expires_at > now) ||
                    current.workspace_path !== null ||
                    db
                      .query(
                        "SELECT 1 FROM workspace WHERE session_id=? AND state='deleting' AND canonical_path=?",
                      )
                      .get(job.sessionId, job.fencePath) === null ||
                    db
                      .query(
                        "SELECT 1 FROM worker_identity WHERE uid=? AND active=1 AND session_id<>?",
                      )
                      .get(job.uid, job.sessionId) !== null
                  )
                    return false;
                  if (
                    !retireWorkerIdentitySync(
                      db,
                      job.sessionId,
                      job.uid,
                      job.root,
                      true,
                    )
                  )
                    return false;
                  db.query(
                    "DELETE FROM workspace WHERE session_id=? AND state='deleting'",
                  ).run(job.sessionId);
                  return true;
                })
                .immediate(),
            "Retention.finalizeOrphan",
          );
          if (!finalized) skippedWorkspaces++;
        }
        return yield* tryDb(() => {
          const root = canonicalRoot;
          const retired = db
            .query<
              { session_id: string; uid: number },
              [number]
            >(`SELECT i.session_id, i.uid FROM worker_identity i JOIN agent_run r ON r.session_id=i.session_id
        WHERE i.active=1 AND r.state IN ('succeeded','failed','canceled')
        AND (r.lease_expires_at IS NULL OR r.lease_expires_at<=?)
        AND NOT EXISTS (SELECT 1 FROM workspace w WHERE w.session_id=i.session_id AND w.state='deleting')`)
            .all(now);
          // Sandbox cleanup needs the durable workspace deletion fence above.
          // Never recycle an orphan through the native process-only path.
          for (const identity of input.beforeRetireSession === undefined
            ? retired
            : []) {
            if (root !== undefined)
              retireWorkerIdentitySync(
                db,
                identity.session_id,
                identity.uid,
                root,
              );
          }
          return { workspaces, skippedWorkspaces };
        }, "Retention.retireOrphans");
      }),
    );
};
