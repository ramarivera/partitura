import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  createNativeBuildRecovery,
  recoverNativeMetadata,
} from "../src/services/native-build-recovery.js";
import { createRegistryNativeBuildClient } from "../src/services/native-build-registry-client.js";
import {
  nativeLimits,
  openNativeBuildState,
} from "../src/services/native-build-state.js";
import { memoryBroker } from "./fixtures/native-build-broker.js";
import { testAwait, testRejects } from "./fixtures/native-build-effects.js";
import {
  fixtureHost,
  fixturePayload,
  registryFixture,
  registryJob,
} from "./fixtures/native-build-registry.js";
import {
  type BrokerEnvelope,
  createNativeBuildTransport,
  decodeBrokerEnvelope,
} from "./fixtures/native-build-transport.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const bundle = async function* () {
  yield Buffer.from("fake git bundle bytes");
};

it.live(
  "runs the isolated engine through fake SSH start/artifact/cancel/restart on the original generation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("engine")));
        const client = yield* testAwait(
          createRegistryNativeBuildClient(fixture.state, fixture.transport, {
            canSubmit: () => true,
            prepareBundle: () => Effect.succeed(bundle()),
          }),
        );
        const request = {
          organizationId: "org-a",
          sessionId: "session-a",
          generationId: fixture.generation.id,
          workspacePath: fixture.root,
          commit: "e".repeat(40),
          pullRequest: 7,
          action: "archive",
        };
        try {
          const job = yield* testAwait(client.start(request));
          yield* testAwait(client.wait(job.jobId));
          expect(
            (yield* client.status("org-a", "session-a", job.jobId)).state,
          ).toBe("succeeded");
          expect(fixture.state.quarantined(fixtureHost)).toBe(false);
          yield* testAwait(
            expect(
              testRejects(client.status("other-org", "session-a", job.jobId)),
            ).rejects.toThrow("not-found"),
          );
          yield* testAwait(
            expect(
              testRejects(client.status("org-a", "other-session", job.jobId)),
            ).rejects.toThrow("not-found"),
          );
          yield* testAwait(
            expect(
              testRejects(client.cancel("other-org", "session-a", job.jobId)),
            ).rejects.toThrow("not-found"),
          );
          const newer = yield* testAwait(
            fixture.state.addGeneration(
              "primary",
              { ...fixture.metadata, hostname: "new.example.test" },
              fixture.key,
            ),
          );
          yield* testAwait(fixture.transport.materialize(newer, fixture.key));
          const artifact = yield* testAwait(
            client.artifact("org-a", "session-a", job.jobId, "primary"),
          );
          expect(yield* testAwait(readFile(artifact.path, "utf8"))).toBe(
            fixturePayload,
          );
          artifact.release();
          artifact.release();
          yield* testAwait(client.cancel("org-a", "session-a", job.jobId));
          expect(fixture.state.quarantined(fixtureHost)).toBe(false);
          expect(
            (yield* client.status("org-a", "session-a", job.jobId)).recovery
              .state,
          ).toBe("resolved-terminal");
          const trace = yield* testAwait(fixture.trace());
          expect(
            trace.filter((entry) => entry.command.startsWith("run-v2 ")),
          ).toHaveLength(1);
          expect(
            trace
              .filter((entry) =>
                /^(artifact|cancel|reconcile|status) /u.test(entry.command),
              )
              .every((entry) => entry.hostname === "builder.example.test"),
          ).toBe(true);
          expect(
            trace.every(
              (entry) =>
                !Object.keys(entry.env).some((key) =>
                  /TOKEN|SECRET|SSH_AUTH|OPENAI|ANTHROPIC/u.test(key),
                ),
            ),
          ).toBe(true);
          expect(
            yield* testAwait(
              readFile(
                join(fixture.options.stateRoot, "metadata.json"),
                "utf8",
              ),
            ),
          ).not.toContain(fixture.key);
          yield* testAwait(client.close());
          yield* testAwait(fixture.state.close());
          const state = yield* testAwait(openNativeBuildState(fixture.options));
          try {
            const transport = yield* testAwait(
              createNativeBuildTransport(state, {
                suffix: "example.test",
                executable: fixture.executable,
              }),
            );
            yield* testAwait(
              transport.restore(fixture.metadata.source, [fixture.key]),
            );
            const restarted = yield* testAwait(
              createRegistryNativeBuildClient(state, transport, {
                canSubmit: () => true,
                prepareBundle: () => Effect.succeed(bundle()),
              }),
            );
            const cached = yield* testAwait(
              restarted.artifact("org-a", "session-a", job.jobId),
            );
            expect(yield* testAwait(readFile(cached.path, "utf8"))).toBe(
              fixturePayload,
            );
            cached.release();
            yield* testAwait(restarted.close());
            expect(
              (yield* testAwait(fixture.trace())).filter((entry) =>
                entry.command.startsWith("run-v2 "),
              ),
            ).toHaveLength(1);
          } finally {
            yield* testAwait(state.close());
          }
        } finally {
          yield* testAwait(fixture.state.close());
        }
      }),
    ),
);

