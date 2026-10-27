import { it } from "@effect/vitest";
import { Config, ConfigProvider, Effect, Layer, Result, Schema } from "effect";
import { afterEach, describe, expect, vi } from "vitest";
import { InputId, SessionId, SourceKey } from "../src/domain/ids.js";
import { LinearGateway } from "../src/services/linear-gateway.js";
import { Reconciler } from "../src/services/reconciler.js";
import {
  makeRetention,
  type RetentionPolicy,
  retentionConfig,
} from "../src/services/retention.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import { RunEventRepo } from "../src/services/store/run-event-repo.js";
import { RunInputRepo } from "../src/services/store/run-input-repo.js";
import { RunRepo } from "../src/services/store/run-repo.js";
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

describe("retention", () => {
  it.live(
    "deduplicates historical prompts and stops after retention and session resumption",
    () =>
      Effect.gen(function* () {
        const { db } = yield* SqliteClient;
        const inputs = yield* RunInputRepo;
        const sessionId = Schema.decodeUnknownSync(SessionId)("session");
        insertRun(db, sessionId, "running");
        for (const [activity, kind] of [
          ["old-prompt", "prompted"],
          ["old-stop", "stop"],
        ] as const) {
          const id = Schema.decodeUnknownSync(InputId)(
            `${sessionId}:${kind}:${activity}`,
          );
          yield* inputs.enqueue({
            id,
            sessionId,
            kind,
            body: "original context",
            payload: {},
            createdAt: 1,
          });
          yield* inputs.markProcessed(id, 2);
        }
        db.query(
          "UPDATE agent_run SET state='succeeded', desired_state='running', updated_at=1",
        ).run();
        expect(
          (yield* makeRetention({
            db,
            workspaceRoot: testPath("root"),
            policy,
            webhookReplayWindowMs: 100,
          }).sweep(now)).inputs,
        ).toBe(0);
        expect(db.query("SELECT COUNT(*) AS n FROM run_input").get()).toEqual({
          n: 2,
        });
        db.query("UPDATE agent_run SET state='running', updated_at=1").run();
        const gateway = {
          listSessionActivities: () =>
            Effect.succeed([
              {
                id: "old-prompt",
                type: "prompt" as const,
                body: "original context",
                title: null,
                signal: null,
                createdAt: new Date(1).toISOString(),
              },
              {
                id: "old-stop",
                type: "prompt" as const,
                body: "stop",
                title: null,
                signal: "stop",
                createdAt: new Date(1).toISOString(),
              },
            ]),
        } as unknown as LinearGateway["Service"];
        const authority = SessionAuthority.of({
          processSession: () => Effect.void,
          processRunnable: () => Effect.void,
          shutdown: () => Effect.void,
          activeWorkerCount: () => Effect.succeed(0),
        });
        yield* Effect.gen(function* () {
          yield* (yield* Reconciler).catchup();
        }).pipe(
          Effect.provide(
            Reconciler.layerWithoutDependencies.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(SessionAuthority, authority),
                  Layer.succeed(LinearGateway, gateway),
                ),
              ),
            ),
          ),
        );
        expect(yield* inputs.pending(sessionId)).toEqual([]);
        expect(
          db.query("SELECT state, desired_state FROM agent_run").get(),
        ).toEqual({ state: "running", desired_state: "running" });
        expect(db.query("SELECT COUNT(*) AS n FROM run_input").get()).toEqual({
          n: 2,
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(RunInputRepo.layer, RunRepo.layer).pipe(
            Layer.provideMerge(SqliteClientLive(":memory:")),
          ),
        ),
      ),
  );

  it("validates retention configuration and provides production defaults", async () => {
    const defaults = await Effect.runPromise(
      Config.unwrap(retentionConfig).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(Object.fromEntries(new Map()), {
            preserveEmptyStrings: true,
          }),
        ),
      ),
    );
    expect(defaults.workspaceTtlMs).toBe(86400000);
    expect(defaults.nixStoreMaxBytes).toBe(20 * 1024 ** 3);
    for (const value of ["0", "-1", "1e3", "1.5", "invalid"]) {
      const result = await Effect.runPromise(
        Effect.result(
          Config.unwrap(retentionConfig).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown(
                Object.fromEntries(
                  new Map([["RETENTION_EVENT_TTL_MS", value]]),
                ),
                { preserveEmptyStrings: true },
              ),
            ),
          ),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
    }
  });
});
describe("run event pagination", () => {
  it.live(
    "bounds pages and uses source keys to disambiguate equal timestamps",
    () =>
      Effect.gen(function* () {
        const repo = yield* RunEventRepo;
        const { db } = yield* SqliteClient;
        insertRun(db, "session", "running");
        const sessionId = Schema.decodeUnknownSync(SessionId)("session");
        // Legacy admin detail callers still receive the complete history.
        for (let index = 0; index < 105; index++)
          yield* repo.upsert({
            sessionId,
            sourceKey: Schema.decodeUnknownSync(SourceKey)(
              `event-${String(index).padStart(3, "0")}`,
            ),
            kind: "rpc",
            level: "info",
            now: 1,
          });
        expect(yield* repo.list(sessionId)).toHaveLength(105);
        expect(yield* repo.list(sessionId, {})).toHaveLength(105);
        const first = yield* repo.list(sessionId, { limit: 100 });
        expect(first).toHaveLength(100);
        const last = first.at(-1);
        if (last === undefined) throw new Error("Expected a first page");
        const second = yield* repo.list(sessionId, {
          limit: 3,
          cursor: { createdAt: last.createdAt, sourceKey: last.sourceKey },
        });
        expect(second.map((event) => event.sourceKey)).toEqual([
          "event-100",
          "event-101",
          "event-102",
        ]);
        expect(
          yield* repo.list(sessionId, {
            cursor: { createdAt: 2, sourceKey: "" },
          }),
        ).toEqual([]);
        expect(yield* repo.list(sessionId, { limit: 0 })).toHaveLength(1);
      }).pipe(
        Effect.provide(
          RunEventRepo.layer.pipe(
            Layer.provideMerge(SqliteClientLive(":memory:")),
          ),
        ),
      ),
  );
});
