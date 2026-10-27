import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { nativeIO } from "../src/services/native-build-errors.js";
import { createNativeBuildRecovery } from "../src/services/native-build-recovery.js";
import {
  nativeLimits,
  newRecovery,
  openNativeBuildState,
} from "../src/services/native-build-state.js";
import {
  fixturePayload,
  registryFixture,
  registryJob,
} from "./fixtures/native-build-registry.js";
import {
  createNativeBuildTransport,
  publishNativeArtifact,
} from "./fixtures/native-build-transport.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();

it.live(
  "free-space admission debits concurrent outstanding reservations across builders",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("free-reservations"), {
          freeMargin: 0,
          filesystem: async () => ({
            type: 0x01021994,
            bsize: 1,
            bavail: nativeLimits.overhead + 150,
          }),
        });
        const generation = yield* fixture.state.addGeneration(
          "secondary",
          fixture.metadata,
          fixture.key,
        );
        const first = registryJob(fixture.generation),
          second = registryJob(generation);
        yield* fixture.state.transaction((draft) => {
          draft.jobs.push(first, second);
        });
        const results = yield* Effect.all(
          [
            fixture.state.reserve(first, "artifact.partial", 100),
            fixture.state.reserve(second, "artifact.partial", 100),
          ].map((operation) => Effect.exit(operation)),
          { concurrency: "unbounded" },
        );
        expect(
          results.filter((result) => result._tag === "Success"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result._tag === "Failure"),
        ).toHaveLength(1);
      }),
    ),
);

it.live(
  "a generation credential lease does not retain an unrelated expired job",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("job-lease"));
        const old = registryJob(fixture.generation, {
          state: "succeeded",
          updatedAt: 1,
        });
        const active = registryJob(fixture.generation, { sessionId: "active" });
        yield* fixture.state.transaction((draft) => {
          draft.jobs.push(old, active);
        });
        const release = fixture.state.retainGeneration(fixture.generation.id);
        yield* fixture.state.prune(nativeLimits.retention + 1000);
        expect(fixture.state.snapshot().jobs.map((job) => job.jobId)).toEqual([
          active.jobId,
        ]);
        release();
      }),
    ),
);

it.live(
  "restore continues past one bad generation and concurrent exact-key loads share files",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("restore-independent"));
        const bad = yield* fixture.state.addGeneration(
          "primary",
          { ...fixture.metadata, hostname: "bad.other.test" },
          fixture.key,
        );
        yield* fixture.state.transaction((draft) => {
          draft.generations.reverse();
        });
        yield* fixture.state.close();
        const state = yield* openNativeBuildState(fixture.options);
        const transport = yield* createNativeBuildTransport(state, {
          suffix: "example.test",
          executable: fixture.executable,
        });
        const restored = yield* transport.restore(fixture.metadata.source, [
          fixture.key,
        ]);
        expect(
          restored.failures.map((failure) => failure.generationId),
        ).toEqual([bad.id]);
        expect(restored.failures[0]?.error._tag).toBe(
          "@Gateway/NativeOperationError",
        );
        expect(transport.credentialState(bad.id)).toBe("failed");
        const job = registryJob(bad, {
          state: "submitting",
          recovery: {
            ...newRecovery(),
            state: "pending",
            deadline: 900_000,
          },
        });
        yield* state.transaction((draft) => {
          draft.jobs.push(job);
        });
        let time = 100_000;
        const recovery = createNativeBuildRecovery(state, transport, {
          now: () => time,
        });
        yield* recovery.tick(job.jobId);
        const held = state.owned("org-a", "session-a", job.jobId).recovery;
        expect(held).toMatchObject({
          state: "operator-required",
          lastReason: "missing-credentials",
          observation: "credentials-failed",
          returnEligible: false,
        });
        const metadata = yield* nativeIO(() =>
          readFile(join(state.options.stateRoot, "metadata.json"), "utf8"),
        );
        time += 600_000;
        yield* recovery.tick(job.jobId);
        expect(
          yield* nativeIO(() =>
            readFile(join(state.options.stateRoot, "metadata.json"), "utf8"),
          ),
        ).toBe(metadata);
        expect(transport.hasCredential(fixture.generation.id)).toBe(true);
        const another = yield* state.addGeneration(
          "primary",
          { ...fixture.metadata, hostname: "another.example.test" },
          fixture.key,
        );
        yield* Effect.all(
          [
            transport.materialize(another, fixture.key),
            transport.materialize(another, fixture.key),
          ],
          { concurrency: "unbounded" },
        );
        expect(transport.hasCredential(another.id)).toBe(true);
        expect(
          yield* nativeIO(() =>
            readFile(
              join(state.generationPath(another.id), "identity"),
              "utf8",
            ),
          ),
        ).toBe(fixture.key);
        expect((yield* transport.envelope(another, "health")).kind).toBe(
          "health",
        );
      }),
    ),
);

