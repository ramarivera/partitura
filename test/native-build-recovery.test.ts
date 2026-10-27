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
import {
  type BrokerEnvelope,
  createNativeBuildTransport,
  decodeBrokerEnvelope,
  type NativeBrokerTransport,
  NativeTransportError,
} from "../src/services/native-build-transport.js";
import {
  fixtureHost,
  fixturePayload,
  registryFixture,
  registryJob,
} from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const bundle = async function* () {
  yield Buffer.from("fake git bundle bytes");
};

it.live(
  "runs the isolated engine through fake SSH start/artifact/cancel/restart on the original generation",
  () =>
    Effect.promise(async () => {
      const fixture = await registryFixture(path("engine"));
      const client = await createRegistryNativeBuildClient(
        fixture.state,
        fixture.transport,
        { canSubmit: () => true, prepareBundle: bundle },
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
        const job = await client.start(request);
        await client.wait(job.jobId);
        expect(client.status("org-a", "session-a", job.jobId).state).toBe(
          "succeeded",
        );
        expect(fixture.state.quarantined(fixtureHost)).toBe(true);
        expect(() =>
          client.status("other-org", "session-a", job.jobId),
        ).toThrow("not-found");
        expect(() =>
          client.status("org-a", "other-session", job.jobId),
        ).toThrow("not-found");
        await expect(
          client.cancel("other-org", "session-a", job.jobId),
        ).rejects.toThrow("not-found");
        const newer = await fixture.state.addGeneration(
          "primary",
          { ...fixture.metadata, hostname: "new.example.test" },
          fixture.key,
        );
        await fixture.transport.materialize(newer, fixture.key);
        const artifact = await client.artifact(
          "org-a",
          "session-a",
          job.jobId,
          "primary",
        );
        expect(await readFile(artifact.path, "utf8")).toBe(fixturePayload);
        artifact.release();
        artifact.release();
        await client.cancel("org-a", "session-a", job.jobId);
        expect(fixture.state.quarantined(fixtureHost)).toBe(false);
        expect(
          client.status("org-a", "session-a", job.jobId).recovery.state,
        ).toBe("resolved-terminal");
        const trace = await fixture.trace();
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
          await readFile(
            join(fixture.options.stateRoot, "metadata.json"),
            "utf8",
          ),
        ).not.toContain(fixture.key);
        await client.close();
        await fixture.state.close();
        const state = await openNativeBuildState(fixture.options);
        try {
          const transport = await createNativeBuildTransport(state, {
            suffix: "example.test",
            executable: fixture.executable,
          });
          await transport.restore(fixture.metadata.source, [fixture.key]);
          const restarted = await createRegistryNativeBuildClient(
            state,
            transport,
            { canSubmit: () => true, prepareBundle: bundle },
          );
          const cached = await restarted.artifact(
            "org-a",
            "session-a",
            job.jobId,
          );
          expect(await readFile(cached.path, "utf8")).toBe(fixturePayload);
          cached.release();
          await restarted.close();
          expect(
            (await fixture.trace()).filter((entry) =>
              entry.command.startsWith("run-v2 "),
            ),
          ).toHaveLength(1);
        } finally {
          await state.close();
        }
      } finally {
        await fixture.state.close();
      }
    }),
);

it.live(
  "crash recovery interrupts starting locally but quarantines submitting before any remote IO",
  () =>
    Effect.promise(async () => {
      const fixture = await registryFixture(path("crashes"));
      const starting = registryJob(fixture.generation);
      const submitting = registryJob(fixture.generation, {
        state: "submitting",
        sessionId: "submitted",
        submissionExpiresAt: 1234,
      });
      await fixture.state.transaction((draft) => {
        draft.jobs.push(starting, submitting);
      });
      const reservation = await fixture.state.reserve(
        starting,
        "source.bundle",
        20,
      );
      await writeFile(reservation.path, "local preparation", { mode: 0o600 });
      await reservation.commit();
      await fixture.state.close();
      const state = await openNativeBuildState(fixture.options);
      try {
        await recoverNativeMetadata(state, 100_000);
        expect(state.owned("org-a", "session-a", starting.jobId).state).toBe(
          "interrupted",
        );
        expect(
          state.owned("org-a", "submitted", submitting.jobId).recovery.state,
        ).toBe("pending");
        expect(state.quarantined(fixtureHost)).toBe(true);
        await expect(readFile(reservation.path)).rejects.toThrow();
        const transport = await createNativeBuildTransport(state, {
          suffix: "example.test",
          executable: fixture.executable,
        });
        const recovery = createNativeBuildRecovery(state, transport, {
          now: () => 100_000,
        });
        await recovery.tick(submitting.jobId);
        expect(
          state.owned("org-a", "submitted", submitting.jobId).recovery
            .lastReason,
        ).toBe("missing-credentials");
        await expect(fixture.trace()).rejects.toThrow();
      } finally {
        await state.close();
      }
    }),
);

