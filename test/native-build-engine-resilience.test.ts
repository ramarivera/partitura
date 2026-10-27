import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import { nativeGitBundle } from "../src/services/native-build-bundle.js";
import { nativeIO } from "../src/services/native-build-errors.js";
import { NativeBuildFiles } from "../src/services/native-build-files.js";
import { createRegistryNativeBuildClient } from "../src/services/native-build-registry-client.js";
import { openNativeBuildState } from "../src/services/native-build-state.js";
import { decodeBrokerEnvelope } from "../src/services/native-build-transport.js";
import {
  registryFixture,
  registryJob,
} from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const request = (
  fixture: Effect.Success<ReturnType<typeof registryFixture>>,
) => ({
  organizationId: "org-a",
  sessionId: "session-a",
  generationId: fixture.generation.id,
  workspacePath: fixture.root,
  commit: "e".repeat(40),
  pullRequest: 7,
  action: "archive",
});
const bundle = () =>
  Effect.succeed(
    (async function* () {
      yield Buffer.from("fake git bundle bytes");
    })(),
  );

it.live(
  "clean terminal plus fresh same-epoch health releases without cancel or reconcile",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("clean-success"));
        yield* nativeIO(() =>
          fixture.plan({
            expectedSecret: JSON.stringify({ signing: "dummy signing value" }),
            expectedBundle: "fake git bundle bytes",
          }),
        );
        const client = yield* createRegistryNativeBuildClient(
          fixture.state,
          fixture.transport,
          { canSubmit: () => true, prepareBundle: bundle },
        );
        const job = yield* client.start({
          ...request(fixture),
          secretFiles: { signing: "dummy signing value" },
        });
        yield* client.wait(job.jobId);
        expect(
          (yield* client.status("org-a", "session-a", job.jobId)).recovery
            .state,
        ).toBe("resolved-terminal");
        const trace = yield* nativeIO(() => fixture.trace());
        expect(trace.map((entry) => entry.command.split(" ")[0])).toEqual([
          "health",
          "run-v2",
          "health",
        ]);
        for (const operation of [
          client.artifact("other-org", "session-a", job.jobId),
          client.artifact("org-a", "other-session", job.jobId),
          client.artifact("org-a", "session-a", job.jobId, "wrong-builder"),
          client.cancel("org-a", "session-a", job.jobId, "wrong-builder"),
        ]) {
          expect((yield* operation.pipe(Effect.flip)).reason).toBe(
            "native-job-not-found",
          );
        }
        expect((yield* nativeIO(() => fixture.trace())).length).toBe(
          trace.length,
        );
      }),
    ),
);

it.live(
  "main's host-maintenance refusal is decoded and the engine leaves submitting",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("maintenance"));
        const job = registryJob(fixture.generation);
        expect(
          decodeBrokerEnvelope(
            `${JSON.stringify({ protocolVersion: 2, hostId: fixture.metadata.hostId, kind: "refused", job: job.jobId, commit: job.commit, action: job.action, attempt: job.attempt, accepted: false, code: "host-maintenance" })}\n`,
            fixture.generation,
            job,
          ).code,
        ).toBe("host-maintenance");
        yield* nativeIO(() => fixture.plan({ refusal: "host-maintenance" }));
        const client = yield* createRegistryNativeBuildClient(
          fixture.state,
          fixture.transport,
          { canSubmit: () => true, prepareBundle: bundle },
        );
        const started = yield* client.start(request(fixture));
        yield* client.wait(started.jobId);
        const result = yield* client.status(
          "org-a",
          "session-a",
          started.jobId,
        );
        expect(result.state).toBe("failed");
        expect(result.failureCode).toBe("host-maintenance");
      }),
    ),
);

it.live(
  "non-EPIPE upload errors still drain and accept only an identified refusal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("upload-errors"));
        const job = registryJob(fixture.generation);
        yield* nativeIO(() => fixture.plan({ refusal: "host-maintenance" }));
        const input = (async function* () {
          yield Buffer.from("bytes");
          throw Object.assign(new Error("dummy upload failure"), {
            code: "ECONNRESET",
          });
        })();
        const reply = yield* fixture.transport.envelope(
          fixture.generation,
          `run-v2 ${job.jobId} ${job.commit} ${job.pullRequest} ${job.action} 5 0 ${job.epoch} ${job.attempt} 12345`,
          job,
          { input },
        );
        expect(reply.kind).toBe("refused");
        expect(reply.code).toBe("host-maintenance");
      }),
    ),
);

