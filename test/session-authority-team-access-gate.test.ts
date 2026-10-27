import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";
import { DatabaseError } from "../src/domain/errors.js";
import { InputId, TeamId, WorkspaceId } from "../src/domain/ids.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  testPath,
  workerSpawnInputs,
  withAuthority,
  testSessionId,
  testIssueId,
  testOrganizationId,
  install,
} = fixture;

describe("SessionAuthority team-access gate", () => {
  it.live.each(["native", "firecracker", "sysbox"] as const)(
    "uses safe uid retirement during initial %s workspace materialization",
    (runtime) => {
      const acquisitions: Array<
        { readonly retireTerminal?: boolean } | undefined
      > = [];
      return withAuthority(
        () =>
          Effect.gen(function* () {
            yield* InstallationRepo.use((repo) =>
              repo.put(install(testOrganizationId)),
            );
            yield* WorkspaceRepo.use((repo) =>
              repo.createRepository({
                organizationId: testOrganizationId,
                id: Schema.decodeUnknownSync(WorkspaceId)(
                  "fresh-materialization-repo",
                ),
                url: "https://github.com/org/repo.git",
                ref: "main",
                isDefault: true,
              }),
            );
            yield* RunRepo.use((repo) =>
              repo.create({
                sessionId: testSessionId,
                organizationId: testOrganizationId,
                issueId: Option.none(),
              }),
            );
            yield* RunInputRepo.use((repo) =>
              repo.enqueue({
                id: Schema.decodeUnknownSync(InputId)(
                  "fresh-materialization-input",
                ),
                sessionId: testSessionId,
                kind: "created",
                body: "start",
                payload: {},
              }),
            );
            const result = yield* (yield* SessionAuthority)
              .processSession(testSessionId)
              .pipe(Effect.result);
            expect(Result.isFailure(result)).toBe(true);
            expect(acquisitions).toEqual([
              { retireTerminal: runtime === "native" },
            ]);
            expect(workerSpawnInputs).toHaveLength(0);
          }),
        {
          configOverride: (config) => ({
            ...config,
            workerSandboxMode: runtime,
            sessionSandboxBrokerSocketPath: testPath("missing-broker.sock"),
          }),
          workerIdentityRepo: {
            acquire: (_sessionId, _root, options) => {
              acquisitions.push(options);
              return Effect.fail(
                new DatabaseError({
                  message: "Reserved uid pool exhausted",
                }),
              );
            },
            release: () => Effect.void,
          },
        },
      );
    },
  );

  it.live(
    "proceeds when the installation team-access snapshot is unknown (null)",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          const teamId = Schema.decodeUnknownSync(TeamId)("authority-team");
          // install() leaves accessibleTeamIds/canAccessAllPublicTeams unset
          // (Option.none) — an unknown snapshot must not cancel teamed runs;
          // Linear enforces access server-side.
          yield* installationRepo.put(install(testOrganizationId));
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.some(testIssueId),
            teamId: Option.some(teamId),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            workspacePath: Option.some(testPath("team-access-unknown")),
            ompSessionFile: Option.some(
              testPath("team-access-unknown/session.jsonl"),
            ),
          });

          yield* authority.processSession(testSessionId);
          expect(workerSpawnInputs).toHaveLength(1);
          const run = yield* runRepo.get(testSessionId);
          expect(Option.isSome(run)).toBe(true);
          if (Option.isSome(run)) {
            expect(run.value.terminalReason).not.toEqual(
              Option.some("Linear team access was removed"),
            );
          }
        }),
      ),
  );

  it.live("releases the persisted worker uid after cancellation", () =>
    withAuthority((db) =>
      Effect.gen(function* () {
        const authority = yield* SessionAuthority;
        const installationRepo = yield* InstallationRepo;
        const runRepo = yield* RunRepo;
        yield* installationRepo.put(install(testOrganizationId));
        yield* runRepo.create({
          sessionId: testSessionId,
          organizationId: testOrganizationId,
          issueId: Option.some(testIssueId),
        });
        db.query(
          "INSERT INTO worker_identity(session_id, uid, active) VALUES (?, 21001, 1)",
        ).run(testSessionId);
        db.query(
          "UPDATE agent_run SET desired_state='canceled' WHERE session_id=?",
        ).run(testSessionId);
        yield* authority.processSession(testSessionId);
        expect(
          db
            .query("SELECT active FROM worker_identity WHERE session_id=?")
            .get(testSessionId),
        ).toEqual({ active: 0 });
      }),
    ),
  );

  it.live.each(["firecracker", "sysbox"] as const)(
    "reserves a terminal uid when %s teardown is unavailable after restart",
    (runtime) =>
      withAuthority(
        (db) =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            yield* InstallationRepo.use((repo) =>
              repo.put(install(testOrganizationId)),
            );
            yield* RunRepo.use((repo) =>
              repo.create({
                sessionId: testSessionId,
                organizationId: testOrganizationId,
                issueId: Option.some(testIssueId),
              }),
            );
            db.query(
              "INSERT INTO worker_identity(session_id, uid, active) VALUES (?, 21001, 1)",
            ).run(testSessionId);
            db.query(
              "UPDATE agent_run SET desired_state='canceled' WHERE session_id=?",
            ).run(testSessionId);
            yield* authority.processSession(testSessionId);
            expect(
              db
                .query("SELECT active FROM worker_identity WHERE session_id=?")
                .get(testSessionId),
            ).toEqual({ active: 1 });
          }),
        {
          config: [
            ["WORKER_SANDBOX_MODE", runtime],
            ["SESSION_SANDBOX_BROKER_SOCKET", testPath("missing-broker.sock")],
          ],
        },
      ),
  );

  it.live("cancels when a known snapshot excludes the run's team", () =>
    withAuthority(() =>
      Effect.gen(function* () {
        const authority = yield* SessionAuthority;
        const installationRepo = yield* InstallationRepo;
        const runRepo = yield* RunRepo;
        const teamId = Schema.decodeUnknownSync(TeamId)("authority-team");
        yield* installationRepo.put({
          ...install(testOrganizationId),
          accessibleTeamIds: Option.some([]),
          canAccessAllPublicTeams: Option.some(false),
        });
        yield* runRepo.create({
          sessionId: testSessionId,
          organizationId: testOrganizationId,
          issueId: Option.some(testIssueId),
          teamId: Option.some(teamId),
        });
        yield* runRepo.update(testSessionId, {
          state: "orphaned",
          workspacePath: Option.some(testPath("team-access-known")),
          ompSessionFile: Option.some(
            testPath("team-access-known/session.jsonl"),
          ),
        });

        yield* authority.processSession(testSessionId);
        expect(workerSpawnInputs).toHaveLength(0);
        const run = yield* runRepo.get(testSessionId);
        expect(Option.isSome(run)).toBe(true);
        if (Option.isSome(run)) {
          expect(run.value.state).toBe("canceled");
          expect(run.value.terminalReason).toEqual(
            Option.some("Linear team access was removed"),
          );
        }
      }),
    ),
  );
  it.live(
    "cancels when only the public-team access snapshot is known and false",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          const teamId = Schema.decodeUnknownSync(TeamId)("authority-team");
          yield* installationRepo.put({
            ...install(testOrganizationId),
            accessibleTeamIds: Option.none(),
            canAccessAllPublicTeams: Option.some(false),
          });
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.some(testIssueId),
            teamId: Option.some(teamId),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            workspacePath: Option.some(testPath("team-access-partial")),
            ompSessionFile: Option.some(
              testPath("team-access-partial/session.jsonl"),
            ),
          });

          yield* authority.processSession(testSessionId);
          expect(workerSpawnInputs).toHaveLength(0);
          const run = yield* runRepo.get(testSessionId);
          expect(Option.isSome(run)).toBe(true);
          if (Option.isSome(run)) {
            expect(run.value.state).toBe("canceled");
            expect(run.value.terminalReason).toEqual(
              Option.some("Linear team access was removed"),
            );
          }
        }),
      ),
  );
});
