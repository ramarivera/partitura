import { mkdir } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";
import { SCRIPT_LIFECYCLE } from "../src/admin-ui/dashboard-script-lifecycle.js";
import { InputId, SessionId, WorkspaceId } from "../src/domain/ids.js";
import { createAdminHandle, deriveCsrfToken } from "../src/services/admin.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  AgentSettingsRepo,
  InstallationRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { deps as adminDeps, token } from "./admin-service-helpers.js";
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
  it.live(
    "saves admin UI defaults into the next worker without restarting authority",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const config = {
            ...adminDeps.config,
            allowedOrganizationIds: new Set([testOrganizationId]),
          };
          const settingsRepo = yield* AgentSettingsRepo;
          const runs = yield* RunRepo;
          const inputs = yield* RunInputRepo;
          yield* InstallationRepo.use((repo) =>
            repo.put(install(testOrganizationId)),
          );
          const handle = createAdminHandle({
            ...adminDeps,
            config,
            agentSettingsRepo: settingsRepo,
            adminSessionRepo: {
              ...adminDeps.adminSessionRepo,
              get: (...args) =>
                adminDeps.adminSessionRepo.get(...args).pipe(
                  Effect.map(
                    Option.map((session) => ({
                      ...session,
                      organizationId: testOrganizationId,
                    })),
                  ),
                ),
            },
          });
          const field = { value: "" };
          const status = { textContent: "" };
          const button = { disabled: false };
          const toggle = { checked: false };
          const elements = new Map<string, object>([
            ["agent-settings-json", field],
            ["agent-settings-status", status],
            ["agent-settings-save", button],
            ["agent-settings-full-access", toggle],
          ]);
          const writes: unknown[] = [];
          const saveSource = SCRIPT_LIFECYCLE.slice(
            SCRIPT_LIFECYCLE.indexOf("  async function saveAgentSettings()"),
            SCRIPT_LIFECYCLE.indexOf("  // ---- logout"),
          );
          const save = runInNewContext(`${saveSource}; saveAgentSettings`, {
            el: (id: string) => elements.get(id),
            AGENT_SETTINGS_URL: "/api/admin/agent-settings",
            fetchJSON: async (
              path: string,
              input: { method: string; body: unknown },
            ) => {
              writes.push(input.body);
              const response = Option.getOrThrow(
                await Effect.runPromise(
                  handle(
                    new Request(new URL(path, config.publicUrl), {
                      method: input.method,
                      headers: {
                        Cookie: `omp_gateway_admin=${token}`,
                        Origin: config.publicUrl.origin,
                        "x-csrf-token": deriveCsrfToken(token),
                        "content-type": "application/json",
                      },
                      body: JSON.stringify(input.body),
                    }),
                  ),
                ),
              );
              expect(response.status).toBe(200);
              return { data: await response.json() };
            },
          }) as () => Promise<void>;
          for (const [index, effort] of ["low", "high"].entries()) {
            field.value = JSON.stringify({ defaults: { effort } });
            yield* Effect.promise(save);
            expect(status.textContent).toBe(
              "Saved. New runs will use these settings.",
            );
            expect(button.disabled).toBe(false);
            const sessionId = Schema.decodeUnknownSync(SessionId)(
              `admin-default-next-${index}`,
            );
            const workspacePath = testPath(`admin-default-next-${index}`);
            yield* Effect.promise(() =>
              mkdir(workspacePath, { recursive: true }),
            );
            yield* runs.create({
              sessionId,
              organizationId: testOrganizationId,
              issueId: Option.none(),
            });
            yield* runs.update(sessionId, {
              state: "orphaned",
              workspacePath: Option.some(workspacePath),
              repositoryId: Option.some(
                Schema.decodeUnknownSync(WorkspaceId)(
                  `admin-default-repo-${index}`,
                ),
              ),
            });
            yield* inputs.enqueue({
              id: Schema.decodeUnknownSync(InputId)(
                `admin-default-input-${index}`,
              ),
              sessionId,
              kind: "prompted",
              body: "continue",
              payload: {},
            });
            yield* authority.processSession(sessionId);
            const snapshot = Option.getOrThrow(
              yield* settingsRepo.getSnapshot(sessionId, testOrganizationId),
            );
            expect(snapshot.settings.effort).toBe(effort);
            expect(snapshot.settings.sources.effort).toBe("admin-default");
            const command = workerSpawnInputs[index]?.command ?? [];
            expect(command).toContain("--thinking");
            expect(command).toContain(effort);
            expect(command).not.toContain(index === 0 ? "high" : "low");
          }
          expect(writes).toHaveLength(2);
          expect(
            Option.getOrThrow(
              yield* settingsRepo.getSnapshot(
                Schema.decodeUnknownSync(SessionId)("admin-default-next-0"),
                testOrganizationId,
              ),
            ).settings.effort,
          ).toBe("low");
        }),
      ),
  );
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
