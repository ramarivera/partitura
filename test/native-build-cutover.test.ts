import { access, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Option } from "effect";
import { GatewayConfig } from "../src/services/config.js";
import { NativeBuildServicesLive } from "../src/services/native-build-assembly.js";
import { NativeBuildJobs } from "../src/services/native-build-jobs.js";
import { journalFile } from "../src/services/native-build-secret-journal.js";
import { document, entry } from "./fixtures/builder-registry.js";
import {
  cutoverFixture,
  cutoverRequest,
} from "./fixtures/native-build-cutover.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { registryJob } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();

it.live("registry unset acquires no registry services, mounts or helper", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* cutoverFixture(path("legacy-inert"));
      yield* Effect.gen(function* () {
        expect(
          Option.isNone(yield* Effect.serviceOption(NativeBuildJobs)),
        ).toBe(true);
      }).pipe(
        Effect.provide(NativeBuildServicesLive),
        Effect.provideService(GatewayConfig, {
          ...f.config,
          nativeBuildRegistry: { ...f.settings, registryFile: undefined },
        }),
      );
      expect(f.journal.snapshot().operations).toEqual([]);
    }),
  ),
);
it.live(
  "registry assembly serves consumers without waiting for offline builders or invalid desired JSON",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("offline-ingress"));
        yield* f.plan({ unavailable: true });
        yield* testAwait(
          writeFile(f.settings.registryFile ?? "", "{invalid", { mode: 0o600 }),
        );
        const live = yield* f.boot().pipe(Effect.timeout(1500));
        expect(live.registry.snapshot().error).toBeDefined();
        expect(live.jobs.availability()).toEqual([]);
        expect(
          yield* Effect.flip(
            live.jobs.start({ ...cutoverRequest, workspacePath: f.root }),
          ),
        ).toBeDefined();
        yield* f.write();
        yield* live.registry.reload();
        yield* live.registry.awaitIdle();
        expect(
          live.jobs.availability().every((entry) => !entry.available),
        ).toBe(true);
      }),
    ),
);
it.live(
  "local quarantine recovery completes before the first registry consumer, even with the host offline",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("boot-quarantine"));
        const first = yield* f.boot();
        yield* first.registry.awaitIdle();
        const generation = first.state.snapshot().generations[0];
        if (!generation) return yield* Effect.die("missing generation");
        const job = registryJob(generation, {
          state: "submitting",
          submissionExpiresAt: Math.floor(Date.now() / 1000) + 120,
        });
        yield* first.state.transaction((draft) => draft.jobs.push(job));
        yield* first.close;
        yield* f.plan({ unavailable: true });
        const next = yield* f.boot().pipe(Effect.timeout(1500));
        const recovered = next.state.owned(
          job.organizationId,
          job.sessionId,
          job.jobId,
        );
        expect(recovered.recovery.state).not.toBe("not-required");
        expect(next.state.quarantined(generation.transport.hostId)).toBe(true);
        expect(
          next.jobs
            .availability()
            .find((entry) => entry.id === generation.builderId)?.available,
        ).toBe(false);
      }),
    ),
);
it.live(
  "explicit targets never fall back; omitted targets use only the declared order before admission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("selection"));
        const live = yield* f.boot();
        yield* live.registry.awaitIdle();
        const ordered = {
          ...document([entry("primary", false), entry("backup")]),
          selection: {
            fallback: "before-submission" as const,
            fallbackBuilders: ["backup"],
          },
        };
        yield* f.write(ordered);
        yield* live.registry.reload();
        yield* live.registry.awaitIdle();
        yield* Effect.flip(
          live.jobs.start({
            ...cutoverRequest,
            workspacePath: f.root,
            builder: "primary",
          }),
        );
        expect(live.state.snapshot().jobs).toHaveLength(0);
        const chosen = yield* live.jobs.start({
          ...cutoverRequest,
          workspacePath: f.root,
        });
        expect(chosen.builderId).toBe("backup");
        yield* live.jobs.wait(chosen.jobId);
        expect(
          (yield* live.jobs.status("org-a", "session-a", chosen.jobId)).state,
        ).toBe("succeeded");
        const runs = (yield* testAwait(f.native.trace())).filter((entry) =>
          entry.command.startsWith("run-v2"),
        );
        expect(runs).toHaveLength(1);
        expect(runs[0]?.hostname).toBe(f.backup.hostname);
        yield* f.write({
          ...ordered,
          defaultBuilder: null,
          selection: { fallback: "none", fallbackBuilders: [] },
        });
        yield* live.registry.reload();
        yield* Effect.flip(
          live.jobs.start({ ...cutoverRequest, workspacePath: f.root }),
        );
        expect(live.state.snapshot().jobs).toHaveLength(1);
      }),
    ),
);
for (const refusal of ["host-busy", "host-maintenance"])
  it.live(
    `a ${refusal} result is never retried on the admitted host or a fallback`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* cutoverFixture(path(`no-retry-${refusal}`));
          const live = yield* f.boot();
          yield* live.registry.awaitIdle();
          yield* f.write({
            ...document([entry(), entry("backup")]),
            selection: {
              fallback: "before-submission",
              fallbackBuilders: ["backup"],
            },
          });
          yield* live.registry.reload();
          yield* f.plan({ refusal, unknown: true });
          const job = yield* live.jobs.start({
            ...cutoverRequest,
            workspacePath: f.root,
          });
          yield* live.jobs.wait(job.jobId);
          expect(live.state.snapshot().jobs).toHaveLength(1);
          const runs = (yield* testAwait(f.native.trace())).filter((entry) =>
            entry.command.startsWith("run-v2"),
          );
          expect(runs).toHaveLength(1);
          expect(runs[0]?.hostname).toBe(f.primary.hostname);
        }),
      ),
  );
