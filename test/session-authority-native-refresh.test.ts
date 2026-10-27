import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option } from "effect";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { fleetFixture } from "./fixtures/native-build-fleet.js";
import { testPaths } from "./fixtures/paths.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const path = testPaths();
const fixture = createAuthorityFixture();
const { testSessionId, testOrganizationId, install, withAuthority } = fixture;
it.live(
  "actual per-run refresh tool shares the HTTP operation service and refuses forged scope, grants, lease and cancellation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("tools"));
        f.grants.add(testOrganizationId);
        yield* withAuthority(
          (db) =>
            Effect.gen(function* () {
              const authority = yield* SessionAuthority;
              const runs = yield* RunRepo;
              const inputs = yield* RunInputRepo;
              yield* (yield* InstallationRepo).put(install(testOrganizationId));
              yield* runs.create({
                sessionId: testSessionId,
                organizationId: testOrganizationId,
                issueId: Option.some(fixture.testIssueId),
              });
              const cwd = fixture.testPath("native-refresh-authority");
              yield* runs.update(testSessionId, {
                state: "orphaned",
                workspacePath: Option.some(cwd),
                ompSessionFile: Option.some(join(cwd, "session.jsonl")),
              });
              yield* authority.processSession(testSessionId);
              const names = fixture.registeredHostTools.map(
                (tool) => tool.name,
              );
              expect(names).toContain("native_build_refresh");
              expect(names).not.toContain("native_build_reconcile");
              expect(names).not.toContain("native_build_decommission");
              const listener = fixture.hostToolListener;
              if (!listener) return yield* Effect.die("missing listener");
              const call = (arguments_: Record<string, unknown>) =>
                listener({
                  id: "refresh-call",
                  toolCallId: "refresh-tool",
                  toolName: "native_build_refresh",
                  arguments: arguments_,
                });
              const valid = { scope: "builder", builder: "primary" };
              expect(
                (yield* call({ ...valid, organizationId: "forged" })).isError,
              ).toBe(true);
              expect(f.journal.snapshot().operations).toHaveLength(0);
              expect((yield* call(valid)).isError).not.toBe(true);
              expect(f.journal.snapshot().operations).toHaveLength(1);
              expect(f.journal.snapshot().operations[0]).toMatchObject({
                kind: "agent",
                org: testOrganizationId,
                all: false,
              });
              f.grants.delete(testOrganizationId);
              expect((yield* call(valid)).isError).toBe(true);
              f.grants.add(testOrganizationId);
              const leased = yield* runs.get(testSessionId);
              if (Option.isNone(leased))
                return yield* Effect.die("missing run");
              const owner = Option.getOrUndefined(leased.value.leaseOwner);
              yield* Effect.sync(() =>
                db
                  .query(
                    "UPDATE agent_run SET lease_owner='foreign-owner' WHERE session_id=?",
                  )
                  .run(testSessionId),
              );
              expect((yield* call(valid)).isError).toBe(true);
              yield* Effect.sync(() =>
                db
                  .query(
                    "UPDATE agent_run SET lease_owner=?, lease_expires_at=0 WHERE session_id=?",
                  )
                  .run(owner ?? "", testSessionId),
              );
              expect((yield* call(valid)).isError).toBe(true);
              yield* Effect.sync(() =>
                db
                  .query(
                    "UPDATE agent_run SET lease_expires_at=? WHERE session_id=?",
                  )
                  .run(Date.now() + 60000, testSessionId),
              );
              yield* Effect.sync(() =>
                db
                  .query(
                    "UPDATE agent_run SET organization_id='forged-org' WHERE session_id=?",
                  )
                  .run(testSessionId),
              );
              expect((yield* call(valid)).isError).toBe(true);
              yield* Effect.sync(() =>
                db
                  .query(
                    "UPDATE agent_run SET organization_id=? WHERE session_id=?",
                  )
                  .run(testOrganizationId, testSessionId),
              );
              const entered = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              fixture.commentEnteredSignal = entered;
              fixture.commentRelease = release;
              const comment = yield* listener({
                id: "comment",
                toolCallId: "comment",
                toolName: "linear_create_comment",
                arguments: { body: "Hold the mutation gate" },
              }).pipe(Effect.forkChild({ startImmediately: true }));
              yield* Deferred.await(entered);
              const queued = yield* call(valid).pipe(
                Effect.forkChild({ startImmediately: true }),
              );
              yield* Effect.yieldNow;
              yield* inputs.applyStop(testSessionId);
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(comment);
              expect((yield* Fiber.join(queued)).isError).toBe(true);
              expect((yield* call(valid)).isError).toBe(true);
              expect(f.journal.snapshot().operations).toHaveLength(1);
              expect(f.reads).toEqual([]);
            }),
          {
            nativeFleet: f.fleet,
            withLinearGateway: true,
            configOverride: (config) => ({
              ...config,
              gatewayAdminOrganizationIds: f.grants,
            }),
          },
        );
      }),
    ),
);
it.live(
  "ordinary workers and default production assembly advertise no fleet actions",
  () =>
    withAuthority(() =>
      Effect.gen(function* () {
        const authority = yield* SessionAuthority;
        const runs = yield* RunRepo;
        yield* (yield* InstallationRepo).put(install(testOrganizationId));
        yield* runs.create({
          sessionId: testSessionId,
          organizationId: testOrganizationId,
          issueId: Option.none(),
        });
        const cwd = fixture.testPath("ordinary-native-refresh");
        yield* runs.update(testSessionId, {
          state: "orphaned",
          workspacePath: Option.some(cwd),
          ompSessionFile: Option.some(join(cwd, "session.jsonl")),
        });
        yield* authority.processSession(testSessionId);
        expect(
          fixture.registeredHostTools.some((tool) =>
            /native_build_(refresh|reconcile|decommission)/u.test(tool.name),
          ),
        ).toBe(false);
      }),
    ),
);