it.live(
  "ambiguous run exits recover typed unknown without ever resubmitting",
  () =>
    Effect.promise(async () => {
      const fixture = await registryFixture(path("ambiguous"));
      await fixture.plan({ lostRun: true });
      const client = await createRegistryNativeBuildClient(
        fixture.state,
        fixture.transport,
        { canSubmit: () => true, prepareBundle: bundle },
      );
      try {
        const job = await client.start({
          organizationId: "org-a",
          sessionId: "session-a",
          generationId: fixture.generation.id,
          workspacePath: fixture.root,
          commit: "e".repeat(40),
          pullRequest: 7,
          action: "archive",
        });
        await client.wait(job.jobId);
        expect(client.status("org-a", "session-a", job.jobId).state).toBe(
          "submitting",
        );
        await fixture.plan({ unknown: true });
        await client.recovery.tick(job.jobId);
        expect(client.status("org-a", "session-a", job.jobId).state).toBe(
          "interrupted",
        );
        expect(
          client.status("org-a", "session-a", job.jobId).recovery.state,
        ).toBe("resolved-unknown");
        expect(fixture.state.quarantined(fixtureHost)).toBe(false);
        expect(
          (await fixture.trace()).filter((entry) =>
            entry.command.startsWith("run-v2 "),
          ),
        ).toHaveLength(1);
      } finally {
        await fixture.state.close();
      }
    }),
);

it.live(
  "clean host-busy EPIPE refusal fails once without initiating recovery",
  () =>
    Effect.promise(async () => {
      const fixture = await registryFixture(path("busy-refusal"));
      await fixture.plan({ busyRefusal: true });
      const upload = async function* () {
        for (let index = 0; index < 128; index++) yield Buffer.alloc(65_536);
      };
      const client = await createRegistryNativeBuildClient(
        fixture.state,
        fixture.transport,
        { canSubmit: () => true, prepareBundle: upload },
      );
      try {
        const job = await client.start({
          organizationId: "org-a",
          sessionId: "session-a",
          generationId: fixture.generation.id,
          workspacePath: fixture.root,
          commit: "e".repeat(40),
          pullRequest: 7,
          action: "archive",
        });
        await client.wait(job.jobId);
        expect(client.status("org-a", "session-a", job.jobId).failureCode).toBe(
          "host-busy",
        );
        expect(
          client.status("org-a", "session-a", job.jobId).recovery.state,
        ).toBe("not-required");
        expect(fixture.state.quarantined(fixtureHost)).toBe(false);
        expect(
          (await fixture.trace()).some((entry) =>
            /^(cancel|reconcile) /u.test(entry.command),
          ),
        ).toBe(false);
      } finally {
        await fixture.state.close();
      }
    }),
);

it.live(
  "disable winning the dispatch boundary prevents run-v2 and remote cancel",
  () =>
    Effect.promise(async () => {
      const fixture = await registryFixture(path("disable"));
      let enabled = true;
      const upload = async function* () {
        yield Buffer.from("bundle");
        enabled = false;
      };
      const client = await createRegistryNativeBuildClient(
        fixture.state,
        fixture.transport,
        { canSubmit: () => enabled, prepareBundle: upload },
      );
      try {
        const job = await client.start({
          organizationId: "org-a",
          sessionId: "session-a",
          generationId: fixture.generation.id,
          workspacePath: fixture.root,
          commit: "e".repeat(40),
          pullRequest: 7,
          action: "archive",
        });
        await client.wait(job.jobId);
        await client.cancel("org-a", "session-a", job.jobId);
        expect(client.status("org-a", "session-a", job.jobId).state).toBe(
          "failed",
        );
        expect((await fixture.trace()).map((entry) => entry.command)).toEqual([
          "health",
        ]);
      } finally {
        await fixture.state.close();
      }
    }),
);

it.live(
  "bounds lying artifact streams and releases partial quota without retrying the build",
  () =>
    Effect.promise(async () => {
      const fixture = await registryFixture(path("lying"));
      const client = await createRegistryNativeBuildClient(
        fixture.state,
        fixture.transport,
        { canSubmit: () => true, prepareBundle: bundle },
      );
      try {
        const job = await client.start({
          organizationId: "org-a",
          sessionId: "session-a",
          generationId: fixture.generation.id,
          workspacePath: fixture.root,
          commit: "e".repeat(40),
          pullRequest: 7,
          action: "archive",
        });
        await client.wait(job.jobId);
        await fixture.plan({ corrupt: true });
        await expect(
          client.artifact("org-a", "session-a", job.jobId),
        ).rejects.toThrow();
        await expect(
          readFile(join(fixture.state.jobPath(job), "artifact.partial")),
        ).rejects.toThrow();
        await fixture.plan({});
        const artifact = await client.artifact("org-a", "session-a", job.jobId);
        artifact.release();
        expect(
          (await fixture.trace()).filter((entry) =>
            entry.command.startsWith("run-v2 "),
          ),
        ).toHaveLength(1);
      } finally {
        await fixture.state.close();
      }
    }),
);