for (const phase of ["create", "delete"] as const)
  it.live(
    `hanging fake git ${phase} update-ref is bounded and hooks are disabled`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* registryFixture(path(`git-${phase}`));
          const executable = join(fixture.root, "fake-git"),
            tracePath = join(fixture.root, "git-trace.jsonl");
          yield* nativeIO(() =>
            writeFile(
              executable,
              `#!${process.execPath}\nimport {appendFileSync} from "node:fs";\nconst args=process.argv.slice(2);\nappendFileSync(${JSON.stringify(tracePath)},JSON.stringify({args,pid:process.pid})+"\\n");\nif(args.includes("update-ref") && (args.includes("-d") ? ${JSON.stringify(phase === "delete")} : ${JSON.stringify(phase === "create")})) await new Promise(()=>{setInterval(()=>{},1000)});\nif(args.includes("bundle")) process.stdout.write("bundle");\n`,
              { mode: 0o700 },
            ),
          );
          const files = yield* NativeBuildFiles.make;
          const exit = yield* Effect.scoped(
            Effect.gen(function* () {
              const input = yield* nativeGitBundle(
                request(fixture),
                registryJob(fixture.generation),
                { executable, referenceTimeout: 1_000 },
              );
              yield* files.stream(
                join(fixture.root, "fake.bundle"),
                input,
                1024,
              );
            }),
          ).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Cause.pretty(exit.cause)).toContain(
              "native-process-timeout",
            );
          const trace = (yield* nativeIO(() => readFile(tracePath, "utf8")))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[]; pid: number });
          expect(
            trace.filter((entry) => entry.args.includes("update-ref")),
          ).toHaveLength(2);
          expect(
            trace.every(
              (entry) =>
                entry.args.slice(0, 2).join(" ") ===
                "-c core.hooksPath=/dev/null",
            ),
          ).toBe(true);
          for (const entry of trace)
            expect(() => process.kill(entry.pid, 0)).toThrow();
        }),
      ),
  );

it.live(
  "scope interruption reaps a hanging SSH child, unlinks tmpfs keys and releases the state lock",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = path("interrupt"),
          executable = join(root, "hanging-ssh"),
          pidPath = join(root, "ssh.pid");
        let ready: (() => void) | undefined;
        const entered = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const options = yield* Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* registryFixture(root);
            yield* nativeIO(() =>
              writeFile(
                executable,
                `#!${process.execPath}\nimport {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);\n`,
                { mode: 0o700 },
              ),
            );
            const { createNativeBuildTransport } = yield* nativeIO(
              () => import("../src/services/native-build-transport.js"),
            );
            yield* fixture.transport.dispose(fixture.generation.id);
            const transport = yield* createNativeBuildTransport(fixture.state, {
              suffix: "example.test",
              executable,
            });
            yield* transport.materialize(fixture.generation, fixture.key);
            const fiber = yield* Effect.forkScoped(
              transport.envelope(fixture.generation, "health"),
            );
            // Observe the child's own creation marker, not a guessed sleep duration.
            const observe = Effect.gen(function* () {
              const result = yield* nativeIO(() =>
                readFile(pidPath, "utf8"),
              ).pipe(Effect.option);
              return result;
            });
            const { Option } = yield* nativeIO(() => import("effect"));
            let marker = yield* observe;
            while (Option.isNone(marker) || Number(marker.value) <= 0) {
              yield* Effect.yieldNow;
              marker = yield* observe;
            }
            ready?.();
            yield* nativeIO(() => entered);
            yield* Fiber.interrupt(fiber);
            return {
              options: fixture.options,
              keyDirectory: fixture.state.generationPath(fixture.generation.id),
              pid: Number(marker.value),
            };
          }),
        );
        expect(options.pid).toBeGreaterThan(0);
        expect(() => process.kill(options.pid, 0)).toThrow();
        expect(
          (yield* nativeIO(() => stat(options.keyDirectory)).pipe(Effect.flip))
            .cause,
        ).toMatchObject({ code: "ENOENT" });
        yield* openNativeBuildState(options.options);
      }),
    ),
);
