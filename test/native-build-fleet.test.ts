import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { NativeFleetError } from "../src/services/native-build-fleet-models.js";
import { NativeTransportError } from "../src/services/native-build-transport.js";
import { entry } from "./fixtures/builder-registry.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { fleetActor, fleetFixture } from "./fixtures/native-build-fleet.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const failure = <A>(effect: Effect.Effect<A, NativeFleetError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.code));
it.live(
  "ordinary and missing org grants fail before registry lookup, progress or provider contact",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("authority"));
        for (const org of ["", "ordinary"]) {
          const actor = { ...fleetActor, organizationId: org };
          expect(
            yield* failure(
              f.fleet.refresh(actor, { scope: "builder", builder: "missing" }),
            ),
          ).toBe("fleet-forbidden");
          expect(yield* failure(f.fleet.fleet(actor))).toBe("fleet-forbidden");
          expect(yield* failure(f.fleet.progress(actor, "a".repeat(32)))).toBe(
            "fleet-forbidden",
          );
          expect(yield* failure(f.fleet.checkHealth(actor, "missing"))).toBe(
            "fleet-forbidden",
          );
        }
        expect(f.journal.snapshot().operations).toEqual([]);
        expect(f.reads).toEqual([]);
      }),
    ),
);
it.live(
  "refresh has exact scopes, supports disabled builders and shares durable source and org limits",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("refresh"));
        yield* f.write([
          {
            ...entry("primary", false),
            secretSource: {
              type: "onepassword",
              vaultId: "a".repeat(26),
              itemId: "b".repeat(26),
            },
          },
        ]);
        expect(
          yield* failure(
            f.fleet.refresh(fleetActor, {
              scope: "builder",
              builder: "primary",
              organizationId: "forged",
            }),
          ),
        ).toBe("fleet-invalid-request");
        const { operationId } = yield* f.fleet.refresh(fleetActor, {
          scope: "builder",
          builder: "primary",
        });
        expect(yield* f.fleet.progress(fleetActor, operationId)).toMatchObject({
          done: false,
        });
        yield* f.cache.tick();
        expect(yield* f.fleet.progress(fleetActor, operationId)).toMatchObject({
          done: true,
          sources: [{ builderId: "primary", status: "succeeded" }],
        });
        for (let i = 1; i < 10; i++)
          yield* f.fleet.refresh(
            {
              ...fleetActor,
              kind: i % 2 ? "agent" : "human",
              sessionHash: `run-${i}`,
            },
            { scope: "builder", builder: "primary" },
          );
        expect(
          yield* failure(
            f.fleet.refresh(
              { ...fleetActor, kind: "agent", sessionHash: "different-run" },
              { scope: "builder", builder: "primary" },
            ),
          ),
        ).toBe("provider-submission-limited");
        yield* f.cache.tick();
        expect(f.reads).toHaveLength(1); // One shared source cooldown, across runs and trigger kinds.
      }),
    ),
);
it.live(
  "fleet and partial progress expose fixed states without connection, source or tenant metadata",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("projection"));
        const a = entry();
        const b = {
          ...entry("backup"),
          secretSource: {
            type: "onepassword" as const,
            vaultId: "a".repeat(26),
            itemId: "b".repeat(26),
          },
        };
        yield* f.write([a, b]);
        const op = yield* f.fleet.refresh(fleetActor, { scope: "all" });
        yield* f.journal.transaction((data) => {
          const operation = data.operations.find(
            (operation) => operation.id === op.operationId,
          );
          if (!operation) throw new Error("missing operation");
          const primary = operation.sources.find(
            (work) => work.builderId === "primary",
          );
          const backup = operation.sources.find(
            (work) => work.builderId === "backup",
          );
          if (primary) primary.status = "cached-noop";
          if (backup) backup.code = "needs-refresh";
        }, Date.now());
        const progress = yield* f.fleet.progress(fleetActor, op.operationId);
        expect(progress).toMatchObject({
          done: false,
          sources: [
            { status: "pending", code: "needs-refresh" },
            { status: "cached-noop" },
          ],
        });
        const view = yield* f.fleet.fleet(fleetActor);
        expect(view.entries[1]?.credential).toMatchObject({
          status: "pending",
          code: "needs-refresh",
        });
        const text = JSON.stringify({ view, progress });
        for (const secret of [
          f.native.metadata.hostname,
          `"sshUser":${JSON.stringify(f.native.metadata.sshUser)}`,
          f.native.key,
          f.native.options.scratchRoot,
          "onepassword:",
          "file:primary",
          "vaultId",
          "organizationId",
          "sessionId",
          "equalityTag",
        ])
          expect(text).not.toContain(secret);
      }),
    ),
);
it.live(
  "cached health checks are single-flight, rate-limited and never read the provider",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("health"));
        const op = yield* f.fleet.checkHealth(fleetActor, "primary");
        expect(yield* failure(f.fleet.checkHealth(fleetActor, "primary"))).toBe(
          "fleet-health-limited",
        );
        for (let i = 0; i < 100; i++) {
          if ((yield* f.fleet.progress(fleetActor, op.operationId)).done) break;
          yield* Effect.sleep(5);
        }
        expect((yield* f.fleet.progress(fleetActor, op.operationId)).done).toBe(
          true,
        );
        expect(f.reads).toEqual([]);
        expect(f.journal.snapshot().charges).toEqual([]);
      }),
    ),
);

