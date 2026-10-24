import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { OrganizationId, SessionId } from "../src/domain/ids.js";
import type { EffectiveRunSettings } from "../src/services/agent-settings.js";
import { AgentSettingsRepo } from "../src/services/store/agent-settings-repo.js";
import { RunEventRepo } from "../src/services/store/run-event-repo.js";
import { RunRepo } from "../src/services/store/run-repo.js";
import {
  SqliteClient,
  SqliteClientLive,
} from "../src/services/store/sqlite-client.js";

const organizationId = Schema.decodeUnknownSync(OrganizationId)("org-settings");
const sessionId = Schema.decodeUnknownSync(SessionId)("session-settings");
const layers = Layer.mergeAll(
  AgentSettingsRepo.layer,
  RunRepo.layer.pipe(Layer.provide(RunEventRepo.layer)),
).pipe(Layer.provideMerge(SqliteClientLive(":memory:")));

describe("AgentSettingsRepo", () => {
  it.effect(
    "reads hot organization defaults and freezes the first run snapshot",
    () =>
      Effect.gen(function* () {
        const repo = yield* AgentSettingsRepo;
        const runs = yield* RunRepo;
        expect((yield* repo.get(organizationId)).allowFullAccessViaLabel).toBe(
          true,
        );
        yield* repo.upsert(organizationId, {
          defaults: { driver: "t3", model: "codex" },
          modelAliases: {
            codex: { t3: { instanceId: "cliproxy", model: "gpt-6-sol" } },
          },
        });
        expect((yield* repo.get(organizationId)).defaults.driver).toBe("t3");
        yield* runs.create({
          sessionId,
          organizationId,
          issueId: Option.none(),
        });
        const settings: EffectiveRunSettings = {
          driver: "t3",
          modelAlias: "codex",
          ompModel: null,
          t3Model: { instanceId: "cliproxy", model: "gpt-6-sol" },
          effort: null,
          runtimeMode: "auto",
          warnings: [],
          sources: {
            driver: "admin-default",
            model: "admin-default",
            effort: "environment",
            mode: "environment",
          },
        };
        const first = yield* repo.saveSnapshot(
          sessionId,
          organizationId,
          settings,
        );
        yield* repo.upsert(organizationId, {
          defaults: { driver: "omp" },
          modelAliases: {},
        });
        const second = yield* repo.saveSnapshot(sessionId, organizationId, {
          ...settings,
          driver: "omp",
          modelAlias: null,
          t3Model: null,
        });
        expect(first.settings).toEqual(settings);
        expect(second.settings).toEqual(settings);
        expect(
          Option.getOrThrow(yield* repo.getSnapshot(sessionId, organizationId))
            .settings,
        ).toEqual(settings);
      }).pipe(Effect.provide(layers)),
  );

  it.effect(
    "decodes snapshot contents and rejects organization mismatches",
    () =>
      Effect.gen(function* () {
        const repo = yield* AgentSettingsRepo;
        const runs = yield* RunRepo;
        yield* runs.create({
          sessionId,
          organizationId,
          issueId: Option.none(),
        });
        const settings: EffectiveRunSettings = {
          driver: "omp",
          modelAlias: null,
          ompModel: "cliproxyapi/gpt-6-sol",
          t3Model: null,
          effort: null,
          runtimeMode: "auto",
          warnings: [],
          sources: {
            driver: "environment",
            model: "environment",
            effort: "environment",
            mode: "environment",
          },
        };
        yield* repo.saveSnapshot(sessionId, organizationId, settings);
        const wrongOrganization = yield* repo
          .getSnapshot(
            sessionId,
            Schema.decodeUnknownSync(OrganizationId)("org-other"),
          )
          .pipe(Effect.result);
        expect(wrongOrganization).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "@Gateway/DatabaseError" },
        });

        const { db } = yield* SqliteClient;
        yield* Effect.sync(() =>
          db
            .query("UPDATE run_settings SET settings_json=? WHERE session_id=?")
            .run(JSON.stringify({ ...settings, driver: "shell" }), sessionId),
        );
        const corruptSettings = yield* repo
          .getSnapshot(sessionId, organizationId)
          .pipe(Effect.result);
        expect(corruptSettings).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "@Gateway/RowDecodeError",
            entity: "RunSettings",
          },
        });
        yield* Effect.sync(() =>
          db
            .query(
              "UPDATE run_settings SET settings_json=?, sources_json=? WHERE session_id=?",
            )
            .run(
              JSON.stringify(settings),
              JSON.stringify({ driver: "invalid" }),
              sessionId,
            ),
        );
        const corruptSources = yield* repo
          .getSnapshot(sessionId, organizationId)
          .pipe(Effect.result);
        expect(corruptSources).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "@Gateway/RowDecodeError",
            entity: "RunSettings",
          },
        });
      }).pipe(Effect.provide(layers)),
  );
});
