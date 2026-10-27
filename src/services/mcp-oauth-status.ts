import type { Database } from "bun:sqlite";
import { Clock, Effect } from "effect";
import type { OrganizationId } from "../domain/ids.js";
import { StatusRow } from "./mcp-oauth-protocol.js";
import { decodeRows, tryDb } from "./store/sqlite-client.js";

export const makeMcpOAuthListStatuses = (db: Database) =>
  Effect.fn("McpOAuth.listStatuses")(function* (
    organizationId: OrganizationId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const rows = yield* tryDb(
      () =>
        db
          .query<StatusRow, [string]>(
            "SELECT server_id, server_url, expires_at FROM mcp_oauth_credential WHERE organization_id = ?",
          )
          .all(organizationId),
      "McpOAuth.listStatuses",
    );
    const decoded = yield* decodeRows(StatusRow, rows, "McpOAuthStatus");
    return new Map(
      decoded.map((row) => [
        row.server_id,
        {
          connected: true,
          serverUrl: row.server_url,
          expired: row.expires_at <= now,
          expiresAt: row.expires_at,
        },
      ]),
    );
  });
