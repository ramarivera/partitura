import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Option, Schema } from "effect";
import * as fc from "fast-check";
import {
  InputId,
  OrganizationId,
  SessionId,
  WorkspaceId,
} from "../src/domain/ids.js";
import type { RpcEvent } from "../src/services/rpc-worker.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  PromptTemplateRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  testPath,
  projectorEvents,
  projectorElicitations,
  projectorTerminals,
  workerPrompts,
  workerSpawnInputs,
  withAuthority,
  testSessionId,
  testOrganizationId,
  install,
} = fixture;

describe("SessionAuthority behavior invariants", () => {
  it.effect(
    "persists each worker event once with distinct sequence keys",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          sessionId: fc.uuid(),
          type: fc.constantFrom(
            ...[
              "agent_start",
              "turn_start",
              "turn_end",
              "tool_execution_start",
              "tool_execution_end",
              "message_end",
              "prompt_result",
            ],
          ),
        });
        const check = ({
          sessionId,
          type,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withAuthority(() =>
            Effect.gen(function* () {
              const sid = Schema.decodeUnknownSync(SessionId)(sessionId);
              const organizationId = Schema.decodeUnknownSync(OrganizationId)(
                `organization-${sessionId}`,
              );
              const authority = yield* SessionAuthority;
              const runRepo = yield* RunRepo;
              const installationRepo = yield* InstallationRepo;
              const runEventRepo = yield* RunEventRepo;
              yield* runRepo.create({
                sessionId: sid,
                organizationId,
                issueId: Option.none(),
              });
              yield* installationRepo.put(install(organizationId));
              yield* runRepo.update(sid, {
                state: "orphaned",
                workspacePath: Option.some(testPath("temporary")),
                ompSessionFile: Option.some(testPath("session.jsonl")),
              });
              yield* authority.processSession(sid);

              const projected = yield* Deferred.make<void>();
              fixture.projectionWaiter = projected;
              fixture.projectionExpected = 2;
              const event: RpcEvent = { type };
              yield* Effect.sync(() => {
                if (fixture.workerEventListener === undefined)
                  throw new Error("worker event listener was not registered");
                fixture.workerEventListener(event);
                fixture.workerEventListener(event);
              });
              yield* Deferred.await(projected);

              const persisted = (yield* runEventRepo.list(sid)).filter(
                (item) =>
                  typeof item.payload === "object" &&
                  item.payload !== null &&
                  "type" in item.payload &&
                  item.payload.type === type,
              );
              expect(persisted).toHaveLength(2);
              expect(
                new Set(persisted.map((item) => item.sourceKey)).size,
              ).toBe(2);
              expect(persisted.map((item) => item.payload)).toEqual([
                event,
                event,
              ]);
            }),
          );
        const context =
          yield* Effect.context<Effect.Services<ReturnType<typeof check>>>();
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(cases, (sample) =>
              Effect.runPromiseWith(context)(check(sample)),
            ),
            { numRuns: 10 },
          ),
        );
      }),
    { timeout: 15_000 },
  );

  it.effect(
    "records UI requests and transitions the run to waiting",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          sessionId: fc.uuid(),
          requestId: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
        });
        const check = ({
          sessionId,
          requestId,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withAuthority(() =>
            Effect.gen(function* () {
              const sid = Schema.decodeUnknownSync(SessionId)(sessionId);
              const organizationId = Schema.decodeUnknownSync(OrganizationId)(
                `organization-${sessionId}`,
              );
              const authority = yield* SessionAuthority;
              const runRepo = yield* RunRepo;
              const installationRepo = yield* InstallationRepo;
              const runEventRepo = yield* RunEventRepo;
              yield* runRepo.create({
                sessionId: sid,
                organizationId,
                issueId: Option.none(),
              });
              yield* installationRepo.put(install(organizationId));
              yield* runRepo.update(sid, {
                state: "orphaned",
                workspacePath: Option.some(testPath("temporary")),
                ompSessionFile: Option.some(testPath("session.jsonl")),
              });
              yield* authority.processSession(sid);

              const elicitationObserved = yield* Deferred.make<void>();
              fixture.elicitationWaiter = elicitationObserved;
              const event: RpcEvent = {
                type: "extension_ui_request",
                id: requestId,
                method: "confirm",
                title: "Continue?",
                message: "Proceed with the task?",
                options: ["yes", "no"],
              };
              yield* Effect.sync(() => {
                if (fixture.workerEventListener === undefined)
                  throw new Error("worker event listener was not registered");
                fixture.workerEventListener(event);
              });
              yield* Deferred.await(elicitationObserved);

              const run = yield* runRepo.get(sid);
              const persisted = yield* runEventRepo.list(sid);
              const uiEvent = persisted.find(
                (item) =>
                  typeof item.payload === "object" &&
                  item.payload !== null &&
                  "type" in item.payload &&
                  item.payload.type === "extension_ui_request",
              );
              expect(Option.isSome(run)).toBe(true);
              if (Option.isSome(run)) expect(run.value.state).toBe("waiting");
              expect(uiEvent).toMatchObject({
                sourceKey: `rpc-ui:${requestId}`,
                kind: "extension_ui_request",
                level: "warn",
                payload: event,
              });
              expect(projectorElicitations).toContainEqual({
                sessionId: sid,
                sourceKey: `rpc-ui:${requestId}`,
                text: "Continue?\n\nProceed with the task?",
                options: ["yes", "no"],
              });
            }),
          );
        const context =
          yield* Effect.context<Effect.Services<ReturnType<typeof check>>>();
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(cases, (sample) =>
              Effect.runPromiseWith(context)(check(sample)),
            ),
            { numRuns: 20 },
          ),
        );
      }),
    { timeout: 15_000 },
  );

  it.effect(
    "round-trips generated worker events through event and projector layers",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          sessionId: fc.uuid(),
          type: fc.constantFrom(
            ...[
              "agent_start",
              "turn_start",
              "turn_end",
              "agent_end",
              "tool_execution_start",
              "message_end",
              "prompt_result",
              "progress",
            ],
          ),
        });
        const check = ({
          sessionId,
          type,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withAuthority(() =>
            Effect.gen(function* () {
              const sid = Schema.decodeUnknownSync(SessionId)(sessionId);
              const organizationId = Schema.decodeUnknownSync(OrganizationId)(
                `organization-${sessionId}`,
              );
              const authority = yield* SessionAuthority;
              const runRepo = yield* RunRepo;
              const installationRepo = yield* InstallationRepo;
              const runEventRepo = yield* RunEventRepo;
              yield* runRepo.create({
                sessionId: sid,
                organizationId,
                issueId: Option.none(),
              });
              yield* installationRepo.put(install(organizationId));
              yield* runRepo.update(sid, {
                state: "orphaned",
                workspacePath: Option.some(testPath("temporary")),
                ompSessionFile: Option.some(testPath("session.jsonl")),
              });
              yield* authority.processSession(sid);

              const projected = yield* Deferred.make<void>();
              fixture.projectionWaiter = projected;
              fixture.projectionExpected = 1;
              const event: RpcEvent = { type };
              yield* Effect.sync(() => {
                if (fixture.workerEventListener === undefined)
                  throw new Error("worker event listener was not registered");
                fixture.workerEventListener(event);
              });
              yield* Deferred.await(projected);

              const persisted = (yield* runEventRepo.list(sid)).filter(
                (item) =>
                  typeof item.payload === "object" &&
                  item.payload !== null &&
                  "type" in item.payload &&
                  item.payload.type === type,
              );
              expect(persisted).toHaveLength(1);
              expect(persisted[0]?.payload).toEqual(event);
              expect(persisted[0]?.sessionId).toBe(sid);
              expect(persisted[0]?.level).toMatch(
                /^(debug|info|warn|result|error)$/,
              );
              expect(projectorEvents).toContainEqual({
                sessionId: sid,
                sequence: expect.any(Number),
                event,
              });
            }),
          );
        const context =
          yield* Effect.context<Effect.Services<ReturnType<typeof check>>>();
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(cases, (sample) =>
              Effect.runPromiseWith(context)(check(sample)),
            ),
            { numRuns: 20 },
          ),
        );
      }),
    { timeout: 15_000 },
  );

  it.effect(
    "persists cancellation outcomes for both stop and canceled desired state",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          sessionId: fc.uuid(),
          desiredState: fc.constantFrom(...(["running", "canceled"] as const)),
          inputKind: fc.constantFrom(...(["prompted", "stop"] as const)),
        });
        const check = ({
          sessionId,
          desiredState,
          inputKind,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withAuthority((db) =>
            Effect.gen(function* () {
              const sid = Schema.decodeUnknownSync(SessionId)(sessionId);
              const organizationId = Schema.decodeUnknownSync(OrganizationId)(
                `organization-${sessionId}`,
              );
              const authority = yield* SessionAuthority;
              const runRepo = yield* RunRepo;
              const runInputRepo = yield* RunInputRepo;
              const runEventRepo = yield* RunEventRepo;
              const installationRepo = yield* InstallationRepo;
              const inputId = Schema.decodeUnknownSync(InputId)(
                `input-${sessionId}`,
              );
              yield* runRepo.create({
                sessionId: sid,
                organizationId,
                issueId: Option.none(),
              });
              yield* installationRepo.put(install(organizationId));
              yield* runInputRepo.enqueue({
                id: inputId,
                sessionId: sid,
                kind: inputKind,
                body: inputKind === "stop" ? "stop" : "cancel this run",
                payload: { source: "property" },
              });
              if (desiredState === "canceled" && inputKind === "prompted") {
                yield* Effect.sync(() =>
                  db
                    .query(
                      "UPDATE agent_run SET desired_state='canceled' WHERE session_id=?",
                    )
                    .run(sid),
                );
              }
              yield* authority.processSession(sid);

              const run = yield* runRepo.get(sid);
              const persisted = yield* runEventRepo.list(sid);
              const shouldCancel =
                desiredState === "canceled" || inputKind === "stop";
              expect(Option.isSome(run)).toBe(true);
              if (Option.isSome(run)) {
                expect(run.value.state).toBe(
                  shouldCancel ? "canceled" : "waiting",
                );
                expect(run.value.desiredState).toBe(
                  shouldCancel ? "canceled" : "running",
                );
              }
              expect(
                persisted.some(
                  (item) =>
                    item.kind === "state" &&
                    typeof item.payload === "object" &&
                    item.payload !== null &&
                    "to" in item.payload &&
                    item.payload.to === (shouldCancel ? "canceled" : "waiting"),
                ),
              ).toBe(true);
              if (shouldCancel) {
                expect(projectorTerminals).toContainEqual({
                  sessionId: sid,
                  sourceKey: `stop:${sid}`,
                  kind: "response",
                  text: "Stopped as requested.",
                });
              }
            }),
          );
        const context =
          yield* Effect.context<Effect.Services<ReturnType<typeof check>>>();
        yield* Effect.promise(() =>
          fc.assert(
            fc.asyncProperty(cases, (sample) =>
              Effect.runPromiseWith(context)(check(sample)),
            ),
            { numRuns: 20 },
          ),
        );
      }),
    { timeout: 15_000 },
  );

  it.effect.each([true, false])(
    "schedules a follow-up prompt when the preceding stop was already processed: %s",
    (processStopFirst) =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const runRepo = yield* RunRepo;
          const runInputRepo = yield* RunInputRepo;
          const installationRepo = yield* InstallationRepo;
          const workspaceRepo = yield* WorkspaceRepo;
          const repositoryId =
            Schema.decodeUnknownSync(WorkspaceId)("resume-repository");
          yield* installationRepo.put(install(testOrganizationId));
          yield* workspaceRepo.createRepository({
            organizationId: testOrganizationId,
            id: repositoryId,
            url: "https://example.com/repository.git",
            ref: "main",
            nixPackages: [],
          });
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* runRepo.update(testSessionId, {
            state: processStopFirst ? "running" : "succeeded",
            repositoryId: Option.some(repositoryId),
            workspacePath: Option.some(testPath("resume-workspace")),
            ompSessionFile: Option.some(
              testPath("resume-workspace/session.jsonl"),
            ),
          });

          yield* runInputRepo.enqueue({
            id: Schema.decodeUnknownSync(InputId)("superseded-prompt"),
            sessionId: testSessionId,
            kind: "prompted",
            body: "this prompt must be canceled by the later stop",
            payload: {},
            createdAt: 0,
          });
          yield* runInputRepo.enqueue({
            id: Schema.decodeUnknownSync(InputId)("stop-input"),
            sessionId: testSessionId,
            kind: "stop",
            body: "stop",
            payload: {},
          });
          if (processStopFirst) yield* authority.processRunnable();

          const stopped = yield* runRepo.get(testSessionId);
          expect(Option.isSome(stopped)).toBe(true);
          if (Option.isSome(stopped) && processStopFirst) {
            expect(stopped.value.state).toBe("canceled");
            expect(stopped.value.desiredState).toBe("canceled");
          }
          expect(yield* runInputRepo.listSessionsWithPendingInputs()).toEqual(
            processStopFirst ? [] : [testSessionId],
          );
          if (processStopFirst)
            expect(projectorTerminals).toContainEqual({
              sessionId: testSessionId,
              sourceKey: `stop:${testSessionId}`,
              kind: "response",
              text: "Stopped as requested.",
            });

          yield* runInputRepo.enqueue({
            id: Schema.decodeUnknownSync(InputId)("resume-input"),
            sessionId: testSessionId,
            kind: "prompted",
            body: "please continue the task",
            payload: {},
          });
          yield* authority.processRunnable();
          if (!processStopFirst) yield* authority.processRunnable();

          const resumed = yield* runRepo.get(testSessionId);
          expect(Option.isSome(resumed)).toBe(true);
          if (Option.isSome(resumed)) {
            // startWorker marks the run running once the worker accepts the
            // prompt.
            expect(resumed.value.state).toBe("running");
            expect(resumed.value.desiredState).toBe("running");
            expect(resumed.value.terminalReason).toEqual(Option.none());
          }
          expect(workerSpawnInputs).toHaveLength(1);
          expect(workerSpawnInputs[0]?.command).toContain("--session");
          expect(workerSpawnInputs[0]?.command).toContain(
            testPath("resume-workspace/session.jsonl"),
          );
          expect(workerSpawnInputs[0]?.cwd).toBe(testPath("resume-workspace"));
          expect(workerPrompts).toEqual(["please continue the task"]);
          expect(yield* runInputRepo.pending(testSessionId)).toEqual([]);
        }),
      ),
    { timeout: 15_000 },
  );

  it.live("renders the prompted template at prompt time", () =>
    withAuthority(() =>
      Effect.gen(function* () {
        const authority = yield* SessionAuthority;
        const installationRepo = yield* InstallationRepo;
        const runRepo = yield* RunRepo;
        const runInputRepo = yield* RunInputRepo;
        const templateRepo = yield* PromptTemplateRepo;
        const workspaceRepo = yield* WorkspaceRepo;
        yield* installationRepo.put(install(testOrganizationId));
        yield* templateRepo.upsert({
          organizationId: testOrganizationId,
          kind: "prompted",
          body: "Follow-up:\n{{userRequest}}",
          updatedAt: 0,
        });
        const repositoryId = Schema.decodeUnknownSync(WorkspaceId)(
          "prompt-template-repository",
        );
        yield* workspaceRepo.createRepository({
          organizationId: testOrganizationId,
          id: repositoryId,
          url: "https://example.com/repository.git",
          ref: "main",
          nixPackages: [],
        });
        yield* runRepo.create({
          sessionId: testSessionId,
          organizationId: testOrganizationId,
          issueId: Option.none(),
        });
        yield* runRepo.update(testSessionId, {
          state: "running",
          repositoryId: Option.some(repositoryId),
          workspacePath: Option.some(testPath("resume-workspace")),
          ompSessionFile: Option.some(
            testPath("resume-workspace/session.jsonl"),
          ),
        });

        yield* runInputRepo.enqueue({
          id: Schema.decodeUnknownSync(InputId)("stop-input"),
          sessionId: testSessionId,
          kind: "stop",
          body: "stop",
          payload: {},
        });
        yield* authority.processSession(testSessionId);

        yield* runInputRepo.enqueue({
          id: Schema.decodeUnknownSync(InputId)("resume-input"),
          sessionId: testSessionId,
          kind: "prompted",
          body: "please continue the task",
          payload: {},
        });
        yield* authority.processSession(testSessionId);

        // The raw input body stays literal; the worker receives the
        // template-rendered prompt.
        expect(workerPrompts).toEqual(["Follow-up:\nplease continue the task"]);
      }),
    ),
  );
});
