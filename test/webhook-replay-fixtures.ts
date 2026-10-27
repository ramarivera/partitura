import { Effect, Schema } from "effect";
import { expect } from "vitest";
import { DeliveryId } from "../src/domain/ids.js";
import { DeliveryRepo } from "../src/services/store/repositories.js";
import { payloadHash } from "../src/services/webhook.js";

export const crashDeliveryId =
  Schema.decodeUnknownSync(DeliveryId)("crash-delivery");
export const replayStatus = (db: import("bun:sqlite").Database) => {
  const row = db
    .query<{ status: string; error: string | null }, []>(
      "SELECT status, error FROM webhook_delivery WHERE delivery_id='crash-delivery'",
    )
    .get();
  if (row === null) throw new Error("Missing crash delivery");
  return row;
};
export const auditCounts = (db: import("bun:sqlite").Database) =>
  db
    .query<{ operation: string; count: number }, []>(
      "SELECT operation, COUNT(*) AS count FROM replay_audit GROUP BY operation ORDER BY operation",
    )
    .all();
export const setupReplayAudit = (db: import("bun:sqlite").Database) =>
  db.exec(`
  CREATE TABLE replay_audit (operation TEXT NOT NULL);
  CREATE TRIGGER replay_installation AFTER UPDATE ON installation BEGIN
    INSERT INTO replay_audit VALUES ('installation');
  END;
  CREATE TRIGGER replay_input AFTER INSERT ON run_input BEGIN
    INSERT INTO replay_audit VALUES ('input');
  END;
`);
export const crashWebhookProcess = (
  databasePath: string,
  checkpoint: string,
  payload: Record<string, unknown>,
) =>
  Effect.promise(async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        new URL("./fixtures/webhook-crash.ts", import.meta.url).pathname,
        databasePath,
        checkpoint,
        JSON.stringify(payload),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({
      code: 86,
      stdout: "",
      stderr: "",
    });
  });

export const storeReplay = (
  payload: Record<string, unknown>,
  token = "original-owner",
) =>
  DeliveryRepo.use((repo) =>
    repo.claim({
      id: crashDeliveryId,
      organizationId: "org",
      payload,
      payloadHash: payloadHash(
        new TextEncoder().encode(JSON.stringify(payload)),
      ),
      payloadVersion: 1,
      claimToken: token,
    }),
  );
