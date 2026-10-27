import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect } from "vitest";
import type {
  DeliveryId,
  OrganizationId,
  SessionId,
  SourceKey,
} from "../src/domain/ids.js";
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
const makeDeliveryId = (value: string): DeliveryId => value as DeliveryId;
const makeOrganizationId = (value: string): OrganizationId =>
  value as OrganizationId;

const makeSourceKey = (value: string): SourceKey => value as SourceKey;

describe("pure invariants", () => {
  it.live(
    "DeliveryRepo.claim idempotency",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          deliveryId: fc.uuid(),
          organizationId: fc.uuid(),
          payload: fc.string(),
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
        });
        const check = ({
          deliveryId,
          organizationId,
          payload,
          hashes: { first, second },
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withRepos(
            Effect.gen(function* () {
              const repo = yield* DeliveryRepo;
              const common = {
                id: makeDeliveryId(deliveryId),
                organizationId: makeOrganizationId(organizationId),
                payload,
              };
              expect(yield* repo.claim({ ...common, payloadHash: first })).toBe(
                "claimed",
              );
              expect(yield* repo.claim({ ...common, payloadHash: first })).toBe(
                "duplicate",
              );
              expect(
                yield* repo.claim({ ...common, payloadHash: second }),
              ).toBe("conflict");
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
    "RunRepo.claimLease exclusivity",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          sessionId: fc.uuid(),
          organizationId: fc.uuid(),
          owner: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
          otherOwner: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
          duration: fc
            .integer({ min: 2, max: 1_000_000 })
            .filter(
              Schema.is(
                Schema.Number.pipe(
                  Schema.check(Schema.isInt()),
                  Schema.check(
                    Schema.isBetween({ minimum: 2, maximum: 1_000_000 }),
                  ),
                ),
              ),
            ),
          now: fc
            .integer({ min: 0, max: 1_000_000 })
            .filter(
              Schema.is(
                Schema.Number.pipe(
                  Schema.check(Schema.isInt()),
                  Schema.check(
                    Schema.isBetween({ minimum: 0, maximum: 1_000_000 }),
                  ),
                ),
              ),
            ),
        });
        const check = ({
          sessionId,
          organizationId,
          owner,
          otherOwner,
          duration,
          now,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withRepos(
            Effect.gen(function* () {
              const repo = yield* RunRepo;
              yield* repo.create({
                sessionId: makeSessionId(sessionId),
                organizationId: makeOrganizationId(organizationId),
                issueId: Option.none(),
                now,
              });
              expect(
                yield* repo.claimLease(
                  makeSessionId(sessionId),
                  owner,
                  duration,
                  now,
                ),
              ).toBe(true);
              expect(
                yield* repo.claimLease(
                  makeSessionId(sessionId),
                  owner,
                  duration,
                  now + 1,
                ),
              ).toBe(true);
              const other = yield* repo.claimLease(
                makeSessionId(sessionId),
                otherOwner,
                duration,
                now + 1,
              );
              if (owner === otherOwner) {
                expect(other).toBe(true);
              } else {
                expect(other).toBe(false);
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
    "RunEventRepo.upsert source-key uniqueness",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          sessionId: fc.uuid(),
          organizationId: fc.uuid(),
          sourceKey: fc.uuid(),
          texts: fc
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
        });
        const check = ({
          sessionId,
          organizationId,
          sourceKey,
          texts: { first: text1, second: text2 },
          bodies: { first: body1, second: body2 },
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withRepos(
            Effect.gen(function* () {
              const runRepo = yield* RunRepo;
              const eventRepo = yield* RunEventRepo;

              yield* runRepo.create({
                sessionId: makeSessionId(sessionId),
                organizationId: makeOrganizationId(organizationId),
                issueId: Option.none(),
                now: 0,
              });

              const key = makeSourceKey(sourceKey);

              yield* eventRepo.upsert({
                sourceKey: key,
                sessionId: makeSessionId(sessionId),
                kind: "agent_start",
                level: "info",
                text: text1,
                payload: { body: body1 },
                status: "pending",
                now: 1_000,
              });
              yield* eventRepo.upsert({
                sourceKey: key,
                sessionId: makeSessionId(sessionId),
                kind: "thought",
                level: "debug",
                text: text2,
                payload: { body: body2 },
                status: "pending",
                now: 2_000,
              });

              const events = yield* eventRepo.list(makeSessionId(sessionId));
              expect(events.length).toBe(1);
              expect(events[0]).toMatchObject({
                sourceKey: key,
                kind: "thought",
                level: "debug",
                text: Option.some(text2),
                status: Option.some("pending"),
                createdAt: 1_000,
                updatedAt: 2_000,
              });

              yield* eventRepo.upsert({
                sourceKey: key,
                sessionId: makeSessionId(sessionId),
                kind: "thought",
                level: "debug",
                text: text2,
                payload: { body: body2 },
                status: "completed",
                now: 3_000,
              });
              yield* eventRepo.upsert({
                sourceKey: key,
                sessionId: makeSessionId(sessionId),
                kind: "response",
                level: "result",
                text: "overwritten",
                payload: { body: "overwritten" },
                status: "pending",
                now: 4_000,
              });

              const events2 = yield* eventRepo.list(makeSessionId(sessionId));
              expect(events2.length).toBe(1);
              expect(events2[0]).toMatchObject({
                sourceKey: key,
                kind: "thought",
                level: "debug",
                text: Option.some(text2),
                status: Option.some("completed"),
                createdAt: 1_000,
                updatedAt: 3_000,
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
});