it.live(
  "pending startup, cached-noop and needs-refresh retain distinct public states without auth-triggered reads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let failed = false;
        const f = yield* fleetFixture(path("freshness"), (transport) => ({
          ...transport,
          envelope: (...args) =>
            failed
              ? Effect.fail(NativeTransportError.new("needs-refresh"))
              : transport.envelope(...args),
        }));
        const source = {
          source: "file:primary.json",
          builderId: "primary",
          revision: 1,
          retained: false,
        };
        yield* f.cache.accept("startup", [source], "");
        expect(
          (yield* f.fleet.fleet(fleetActor)).entries[0]?.credential,
        ).toMatchObject({ trigger: "startup", status: "pending" });
        yield* f.cache.tick();
        const lastSuccess = (yield* f.fleet.fleet(fleetActor)).entries[0]
          ?.credential?.lastSuccessAt;
        expect(lastSuccess).toBeTypeOf("number");
        const accepted = yield* f.fleet.refresh(
          { ...fleetActor, kind: "agent" },
          { scope: "builder", builder: "primary" },
        );
        expect(
          yield* f.fleet.progress(fleetActor, accepted.operationId),
        ).toMatchObject({
          kind: "agent",
          sources: [{ status: "cached-noop", lastSuccessAt: lastSuccess }],
        });
        failed = true;
        const health = yield* f.fleet.checkHealth(fleetActor, "primary");
        for (
          let i = 0;
          i < 100 &&
          !(yield* f.fleet.progress(fleetActor, health.operationId)).done;
          i++
        )
          yield* Effect.sleep(5);
        expect(
          yield* f.fleet.progress(fleetActor, health.operationId),
        ).toMatchObject({ done: true, code: "needs-refresh" });
        // Cached-noop must not re-install a cached key or silently retry SSH,
        // even after the connection recovers. A human read is still required.
        failed = false;
        yield* f.fleet.refresh(
          { ...fleetActor, kind: "agent" },
          { scope: "builder", builder: "primary" },
        );
        yield* Effect.sleep(20);
        yield* f.registry.awaitIdle();
        const view = yield* f.fleet.fleet(fleetActor);
        expect(view.entries[0]).toMatchObject({
          available: false,
          reason: "needs-refresh",
          credential: { status: "cached-noop", lastSuccessAt: lastSuccess },
        });
        expect(f.reads).toHaveLength(1);
      }),
    ),
);

it.live(
  "explicit cached-health failure after admission blocks that admitted generation before submission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fleetFixture(path("admitted-health"));
        const admission = yield* f.registry.admit("primary");
        yield* testAwait(f.native.plan({ healthBusy: true }));
        const health = yield* f.fleet.checkHealth(fleetActor, "primary");
        for (
          let i = 0;
          i < 100 &&
          !(yield* f.fleet.progress(fleetActor, health.operationId)).done;
          i++
        )
          yield* Effect.sleep(5);
        let dispatched = false;
        expect(
          yield* Effect.flip(
            f.registry.submit(admission, () =>
              Effect.sync(() => {
                dispatched = true;
              }),
            ),
          ),
        ).toMatchObject({ code: "registry-submission-closed" });
        expect(dispatched).toBe(false);
        expect(f.journal.snapshot().operations).toEqual([]);
      }),
    ),
);

it.live(
  "Check health can recover the failed first cached-credential probe without a registry edit or provider read",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let offline = true;
        const f = yield* fleetFixture(
          path("first-health-retry"),
          (transport) => ({
            ...transport,
            envelope: (...args) =>
              offline
                ? Effect.fail(NativeTransportError.new("unavailable"))
                : transport.envelope(...args),
          }),
        );
        expect(f.registry.current("primary")?.identity).toBeUndefined();
        offline = false;
        const health = yield* f.fleet.checkHealth(fleetActor, "primary");
        for (
          let i = 0;
          i < 100 &&
          !(yield* f.fleet.progress(fleetActor, health.operationId)).done;
          i++
        )
          yield* Effect.sleep(5);
        expect(
          yield* f.fleet.progress(fleetActor, health.operationId),
        ).toMatchObject({ done: true });
        expect(f.registry.snapshot().entries[0]?.available).toBe(true);
        expect(f.reads).toEqual([]);
        expect(f.journal.snapshot().operations).toEqual([]);
      }),
    ),
);
