import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { DatabaseError, type RowDecodeError } from "../../domain/errors.js";
import { OrganizationId, SessionId } from "../../domain/ids.js";
import {
  type AgentSettings,
  DEFAULT_AGENT_SETTINGS,
  type EffectiveRunSettings,
  validateAgentSettings,
} from "../agent-settings.js";
import { decodeRow, SqliteClient, tryDb } from "./sqlite-client.js";

export interface RunSettingsSnapshot {
  readonly sessionId: SessionId;
  readonly organizationId: OrganizationId;
  readonly settings: EffectiveRunSettings;
  readonly createdAt: number;
}

const AgentSettingsRecord = Schema.Struct({
  organizationId: OrganizationId,
  settings: Schema.Unknown,
  updatedAt: Schema.Number,
});
const RunSettingsRecord = Schema.Struct({
  sessionId: SessionId,
  organizationId: OrganizationId,
  settings: Schema.Unknown,
  sources: Schema.Unknown,
  createdAt: Schema.Number,
});

export class AgentSettingsRepo extends Context.Service<AgentSettingsRepo>()(
  "AgentSettingsRepo",
  {
    make: Effect.gen(function* () {
      const { db } = yield* SqliteClient;

      const get = Effect.fn("AgentSettingsRepo.get")(function* (
        organizationId: string,
      ): Effect.fn.Return<AgentSettings, DatabaseError | RowDecodeError> {
        const row = yield* tryDb(
          () =>
            db
              .query<{ settings_json: string }, [string]>(
                "SELECT settings_json FROM agent_settings WHERE organization_id=?",
              )
              .get(organizationId),
          "AgentSettingsRepo.get",
        );
        if (row === null) return DEFAULT_AGENT_SETTINGS;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.settings_json);
        } catch {
          return yield* Effect.fail(
            new DatabaseError({ message: "Stored agent settings are invalid" }),
          );
        }
        try {
          return validateAgentSettings(parsed);
        } catch (error) {
          return yield* Effect.fail(
            new DatabaseError({
              message: `Stored agent settings are invalid: ${error instanceof Error ? error.message : String(error)}`,
            }),
          );
        }
      });

      const upsert = Effect.fn("AgentSettingsRepo.upsert")(function* (
        organizationId: string,
        input: unknown,
      ): Effect.fn.Return<AgentSettings, DatabaseError | RowDecodeError> {
        let settings: AgentSettings;
        try {
          settings = validateAgentSettings(input);
        } catch (error) {
          return yield* Effect.fail(
            new DatabaseError({
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        const now = yield* Clock.currentTimeMillis;
        yield* decodeRow(
          AgentSettingsRecord,
          { organizationId, settings, updatedAt: now },
          "AgentSettings",
        );
        yield* tryDb(
          () =>
            db
              .query(
                `INSERT INTO agent_settings (organization_id, settings_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(organization_id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at`,
              )
              .run(organizationId, JSON.stringify(settings), now),
          "AgentSettingsRepo.upsert",
        );
        return settings;
      });

      const getSnapshot = Effect.fn("AgentSettingsRepo.getSnapshot")(function* (
        sessionId: string,
      ): Effect.fn.Return<
        Option.Option<RunSettingsSnapshot>,
        DatabaseError | RowDecodeError
      > {
        const row = yield* tryDb(
          () =>
            db
              .query<
                {
                  session_id: string;
                  organization_id: string;
                  settings_json: string;
                  sources_json: string;
                  created_at: number;
                },
                [string]
              >("SELECT * FROM run_settings WHERE session_id=?")
              .get(sessionId),
          "AgentSettingsRepo.getSnapshot",
        );
        if (row === null) return Option.none();
        let settings: unknown;
        let sources: unknown;
        try {
          settings = JSON.parse(row.settings_json);
          sources = JSON.parse(row.sources_json);
        } catch {
          return yield* Effect.fail(
            new DatabaseError({ message: "Stored run settings are invalid" }),
          );
        }
        const decoded = yield* decodeRow(
          RunSettingsRecord,
          {
            sessionId: row.session_id,
            organizationId: row.organization_id,
            settings,
            sources,
            createdAt: row.created_at,
          },
          "RunSettings",
        );
        return Option.some({
          sessionId: decoded.sessionId,
          organizationId: decoded.organizationId,
          settings: {
            ...(decoded.settings as EffectiveRunSettings),
            sources: decoded.sources as EffectiveRunSettings["sources"],
          },
          createdAt: decoded.createdAt,
        });
      });

      const saveSnapshot = Effect.fn("AgentSettingsRepo.saveSnapshot")(
        function* (
          sessionId: string,
          organizationId: string,
          settings: EffectiveRunSettings,
        ): Effect.fn.Return<
          RunSettingsSnapshot,
          DatabaseError | RowDecodeError
        > {
          const now = yield* Clock.currentTimeMillis;
          yield* decodeRow(
            RunSettingsRecord,
            {
              sessionId,
              organizationId,
              settings,
              sources: settings.sources,
              createdAt: now,
            },
            "RunSettings",
          );
          yield* tryDb(
            () =>
              db
                .query(
                  `INSERT INTO run_settings (session_id, organization_id, settings_json, sources_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`,
                )
                .run(
                  sessionId,
                  organizationId,
                  JSON.stringify(settings),
                  JSON.stringify(settings.sources),
                  now,
                ),
            "AgentSettingsRepo.saveSnapshot",
          );
          const saved = yield* getSnapshot(sessionId);
          if (Option.isNone(saved))
            return yield* Effect.fail(
              new DatabaseError({
                message: "Run settings snapshot was not persisted",
              }),
            );
          return saved.value;
        },
      );

      return { get, upsert, getSnapshot, saveSnapshot };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies;
}