it.live(
  "crash recovery interrupts starting locally but quarantines submitting before any remote IO",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("crashes")));
        const starting = registryJob(fixture.generation);
        const submitting = registryJob(fixture.generation, {
          state: "submitting",
          sessionId: "submitted",
          submissionExpiresAt: 1234,
        });
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(starting, submitting);
          }),
        );
        const reservation = yield* testAwait(
          fixture.state.reserve(starting, "source.bundle", 20),
        );
        yield* testAwait(
          writeFile(reservation.path, "local preparation", { mode: 0o600 }),
        );
        yield* testAwait(reservation.commit());
        yield* testAwait(fixture.state.close());
        const state = yield* testAwait(openNativeBuildState(fixture.options));
        try {
          yield* testAwait(recoverNativeMetadata(state, 100_000));
          expect(state.owned("org-a", "session-a", starting.jobId).state).toBe(
            "interrupted",
          );
          expect(
            state.owned("org-a", "submitted", submitting.jobId).recovery.state,
          ).toBe("pending");
          expect(state.quarantined(fixtureHost)).toBe(true);
          yield* testAwait(
            expect(testRejects(readFile(reservation.path))).rejects.toThrow(),
          );
          const transport = yield* testAwait(
            createNativeBuildTransport(state, {
              suffix: "example.test",
              executable: fixture.executable,
            }),
          );
          const recovery = createNativeBuildRecovery(state, transport, {
            now: () => 100_000,
          });
          yield* testAwait(recovery.tick(submitting.jobId));
          expect(
            state.owned("org-a", "submitted", submitting.jobId).recovery
              .observation,
          ).toBe("credentials-pending");
          expect(
            state.owned("org-a", "submitted", submitting.jobId).recovery.state,
          ).toBe("pending");
          yield* testAwait(transport.restore(fixture.metadata.source, []));
          const settled = createNativeBuildRecovery(state, transport, {
            now: () => 110_000,
          });
          yield* testAwait(settled.tick(submitting.jobId));
          expect(
            state.owned("org-a", "submitted", submitting.jobId).recovery
              .lastReason,
          ).toBe("missing-credentials");
          yield* testAwait(
            expect(testRejects(fixture.trace())).rejects.toThrow(),
          );
        } finally {
          yield* testAwait(state.close());
        }
      }),
    ),
);

it.live(
  "ambiguous run exits recover typed unknown without ever resubmitting",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("ambiguous")));
        yield* testAwait(fixture.plan({ lostRun: true }));
        const client = yield* testAwait(
          createRegistryNativeBuildClient(fixture.state, fixture.transport, {
            canSubmit: () => true,
            prepareBundle: () => Effect.succeed(bundle()),
          }),
        );
        try {
          const job = yield* testAwait(
            client.start({
              organizationId: "org-a",
              sessionId: "session-a",
              generationId: fixture.generation.id,
              workspacePath: fixture.root,
              commit: "e".repeat(40),
              pullRequest: 7,
              action: "archive",
            }),
          );
          yield* testAwait(client.wait(job.jobId));
          expect(
            (yield* client.status("org-a", "session-a", job.jobId)).state,
          ).toBe("submitting");
          yield* testAwait(fixture.plan({ unknown: true }));
          yield* testAwait(client.recovery.tick(job.jobId));
          expect(
            (yield* client.status("org-a", "session-a", job.jobId)).state,
          ).toBe("interrupted");
          expect(
            (yield* client.status("org-a", "session-a", job.jobId)).recovery
              .state,
          ).toBe("resolved-unknown");
          expect(fixture.state.quarantined(fixtureHost)).toBe(false);
          expect(
            (yield* testAwait(fixture.trace())).filter((entry) =>
              entry.command.startsWith("run-v2 "),
            ),
          ).toHaveLength(1);
        } finally {
          yield* testAwait(fixture.state.close());
        }
      }),
    ),
);

