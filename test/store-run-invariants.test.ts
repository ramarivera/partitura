import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Result, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect } from "vitest";
import type {
  ActivityId,
  AppUserId,
  OrganizationId,
  SessionId,
  SourceKey,
  TeamId,
} from "../src/domain/ids.js";
import { type Installation, RunState } from "../src/domain/models.js";
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

const makeTeamId = (value: string): TeamId => value as TeamId;
const makeAppUserId = (value: string): AppUserId => value as AppUserId;
const makeSourceKey = (value: string): SourceKey => value as SourceKey;

const makeActivityId = (value: string): ActivityId => value as ActivityId;

describe("pure invariants", () => {
  it.live(
    "ProjectionRepo.enqueue firstWriteWins",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          sessionId: fc.uuid(),
          organizationId: fc.uuid(),
          sourceKey: fc.uuid(),
          bodies: fc
            .record({
              first: fc
                .string()
                .filter(
                  Schema.is(
                    Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
                  ),
                ),
              second: fc
                .string()
                .filter(
                  Schema.is(
                    Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
                  ),
                ),
            })
            .filter(
              Schema.is(
                Schema.Struct({
                  first: Schema.String.pipe(
                    Schema.check(Schema.isMinLength(1)),
                  ),
                  second: Schema.String.pipe(
                    Schema.check(Schema.isMinLength(1)),
                  ),
                }).pipe(
                  Schema.check(Schema.makeFilter((s) => s.first !== s.second)),
                ),
              ),
            ),
          hashes: fc.record({ first: fc.string(), second: fc.string() }).filter(
            Schema.is(
              Schema.Struct({
                first: Schema.String,
                second: Schema.String,
              }).pipe(
                Schema.check(Schema.makeFilter((s) => s.first !== s.second)),
              ),
            ),
          ),
          activityId: fc.uuid(),
        });
        const check = ({
          sessionId,
          organizationId,
          sourceKey,
          bodies: { first: body, second: otherBody },
          hashes: { first: firstHash, second: secondHash },
          activityId,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withRepos(
            Effect.gen(function* () {
              const runRepo = yield* RunRepo;
              const projectionRepo = yield* ProjectionRepo;
              const eventRepo = yield* RunEventRepo;

              yield* runRepo.create({
                sessionId: makeSessionId(sessionId),
                organizationId: makeOrganizationId(organizationId),
                issueId: Option.none(),
                now: 0,
              });

              const key = makeSourceKey(sourceKey);

              const first = yield* projectionRepo.enqueue({
                sourceKey: key,
                sessionId: makeSessionId(sessionId),
                activityType: "response",
                payloadHash: firstHash,
                payload: { request: { content: { type: "response", body } } },
                now: 1_000,
              });
              expect(first).toBe(true);

              const sameHash = yield* projectionRepo.enqueue({
                sourceKey: key,
                sessionId: makeSessionId(sessionId),
                activityType: "response",
                payloadHash: firstHash,
                payload: { request: { content: { type: "response", body } } },
                now: 1_000,
              });
              expect(sameHash).toBe(false);

              const job = yield* projectionRepo.claim(key, "owner", 60_000);
              expect(job).not.toEqual(Option.none());

              yield* projectionRepo.complete(
                key,
                "owner",
                Option.some(makeActivityId(activityId)),
              );

              const differentHash = yield* projectionRepo.enqueue({
                sourceKey: key,
                sessionId: makeSessionId(sessionId),
                activityType: "response",
                payloadHash: secondHash,
                payload: {
                  request: { content: { type: "response", body: otherBody } },
                },
                now: 2_000,
                firstWriteWins: true,
              });
              expect(differentHash).toBe(false);

              const events = yield* eventRepo.list(makeSessionId(sessionId));
              const event = events[0];
              expect(event?.text).toEqual(Option.some(body));
              expect(event?.status).toEqual(Option.some("completed"));
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

  it.live(
    "RunRepo.update rejects transitions from terminal states",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          sessionId: fc.uuid(),
          organizationId: fc.uuid(),
          firstState: fc.constantFrom(...RunState.literals),
          secondState: fc.constantFrom(...RunState.literals),
        });
        const check = ({
          sessionId,
          organizationId,
          firstState,
          secondState,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withRepos(
            Effect.gen(function* () {
              const repo = yield* RunRepo;
              const sid = makeSessionId(sessionId);
              const oid = makeOrganizationId(organizationId);

              yield* repo.create({
                sessionId: sid,
                organizationId: oid,
                issueId: Option.none(),
                now: 0,
              });

              yield* repo.update(sid, { state: firstState });
              const first = yield* repo.get(sid);
              expect(Option.isSome(first)).toBe(true);
              if (Option.isSome(first)) {
                expect(first.value.state).toBe(firstState);
              }

              const either = yield* Effect.result(
                repo.update(sid, { state: secondState }),
              );
              const terminal = ["succeeded", "failed", "canceled"] as const;
              const isTerminal = terminal.includes(
                firstState as (typeof terminal)[number],
              );
              const shouldFail = isTerminal && secondState !== firstState;

              if (shouldFail) {
                expect(Result.isFailure(either)).toBe(true);
                if (Result.isFailure(either)) {
                  expect(either.failure.message).toBe(
                    "Terminal run state is immutable",
                  );
                }
              } else {
                expect(Result.isSuccess(either)).toBe(true);
                const after = yield* repo.get(sid);
                expect(Option.isSome(after)).toBe(true);
                if (Option.isSome(after)) {
                  expect(after.value.state).toBe(secondState);
                }
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
  it.live(
    "InstallationRepo persists generated installation records and replaces them",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          organizationId: fc.uuid(),
          appUserId: fc.uuid(),
          accessToken: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
          refreshToken: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
          expiresAt: fc
            .integer({ min: 0, max: 1_000_000_000 })
            .filter(
              Schema.is(
                Schema.Number.pipe(
                  Schema.check(Schema.isInt()),
                  Schema.check(
                    Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 }),
                  ),
                ),
              ),
            ),
          scopes: fc.array(fc.string()),
          revokedAt: fc.option(
            fc
              .integer({ min: 0, max: 1_000_000_000 })
              .filter(
                Schema.is(
                  Schema.Number.pipe(
                    Schema.check(Schema.isInt()),
                    Schema.check(
                      Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 }),
                    ),
                  ),
                ),
              ),
            { nil: null },
          ),
          accessibleTeamIds: fc.option(fc.array(fc.uuid()), { nil: null }),
          canAccessAllPublicTeams: fc.option(fc.boolean(), { nil: null }),
        });
        const check = (
          input: typeof cases extends fc.Arbitrary<infer A> ? A : never,
        ) =>
          withRepos(
            Effect.gen(function* () {
              const repo = yield* InstallationRepo;
              const expected: Installation = {
                organizationId: makeOrganizationId(input.organizationId),
                appUserId: makeAppUserId(input.appUserId),
                accessToken: input.accessToken,
                refreshToken: input.refreshToken,
                expiresAt: input.expiresAt,
                scopes: input.scopes,
                revokedAt:
                  input.revokedAt === null
                    ? Option.none()
                    : Option.some(input.revokedAt),
                accessibleTeamIds:
                  input.accessibleTeamIds === null
                    ? Option.none()
                    : Option.some(input.accessibleTeamIds.map(makeTeamId)),
                canAccessAllPublicTeams:
                  input.canAccessAllPublicTeams === null
                    ? Option.none()
                    : Option.some(input.canAccessAllPublicTeams),
              };
              yield* repo.put(expected);
              expect(yield* repo.get(expected.organizationId)).toEqual(
                Option.some(expected),
              );

              const replacement = {
                ...expected,
                accessToken: `${input.accessToken}-replacement`,
              };
              yield* repo.put(replacement);
              expect(yield* repo.get(expected.organizationId)).toEqual(
                Option.some(replacement),
              );
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
});
