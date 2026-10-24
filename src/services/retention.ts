import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Schedule,
} from "effect";
import { GatewayConfig } from "./config.js";
import { NixEnvironment } from "./nix-environment.js";
import { makeWorkspaceRetention } from "./retention-workspaces.js";
import { SqliteClient, tryDb } from "./store/sqlite-client.js";

const positiveInteger = (name: string, fallback: number) =>
  Config.String(name).pipe(
    Config.withDefault(String(fallback)),
    Config.mapEffect((value) => {
      const parsed = /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
      return Number.isSafeInteger(parsed) && parsed > 0
        ? Effect.succeed(parsed)
        : Effect.fail(
            new Config.ConfigError(
              new ConfigProvider.SourceError({
                message: `${name} must be a positive integer`,
              }),
            ),
          );
    }),
  );

const day = 24 * 60 * 60 * 1000;
export const retentionConfig = Config.all({
  intervalMs: positiveInteger("RETENTION_INTERVAL_MS", 60 * 60 * 1000),
  workspaceTtlMs: positiveInteger("RETENTION_WORKSPACE_TTL_MS", day),
  deliveryTtlMs: positiveInteger("RETENTION_DELIVERY_TTL_MS", 7 * day),
  eventTtlMs: positiveInteger("RETENTION_EVENT_TTL_MS", 7 * day),
  projectionTtlMs: positiveInteger("RETENTION_PROJECTION_TTL_MS", 30 * day),
  authGraceMs: positiveInteger("RETENTION_AUTH_GRACE_MS", day),
  nixStoreMaxBytes: positiveInteger("NIX_STORE_MAX_BYTES", 20 * 1024 ** 3),
});
export type RetentionPolicy = Config.Success<typeof retentionConfig>;

export const MAX_WORKSPACES_PER_SWEEP = 25;

const terminal = "state IN ('succeeded','failed','canceled')";

export const makeRetention = (input: {
  readonly db: import("bun:sqlite").Database;
  readonly workspaceRoot: string;
  readonly policy: RetentionPolicy;
  readonly webhookReplayWindowMs: number;
  readonly removeWorkspace?: (path: string) => void | Promise<void>;
}) => {
  const { db, policy } = input;
  const workspaceSweep = makeWorkspaceRetention({
    db,
    workspaceRoot: input.workspaceRoot,
    workspaceTtlMs: policy.workspaceTtlMs,
    maxWorkspaces: MAX_WORKSPACES_PER_SWEEP,
    removeWorkspace: input.removeWorkspace,
  });
  const sweep = (now: number) =>
    Effect.gen(function* () {
      const workspaceResult = yield* workspaceSweep(now);
      return yield* tryDb(() => {
        return db
          .transaction(() => {
            const terminalSessions = `SELECT session_id FROM agent_run WHERE ${terminal} AND updated_at<? AND (lease_expires_at IS NULL OR lease_expires_at<=?)`;
            // Retryable projections have a longer TTL than raw events. Once that
            // TTL expires for a terminal run, expire them too, unless a projector
            // still owns a live lease.
            const outbox = db
              .query(
                `DELETE FROM projection_outbox WHERE session_id IN (${terminalSessions}) AND updated_at<?
             AND (lease_expires_at IS NULL OR lease_expires_at<=?)`,
              )
              .run(
                now - policy.projectionTtlMs,
                now,
                now - policy.projectionTtlMs,
                now,
              ).changes;
            const projections =
              outbox +
              db
                .query(
                  `DELETE FROM activity_projection WHERE session_id IN (${terminalSessions}) AND updated_at<?
             AND NOT EXISTS (SELECT 1 FROM projection_outbox o WHERE o.source_key=activity_projection.source_key)`,
                )
                .run(
                  now - policy.projectionTtlMs,
                  now,
                  now - policy.projectionTtlMs,
                ).changes;
            const events = db
              .query(
                `DELETE FROM run_event WHERE session_id IN (${terminalSessions}) AND updated_at<?
         AND NOT EXISTS (SELECT 1 FROM activity_projection p WHERE p.source_key=run_event.source_key AND p.status<>'completed')
         AND NOT EXISTS (SELECT 1 FROM projection_outbox o WHERE o.source_key=run_event.source_key AND o.status<>'completed')`,
              )
              .run(
                now - policy.eventTtlMs,
                now,
                now - policy.eventTtlMs,
              ).changes;
            // Catch-up replays the entire Linear history. Keep processed input
            // identities and their original resume context until a durable catch-up
            // watermark exists; deleting them would execute historical prompts again.
            const inputs = 0;
            // Preserve delivery identities for deduplication. Drop their large raw payloads.
            const deliveries = db
              .query(
                "UPDATE webhook_delivery SET payload_json='null' WHERE status IN ('processed','failed') AND received_at<? AND payload_json<>'null'",
              )
              .run(
                now -
                  Math.max(policy.deliveryTtlMs, input.webhookReplayWindowMs),
              ).changes;
            let auth = 0;
            for (const table of [
              "oauth_state",
              "mcp_oauth_state",
              "admin_session",
            ] as const) {
              auth += db
                .query(`DELETE FROM ${table} WHERE expires_at<?`)
                .run(now - policy.authGraceMs).changes;
            }
            return {
              ...workspaceResult,
              events,
              projections,
              inputs,
              deliveries,
              auth,
            };
          })
          .immediate();
      }, "Retention.sweep");
    });
  return { sweep };
};

export class Retention extends Context.Service<Retention>()("Retention", {
  make: Effect.gen(function* () {
    const config = yield* GatewayConfig;
    const policy = yield* Config.unwrap(retentionConfig);
    const { db } = yield* SqliteClient;
    const nix = yield* NixEnvironment;
    const { sweep } = makeRetention({
      db,
      workspaceRoot: config.workspaceRoot,
      policy,
      webhookReplayWindowMs: config.webhookReplayWindowMs,
    });
    const sweepTick = Effect.gen(function* () {
      const result = yield* sweep(Date.now());
      yield* Effect.logInfo("Retention sweep finished").pipe(
        Effect.annotateLogs({ event: "retention.swept", ...result }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Retention sweep failed", cause),
      ),
    );
    const budgetTick = nix
      .enforceBudget(policy.nixStoreMaxBytes)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Nix store budget enforcement failed", cause),
        ),
      );
    return {
      sweep,
      run: Effect.repeat(
        Effect.andThen(sweepTick, budgetTick),
        Schedule.spaced(policy.intervalMs),
      ),
    };
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide([GatewayConfig.layer, NixEnvironment.layer]),
  );
}