it.live(
  "clean host-busy EPIPE refusal fails once without initiating recovery",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("busy-refusal")));
        yield* testAwait(fixture.plan({ busyRefusal: true }));
        const upload = async function* () {
          for (let index = 0; index < 128; index++) yield Buffer.alloc(65_536);
        };
        const client = yield* testAwait(
          createRegistryNativeBuildClient(fixture.state, fixture.transport, {
            canSubmit: () => true,
            prepareBundle: () => Effect.succeed(upload()),
          }),
        );
        try {
          const job = yield* testAwait(
            client.start({
              organizationId: "org-a",
              sessionId: "session-a",
              generationId: fixture.generation.id,
              workspacePath: fixture.root,
              commit: "e".repeat(40),
              pullRequest: 7,
              action: "archive",
            }),
          );
          yield* testAwait(client.wait(job.jobId));
          expect(
            (yield* client.status("org-a", "session-a", job.jobId)).failureCode,
          ).toBe("host-busy");
          expect(
            (yield* client.status("org-a", "session-a", job.jobId)).recovery
              .state,
          ).toBe("not-required");
          expect(fixture.state.quarantined(fixtureHost)).toBe(false);
          expect(
            (yield* testAwait(fixture.trace())).some((entry) =>
              /^(cancel|reconcile) /u.test(entry.command),
            ),
          ).toBe(false);
        } finally {
          yield* testAwait(fixture.state.close());
        }
      }),
    ),
);

it.live(
  "disable winning the dispatch boundary prevents run-v2 and remote cancel",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("disable")));
        let enabled = true;
        const upload = async function* () {
          yield Buffer.from("bundle");
          enabled = false;
        };
        const client = yield* testAwait(
          createRegistryNativeBuildClient(fixture.state, fixture.transport, {
            canSubmit: () => enabled,
            prepareBundle: () => Effect.succeed(upload()),
          }),
        );
        try {
          const job = yield* testAwait(
            client.start({
              organizationId: "org-a",
              sessionId: "session-a",
              generationId: fixture.generation.id,
              workspacePath: fixture.root,
              commit: "e".repeat(40),
              pullRequest: 7,
              action: "archive",
            }),
          );
          yield* testAwait(client.wait(job.jobId));
          yield* testAwait(client.cancel("org-a", "session-a", job.jobId));
          expect(
            (yield* client.status("org-a", "session-a", job.jobId)).state,
          ).toBe("failed");
          expect(
            (yield* testAwait(fixture.trace())).map((entry) => entry.command),
          ).toEqual(["health"]);
        } finally {
          yield* testAwait(fixture.state.close());
        }
      }),
    ),
);

it.live(
  "bounds lying artifact streams and releases partial quota without retrying the build",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("lying")));
        const client = yield* testAwait(
          createRegistryNativeBuildClient(fixture.state, fixture.transport, {
            canSubmit: () => true,
            prepareBundle: () => Effect.succeed(bundle()),
          }),
        );
        try {
          const job = yield* testAwait(
            client.start({
              organizationId: "org-a",
              sessionId: "session-a",
              generationId: fixture.generation.id,
              workspacePath: fixture.root,
              commit: "e".repeat(40),
              pullRequest: 7,
              action: "archive",
            }),
          );
          yield* testAwait(client.wait(job.jobId));
          yield* testAwait(fixture.plan({ corrupt: true }));
          yield* testAwait(
            expect(
              testRejects(client.artifact("org-a", "session-a", job.jobId)),
            ).rejects.toThrow(),
          );
          yield* testAwait(
            expect(
              testRejects(
                readFile(join(fixture.state.jobPath(job), "artifact.partial")),
              ),
            ).rejects.toThrow(),
          );
          yield* testAwait(fixture.plan({}));
          const artifact = yield* testAwait(
            client.artifact("org-a", "session-a", job.jobId),
          );
          artifact.release();
          expect(
            (yield* testAwait(fixture.trace())).filter((entry) =>
              entry.command.startsWith("run-v2 "),
            ),
          ).toHaveLength(1);
        } finally {
          yield* testAwait(fixture.state.close());
        }
      }),
    ),
);

