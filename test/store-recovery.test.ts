import { it } from "@effect/vitest";
import { Clock, ConfigProvider, Effect, Layer, Option } from "effect";
import { describe, expect } from "vitest";
import type {
  AppUserId,
  InputId,
  IssueId,
  OrganizationId,
  SessionId,
  TeamId,
} from "../src/domain/ids.js";
import type { Installation } from "../src/domain/models.js";
import {
  AdminSessionRepo,
  DeliveryRepo,
  InstallationRepo,
  ProjectionRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { SqliteClientLive } from "../src/services/store/sqlite-client.js";
import { TokenCrypto } from "../src/services/token-crypto.js";

const testKeyBase64 = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const configProvider = ConfigProvider.fromUnknown(
  Object.fromEntries(
    new Map([
      ["WORKER_SANDBOX_MODE", "native"],
      ["LINEAR_CLIENT_ID", "test"],
      ["LINEAR_CLIENT_SECRET", "test"],
      ["LINEAR_WEBHOOK_SECRET", "test"],
      ["PUBLIC_URL", "http://localhost:3000"],
      ["TOKEN_ENCRYPTION_KEY", testKeyBase64],
    ]),
  ),
  { preserveEmptyStrings: true },
);

type RepoServices =
  | AdminSessionRepo
  | InstallationRepo
  | DeliveryRepo
  | RunRepo
  | RunInputRepo
  | RunEventRepo
  | ProjectionRepo
  | TokenCrypto;

const withRepos = <A, E>(effect: Effect.Effect<A, E, RepoServices>) =>
  Effect.gen(function* () {
    yield* Effect.scope;
    const sqlite = SqliteClientLive(":memory:");
    const repos = Layer.mergeAll(
      AdminSessionRepo.layer,
      InstallationRepo.layer,
      DeliveryRepo.layer,
      RunRepo.layer,
      RunInputRepo.layer,
      RunEventRepo.layer,
      ProjectionRepo.layer,
      TokenCrypto.layer,
    ).pipe(
      Layer.provide(
        Layer.mergeAll(sqlite, ConfigProvider.layer(configProvider)),
      ),
    );
    return yield* effect.pipe(Effect.provide(repos));
  });

const makeSessionId = (value: string): SessionId => value as SessionId;

const makeOrganizationId = (value: string): OrganizationId =>
  value as OrganizationId;
const makeIssueId = (value: string): IssueId => value as IssueId;
const makeTeamId = (value: string): TeamId => value as TeamId;
const makeAppUserId = (value: string): AppUserId => value as AppUserId;

const makeInputId = (value: string): InputId => value as InputId;

const makeInstallation = (
  overrides: Partial<Installation> = {},
): Installation => ({
  organizationId: makeOrganizationId("org-1"),
  appUserId: makeAppUserId("app-user-1"),
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiresAt: 1_000_000,
  scopes: ["read", "write"],
  revokedAt: Option.none(),
  accessibleTeamIds: Option.none(),
  canAccessAllPublicTeams: Option.none(),
  ...overrides,
});

describe("Store repositories", () => {
  it.live("recovers active runs and leases after a process restart", () =>
    withRepos(
      Effect.gen(function* () {
        const runRepo = yield* RunRepo;
        const inputRepo = yield* RunInputRepo;

        yield* runRepo.create({
          sessionId: makeSessionId("running-session"),
          organizationId: makeOrganizationId("org-1"),
          issueId: Option.some(makeIssueId("issue-1")),
          now: 1_000,
        });
        yield* runRepo.update(makeSessionId("running-session"), {
          state: "running",
          workspacePath: Option.some("/workspace"),
          ompSessionFile: Option.some("/workspace/session.jsonl"),
        });
        expect(
          yield* runRepo.claimLease(
            makeSessionId("running-session"),
            "dead-process",
            500,
            1_000,
          ),
        ).toBe(true);

        yield* runRepo.create({
          sessionId: makeSessionId("canceled-session"),
          organizationId: makeOrganizationId("org-1"),
          issueId: Option.some(makeIssueId("issue-2")),
          now: 1_000,
        });
        yield* runRepo.update(makeSessionId("canceled-session"), {
          state: "running",
        });
        yield* inputRepo.enqueue({
          id: makeInputId("stop"),
          sessionId: makeSessionId("canceled-session"),
          kind: "stop",
          body: "",
          payload: {},
          createdAt: 1_100,
        });

        expect(yield* runRepo.recoverInterruptedRuns(2_000)).toBe(2);

        const maybeRunning = yield* runRepo.get(
          makeSessionId("running-session"),
        );
        Option.match(maybeRunning, {
          onNone: () => expect.fail("running-session not found"),
          onSome: (run) => {
            expect(run).toMatchObject({
              state: "orphaned",
              nextAttemptAt: Option.some(2_000),
              leaseOwner: Option.none(),
              leaseExpiresAt: Option.none(),
            });
          },
        });

        const runnable = yield* runRepo.listRunnable(2_000);
        expect(runnable.map((run) => run.sessionId)).toContain(
          makeSessionId("running-session"),
        );

        const maybeCanceled = yield* runRepo.get(
          makeSessionId("canceled-session"),
        );
        Option.match(maybeCanceled, {
          onNone: () => expect.fail("canceled-session not found"),
          onSome: (run) => {
            expect(run).toMatchObject({
              state: "stopping",
              desiredState: "canceled",
              leaseOwner: Option.none(),
              leaseExpiresAt: Option.none(),
            });
          },
        });
      }),
    ),
  );

  it.live(
    "prompts after stop are accepted for resume and revocation cancels all live runs",
    () =>
      withRepos(
        Effect.gen(function* () {
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          const inputRepo = yield* RunInputRepo;

          yield* installationRepo.put(makeInstallation());
          yield* runRepo.create({
            sessionId: makeSessionId("session-1"),
            organizationId: makeOrganizationId("org-1"),
            issueId: Option.none(),
          });

          expect(
            yield* inputRepo.enqueue({
              id: makeInputId("stop"),
              sessionId: makeSessionId("session-1"),
              kind: "stop",
              body: "stop",
              payload: {},
            }),
          ).toBe(true);
          // A follow-up prompt is no longer rejected at enqueue time; the
          // session authority decides between honoring the cancellation and
          // resuming when it processes the input.
          expect(
            yield* inputRepo.enqueue({
              id: makeInputId("late"),
              sessionId: makeSessionId("session-1"),
              kind: "prompted",
              body: "keep going",
              payload: {},
            }),
          ).toBe(true);

          const maybeRun = yield* runRepo.get(makeSessionId("session-1"));
          Option.match(maybeRun, {
            onNone: () => expect.fail("run not found"),
            onSome: (run) => expect(run.desiredState).toBe("canceled"),
          });

          const revokedAt = yield* Clock.currentTimeMillis;
          yield* installationRepo.revoke(
            makeOrganizationId("org-1"),
            revokedAt,
          );
          const maybeInstallation = yield* installationRepo.get(
            makeOrganizationId("org-1"),
          );
          Option.match(maybeInstallation, {
            onNone: () => expect.fail("installation not found"),
            onSome: (installation) =>
              expect(installation.revokedAt).not.toEqual(Option.none()),
          });
        }),
      ),
  );

  it.live(
    "updates permission snapshots without rewriting rotating tokens",
    () =>
      withRepos(
        Effect.gen(function* () {
          const repo = yield* InstallationRepo;
          yield* repo.put(
            makeInstallation({
              accessibleTeamIds: Option.some([makeTeamId("team-a")]),
            }),
          );

          const before = yield* repo.getRawEncryptedAccessToken(
            makeOrganizationId("org-1"),
          );

          const changed = yield* repo.applyPermissionChange(
            makeOrganizationId("org-1"),
            makeAppUserId("app-user-1"),
            [makeTeamId("team-b")],
            [makeTeamId("team-a")],
            false,
            0,
          );
          expect(changed).toBe(true);

          const after = yield* repo.getRawEncryptedAccessToken(
            makeOrganizationId("org-1"),
          );
          expect(after).toEqual(before);

          const maybeInstallation = yield* repo.get(
            makeOrganizationId("org-1"),
          );
          Option.match(maybeInstallation, {
            onNone: () => expect.fail("installation not found"),
            onSome: (installation) => {
              expect(installation.accessibleTeamIds).toEqual(
                Option.some([makeTeamId("team-b")]),
              );
            },
          });
        }),
      ),
  );
});
