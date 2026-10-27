import { mkdir } from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";
import { InputId, WorkspaceId } from "../src/domain/ids.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  AgentSettingsRepo,
  InstallationRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  testPath,
  workerSpawnInputs,
  withAuthority,
  testSessionId,
  testOrganizationId,
  install,
} = fixture;

describe("run settings startup snapshots", () => {
  it.effect.each(["firecracker", "sysbox"] as const)(
    "refuses a directly supplied %s config without a broker",
    (runtime) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          withAuthority(() => Effect.void, {
            configOverride: (config) => ({
              ...config,
              workerSandboxMode: runtime,
              sessionSandboxBrokerSocketPath: undefined,
            }),
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(String(result.failure)).toContain(
            "native execution is forbidden",
          );
        expect(workerSpawnInputs).toHaveLength(0);
      }),
  );

  it.effect("reuses the frozen settings snapshot on a worker retry", () =>
    withAuthority(() =>
      Effect.gen(function* () {
        const authority = yield* SessionAuthority;
        const runRepo = yield* RunRepo;
        const inputRepo = yield* RunInputRepo;
        const settingsRepo = yield* AgentSettingsRepo;
        const workspacePath = testPath("run-settings-retry");
        yield* InstallationRepo.use((repo) =>
          repo.put(install(testOrganizationId)),
        );
        yield* Effect.promise(() => mkdir(workspacePath, { recursive: true }));
        yield* runRepo.create({
          sessionId: testSessionId,
          organizationId: testOrganizationId,
          issueId: Option.none(),
        });
        yield* runRepo.update(testSessionId, {
          state: "orphaned",
          repositoryId: Option.some(
            Schema.decodeUnknownSync(WorkspaceId)("run-settings-retry-repo"),
          ),
          workspacePath: Option.some(workspacePath),
        });
        const enqueue = (id: string, label: string) =>
          inputRepo.enqueue({
            id: Schema.decodeUnknownSync(InputId)(id),
            sessionId: testSessionId,
            kind: "prompted",
            body: "continue",
            payload: {
              agentSession: { issue: { labels: [label] } },
            },
          });
        yield* enqueue("run-settings-first", "mode:full-access");

        yield* authority.processSession(testSessionId);
        expect(workerSpawnInputs).toHaveLength(1);
        expect(workerSpawnInputs[0]?.command).toContain("--approval-mode");
        expect(workerSpawnInputs[0]?.command).toContain("yolo");
        const firstSnapshot = Option.getOrThrow(
          yield* settingsRepo.getSnapshot(testSessionId, testOrganizationId),
        );
        expect(firstSnapshot.settings.runtimeMode).toBe("full-access");

        yield* authority.shutdown();
        yield* settingsRepo.upsert(testOrganizationId, {
          defaults: { mode: "approval-required" },
        });
        yield* runRepo.update(testSessionId, { state: "orphaned" });
        yield* enqueue("run-settings-retry", "mode:auto");
        yield* authority.processSession(testSessionId);

        expect(workerSpawnInputs).toHaveLength(2);
        expect(workerSpawnInputs[1]?.command).toContain("--approval-mode");
        expect(workerSpawnInputs[1]?.command).toContain("yolo");
        expect(workerSpawnInputs[1]?.command).not.toContain("always-ask");
        expect(
          Option.getOrThrow(
            yield* settingsRepo.getSnapshot(testSessionId, testOrganizationId),
          ).settings,
        ).toEqual(firstSnapshot.settings);
      }),
    ),
  );
});