function memoryBroker(clock: () => number) {
  const calls: { generationId: string; command: string }[] = [];
  const settings = {
    unavailable: false,
    busy: false,
    fresh: true,
    cleanup: "",
    badHealthEpoch: false,
  };
  const transport: NativeBrokerTransport = {
    hasCredential: () => true,
    artifact: async () => {
      throw new Error("unused");
    },
    envelope: async (generation, command, job) => {
      calls.push({ generationId: generation.id, command });
      if (settings.unavailable) throw new NativeTransportError("unavailable");
      const base = {
        protocolVersion: 2 as const,
        hostId: generation.transport.hostId,
      };
      if (command === "health")
        return {
          ...base,
          kind: "health",
          profile: "registry-only",
          status: "ready",
          accepting: true,
          capacity: 1,
          reasons: [],
          epoch: (settings.badHealthEpoch ? "f" : "a").repeat(32),
        };
      if (!job) throw new Error("missing-job");
      if (command.startsWith("cancel "))
        return { ...base, kind: "cancellation-requested", job: job.jobId };
      if (settings.cleanup)
        return { ...base, kind: settings.cleanup, job: job.jobId };
      if (settings.busy)
        return {
          ...base,
          kind: "busy",
          job: job.jobId,
          runner: {
            job: job.jobId,
            attempt: job.attempt,
            stage: "receiving",
            heartbeat: (clock() - (settings.fresh ? 0 : 120_000)) / 1000,
          },
        };
      return {
        ...base,
        kind: "reconciled-unknown",
        job: job.jobId,
        epoch: "a".repeat(32),
        nonce: "c".repeat(32),
        reconciledJobs: [job.jobId],
      };
    },
  };
  return { calls, settings, transport };
}

it.live(
  "fresh receiving heartbeats do not spend failures but cannot exceed 750 seconds",
  () =>
    Effect.promise(async () => {
      const fixture = await registryFixture(path("heartbeat"));
      let time = 1_000_000;
      const job = registryJob(fixture.generation, {
        state: "submitting",
        submissionExpiresAt: 1,
      });
      await fixture.state.transaction((draft) => {
        draft.jobs.push(job);
      });
      await recoverNativeMetadata(fixture.state, time);
      const broker = memoryBroker(() => time);
      broker.settings.busy = true;
      const recovery = createNativeBuildRecovery(
        fixture.state,
        broker.transport,
        { now: () => time },
      );
      try {
        for (let index = 0; index < 51; index++) {
          await recovery.tick(job.jobId);
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
        await fixture.state.close();
      }
    }),
);

it.live(
  "six unavailable failures survive restart, then consume exactly one same-generation return latch",
  () =>
    Effect.promise(async () => {
      const fixture = await registryFixture(path("latch"));
      let time = 1_000_000;
      const job = registryJob(fixture.generation, {
        state: "submitting",
        submissionExpiresAt: 1,
      });
      await fixture.state.transaction((draft) => {
        draft.jobs.push(job);
      });
      await recoverNativeMetadata(fixture.state, time);
      const broker = memoryBroker(() => time);
      broker.settings.unavailable = true;
      const recovery = createNativeBuildRecovery(
        fixture.state,
        broker.transport,
        { now: () => time },
      );
      for (const delay of [0, 5_000, 15_000, 30_000, 60_000, 120_000]) {
        time += delay;
        await recovery.tick(job.jobId);
      }
      const held = fixture.state.owned("org-a", "session-a", job.jobId);
      expect(held.recovery.attempts).toBe(6);
      expect(held.recovery.state).toBe("operator-required");
      const rotated = await fixture.state.addGeneration(
        "primary",
        { ...fixture.metadata, hostname: "current.example.test" },
        fixture.key,
      );
      await fixture.state.close();
      const state = await openNativeBuildState(fixture.options);
      try {
        await recoverNativeMetadata(state, time);
        const after = state.owned("org-a", "session-a", job.jobId);
        expect(after.recovery.deadline).toBe(held.recovery.deadline);
        expect(after.recovery.attempts).toBe(6);
        const restart = createNativeBuildRecovery(state, broker.transport, {
          now: () => time,
        });
        broker.settings.unavailable = false;
        broker.settings.busy = true;
        time = after.recovery.nextAt;
        await restart.tick(job.jobId);
        expect(
          state.owned("org-a", "session-a", job.jobId).recovery.returnEventUsed,
        ).toBe(true);
        const count = broker.calls.length;
        broker.settings.busy = false;
        time += 600_000;
        await restart.tick(job.jobId);
        expect(broker.calls).toHaveLength(count);
        expect(
          broker.calls.every((call) => call.generationId !== rotated.id),
        ).toBe(true);
        expect(state.quarantined(fixtureHost)).toBe(true);
      } finally {
        await state.close();
      }
      const again = await openNativeBuildState(fixture.options);
      try {
        const count = broker.calls.length;
        const restart = createNativeBuildRecovery(again, broker.transport, {
          now: () => time + 600_000,
        });
        await restart.tick(job.jobId);
        expect(broker.calls).toHaveLength(count);
      } finally {
        await again.close();
      }
    }),
);

it.live(
  "host-return can release a safe unknown hold but cleanup faults remain manual",
  () =>
    Effect.promise(async () => {
      const fixture = await registryFixture(path("return-success"));
      let time = 1_000_000;
      const job = registryJob(fixture.generation, {
        state: "submitting",
        submissionExpiresAt: 1,
      });
      job.recovery.state = "operator-required";
      job.recovery.lastReason = "unavailable";
      job.recovery.deadline = 1;
      job.recovery.nextAt = time;
      await fixture.state.transaction((draft) => {
        draft.jobs.push(job);
      });
      const broker = memoryBroker(() => time);
      const recovery = createNativeBuildRecovery(
        fixture.state,
        broker.transport,
        { now: () => time },
      );
      try {
        await recovery.tick(job.jobId);
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
          await fixture.state.transaction((draft) => {
            const current = draft.jobs[0];
            if (!current) throw new Error("no-job");
            current.recovery.state = "operator-required";
            current.recovery.returnEventUsed = false;
            current.recovery.lastReason = reason;
            current.recovery.nextAt = time;
          });
          const count = broker.calls.length;
          time += 600_000;
          await recovery.tick(job.jobId);
          expect(broker.calls).toHaveLength(count);
        }
      } finally {
        await fixture.state.close();
      }
    }),
);

