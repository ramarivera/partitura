import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { vi } from "vitest";
import { document, entry } from "./fixtures/builder-registry.js";
import {
  cutoverFixture,
  cutoverRequest,
} from "./fixtures/native-build-cutover.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { testPaths } from "./fixtures/paths.js";

const disk = vi.hoisted(() => ({
  beforeRename: undefined as
    | undefined
    | ((from: string, to: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      if (
        disk.beforeRename &&
        typeof args[0] === "string" &&
        typeof args[1] === "string"
      )
        await disk.beforeRename(args[0], args[1]);
      return fs.rename(...args);
    },
  };
});
const path = testPaths();
it.live(
  "publication cannot land between canSubmit and the durable submitting commit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("submit-gate"));
        const live = yield* f.boot();
        yield* live.registry.awaitIdle();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let once = false;
        disk.beforeRename = async (from, to) => {
          if (once || !to.endsWith("/metadata.json")) return;
          const draft = await Bun.file(from).json();
          if (
            !draft.jobs.some(
              (job: { state: string }) => job.state === "submitting",
            )
          )
            return;
          once = true;
          entered.resolve();
          await release.promise;
        };
        yield* Effect.gen(function* () {
          const job = yield* live.jobs.start({
            ...cutoverRequest,
            workspacePath: f.root,
          });
          yield* testAwait(entered.promise);
          expect(
            live.state.owned(job.organizationId, job.sessionId, job.jobId)
              .state,
          ).toBe("starting");
          const attempting = yield* Deferred.make<void>();
          const published = yield* Deferred.make<void>();
          const disable = yield* Deferred.succeed(attempting, undefined).pipe(
            Effect.andThen(
              live.registry.publish(document([entry("primary", false)])),
            ),
            Effect.andThen(Deferred.succeed(published, undefined)),
            Effect.forkChild,
          );
          yield* Deferred.await(attempting);
          expect(
            yield* Effect.raceFirst(
              Deferred.await(published).pipe(Effect.as(true)),
              Effect.sleep(30).pipe(Effect.as(false)),
            ),
          ).toBe(false);
          expect(live.registry.enabled("primary")).toBe(true);
          release.resolve();
          yield* Fiber.join(disable);
          yield* live.jobs.wait(job.jobId);
          expect(live.registry.enabled("primary")).toBe(false);
          expect(
            live.state.owned(job.organizationId, job.sessionId, job.jobId)
              .generationId,
          ).toBe(job.generationId);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              disk.beforeRename = undefined;
              release.resolve();
            }),
          ),
        );
      }),
    ).pipe(Effect.timeout(10000)),
);
