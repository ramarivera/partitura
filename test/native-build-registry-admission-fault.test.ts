import { unlink, writeFile } from "node:fs/promises";
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
    `a hot ${fault} registry closes starts until a valid reload, retaining existing jobs`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* cutoverFixture(path(fault));
          const live = yield* f.boot();
          yield* live.registry.awaitIdle();
          const job = yield* live.jobs.start({
            ...cutoverRequest,
            workspacePath: f.root,
          });
          yield* live.jobs.wait(job.jobId);
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
