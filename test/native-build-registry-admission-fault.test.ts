import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  cutoverFixture,
  cutoverRequest,
} from "./fixtures/native-build-cutover.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
for (const fault of ["invalid", "missing"] as const)
  it.live(
    `a hot ${fault} registry closes starts until a valid reload, retaining in-flight status, cancellation and fenced recovery`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* cutoverFixture(path(fault));
          const live = yield* f.boot();
          yield* live.registry.awaitIdle();
          const barrier = join(f.native.root, "run-release");
          yield* f.plan({ runBarrier: barrier });
          yield* Effect.addFinalizer(() =>
            testAwait(writeFile(barrier, "release", { mode: 0o600 })).pipe(
              Effect.orDie,
            ),
          );
          const job = yield* live.jobs.start({
            ...cutoverRequest,
            workspacePath: f.root,
          });
          yield* Effect.repeat(Effect.sleep(5), {
            until: () =>
              testAwait(Bun.file(join(f.native.root, "run-entered")).exists()),
          });
          expect(
            (yield* live.jobs.status(
              job.organizationId,
              job.sessionId,
              job.jobId,
            )).state,
          ).toBe("submitting");
          const before = live.state.snapshot().jobs.length;
          yield* testAwait(
            fault === "missing"
              ? unlink(f.settings.registryFile ?? "")
              : writeFile(f.settings.registryFile ?? "", "{invalid"),
          );
          yield* live.registry.reload();
          expect(live.registry.snapshot().error).toBeDefined();
          expect(
            live.jobs.availability().every((builder) => !builder.available),
          ).toBe(true);
          expect(
            yield* Effect.flip(
              live.jobs.start({ ...cutoverRequest, workspacePath: f.root }),
            ),
          ).toMatchObject({ code: "registry-admission-closed" });
          expect(live.state.snapshot().jobs).toHaveLength(before);
          expect(
            (yield* live.jobs.status(
              job.organizationId,
              job.sessionId,
              job.jobId,
            )).generationId,
          ).toBe(job.generationId);
          yield* f.plan({ unknown: true });
          yield* live.jobs.cancel(job.organizationId, job.sessionId, job.jobId);
          const cancelled = yield* live.jobs.status(
            job.organizationId,
            job.sessionId,
            job.jobId,
          );
          expect(cancelled).toMatchObject({
            state: "interrupted",
            generationId: job.generationId,
            recovery: {
              state: "resolved-unknown",
              resolvedEpoch: "b".repeat(32),
            },
          });
          expect(cancelled.recovery.resolvedEpoch).not.toBe(job.epoch);
          expect(live.state.quarantined(cancelled.verifiedHostId)).toBe(false);
          expect(live.registry.snapshot().error).toBeDefined();
          expect(
            (yield* testAwait(f.native.trace()))
              .map((call) => call.command.split(" ")[0])
              .slice(-3),
          ).toEqual(["cancel", "reconcile", "health"]);
          yield* f.plan();
          yield* f.write();
          yield* live.registry.reload();
          yield* live.registry.awaitIdle();
          const next = yield* live.jobs.start({
            ...cutoverRequest,
            workspacePath: f.root,
          });
          yield* live.jobs.wait(next.jobId);
          expect(live.state.snapshot().jobs).toHaveLength(before + 1);
        }),
      ),
  );
it.live(
  "submission checks enabled state without cloning private credentials",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("narrow-enabled"));
        const live = yield* f.boot();
        yield* live.registry.awaitIdle();
        let clones = 0;
        const current = live.registry.current;
        live.registry.current = (...args) => {
          clones++;
          return current(...args);
        };
        const job = yield* live.jobs.start({
          ...cutoverRequest,
          workspacePath: f.root,
        });
        yield* live.jobs.wait(job.jobId);
        expect(clones).toBe(0);
      }),
    ),
);
