import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { nativeIO } from "../src/services/native-build-errors.js";
import { createRegistryNativeBuildClient } from "../src/services/native-build-registry-client.js";
import { registryFixture } from "./fixtures/native-build-registry.js";
import {
  type NativeBrokerTransport,
  NativeTransportError,
} from "./fixtures/native-build-transport.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const runningFixture = Effect.fn("Test.runningNativeJob")(function* (
  name: string,
  wrap?: (transport: NativeBrokerTransport) => NativeBrokerTransport,
) {
  const f = yield* registryFixture(path(name));
  const barrier = join(f.root, "release-run");
  yield* nativeIO(() => f.plan({ runBarrier: barrier, runningReceipt: true }));
  const client = yield* createRegistryNativeBuildClient(
    f.state,
    wrap ? wrap(f.transport) : f.transport,
    {
      canSubmit: () => true,
      prepareBundle: () =>
        Effect.succeed(
          (async function* () {
            yield Buffer.from("bundle");
          })(),
        ),
    },
  );
  const job = yield* client.start({
    organizationId: "org-a",
    sessionId: "session-a",
    generationId: f.generation.id,
    workspacePath: f.root,
    commit: "e".repeat(40),
    pullRequest: 7,
    action: "test",
  });
  for (let attempt = 0; ; attempt++) {
    if (
      yield* nativeIO(() =>
        access(join(f.root, "run-entered")).then(
          () => true,
          () => false,
        ),
      )
    )
      break;
    if (attempt >= 200) return yield* Effect.die("run did not enter broker");
    yield* Effect.sleep(5);
  }
  const release = nativeIO(() =>
    writeFile(barrier, "release", { mode: 0o600 }),
  );
  yield* Effect.addFinalizer(() => release.pipe(Effect.orDie));
  return { f, client, job, release };
});

it.live(
  "status exposes authenticated running state while the run SSH call remains open",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { f, client, job, release } =
          yield* runningFixture("live-status");
        expect(f.state.owned("org-a", "session-a", job.jobId).state).toBe(
          "submitting",
        );
        expect(
          (yield* client.status("org-a", "session-a", job.jobId)).state,
        ).toBe("running");
        const persisted = JSON.parse(
          yield* nativeIO(() =>
            readFile(join(f.options.stateRoot, "metadata.json"), "utf8"),
          ),
        );
        expect(persisted.jobs[0].state).toBe("running");
        yield* release;
        yield* client.wait(job.jobId);
        expect(
          (yield* client.status("org-a", "session-a", job.jobId)).state,
        ).toBe("succeeded");
        expect(
          (yield* nativeIO(() => f.trace())).filter((x) =>
            x.command.startsWith("run-v2 "),
          ),
        ).toHaveLength(1);
      }),
    ),
);

it.live(
  "wrong tenant, builder and broker attempt cannot publish running state",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { f, client, job, release } =
          yield* runningFixture("bound-status");
        for (const call of [
          client.status("other-org", "session-a", job.jobId),
          client.status("org-a", "other-session", job.jobId),
          client.status("org-a", "session-a", job.jobId, "backup"),
        ]) {
          expect((yield* call.pipe(Effect.exit))._tag).toBe("Failure");
        }
        expect(
          (yield* nativeIO(() => f.trace())).filter((x) =>
            x.command.startsWith("status "),
          ),
        ).toHaveLength(0);
        const record = join(f.root, `${job.jobId}.json`);
        const receipt = JSON.parse(
          yield* nativeIO(() => readFile(record, "utf8")),
        );
        receipt.attempt = "a".repeat(32);
        yield* nativeIO(() => writeFile(record, JSON.stringify(receipt)));
        expect(
          (yield* client
            .status("org-a", "session-a", job.jobId)
            .pipe(Effect.exit))._tag,
        ).toBe("Failure");
        expect(f.state.owned("org-a", "session-a", job.jobId).state).toBe(
          "submitting",
        );
        yield* release;
        yield* client.wait(job.jobId);
      }),
    ),
);

it.live(
  "a delayed running observation cannot overwrite a terminal submission receipt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const observed = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const { f, client, job, release } = yield* runningFixture(
          "terminal-status-race",
          (transport) => ({
            ...transport,
            envelope: Effect.fn("Test.delayStatus")(function* (
              ...args: Parameters<NativeBrokerTransport["envelope"]>
            ) {
              const receipt = yield* transport.envelope(...args);
              if (
                args[1].startsWith("status ") &&
                receipt.state === "running"
              ) {
                yield* Deferred.succeed(observed, undefined);
                yield* Deferred.await(resume);
              }
              return receipt;
            }),
          }),
        );
        const pending = yield* client
          .status("org-a", "session-a", job.jobId)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(observed);
        yield* release;
        yield* client.wait(job.jobId);
        yield* Deferred.succeed(resume, undefined);
        expect((yield* Fiber.join(pending)).state).toBe("succeeded");
        expect(f.state.owned("org-a", "session-a", job.jobId).state).toBe(
          "succeeded",
        );
      }),
    ),
);

it.live(
  "observed running jobs can be cancelled and reconciled without a second submission",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { f, client, job } = yield* runningFixture("cancel-live-status");
        expect(
          (yield* client.status("org-a", "session-a", job.jobId)).state,
        ).toBe("running");
        yield* client.cancel("org-a", "session-a", job.jobId);
        expect(
          yield* client.status("org-a", "session-a", job.jobId),
        ).toMatchObject({
          state: "interrupted",
          recovery: { state: "resolved-terminal" },
        });
        expect(f.state.quarantined(f.metadata.hostId)).toBe(false);
        const trace = yield* nativeIO(() => f.trace());
        expect(
          trace.filter((x) => x.command.startsWith("run-v2 ")),
        ).toHaveLength(1);
        expect(trace.some((x) => x.command.startsWith("cancel "))).toBe(true);
      }),
    ),
);

it.live(
  "broker outages preserve durable status and cannot prevent cancellation recovery",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { f, client, job } = yield* runningFixture(
          "outage-live-status",
          (transport) => ({
            ...transport,
            envelope: Effect.fn("Test.outageStatus")(function* (
              ...args: Parameters<NativeBrokerTransport["envelope"]>
            ) {
              if (args[1].startsWith("status "))
                return yield* Effect.fail(
                  NativeTransportError.new("unavailable"),
                );
              return yield* transport.envelope(...args);
            }),
          }),
        );
        expect(
          (yield* client.status("org-a", "session-a", job.jobId)).state,
        ).toBe("submitting");
        yield* client.cancel("org-a", "session-a", job.jobId);
        const saved = yield* client.owned("org-a", "session-a", job.jobId);
        expect(saved.recovery.attempts).toBeGreaterThan(0);
        expect(saved.recovery.lastReason).toBe("unavailable");
        expect(f.state.quarantined(f.metadata.hostId)).toBe(true);
        expect(
          (yield* nativeIO(() => f.trace())).some((x) =>
            x.command.startsWith("cancel "),
          ),
        ).toBe(true);
      }),
    ),
);
