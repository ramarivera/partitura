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

export const makeWorkspaceRetention = (input: {
  readonly db: Database;
  readonly workspaceRoot: string;
  readonly workspaceTtlMs: number;
  readonly maxWorkspaces: number;
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
                  `SELECT session_id, workspace_path FROM agent_run WHERE ${terminal}
         AND (updated_at<? OR EXISTS (SELECT 1 FROM workspace w WHERE w.session_id=agent_run.session_id AND w.state='deleting')) AND workspace_path IS NOT NULL
         AND (lease_expires_at IS NULL OR lease_expires_at<=?)`,
                );
                // Bind both cutoffs explicitly; the workspace grace is based on terminal update time.
                const rows = candidates.all(now - input.workspaceTtlMs, now);
                for (const row of rows) {
                  const path = resolve(row.workspace_path);
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
              SELECT session_id, workspace_path, COALESCE(repository_id,''), '', '', 'deleting', ?, ? FROM agent_run WHERE session_id=?
              ON CONFLICT(session_id) DO UPDATE SET state='deleting', updated_at=excluded.updated_at`).run(
                    now,
                    now,
                    row.session_id,
                  );
                  jobs.push({
                    sessionId: row.session_id,
                    path,
                    root,
                    uid,
                    identityUid: uid,
                  });
                }
                return { jobs, skippedWorkspaces };
              })
              .immediate(),
          "Retention.claim",
        );
        let workspaces = 0;
        let skippedWorkspaces = claimed.skippedWorkspaces;
        for (const job of claimed.jobs) {
          const removed = yield* Effect.tryPromise({
            try: async () => {
              if (job.uid !== undefined) stopWorkerUidProcessesSync(job.uid);
              if (input.removeWorkspace === undefined)
                await removeWorkerWorkspace(
                  job.path,
                  job.root,
                  job.uid === undefined ? undefined : String(job.uid),
                );
              else await input.removeWorkspace(job.path);
            },
            catch: () =>
              new DatabaseError({
                message: "Retention workspace removal failed",
              }),
          }).pipe(Effect.uninterruptible, Effect.result);
          if (Result.isFailure(removed)) {
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
          for (const identity of retired) {
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