it.live(
  "fresh receiving heartbeats do not spend failures but cannot exceed 750 seconds",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("heartbeat")));
        let time = 1_000_000;
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(job);
          }),
        );
        yield* testAwait(recoverNativeMetadata(fixture.state, time));
        const broker = memoryBroker(() => time);
        broker.settings.busy = true;
        const recovery = createNativeBuildRecovery(
          fixture.state,
          broker.transport,
          { now: () => time },
        );
        try {
          for (let index = 0; index < 51; index++) {
            yield* testAwait(recovery.tick(job.jobId));
            time += 15_000;
          }
          const result = fixture.state.owned("org-a", "session-a", job.jobId);
          expect(result.recovery.attempts).toBe(0);
          expect(result.recovery.state).toBe("operator-required");
          expect(result.recovery.lastReason).toBe("busy");
          expect(fixture.state.quarantined(fixtureHost)).toBe(true);
          expect(
            broker.calls.some((call) => call.command.startsWith("run")),
          ).toBe(false);
        } finally {
          yield* testAwait(fixture.state.close());
        }
      }),
    ),
);

it.live(
  "six unavailable failures survive restart, then consume exactly one same-generation return latch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("latch")));
        let time = 1_000_000;
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(job);
          }),
        );
        yield* testAwait(recoverNativeMetadata(fixture.state, time));
        const broker = memoryBroker(() => time);
        broker.settings.unavailable = true;
        const recovery = createNativeBuildRecovery(
          fixture.state,
          broker.transport,
          { now: () => time },
        );
        for (const delay of [0, 5_000, 15_000, 30_000, 60_000, 120_000]) {
          time += delay;
          yield* testAwait(recovery.tick(job.jobId));
        }
        const held = fixture.state.owned("org-a", "session-a", job.jobId);
        expect(held.recovery.attempts).toBe(6);
        expect(held.recovery.state).toBe("operator-required");
        const rotated = yield* testAwait(
          fixture.state.addGeneration(
            "primary",
            { ...fixture.metadata, hostname: "current.example.test" },
            fixture.key,
          ),
        );
        yield* testAwait(fixture.state.close());
        const state = yield* testAwait(openNativeBuildState(fixture.options));
        try {
          yield* testAwait(recoverNativeMetadata(state, time));
          const after = state.owned("org-a", "session-a", job.jobId);
          expect(after.recovery.deadline).toBe(held.recovery.deadline);
          expect(after.recovery.attempts).toBe(6);
          const restart = createNativeBuildRecovery(state, broker.transport, {
            now: () => time,
          });
          broker.settings.unavailable = false;
          broker.settings.busy = true;
          time = after.recovery.nextAt;
          yield* testAwait(restart.tick(job.jobId));
          expect(
            state.owned("org-a", "session-a", job.jobId).recovery
              .returnEventUsed,
          ).toBe(true);
          const count = broker.calls.length;
          broker.settings.busy = false;
          time += 600_000;
          yield* testAwait(restart.tick(job.jobId));
          expect(broker.calls).toHaveLength(count);
          expect(
            broker.calls.every((call) => call.generationId !== rotated.id),
          ).toBe(true);
          expect(state.quarantined(fixtureHost)).toBe(true);
        } finally {
          yield* testAwait(state.close());
        }
        const again = yield* testAwait(openNativeBuildState(fixture.options));
        try {
          const count = broker.calls.length;
          const restart = createNativeBuildRecovery(again, broker.transport, {
            now: () => time + 600_000,
          });
          yield* testAwait(restart.tick(job.jobId));
          expect(broker.calls).toHaveLength(count);
        } finally {
          yield* testAwait(again.close());
        }
      }),
    ),
);

it.live(
  "host-return can release a safe unknown hold but cleanup faults remain manual",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(
          registryFixture(path("return-success")),
        );
        let time = 1_000_000;
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        job.recovery.state = "operator-required";
        job.recovery.lastReason = "unavailable";
        job.recovery.deadline = 1;
        job.recovery.nextAt = time;
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(job);
          }),
        );
        const broker = memoryBroker(() => time);
        const recovery = createNativeBuildRecovery(
          fixture.state,
          broker.transport,
          { now: () => time },
        );
        try {
          yield* testAwait(recovery.tick(job.jobId));
          expect(fixture.state.quarantined(fixtureHost)).toBe(false);
          expect(
            fixture.state.owned("org-a", "session-a", job.jobId).recovery.state,
          ).toBe("resolved-unknown");
          for (const reason of [
            "cleanup-required",
            "keychain-relock-pending",
            "wrong-host",
            "protocol-mismatch",
            "missing-credentials",
          ] as const) {
            yield* testAwait(
              fixture.state.transaction((draft) => {
                const current = draft.jobs[0];
                if (!current) throw new Error("no-job");
                current.recovery.state = "operator-required";
                current.recovery.returnEventUsed = false;
                current.recovery.lastReason = reason;
                current.recovery.nextAt = time;
              }),
            );
            const count = broker.calls.length;
            time += 600_000;
            yield* testAwait(recovery.tick(job.jobId));
            expect(broker.calls).toHaveLength(count);
          }
        } finally {
          yield* testAwait(fixture.state.close());
        }
      }),
    ),
);

