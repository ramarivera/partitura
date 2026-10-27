import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { NativeBuildFiles } from "../src/services/native-build-files.js";
import { NativeBuildProcesses } from "../src/services/native-build-process.js";
import { createNativeBuildTransport } from "../src/services/native-build-transport.js";
import { registryFixture } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.live("transport uses its context file and process adapters", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* registryFixture(path("context"));
      yield* fixture.transport.dispose(fixture.generation.id);
      const files = yield* NativeBuildFiles.make;
      const processes = yield* NativeBuildProcesses.make;
      let reads = 0,
        starts = 0;
      const transport = yield* createNativeBuildTransport(fixture.state, {
        suffix: "example.test",
        executable: fixture.executable,
      }).pipe(
        Effect.provideService(NativeBuildFiles, {
          ...files,
          file: (...args) => {
            reads++;
            return files.file(...args);
          },
        }),
        Effect.provideService(NativeBuildProcesses, {
          acquire: (...args) => {
            starts++;
            return processes.acquire(...args);
          },
        }),
      );
      yield* transport.materialize(fixture.generation, fixture.key);
      yield* transport.envelope(fixture.generation, "health");
      expect(reads).toBeGreaterThan(0);
      expect(starts).toBeGreaterThan(0);
    }),
  ),
);
