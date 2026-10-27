import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect } from "vitest";
import type { InputId, OrganizationId, SessionId } from "../src/domain/ids.js";
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

const makeInputId = (value: string): InputId => value as InputId;

describe("pure invariants", () => {
  it.live(
    "RunInputRepo keeps generated inputs pending exactly once until processed",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          sessionId: fc.uuid(),
          organizationId: fc.uuid(),
          inputId: fc.uuid(),
          kind: fc.constantFrom(...(["created", "prompted", "stop"] as const)),
          body: fc.string(),
          marker: fc.string(),
          createdAt: fc
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
        });
        const check = ({
          sessionId,
          organizationId,
          inputId,
          kind,
          body,
          marker,
          createdAt,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withRepos(
            Effect.gen(function* () {
              const runRepo = yield* RunRepo;
              const repo = yield* RunInputRepo;
              const sid = makeSessionId(sessionId);
              yield* runRepo.create({
                sessionId: sid,
                organizationId: makeOrganizationId(organizationId),
                issueId: Option.none(),
                now: createdAt,
              });

              const input = {
                id: makeInputId(inputId),
                sessionId: sid,
                kind,
                body,
                payload: { marker },
                createdAt,
              };
              expect(yield* repo.enqueue(input)).toBe(true);
              expect(yield* repo.enqueue(input)).toBe(false);

              const pending = yield* repo.pending(sid);
              expect(pending).toHaveLength(1);
              expect(pending[0]).toEqual(input);
              expect(yield* repo.listSessionsWithPendingInputs()).toContain(
                sid,
              );

              const latest = yield* repo.latestActionableInput(sid);
              if (kind === "stop") {
                expect(latest).toEqual(Option.none());
              } else {
                expect(latest).toEqual(
                  Option.some({
                    id: input.id,
                    body,
                    kind,
                    payload: { marker },
                  }),
                );
              }

              yield* repo.markProcessed(input.id, createdAt + 1);
              expect(yield* repo.pending(sid)).toEqual([]);
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
    "AdminSessionRepo enforces inclusive expiry and single deletion",
    () =>
      Effect.gen(function* () {
        const cases = fc.record({
          organizationId: fc.uuid(),
          tokenHash: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
          csrfTokenHash: fc
            .string()
            .filter(
              Schema.is(
                Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
              ),
            ),
          now: fc
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
          ttl: fc
            .integer({ min: 1, max: 1_000_000 })
            .filter(
              Schema.is(
                Schema.Number.pipe(
                  Schema.check(Schema.isInt()),
                  Schema.check(
                    Schema.isBetween({ minimum: 1, maximum: 1_000_000 }),
                  ),
                ),
              ),
            ),
        });
        const check = ({
          organizationId,
          tokenHash,
          csrfTokenHash,
          now,
          ttl,
        }: typeof cases extends fc.Arbitrary<infer A> ? A : never) =>
          withRepos(
            Effect.gen(function* () {
              const repo = yield* AdminSessionRepo;
              const organization = makeOrganizationId(organizationId);
              const expiresAt = now + ttl;
              yield* repo.create({
                organizationId: organization,
                tokenHash,
                csrfTokenHash,
                expiresAt,
                now,
              });

              expect(yield* repo.get(tokenHash, now)).toEqual(
                Option.some({ organizationId: organization, csrfTokenHash }),
              );
              expect(yield* repo.get(tokenHash, expiresAt)).toEqual(
                Option.some({ organizationId: organization, csrfTokenHash }),
              );
              expect(yield* repo.get(tokenHash, expiresAt + 1)).toEqual(
                Option.none(),
              );
              expect(yield* repo.deleteAdminSession(tokenHash)).toBe(true);
              expect(yield* repo.deleteAdminSession(tokenHash)).toBe(false);
              expect(yield* repo.get(tokenHash, now)).toEqual(Option.none());
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