it.live(
  "cleanup/epoch failures never release quarantine and wrong-host envelopes are rejected",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("unsafe")));
        const time = 1_000_000;
        const job = registryJob(fixture.generation, {
          state: "submitting",
          submissionExpiresAt: 1,
        });
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(job);
          }),
        );
        yield* testAwait(recoverNativeMetadata(fixture.state, time));
        const broker = memoryBroker(() => time);
        broker.settings.cleanup = "cleanup-required";
        try {
          const recovery = createNativeBuildRecovery(
            fixture.state,
            broker.transport,
            { now: () => time },
          );
          yield* testAwait(recovery.tick(job.jobId));
          expect(
            fixture.state.owned("org-a", "session-a", job.jobId).recovery
              .lastReason,
          ).toBe("cleanup-required");
          expect(fixture.state.quarantined(fixtureHost)).toBe(true);
          yield* testAwait(
            fixture.state.transaction((draft) => {
              const current = draft.jobs[0];
              if (!current) throw new Error("no-job");
              current.recovery.state = "pending";
              current.recovery.nextAt = time;
            }),
          );
          broker.settings.cleanup = "";
          broker.settings.badHealthEpoch = true;
          yield* testAwait(recovery.tick(job.jobId));
          expect(
            fixture.state.owned("org-a", "session-a", job.jobId).recovery
              .lastReason,
          ).toBe("protocol-mismatch");
          expect(fixture.state.quarantined(fixtureHost)).toBe(true);
          const envelope: BrokerEnvelope = {
            protocolVersion: 2,
            hostId: "wrong",
            kind: "cancellation-requested",
            job: job.jobId,
          };
          expect(() =>
            decodeBrokerEnvelope(
              `${JSON.stringify(envelope)}\n`,
              fixture.generation,
              job,
            ),
          ).toThrow("wrong-host");
          expect(() =>
            decodeBrokerEnvelope("{}\n", fixture.generation, job),
          ).toThrow("protocol-mismatch");
          expect(() =>
            decodeBrokerEnvelope(
              `${JSON.stringify({ ...envelope, hostId: fixtureHost, extra: "unsafe" })}\n`,
              fixture.generation,
              job,
            ),
          ).toThrow("protocol-mismatch");
        } finally {
          yield* testAwait(fixture.state.close());
        }
      }),
    ),
);

it.live("scratch quota refusal happens before artifact SSH", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* registryFixture(path("artifact-quota"), {
        bytesTotal: nativeLimits.bundle + nativeLimits.overhead,
      });
      yield* Effect.gen(function* () {
        const client = yield* createRegistryNativeBuildClient(
          fixture.state,
          fixture.transport,
          {
            canSubmit: () => true,
            prepareBundle: () => Effect.succeed(bundle()),
          },
        );
        const job = yield* client.start({
          organizationId: "org-a",
          sessionId: "session-a",
          generationId: fixture.generation.id,
          workspacePath: fixture.root,
          commit: "e".repeat(40),
          pullRequest: 7,
          action: "archive",
        });
        yield* client.wait(job.jobId);
        const held = yield* fixture.state.reserve(
          job,
          "source.bundle",
          nativeLimits.bundle,
        );
        yield* testAwait(
          expect(
            testRejects(client.artifact("org-a", "session-a", job.jobId)),
          ).rejects.toThrow("scratch-quota-exceeded"),
        ).pipe(Effect.ensuring(held.release().pipe(Effect.orDie)));
        expect(
          (yield* testAwait(fixture.trace())).some((call) =>
            call.command.startsWith("artifact "),
          ),
        ).toBe(false);
      }).pipe(Effect.ensuring(fixture.state.close().pipe(Effect.orDie)));
    }),
  ),
);
