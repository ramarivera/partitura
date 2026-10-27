import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  InputId,
  SessionId,
  SourceKey,
  WorkspaceId,
} from "../src/domain/ids.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  projectorEvents,
  orderEvents,
  workerSpawnInputs,
  withAuthority,
  testSessionId,
  testOrganizationId,
  install,
  seedInterrupted,
} = fixture;

describe("Recovery and concurrency regressions", () => {
  it.effect.each(["starting", "running", "waiting", "orphaned"] as const)(
    "exhausts retries for an interrupted %s run without actionable input",
    (state) =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          yield* seedInterrupted(testSessionId, state);
          yield* RunRepo.use((service) =>
            service.update(testSessionId, {
              ompSessionFile: Option.none(),
            }),
          );
          for (let attempt = 1; attempt <= 5; attempt++) {
            yield* authority.processRunnable();
            const run = yield* RunRepo.use((service) =>
              service.get(testSessionId),
            );
            if (Option.isNone(run)) throw new Error("run missing");
            expect(run.value.attempt).toBe(attempt);
            expect(run.value.state).toBe(attempt === 5 ? "failed" : "orphaned");
            if (attempt < 5) {
              const next = Option.getOrThrow(run.value.nextAttemptAt);
              expect(next).toBeGreaterThan(yield* Clock.currentTimeMillis);
              yield* authority.processRunnable();
              expect(
                yield* RunRepo.use((service) => service.get(testSessionId)),
              ).toEqual(run);
              yield* TestClock.setTime(next + 1);
            }
          }
          expect(
            Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(testSessionId)),
            ).leaseOwner,
          ).toEqual(Option.none());
        }),
      ),
  );

  it.effect(
    "recovers a starting run that has neither workspace nor pending input",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          yield* seedInterrupted(testSessionId, "starting");
          yield* RunRepo.use((service) =>
            service.update(testSessionId, {
              workspacePath: Option.none(),
            }),
          );
          yield* authority.processRunnable();
          const run = Option.getOrThrow(
            yield* RunRepo.use((service) => service.get(testSessionId)),
          );
          expect(run.state).toBe("orphaned");
          expect(run.attempt).toBe(1);
          expect(Option.getOrNull(run.terminalReason)).toContain(
            "no workspace",
          );
        }),
      ),
  );

  it.live(
    "isolates materialization errors and continues to newer sessions",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const bad = Schema.decodeUnknownSync(SessionId)("a-broken-clone");
          const good = Schema.decodeUnknownSync(SessionId)("z-newer-session");
          const repoId =
            Schema.decodeUnknownSync(WorkspaceId)("broken-local-repo");
          yield* InstallationRepo.use((service) =>
            service.put(install(testOrganizationId)),
          );
          yield* WorkspaceRepo.use((service) =>
            service.createRepository({
              organizationId: testOrganizationId,
              id: repoId,
              url: join(fixture.authorityTestRoot, "missing-repository"),
              ref: "main",
              isDefault: true,
            }),
          );
          yield* RunRepo.use((service) =>
            service.create({
              sessionId: bad,
              organizationId: testOrganizationId,
              issueId: Option.none(),
            }),
          );
          yield* RunInputRepo.use((service) =>
            service.enqueue({
              id: Schema.decodeUnknownSync(InputId)("clone-input"),
              sessionId: bad,
              kind: "created",
              body: "work",
              payload: { organizationId: testOrganizationId },
            }),
          );
          yield* seedInterrupted(good);
          yield* authority.processRunnable();
          const failed = Option.getOrThrow(
            yield* RunRepo.use((service) => service.get(bad)),
          );
          expect(failed.state).toBe("orphaned");
          expect(failed.attempt).toBe(1);
          expect(Option.getOrNull(failed.terminalReason)).toContain(
            "Repository must be an HTTPS GitHub URL with a valid ref",
          );
          expect(
            Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(good)),
            ).state,
          ).toBe("running");
          expect(yield* authority.activeWorkerCount()).toBe(1);
        }),
      ),
  );

  it.effect.each(["canceled", "started", "unavailable"] as const)(
    "verifies a deferred %s stop before retry backoff and full worker capacity",
    (issueState) =>
      withAuthority(
        () =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            const busy = Schema.decodeUnknownSync(SessionId)("busy-worker");
            yield* seedInterrupted(busy);
            yield* authority.processSession(busy);
            yield* seedInterrupted(testSessionId);
            const deadline = (yield* Clock.currentTimeMillis) + 60_000;
            yield* RunRepo.use((service) =>
              service.update(testSessionId, {
                nextAttemptAt: Option.some(deadline),
              }),
            );
            const inputId = Schema.decodeUnknownSync(InputId)("backoff-stop");
            yield* RunInputRepo.use((service) =>
              service.enqueue({
                id: inputId,
                sessionId: testSessionId,
                kind: "stop",
                body: "Issue status changed",
                payload: {
                  type: "AppUserNotification",
                  action: "issueStatusChanged",
                  notification: { issueId: "issue-1" },
                },
              }),
            );
            fixture.linearIssueStateType = issueState;
            fixture.linearIssueLookupFails = issueState === "unavailable";
            yield* authority.processSession(testSessionId);
            const run = Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(testSessionId)),
            );
            expect(run.state).toBe(
              issueState === "canceled" ? "canceled" : "orphaned",
            );
            expect(run.desiredState).toBe(
              issueState === "canceled" ? "canceled" : "running",
            );
            expect(
              yield* RunInputRepo.use((service) =>
                service.pending(testSessionId),
              ),
            ).toHaveLength(issueState === "unavailable" ? 1 : 0);
            expect(run.attempt).toBe(0);
            expect(run.leaseOwner).toEqual(Option.none());
            expect(workerSpawnInputs).toHaveLength(1);
            expect(yield* authority.activeWorkerCount()).toBe(1);
          }),
        { withLinearGateway: true, config: [["MAX_CONCURRENT_WORKERS", "1"]] },
      ),
  );

  it.effect(
    "leaves a deferred stop untouched while another authority owns its lease",
    () =>
      withAuthority(
        (db) =>
          Effect.gen(function* () {
            yield* seedInterrupted(testSessionId);
            yield* RunInputRepo.use((service) =>
              service.enqueue({
                id: Schema.decodeUnknownSync(InputId)("foreign-owned-stop"),
                sessionId: testSessionId,
                kind: "stop",
                body: "Issue status changed",
                payload: {
                  type: "AppUserNotification",
                  action: "issueStatusChanged",
                  notification: { issueId: "issue-1" },
                },
              }),
            );
            db.query(
              "UPDATE agent_run SET lease_owner='other-authority', lease_expires_at=? WHERE session_id=?",
            ).run((yield* Clock.currentTimeMillis) + 60_000, testSessionId);
            fixture.linearIssueStateType = "canceled";
            const before = yield* RunRepo.use((service) =>
              service.get(testSessionId),
            );
            yield* SessionAuthority.use((service) =>
              service.processSession(testSessionId),
            );
            expect(
              yield* RunRepo.use((service) => service.get(testSessionId)),
            ).toEqual(before);
            expect(
              yield* RunInputRepo.use((service) =>
                service.pending(testSessionId),
              ),
            ).toHaveLength(1);
          }),
        { withLinearGateway: true },
      ),
  );

  it.effect.each(["matching", "mismatched", "missing", "invalid"] as const)(
    "uses only the current retry event with a %s schedule",
    (schedule) =>
      withAuthority((db) =>
        Effect.gen(function* () {
          yield* seedInterrupted(testSessionId);
          const repositoryId =
            Schema.decodeUnknownSync(WorkspaceId)("targeted-retry");
          yield* WorkspaceRepo.use((service) =>
            service.createRepository({
              organizationId: testOrganizationId,
              id: repositoryId,
              url: "https://example.invalid/unused",
              ref: "main",
            }),
          );
          yield* RunRepo.use((service) =>
            service.update(testSessionId, {
              repositoryId: Option.some(repositoryId),
            }),
          );
          const deadline = (yield* Clock.currentTimeMillis) + 60_000;
          yield* RunRepo.use((service) =>
            service.update(testSessionId, {
              nextAttemptAt: Option.some(deadline),
            }),
          );
          if (schedule !== "missing")
            yield* RunEventRepo.use((service) =>
              service.upsert({
                sourceKey: Schema.decodeUnknownSync(SourceKey)(
                  `retry:${testSessionId}:0`,
                ),
                sessionId: testSessionId,
                kind: "retry",
                level: "info",
                payload: {
                  nextAttemptAt:
                    schedule === "mismatched" ? deadline + 1 : deadline,
                  scheduledAt: schedule === "invalid" ? "bad" : 0,
                },
              }),
            );
          if (schedule === "missing") {
            db.query("DELETE FROM run_event WHERE source_key=?").run(
              `retry:${testSessionId}:0`,
            );
          }
          // An unrelated, unreadable payload must not be loaded on a retry tick.
          yield* RunEventRepo.use((service) =>
            service.upsert({
              sourceKey: Schema.decodeUnknownSync(SourceKey)(
                `rpc:${testSessionId}:7:progress`,
              ),
              sessionId: testSessionId,
              kind: "progress",
              level: "info",
            }),
          );
          db.query(
            "UPDATE run_event SET payload_json='invalid' WHERE kind='progress'",
          ).run();
          yield* RunInputRepo.use((service) =>
            service.enqueue({
              id: Schema.decodeUnknownSync(InputId)("fresh-prompt"),
              sessionId: testSessionId,
              kind: "prompted",
              body: "Continue",
              payload: {},
              createdAt: 1,
            }),
          );
          yield* SessionAuthority.use((service) =>
            service.processSession(testSessionId),
          );
          expect(workerSpawnInputs).toHaveLength(
            schedule === "matching" ? 1 : 0,
          );
          expect(
            Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(testSessionId)),
            ).attempt,
          ).toBe(schedule === "matching" ? 1 : 0);
        }),
      ),
  );

  it.effect("seeds event sequence from persisted events after restart", () =>
    withAuthority((db) =>
      Effect.gen(function* () {
        const authority = yield* SessionAuthority;
        yield* seedInterrupted(testSessionId);
        yield* RunEventRepo.use((service) =>
          service.upsert({
            sessionId: testSessionId,
            sourceKey: Schema.decodeUnknownSync(SourceKey)(
              `rpc:${testSessionId}:40:progress`,
            ),
            kind: "progress",
            level: "info",
            payload: { type: "progress", message: "old" },
          }),
        );
        // Sequence seeding must read keys without decoding historical payloads.
        db.query(
          "UPDATE run_event SET payload_json='unreadable history' WHERE source_key=?",
        ).run(`rpc:${testSessionId}:40:progress`);
        for (const sequence of [41, 42]) {
          yield* authority.processSession(testSessionId);
          const observed = yield* Deferred.make<void>();
          fixture.projectionWaiter = observed;
          fixture.projectionExpected = sequence - 40;
          if (fixture.workerEventListener === undefined)
            throw new Error("listener missing");
          fixture.workerEventListener({
            type: "progress",
            message: `new-${sequence}`,
          });
          yield* Deferred.await(observed);
          expect(projectorEvents.at(-1)?.sequence).toBe(sequence);
          yield* authority.shutdown();
          yield* RunRepo.use((service) =>
            service.update(testSessionId, {
              state: "orphaned",
              ompSessionFile: Option.some(
                join(fixture.authorityTestRoot, "session.jsonl"),
              ),
            }),
          );
        }
        db.query("UPDATE run_event SET payload_json=? WHERE source_key=?").run(
          JSON.stringify({ type: "progress", message: "old" }),
          `rpc:${testSessionId}:40:progress`,
        );
        const events = (yield* RunEventRepo.use((service) =>
          service.list(testSessionId),
        )).filter((event) => event.kind === "progress");
        expect(events).toHaveLength(3);
        expect(
          events.find((event) => event.sourceKey.endsWith(":40:progress"))
            ?.payload,
        ).toEqual({ type: "progress", message: "old" });
      }),
    ),
  );

  it.effect("drops a crashed worker and retries it with backoff", () =>
    withAuthority(() =>
      Effect.gen(function* () {
        const authority = yield* SessionAuthority;
        yield* seedInterrupted(testSessionId);
        yield* authority.processSession(testSessionId);
        if (fixture.workerEventListener === undefined)
          throw new Error("listener missing");
        fixture.workerEventListener({
          type: "worker_exited",
          message: "worker exited with code 17",
        });
        yield* Effect.repeat(Effect.yieldNow, {
          until: () => orderEvents.includes("worker-stopped"),
        });
        yield* Effect.repeat(Effect.yieldNow, {
          until: () => fixture.workerEventListener === undefined,
        });
        // Wait for the event consumer's failure transaction, without a real clock.
        yield* Effect.repeat(
          RunRepo.use((service) => service.get(testSessionId)),
          {
            until: (run) =>
              Option.isSome(run) && run.value.state === "orphaned",
          },
        );
        expect(yield* authority.activeWorkerCount()).toBe(0);
        const run = Option.getOrThrow(
          yield* RunRepo.use((service) => service.get(testSessionId)),
        );
        expect(run.attempt).toBe(1);
        expect(Option.getOrNull(run.terminalReason)).toContain("code 17");
        expect(Option.isSome(run.nextAttemptAt)).toBe(true);
      }),
    ),
  );

  it.effect(
    "leaves waiting runs without workspaces idle until actionable input arrives",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          yield* seedInterrupted(testSessionId);
          yield* RunRepo.use((service) =>
            service.update(testSessionId, {
              state: "waiting",
              workspacePath: Option.none(),
              ompSessionFile: Option.none(),
            }),
          );
          for (let tick = 0; tick < 4; tick++)
            yield* SessionAuthority.use((service) => service.processRunnable());
          const run = Option.getOrThrow(
            yield* RunRepo.use((service) => service.get(testSessionId)),
          );
          expect(run.state).toBe("waiting");
          expect(run.attempt).toBe(0);
          expect(run.terminalReason).toEqual(Option.none());
          expect(workerSpawnInputs).toHaveLength(0);
          const repositoryId =
            Schema.decodeUnknownSync(WorkspaceId)("waiting-repository");
          yield* WorkspaceRepo.use((service) =>
            service.createRepository({
              organizationId: testOrganizationId,
              id: repositoryId,
              url: "https://github.com/fixture/waiting.git",
              ref: "main",
            }),
          );
          yield* RunRepo.use((service) =>
            service.update(testSessionId, {
              workspacePath: Option.some(fixture.authorityTestRoot),
              repositoryId: Option.some(repositoryId),
            }),
          );
          yield* RunInputRepo.use((service) =>
            service.enqueue({
              id: Schema.decodeUnknownSync(InputId)("waiting-prompt"),
              sessionId: testSessionId,
              kind: "prompted",
              body: "Start working",
              payload: {},
            }),
          );
          yield* SessionAuthority.use((service) =>
            service.processSession(testSessionId),
          );
          expect(workerSpawnInputs).toHaveLength(1);
          expect(
            Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(testSessionId)),
            ).state,
          ).toBe("running");
        }),
      ),
  );

  it.effect(
    "caps concurrent workers and admits a waiting session when capacity is released",
    () =>
      withAuthority(
        () =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            const next = Schema.decodeUnknownSync(SessionId)("second-worker");
            yield* seedInterrupted(testSessionId);
            yield* seedInterrupted(next);
            yield* Effect.all(
              [
                authority.processSession(testSessionId),
                authority.processSession(next),
              ],
              { concurrency: "unbounded" },
            );
            expect(workerSpawnInputs).toHaveLength(1);
            expect(yield* authority.activeWorkerCount()).toBe(1);
            const first = Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(testSessionId)),
            );
            const second = Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(next)),
            );
            const blocked = first.state === "running" ? next : testSessionId;
            expect(
              [first.state, second.state].filter(
                (state) => state === "running",
              ),
            ).toHaveLength(1);
            expect(
              Option.getOrThrow(
                yield* RunRepo.use((service) => service.get(blocked)),
              ).state,
            ).not.toBe("running");
            yield* authority.shutdown();
            yield* authority.processSession(blocked);
            expect(workerSpawnInputs).toHaveLength(2);
            expect(
              Option.getOrThrow(
                yield* RunRepo.use((service) => service.get(blocked)),
              ).state,
            ).toBe("running");
          }),
        { config: [["MAX_CONCURRENT_WORKERS", "1"]] },
      ),
  );

  it.effect(
    "renews healthy workers while another session is blocked preparing Nix",
    () =>
      withAuthority(
        () =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            yield* seedInterrupted(testSessionId);
            yield* authority.processSession(testSessionId);
            const blocked =
              Schema.decodeUnknownSync(SessionId)("slow-preparation");
            const repoId = Schema.decodeUnknownSync(WorkspaceId)("slow-nix");
            yield* seedInterrupted(blocked);
            yield* WorkspaceRepo.use((service) =>
              service.createRepository({
                organizationId: testOrganizationId,
                id: repoId,
                url: "https://example.invalid/unused",
                ref: "main",
              }),
            );
            yield* RunRepo.use((service) =>
              service.update(blocked, {
                repositoryId: Option.some(repoId),
              }),
            );
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            fixture.nixPrepareBlock = { entered, release };
            const preparation = yield* Effect.forkChild(
              authority.processSession(blocked),
            );
            yield* Deferred.await(entered);
            for (let step = 0; step < 12; step++) yield* TestClock.adjust(100);
            const now = yield* Clock.currentTimeMillis;
            const run = Option.getOrThrow(
              yield* RunRepo.use((service) => service.get(testSessionId)),
            );
            expect(Option.getOrThrow(run.leaseExpiresAt)).toBeGreaterThan(now);
            expect(yield* authority.activeWorkerCount()).toBe(1);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(preparation);
            expect(yield* authority.activeWorkerCount()).toBe(2);
          }),
        { config: [["LEASE_DURATION_MS", "600"]] },
      ),
  );
});
