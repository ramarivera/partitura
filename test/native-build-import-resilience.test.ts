import { link, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { importLegacyNativeSlot } from "../deploy/mac-build/native-build-import.js";
import {
  NativeOperationError,
  nativeIO,
} from "../src/services/native-build-errors.js";
import { NativeBuildProcesses } from "../src/services/native-build-process.js";
import { openNativeBuildState } from "../src/services/native-build-state.js";
import {
  createNativeBuildTransport,
  publishNativeArtifact,
} from "../src/services/native-build-transport.js";
import { legacyFixture } from "./fixtures/native-build-import.js";
import {
  fixturePayload,
  registryFixture,
} from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();

it.live(
  "uncached legacy receipts are remote-only and fetchable on the imported generation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("remote-only")),
          legacy = yield* legacyFixture(fixture);
        yield* importLegacyNativeSlot(
          fixture.state,
          fixture.transport,
          legacy.input,
        );
        const job = fixture.state.owned(
          "owner-org",
          legacy.sessionId,
          legacy.id,
        );
        expect(job.importBinding?.artifact).toBe("remote-only");
        expect(job.artifactSha256).toBe(legacy.record.artifactSha256);
        const artifact = yield* publishNativeArtifact(
          fixture.state,
          fixture.transport,
          fixture.generation,
          job,
        );
        expect(yield* nativeIO(() => readFile(artifact.path, "utf8"))).toBe(
          fixturePayload,
        );
        artifact.release();
        expect(yield* nativeIO(() => readFile(legacy.recordPath, "utf8"))).toBe(
          JSON.stringify(legacy.record),
        );
      }),
    ),
);

it.live(
  "failed copy resumes the committed import and rejects original-tenant reassignment",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("resume-copy")),
          legacy = yield* legacyFixture(fixture);
        yield* nativeIO(() =>
          writeFile(legacy.artifactPath, fixturePayload, { mode: 0o600 }),
        );
        const error = yield* importLegacyNativeSlot(
          fixture.state,
          fixture.transport,
          legacy.input,
          {
            copy: () =>
              Effect.fail(NativeOperationError.new("injected-copy-failure")),
          },
        ).pipe(Effect.flip);
        expect(error.reason).toBe("injected-copy-failure");
        expect(
          fixture.state.owned("owner-org", legacy.sessionId, legacy.id)
            .importBinding?.artifact,
        ).toBe("copy-pending");
        const firstAttempt = fixture.state.owned(
          "owner-org",
          legacy.sessionId,
          legacy.id,
        ).attempt;
        const reassigned = {
          ...legacy.input,
          resolveOwner: async () => ({
            organizationId: "attacker-org",
            pullRequest: 9,
          }),
        };
        expect(
          (yield* importLegacyNativeSlot(
            fixture.state,
            fixture.transport,
            reassigned,
          ).pipe(Effect.flip)).reason,
        ).toBe("import-owner-quarantined");
        yield* importLegacyNativeSlot(
          fixture.state,
          fixture.transport,
          legacy.input,
        );
        yield* importLegacyNativeSlot(
          fixture.state,
          fixture.transport,
          legacy.input,
        );
        const job = fixture.state.owned(
          "owner-org",
          legacy.sessionId,
          legacy.id,
        );
        expect(job.attempt).toBe(firstAttempt);
        expect(job.importBinding?.artifact).toBe("cached");
        expect(
          yield* nativeIO(() =>
            readFile(join(fixture.state.jobPath(job), "artifact.tar"), "utf8"),
          ),
        ).toBe(fixturePayload);
        expect(
          yield* nativeIO(() => readFile(legacy.artifactPath, "utf8")),
        ).toBe(fixturePayload);
      }),
    ),
);

it.live(
  "a process crash mid-copy resumes partial artifact copying without duplicates",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("crash-copy")),
          legacy = yield* legacyFixture(fixture);
        yield* nativeIO(() =>
          writeFile(legacy.artifactPath, fixturePayload, { mode: 0o600 }),
        );
        const inputPath = join(fixture.root, "import-input.json");
        yield* nativeIO(() =>
          writeFile(
            inputPath,
            JSON.stringify({ state: fixture.options, input: legacy.input }),
            { mode: 0o600 },
          ),
        );
        yield* fixture.state.close();
        const processes = yield* NativeBuildProcesses.make;
        const child = yield* processes.acquire(
          [
            process.execPath,
            fileURLToPath(
              new URL(
                "./fixtures/native-build-import-crash.ts",
                import.meta.url,
              ),
            ),
            inputPath,
          ],
          { timeout: 5_000 },
        );
        child.child.stdin.end();
        child.child.stdout.resume();
        child.child.stderr.resume();
        yield* nativeIO(() => child.completion);
        expect(child.child.signalCode).toBe("SIGKILL");
        const state = yield* openNativeBuildState(fixture.options);
        const job = state.owned("owner-org", legacy.sessionId, legacy.id),
          partial = join(state.jobPath(job), "artifact.partial");
        expect(job.importBinding?.artifact).toBe("copy-pending");
        expect((yield* nativeIO(() => readFile(partial))).length).toBe(3);
        const transport = yield* createNativeBuildTransport(state, {
          suffix: "example.test",
          executable: fixture.executable,
        });
        yield* importLegacyNativeSlot(state, transport, legacy.input);
        expect(state.snapshot().jobs).toHaveLength(1);
        expect(
          state.owned("owner-org", legacy.sessionId, legacy.id).importBinding
            ?.artifact,
        ).toBe("cached");
        expect(
          yield* nativeIO(() =>
            readFile(join(state.jobPath(job), "artifact.tar"), "utf8"),
          ),
        ).toBe(fixturePayload);
        expect(
          (yield* nativeIO(() => readFile(partial)).pipe(Effect.flip)).cause,
        ).toMatchObject({ code: "ENOENT" });
        expect(
          yield* nativeIO(() => readFile(legacy.artifactPath, "utf8")),
        ).toBe(fixturePayload);
      }),
    ),
);

for (const attack of [
  "unknown-state",
  "extra-field",
  "hardlink",
  "symlink",
] as const)
  it.live(`import rejects ${attack} before committing jobs`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path(attack)),
          legacy = yield* legacyFixture(fixture);
        if (attack === "unknown-state")
          yield* nativeIO(() =>
            writeFile(
              legacy.recordPath,
              JSON.stringify({ ...legacy.record, state: "invented" }),
            ),
          );
        if (attack === "extra-field")
          yield* nativeIO(() =>
            writeFile(
              legacy.recordPath,
              JSON.stringify({ ...legacy.record, organizationId: "attacker" }),
            ),
          );
        if (attack === "hardlink")
          yield* nativeIO(() =>
            link(legacy.recordPath, join(legacy.root, "extra-link")),
          );
        if (attack === "symlink") {
          const target = join(legacy.root, "original");
          yield* nativeIO(() =>
            writeFile(target, JSON.stringify(legacy.record), { mode: 0o600 }),
          );
          yield* nativeIO(() => unlink(legacy.recordPath));
          yield* nativeIO(() => symlink(target, legacy.recordPath));
        }
        const error = yield* importLegacyNativeSlot(
          fixture.state,
          fixture.transport,
          legacy.input,
        ).pipe(Effect.flip);
        if (attack === "symlink")
          expect(error.cause).toMatchObject({ code: "ELOOP" });
        else
          expect(error.reason).toBe(
            attack === "hardlink"
              ? "unsafe-native-file"
              : "invalid-import-record",
          );
        expect(fixture.state.snapshot().jobs).toHaveLength(0);
      }),
    ),
  );
