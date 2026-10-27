import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schedule, Schema } from "effect";
import { InputId, WorkspaceId } from "../src/domain/ids.js";
import { NixPackageName } from "../src/domain/models.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  PromptTemplateRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { createDriverFixture } from "./session-authority-driver-fixture.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const { seedDriverRun, awaitState, withT3Authority, t3Server } =
  createDriverFixture(fixture);
const {
  projectorEvents,
  toolExternalUrlCalls,
  workerPrompts,
  orderEvents,
  workerSpawnInputs,
  withAuthority,
  testSessionId,
  testOrganizationId,
} = fixture;

describe("AgentDriver authority integration", () => {
  it.live(
    "stops both drivers when persisting their session fails before registration",
    () =>
      Effect.gen(function* () {
        const server = yield* t3Server;
        for (const driver of ["omp", "t3"] as const) {
          yield* withAuthority(
            (db) =>
              Effect.gen(function* () {
                yield* seedDriverRun(driver);
                yield* Effect.sync(() =>
                  db.exec(
                    "CREATE TRIGGER fail_driver_session BEFORE INSERT ON driver_session BEGIN SELECT RAISE(ABORT, 'persistence failed'); END",
                  ),
                );
                const authority = yield* SessionAuthority;
                const result = yield* authority
                  .processSession(testSessionId)
                  .pipe(Effect.result);
                expect(Result.isFailure(result)).toBe(true);
                expect(yield* authority.activeWorkerCount()).toBe(0);
                if (driver === "omp")
                  expect(orderEvents).toContain("worker-stopped");
                else {
                  yield* Effect.sync(() => server.activeSocketCount()).pipe(
                    Effect.repeat({
                      while: (count) => count > 0,
                      schedule: Schedule.spaced(5),
                    }),
                    Effect.timeout(1000),
                  );
                  expect(server.activeSocketCount()).toBe(0);
                }
              }),
            {
              withLinearGateway: true,
              config: [
                ["T3_BASE_URL", server.baseUrl.toString()],
                ["T3_ALLOW_PRIVATE_NETWORK_HTTP", "true"],
                ["T3_TOKEN", server.token],
                ["T3_PROVIDER_INSTANCE", "codex-cliproxy"],
                ["T3_MODEL", "gpt-6-sol"],
              ],
            },
          );
        }
      }),
  );
  it.live(
    "rejects remote T3 repository Nix packages instead of omitting them",
    () =>
      Effect.gen(function* () {
        const server = yield* t3Server;
        yield* withT3Authority(
          () =>
            Effect.gen(function* () {
              yield* seedDriverRun("t3");
              yield* (yield* WorkspaceRepo).updateRepository(
                testOrganizationId,
                Schema.decodeUnknownSync(WorkspaceId)("driver-repo"),
                {
                  nixPackages: [
                    Schema.decodeUnknownSync(NixPackageName)("nodejs"),
                  ],
                },
              );
              const result = yield* (yield* SessionAuthority)
                .processSession(testSessionId)
                .pipe(Effect.result);
              expect(Result.isFailure(result)).toBe(true);
              if (Result.isFailure(result))
                expect(result.failure.message).toContain(
                  "Remote T3 cannot receive repository Nix packages",
                );
              expect(server.projectMutations).toEqual([]);
            }),
          server,
        );
      }),
  );
  it.live(
    "denies retained non-gateway Git credentials before remote T3 opens the workspace",
    () =>
      Effect.gen(function* () {
        const server = yield* t3Server;
        for (const config of [
          '[http "https://github.com/"]\nextraheader = AUTHORIZATION: bearer retained-secret\n',
          "[credential]\nhelper = store\n",
          '[remote "origin"]\nurl = https://user:retained-secret@github.com/org/repo\n',
          "[include]\npath = /secret/config\n",
        ])
          yield* withT3Authority(
            () =>
              Effect.gen(function* () {
                const { configPath } = yield* seedDriverRun("t3");
                yield* Effect.promise(() => writeFile(configPath, config));
                const result = yield* (yield* SessionAuthority)
                  .processSession(testSessionId)
                  .pipe(Effect.result);
                expect(Result.isFailure(result)).toBe(true);
                if (Result.isFailure(result)) {
                  expect(result.failure.message).toContain(
                    "T3 refused non-gateway workspace Git credentials",
                  );
                  expect(result.failure.message).not.toContain(
                    "retained-secret",
                  );
                }
                expect(server.projectMutations).toEqual([]);
              }),
            server,
          );
      }),
  );
  it.live(
    "denies non-gateway Git credentials before the private daemon starts",
    () =>
      withAuthority(
        () =>
          Effect.gen(function* () {
            const { configPath } = yield* seedDriverRun("t3");
            yield* Effect.promise(() =>
              writeFile(
                configPath,
                '[http "https://github.com/"]\nextraheader = AUTHORIZATION: bearer retained-secret\n',
              ),
            );
            const result = yield* (yield* SessionAuthority)
              .processSession(testSessionId)
              .pipe(Effect.result);
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result))
              expect(result.failure.message).toBe(
                "T3 refused non-gateway workspace Git credentials or config includes",
              );
            expect(workerSpawnInputs).toHaveLength(0);
          }),
        {
          withLinearGateway: true,
          config: [
            ["T3_MODE", "launch"],
            ["T3_CLI_PATH", "/must-not-execute-t3"],
            ["T3_PROVIDER_INSTANCE", "codex-cliproxy"],
            ["T3_MODEL", "gpt-6-sol"],
            ["CLIPROXYAPI_BASE_URL", "https://cliproxyapi.example.test"],
            ["CLIPROXYAPI_API_KEY", "proxy-client-key"],
          ],
        },
      ),
  );
  it.live(
    "runs T3 with the same projection/terminal lifecycle and persists its native ref",
    () =>
      Effect.gen(function* () {
        const server = yield* t3Server;
        yield* withT3Authority(
          () =>
            Effect.gen(function* () {
              const authority = yield* SessionAuthority;
              const repositories = yield* WorkspaceRepo;
              const { cwd, configPath } = yield* seedDriverRun("t3");
              yield* (yield* PromptTemplateRepo).upsert({
                organizationId: testOrganizationId,
                kind: "contract",
                body: "Org OMP contract: use linear_get_issue, linear_create_comment, linear_add_external_url and rromp_report_deviation, then push.",
                updatedAt: 0,
              });
              yield* authority.processSession(testSessionId);
              const ref = Option.getOrThrow(
                yield* repositories.getDriverSession(testSessionId),
              );
              expect(ref.driver).toBe("t3");
              expect(workerSpawnInputs).toHaveLength(0);
              expect(server.projects.size).toBe(1);
              expect([...server.projects.values()][0]?.workspaceRoot).toBe(cwd);
              expect(
                yield* Effect.promise(() => readFile(configPath, "utf8")),
              ).not.toContain("AUTHORIZATION");
              const command = server.commandsOf("message.dispatch")[0];
              const prompt = JSON.stringify(command);
              expect(prompt).toContain("No Git or GitHub credential");
              expect(prompt).toContain("don't try to push");
              expect(prompt).not.toContain("Org OMP contract");
              expect(prompt).not.toContain("rromp_report_deviation");
              expect(prompt).not.toContain("linear_get_issue");
              expect(command?.messageId).toBe(
                `symphony:${ref.nativeId}:message:driver-input`,
              );
              expect(JSON.stringify(server.requests)).not.toContain(
                "access-token",
              );
              server.updateRun(ref.nativeId, "run-1", { status: "running" });
              server.upsertItem(ref.nativeId, {
                id: "tool-1",
                type: "command_execution",
                runId: "run-1",
                status: "running",
                ordinal: 1,
                input: "bun test",
              });
              server.upsertItem(ref.nativeId, {
                id: "todo-1",
                type: "todo_list",
                runId: "run-1",
                status: "completed",
                ordinal: 2,
                steps: [
                  { id: "step-1", text: "Tests passed", status: "completed" },
                ],
              });
              server.upsertItem(ref.nativeId, {
                id: "message-1",
                type: "assistant_message",
                runId: "run-1",
                status: "completed",
                ordinal: 3,
                messageId: "assistant-1",
                text: "Fixed. https://github.com/org/repo/pull/12",
                streaming: false,
              });
              server.updateRun(ref.nativeId, "run-1", { status: "completed" });
              yield* awaitState("succeeded");
              expect(
                projectorEvents.some(
                  ({ event }) => event.type === "tool_execution_start",
                ),
              ).toBe(true);
              expect(
                projectorEvents.some(({ event }) => event.type === "agent_end"),
              ).toBe(true);
              expect(toolExternalUrlCalls).toContainEqual({
                sessionId: testSessionId,
                urls: [
                  {
                    label: "Pull request",
                    url: "https://github.com/org/repo/pull/12",
                  },
                ],
              });
              expect(
                Option.getOrThrow(yield* (yield* RunRepo).get(testSessionId))
                  .ompSessionFile,
              ).toEqual(Option.none());
            }),
          server,
        );
      }),
  );
  it.live(
    "auto-approves T3 requests through the cancellation mutation gate",
    () =>
      Effect.gen(function* () {
        const server = yield* t3Server;
        yield* withT3Authority(
          () =>
            Effect.gen(function* () {
              yield* seedDriverRun("t3");
              const authority = yield* SessionAuthority;
              yield* authority.processSession(testSessionId);
              const ref = Option.getOrThrow(
                yield* (yield* WorkspaceRepo).getDriverSession(testSessionId),
              );
              server.upsertItem(ref.nativeId, {
                id: "approval",
                type: "approval_request",
                runId: "run-1",
                status: "waiting",
                ordinal: 1,
                requestId: "approval-1",
                requestKind: "command",
                prompt: "Run tests?",
                options: [{ decision: "accept", label: "Allow once" }],
              });
              server.upsertRequest(ref.nativeId, {
                id: "approval-1",
                kind: "command",
                status: "pending",
              });
              yield* Effect.repeat(
                Effect.sync(
                  () => server.commandsOf("runtime-request.respond").length,
                ),
                {
                  while: (count) => count === 0,
                  schedule: Schedule.spaced(5),
                },
              ).pipe(
                Effect.timeoutOrElse({
                  duration: 3_000,
                  orElse: () => Effect.die(new Error("approval not handled")),
                }),
              );
              expect(
                server.commandsOf("runtime-request.respond")[0],
              ).toMatchObject({ requestId: "approval-1", decision: "accept" });
              const inputs = yield* RunInputRepo;
              yield* inputs.enqueue({
                id: Schema.decodeUnknownSync(InputId)("driver-stop"),
                sessionId: testSessionId,
                kind: "stop",
                body: "stop",
                payload: {},
              });
              yield* authority.processSession(testSessionId);
              expect(
                Option.getOrThrow(yield* (yield* RunRepo).get(testSessionId))
                  .state,
              ).toBe("canceled");
              expect(yield* authority.activeWorkerCount()).toBe(0);
            }),
          server,
        );
      }),
  );
  it.live(
    "falls back to webhook driver labels when Linear is unavailable",
    () =>
      Effect.gen(function* () {
        const server = yield* t3Server;
        for (const t3Configured of [false, true]) {
          for (const webhookOverride of [false, true]) {
            yield* withAuthority(
              () =>
                Effect.gen(function* () {
                  yield* seedDriverRun(
                    webhookOverride ? "t3" : "omp",
                    webhookOverride ? ["driver:omp"] : [],
                  );
                  fixture.linearIssueLookupFails = true;
                  yield* (yield* PromptTemplateRepo).upsert({
                    organizationId: testOrganizationId,
                    kind: "contract",
                    body: "Stored OMP contract",
                    updatedAt: 0,
                  });
                  yield* (yield* SessionAuthority).processSession(
                    testSessionId,
                  );
                  expect(workerSpawnInputs).toHaveLength(1);
                  expect(workerPrompts[0]).toContain("Stored OMP contract");
                  expect(server.threads.size).toBe(0);
                  expect(
                    Option.getOrThrow(
                      yield* (yield* WorkspaceRepo).getDriverSession(
                        testSessionId,
                      ),
                    ).driver,
                  ).toBe("omp");
                }),
              {
                withLinearGateway: true,
                config: t3Configured
                  ? [
                      ["T3_BASE_URL", server.baseUrl.toString()],
                      ["T3_ALLOW_PRIVATE_NETWORK_HTTP", "true"],
                      ["T3_TOKEN", server.token],
                      ["T3_PROVIDER_INSTANCE", "codex-cliproxy"],
                      ["T3_MODEL", "gpt-6-sol"],
                    ]
                  : [],
              },
            );
          }
        }
      }),
  );

  it.live(
    "reads Linear's current driver label over the stored repository default",
    () =>
      Effect.gen(function* () {
        const server = yield* t3Server;
        yield* withT3Authority(
          () =>
            Effect.gen(function* () {
              yield* seedDriverRun("t3");
              fixture.linearIssueLabels = ["driver:omp"];
              yield* (yield* SessionAuthority).processSession(testSessionId);
              expect(workerSpawnInputs).toHaveLength(1);
              expect(server.threads.size).toBe(0);
              expect(
                Option.getOrThrow(
                  yield* (yield* WorkspaceRepo).getDriverSession(testSessionId),
                ).driver,
              ).toBe("omp");
            }),
          server,
        );
      }),
  );
  it.live(
    "fails closed before contacting remote T3 when uid or container isolation is active",
    () =>
      Effect.gen(function* () {
        const server = yield* t3Server;
        for (const sandboxMode of [false, "firecracker", "sysbox"] as const)
          yield* withT3Authority(
            () =>
              Effect.gen(function* () {
                yield* seedDriverRun("t3");
                const result = yield* (yield* SessionAuthority)
                  .processSession(testSessionId)
                  .pipe(Effect.result);
                expect(Result.isFailure(result)).toBe(true);
                if (Result.isFailure(result))
                  expect(result.failure.message).toContain(
                    "shared T3 daemon cannot serve isolated worker workspaces",
                  );
                expect(server.threads.size).toBe(0);
                expect(server.projectMutations).toHaveLength(0);
                expect(workerSpawnInputs).toHaveLength(0);
                expect(
                  Option.getOrThrow(yield* (yield* RunRepo).get(testSessionId))
                    .state,
                ).toBe("orphaned");
              }),
            server,
            sandboxMode ? undefined : "10001",
            sandboxMode,
          );
      }),
  );
});
