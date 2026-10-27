import { writeFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { cutoverFixture } from "./fixtures/native-build-cutover.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { registryJob } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.live(
  "valid publications and recovery changes prune obsolete bindings, preserving pending work and unreadable snapshots",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("retention"));
        const live = yield* f.boot();
        yield* live.registry.awaitIdle();
        const generation = live.state.snapshot().generations[0];
        if (!generation) return yield* Effect.die("missing generation");
        const retained = yield* live.state.addGeneration(
          "removed",
          { ...generation.transport, source: "file:removed.json" },
          f.native.key,
        );
        const job = registryJob(retained, {
          state: "interrupted",
          recovery: {
            ...registryJob(retained).recovery,
            state: "operator-required",
            lastReason: "missing-credentials",
            nextAt: Date.now() + 86400000,
          },
        });
        yield* live.state.transaction((draft) => draft.jobs.push(job));
        const at = Date.now();
        yield* live.journal.transaction((draft) => {
          for (let i = 0; i < 318; i++)
            draft.successes[`file:obsolete-${i}.json@1`] = at;
          draft.successes["file:removed.json@0"] = at;
          draft.successes["file:pending.json@1"] = at;
          draft.operations.push({
            id: "e".repeat(32),
            kind: "human",
            org: "org",
            all: false,
            acceptedAt: at,
            deadline: at + 7200000,
            sources: [
              {
                builderId: "pending",
                source: "file:pending.json",
                revision: 1,
                retained: true,
                status: "pending",
                createdAt: at,
                deadline: at + 7200000,
                attempts: 0,
                nextFit: at + 3600000,
              },
            ],
          });
        });
        yield* testAwait(writeFile(f.settings.registryFile ?? "", "{invalid"));
        yield* live.registry.reload();
        // Exercise the periodic sweep, not just the invalid reload path.
        yield* Effect.sleep(1100);
        expect(live.registry.snapshot().error).toBeDefined();
        expect(Object.keys(live.journal.snapshot().successes)).toHaveLength(
          320,
        );
        yield* f.write();
        yield* live.registry.reload();
        expect(live.journal.snapshot().successes).toEqual({
          "file:removed.json@0": at,
          "file:pending.json@1": at,
        });
        expect(live.cache.progress("e".repeat(32))?.sources[0]?.status).toBe(
          "pending",
        );
        yield* live.state.transaction((draft) => {
          const current = draft.jobs.find((entry) => entry.jobId === job.jobId);
          if (current) current.recovery.state = "admin-resolved";
        });
        yield* Effect.repeat(Effect.sleep(10), {
          until: () =>
            live.journal.snapshot().successes["file:removed.json@0"] ===
            undefined,
        });
        expect(live.journal.snapshot().successes).toEqual({
          "file:pending.json@1": at,
        });
        expect(live.journal.snapshot().charges).toEqual([]);
      }),
    ).pipe(Effect.timeout(4000)),
);