it.live(
  "disable wins while preparing and prevents run-v2 without moving the job",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("disable-preparation"));
        const entered = yield* Deferred.make<void>();
        const live = yield* f.boot(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        );
        yield* live.registry.awaitIdle();
        const job = yield* live.jobs.start({
          ...cutoverRequest,
          workspacePath: f.root,
        });
        yield* Deferred.await(entered);
        yield* f.write(document([entry("primary", false), entry("backup")]));
        yield* live.registry.reload();
        yield* live.jobs.wait(job.jobId);
        expect(
          (yield* live.jobs.status("org-a", "session-a", job.jobId)).state,
        ).toBe("failed");
        expect(
          (yield* testAwait(f.native.trace())).some((call) =>
            call.command.startsWith("run-v2"),
          ),
        ).toBe(false);
        expect(live.state.snapshot().jobs).toHaveLength(1);
      }),
    ),
);
it.live(
  "submitting wins before disable and drains on its admitted generation; ownership survives restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("drain-restart"));
        const live = yield* f.boot();
        yield* live.registry.awaitIdle();
        const barrier = join(f.native.root, "run-release");
        yield* f.plan({ runBarrier: barrier });
        const job = yield* live.jobs.start({
          ...cutoverRequest,
          workspacePath: f.root,
        });
        for (let attempt = 0; ; attempt++) {
          if (
            yield* testAwait(
              access(join(f.native.root, "run-entered")).then(
                () => true,
                () => false,
              ),
            )
          )
            break;
          if (attempt >= 200)
            return yield* Effect.die("broker never entered run-v2");
          yield* Effect.sleep(5);
        }
        expect(live.state.owned("org-a", "session-a", job.jobId).state).toBe(
          "submitting",
        );
        yield* f.write(document([entry("primary", false), entry("backup")]));
        yield* live.registry.reload();
        yield* testAwait(writeFile(barrier, "release", { mode: 0o600 }));
        yield* live.jobs.wait(job.jobId);
        const artifact = yield* live.jobs.artifact(
          "org-a",
          "session-a",
          job.jobId,
        );
        expect(artifact.bytes).toBeGreaterThan(0);
        artifact.release();
        yield* Effect.flip(
          live.jobs.status("org-other", "session-a", job.jobId),
        );
        yield* Effect.flip(
          live.jobs.status("org-a", "session-a", job.jobId, "backup"),
        );
        yield* live.close;
        const restarted = yield* f.boot();
        yield* restarted.registry.awaitIdle();
        expect(
          (yield* restarted.jobs.status("org-a", "session-a", job.jobId))
            .generationId,
        ).toBe(job.generationId);
        const retained = yield* restarted.jobs.artifact(
          "org-a",
          "session-a",
          job.jobId,
        );
        expect(retained.sha256).toBe(artifact.sha256);
        retained.release();
        yield* restarted.jobs.cancel("org-a", "session-a", job.jobId);
        const runs = (yield* testAwait(f.native.trace())).filter((call) =>
          call.command.startsWith("run-v2"),
        );
        expect(runs).toHaveLength(1);
      }),
    ),
);
it.live(
  "periodic admission health is cache-only and skips a host reserved by preparation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("cache-health"));
        const entered = yield* Deferred.make<void>();
        const live = yield* f.boot(() =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        );
        yield* live.registry.awaitIdle();
        const before = (yield* testAwait(f.native.trace())).length;
        yield* live.jobs.checkHealth();
        yield* live.registry.awaitIdle();
        expect((yield* testAwait(f.native.trace())).length).toBe(before + 2);
        const job = yield* live.jobs.start({
          ...cutoverRequest,
          workspacePath: f.root,
        });
        yield* Deferred.await(entered);
        const reserved = (yield* testAwait(f.native.trace())).length;
        yield* live.jobs.checkHealth();
        yield* live.registry.awaitIdle();
        const extra = (yield* testAwait(f.native.trace())).slice(reserved);
        expect(extra.map((call) => call.hostname)).toEqual([f.backup.hostname]);
        expect(live.journal.snapshot().operations).toEqual([]);
        yield* live.jobs.cancel("org-a", "session-a", job.jobId);
      }),
    ),
);
it.live(
  "removed recovery sources count toward the cold-start capacity gate for newly enabled provider entries",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("retained-capacity"));
        const live = yield* f.boot();
        yield* live.registry.awaitIdle();
        const source = `onepassword:${f.settings.vaultId}:${"z".repeat(26)}`;
        const generation = yield* live.state.addGeneration(
          "retired",
          { ...f.native.metadata, source },
          f.native.key,
        );
        yield* live.state.transaction((draft) =>
          draft.jobs.push(
            registryJob(generation, {
              state: "interrupted",
              recovery: {
                ...registryJob(generation).recovery,
                state: "operator-required",
                lastReason: "missing-credentials",
              },
            }),
          ),
        );
        const added = Array.from({ length: 8 }, (_, n) => ({
          ...entry(`builder-${n}`),
          secretSource: {
            type: "onepassword" as const,
            vaultId: f.settings.vaultId ?? "",
            itemId: String(n).padStart(26, "a"),
          },
        }));
        yield* f.write(document([entry(), entry("backup"), ...added]));
        yield* live.registry.reload();
        yield* live.registry.awaitIdle();
        expect(live.registry.snapshot().capacityError).toBe("budget-capacity");
        expect(
          live.registry
            .snapshot()
            .entries.filter((item) => item.id.startsWith("builder-"))
            .every((item) => item.reason === "budget-capacity"),
        ).toBe(true);
        expect(live.journal.snapshot().charges).toEqual([]);
      }),
    ),
);

it.live(
  "missing provider accounting closes reads without blocking file builds or creating a fresh journal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("journal-unavailable"));
        yield* testAwait(unlink(journalFile(f.settings.stateRoot)));
        const live = yield* f.boot();
        yield* live.registry.awaitIdle();
        const error = yield* Effect.flip(
          live.cache.accept(
            "human",
            [
              {
                source: "file:primary.json",
                builderId: "primary",
                revision: 1,
                retained: false,
              },
            ],
            "org",
          ),
        );
        expect(error.code).toBe("journal-repair-required");
        const job = yield* live.jobs.start({
          ...cutoverRequest,
          workspacePath: f.root,
        });
        yield* live.jobs.wait(job.jobId);
        expect(
          (yield* live.jobs.status("org-a", "session-a", job.jobId)).state,
        ).toBe("succeeded");
        expect(
          yield* testAwait(
            access(journalFile(f.settings.stateRoot)).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
    ),
);