it.live(
  "cleanup/epoch failures never release quarantine and wrong-host envelopes are rejected",
  () =>
    Effect.promise(async () => {
      const fixture = await registryFixture(path("unsafe"));
      const time = 1_000_000;
      const job = registryJob(fixture.generation, {
        state: "submitting",
        submissionExpiresAt: 1,
      });
      await fixture.state.transaction((draft) => {
        draft.jobs.push(job);
      });
      await recoverNativeMetadata(fixture.state, time);
      const broker = memoryBroker(() => time);
      broker.settings.cleanup = "cleanup-required";
      try {
        const recovery = createNativeBuildRecovery(
          fixture.state,
          broker.transport,
          { now: () => time },
        );
        await recovery.tick(job.jobId);
        expect(
          fixture.state.owned("org-a", "session-a", job.jobId).recovery
            .lastReason,
        ).toBe("cleanup-required");
        expect(fixture.state.quarantined(fixtureHost)).toBe(true);
        await fixture.state.transaction((draft) => {
          const current = draft.jobs[0];
          if (!current) throw new Error("no-job");
          current.recovery.state = "pending";
          current.recovery.nextAt = time;
        });
        broker.settings.cleanup = "";
        broker.settings.badHealthEpoch = true;
        await recovery.tick(job.jobId);
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
        await fixture.state.close();
      }
    }),
);

it.live("scratch quota refusal happens before artifact SSH", () =>
  Effect.promise(async () => {
    const fixture = await registryFixture(path("artifact-quota"), {
      bytesTotal: nativeLimits.bundle + nativeLimits.overhead,
    });
    const client = await createRegistryNativeBuildClient(
      fixture.state,
      fixture.transport,
      { canSubmit: () => true, prepareBundle: bundle },
    );
    try {
      const job = await client.start({
        organizationId: "org-a",
        sessionId: "session-a",
        generationId: fixture.generation.id,
        workspacePath: fixture.root,
        commit: "e".repeat(40),
        pullRequest: 7,
        action: "archive",
      });
      await client.wait(job.jobId);
      const held = await fixture.state.reserve(
        job,
        "source.bundle",
        nativeLimits.bundle,
      );
      try {
        await expect(
          client.artifact("org-a", "session-a", job.jobId),
        ).rejects.toThrow("scratch-quota-exceeded");
      } finally {
        await held.release();
      }
      expect(
        (await fixture.trace()).some((call) =>
          call.command.startsWith("artifact "),
        ),
      ).toBe(false);
    } finally {
      await fixture.state.close();
    }
  }),
);