for (const code of [0, 1])
  it.live(
    `authenticated oversized output with exit ${code} is a protocol mismatch`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* registryFixture(path(`oversized-${code}`));
          yield* nativeIO(() =>
            writeFile(
              fixture.executable,
              `#!${process.execPath}\nprocess.stdout.write("x".repeat(8192));process.exitCode=${code};\n`,
              { mode: 0o700 },
            ),
          );
          expect(
            (yield* fixture.transport
              .envelope(fixture.generation, "health")
              .pipe(Effect.flip)).reason,
          ).toBe("protocol-mismatch");
          const job = registryJob(fixture.generation, { artifactBytes: 1 });
          expect(
            (yield* fixture.transport
              .artifact(
                fixture.generation,
                job,
                join(fixture.root, "artifact.partial"),
              )
              .pipe(Effect.flip)).reason,
          ).toBe("protocol-mismatch");
        }),
      ),
  );

it.live("capacity pruning promptly disposes old generation credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* registryFixture(path("prune-keys"));
      yield* fixture.state.transaction((draft) => {
        for (let index = 0; index < 255; index++)
          draft.generations.push({
            ...fixture.generation,
            id: index.toString(16).padStart(32, "0"),
            equalityTag: index.toString(16).padStart(64, "0"),
          });
      });
      yield* fixture.state.addGeneration(
        "primary",
        { ...fixture.metadata, hostname: "new.example.test" },
        fixture.key,
      );
      expect(fixture.transport.hasCredential(fixture.generation.id)).toBe(
        false,
      );
      expect(
        (yield* nativeIO(() =>
          stat(fixture.state.generationPath(fixture.generation.id)),
        ).pipe(Effect.flip)).cause,
      ).toMatchObject({ code: "ENOENT" });
    }),
  ),
);

it.live(
  "an unleased corrupt cached tar is removed and refetched with digest verification",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* registryFixture(path("refetch"));
        const { createHash } = yield* nativeIO(() => import("node:crypto"));
        const job = registryJob(fixture.generation, {
          state: "succeeded",
          artifactBytes: Buffer.byteLength(fixturePayload),
          artifactSha256: createHash("sha256")
            .update(fixturePayload)
            .digest("hex"),
        });
        yield* fixture.state.transaction((draft) => {
          draft.jobs.push(job);
        });
        const reservation = yield* fixture.state.reserve(
          job,
          "artifact.partial",
          job.artifactBytes ?? 0,
        );
        yield* nativeIO(() =>
          writeFile(reservation.path, "corrupt", { mode: 0o600 }),
        );
        const target = join(fixture.state.jobPath(job), "artifact.tar");
        yield* reservation.commit(target);
        const reader = fixture.state.retainFile(target);
        const error = yield* publishNativeArtifact(
          fixture.state,
          fixture.transport,
          fixture.generation,
          job,
        ).pipe(Effect.flip);
        expect(error.reason).toBe("native-artifact-in-use");
        reader();
        const fetched = yield* publishNativeArtifact(
          fixture.state,
          fixture.transport,
          fixture.generation,
          job,
        );
        expect(yield* nativeIO(() => readFile(fetched.path, "utf8"))).toBe(
          fixturePayload,
        );
        fetched.release();
      }),
    ),
);
