import { mkdir } from "node:fs/promises";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";
import {
  DatabaseError,
  InterruptedRunNoActionableInputError,
  RpcProtocolError,
} from "../src/domain/errors.js";
import { InputId, SourceKey, WorkspaceId } from "../src/domain/ids.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  testPath,
  orderEvents,
  withAuthority,
  testSessionId,
  testOrganizationId,
  install,
} = fixture;

describe("SessionAuthority infrastructure failures", () => {
  it.live(
    "keeps a run lookup database failure distinct from an absent run",
    () =>
      withAuthority((db) =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          yield* Effect.sync(() => db.exec("DROP TABLE agent_run"));

          const result = yield* Effect.result(
            authority.processSession(testSessionId),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("@Gateway/DatabaseError");
          }
        }),
      ),
  );

  it.live(
    "surfaces terminal state persistence failure instead of reporting terminal handling",
    () =>
      withAuthority((db) =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const runRepo = yield* RunRepo;
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* Effect.sync(() =>
            db.exec(
              "CREATE TRIGGER reject_terminal_update BEFORE UPDATE ON agent_run WHEN NEW.state = 'failed' BEGIN SELECT RAISE(FAIL, 'terminal persistence failed'); END",
            ),
          );

          const result = yield* Effect.result(
            authority.processSession(testSessionId),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("@Gateway/DatabaseError");
          }
        }),
      ),
  );

  it.live(
    "propagates projection persistence failure after terminal state persistence",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const runRepo = yield* RunRepo;
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          fixture.terminalFailure = new DatabaseError({
            message: "projection failed",
          });

          const result = yield* Effect.result(
            authority.processSession(testSessionId),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("@Gateway/DatabaseError");
          }
        }),
      ),
  );

  it.live(
    "stops and unregisters a worker when host-tool registration fails",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          fixture.hostToolRegistrationError = new RpcProtocolError({
            method: "set_host_tools",
            message: "forced host-tool registration failure",
          });
          yield* Effect.promise(() =>
            mkdir(testPath("host-tool-registration"), { recursive: true }),
          );
          yield* installationRepo.put(install(testOrganizationId));
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            workspacePath: Option.some(testPath("host-tool-registration")),
            ompSessionFile: Option.some(
              testPath("host-tool-registration/session.jsonl"),
            ),
          });

          const result = yield* Effect.result(
            authority.processSession(testSessionId),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({
              _tag: "@Gateway/RpcProtocolError",
              method: "set_host_tools",
              message: "forced host-tool registration failure",
            });
          }
          expect(orderEvents).toContain("worker-stopped");
          expect(yield* authority.activeWorkerCount()).toBe(0);
        }),
      ),
  );

  it.live(
    "returns a typed error for an interrupted run without actionable input",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          yield* installationRepo.put(install(testOrganizationId));
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            workspacePath: Option.some(fixture.authorityTestRoot),
          });

          const result = yield* Effect.result(
            authority.processSession(testSessionId),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(
              InterruptedRunNoActionableInputError,
            );
          }
        }),
      ),
  );

  it.live("surfaces a run-event persistence failure", () =>
    withAuthority((db) =>
      Effect.gen(function* () {
        const runEventRepo = yield* RunEventRepo;
        const runRepo = yield* RunRepo;
        yield* runRepo.create({
          sessionId: testSessionId,
          organizationId: testOrganizationId,
          issueId: Option.none(),
        });
        yield* Effect.sync(() =>
          db.exec(
            "CREATE TRIGGER reject_run_event BEFORE INSERT ON run_event BEGIN SELECT RAISE(FAIL, 'event persistence failed'); END",
          ),
        );

        const result = yield* Effect.result(
          runEventRepo.upsert({
            sourceKey: Schema.decodeUnknownSync(SourceKey)("authority-event"),
            sessionId: testSessionId,
            kind: "agent",
            level: "info",
            text: "event",
            payload: {},
            status: "observed",
            now: 0,
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("@Gateway/DatabaseError");
        }
      }),
    ),
  );

  it.live(
    "rolls back a run transition when its admin event cannot be persisted",
    () =>
      withAuthority((db) =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const runRepo = yield* RunRepo;
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* Effect.sync(() =>
            db.exec(
              "CREATE TRIGGER reject_authority_state_event BEFORE INSERT ON run_event BEGIN SELECT RAISE(FAIL, 'state event persistence failed'); END",
            ),
          );

          const result = yield* Effect.result(
            authority.processSession(testSessionId),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("@Gateway/DatabaseError");
          }
          const run = yield* runRepo.get(testSessionId);
          expect(Option.isSome(run)).toBe(true);
          if (Option.isSome(run)) expect(run.value.state).toBe("queued");
        }),
      ),
  );

  it.live(
    "surfaces markProcessed failure after a successful worker action",
    () =>
      withAuthority((db) =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          const runInputRepo = yield* RunInputRepo;
          yield* installationRepo.put(install(testOrganizationId));
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* Effect.promise(() =>
            mkdir(testPath("mark-failure"), { recursive: true }),
          );
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            repositoryId: Option.some(
              Schema.decodeUnknownSync(WorkspaceId)("repo-for-mark-failure"),
            ),
            workspacePath: Option.some(testPath("mark-failure")),
            ompSessionFile: Option.some(testPath("mark-failure/session.jsonl")),
          });
          yield* authority.processSession(testSessionId);
          yield* runInputRepo.enqueue({
            id: Schema.decodeUnknownSync(InputId)("mark-failure-input"),
            sessionId: testSessionId,
            kind: "prompted",
            body: "continue",
            payload: {},
          });
          yield* Effect.sync(() =>
            db.exec(
              "CREATE TRIGGER reject_input_processed BEFORE UPDATE OF processed_at ON run_input WHEN NEW.processed_at IS NOT NULL BEGIN SELECT RAISE(FAIL, 'mark processed failed'); END",
            ),
          );

          const result = yield* Effect.result(
            authority.processSession(testSessionId),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("@Gateway/DatabaseError");
          }
          const run = yield* runRepo.get(testSessionId);
          expect(Option.isSome(run)).toBe(true);
          if (Option.isSome(run)) expect(run.value.state).toBe("orphaned");
          expect(yield* runInputRepo.pending(testSessionId)).toHaveLength(1);
        }),
      ),
  );

  it.live(
    "continues terminal handling when best-effort lease release fails",
    () =>
      withAuthority((db) =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const runRepo = yield* RunRepo;
          const runInputRepo = yield* RunInputRepo;
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* runInputRepo.enqueue({
            id: Schema.decodeUnknownSync(InputId)("lease-cleanup-input"),
            sessionId: testSessionId,
            kind: "stop",
            body: "stop",
            payload: {},
          });
          yield* Effect.sync(() =>
            db.exec(
              "CREATE TRIGGER reject_lease_release_success BEFORE UPDATE ON agent_run WHEN OLD.lease_owner IS NOT NULL AND NEW.lease_owner IS NULL BEGIN SELECT RAISE(FAIL, 'lease release failed'); END",
            ),
          );

          yield* authority.processSession(testSessionId);

          const run = yield* runRepo.get(testSessionId);
          expect(Option.isSome(run)).toBe(true);
          if (Option.isSome(run)) {
            expect(run.value.state).toBe("canceled");
            expect(run.value.desiredState).toBe("canceled");
          }
        }),
      ),
  );

  it.live("keeps the primary projection failure when lease cleanup fails", () =>
    withAuthority((db) =>
      Effect.gen(function* () {
        const authority = yield* SessionAuthority;
        const runRepo = yield* RunRepo;
        yield* runRepo.create({
          sessionId: testSessionId,
          organizationId: testOrganizationId,
          issueId: Option.none(),
        });
        yield* Effect.sync(() =>
          db.exec(
            "CREATE TRIGGER reject_lease_release BEFORE UPDATE ON agent_run WHEN NEW.lease_owner IS NULL BEGIN SELECT RAISE(FAIL, 'lease release failed'); END",
          ),
        );
        fixture.terminalFailure = new DatabaseError({
          message: "primary projection failure",
        });

        const result = yield* Effect.result(
          authority.processSession(testSessionId),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.message).toBe("primary projection failure");
        }
      }),
    ),
  );
});
