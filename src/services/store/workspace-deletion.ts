import type { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { canonicalReference, isWithin } from "../../util/paths.js";

/** Call inside the transaction that records a workspace reference. */
export const assertWorkspaceAvailable = (
  db: Database,
  sessionId: string,
  path?: string | null,
): void => {
  const claims = db
    .query<{ session_id: string; canonical_path: string }, []>(
      "SELECT session_id, canonical_path FROM workspace WHERE state='deleting'",
    )
    .all();
  const canonical =
    path == null ? undefined : canonicalReference(resolve(path));
  for (const claim of claims) {
    if (
      claim.session_id === sessionId ||
      (path != null &&
        (canonical === undefined ||
          isWithin(claim.canonical_path, canonical) ||
          isWithin(canonical, claim.canonical_path)))
    )
      throw new Error("Workspace deletion is in progress; retry the operation");
  }
};
