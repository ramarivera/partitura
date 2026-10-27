import { unlink, writeFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";
import { setupNativeBudget } from "../deploy/mac-build/native-build-budget-admin.js";
import { registryIO } from "../src/services/builder-registry-files.js";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import { lockNativeState } from "../src/services/native-build-file-io.js";
import {
  NativeSecretAdmin,
  NativeSecretAdminAuthority,
} from "../src/services/native-build-secret-admin.js";
import {
  journalFile,
  markerFile,
} from "../src/services/native-build-secret-journal.js";
import {
  NativeStateConfig,
  NativeStateOwnership,
} from "../src/services/native-build-state-ownership.js";
import { builderFilesFixture } from "./fixtures/builder-registry.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.live(
  "budget command keeps the real layer state lock throughout setup and releases it afterward",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* builderFilesFixture(path("real-admin-layer"));
        let checks = 0;
        let probe: Promise<string> | undefined;
        const root = vi.spyOn(process, "geteuid").mockImplementation(() => {
          if (++checks === 2)
            probe = lockNativeState(f.settings.stateRoot).then(
              async (release) => {
                await release();
                return "unexpected-lock-acquired";
              },
              (cause: unknown) =>
                cause instanceof Error && "reason" in cause
                  ? String(cause.reason)
                  : "unexpected-lock-error",
            );
          return 0;
        });
        yield* setupNativeBudget(
          "initialize",
          "dummy-human",
          "dummy-reason",
          true,
        ).pipe(
          Effect.provideService(BuilderRegistryConfig, f.settings),
          Effect.provideService(NativeStateConfig, {
            stateRoot: f.settings.stateRoot,
            scratchRoot: f.settings.scratchRoot,
            cacheRoot: f.settings.cacheRoot,
            bytesPerBuilder: f.settings.perBuilderBytes,
            bytesTotal: f.settings.totalBytes,
          }),
          Effect.ensuring(Effect.sync(() => root.mockRestore())),
        );
        expect(checks).toBe(2);
        expect(
          yield* Effect.promise(
            () => probe ?? Promise.resolve("missing-probe"),
          ),
        ).toBe("native-state-locked-or-unsafe");
        const release = yield* registryIO(() =>
          lockNativeState(f.settings.stateRoot),
        );
        yield* registryIO(release);
      }),
    ),
);

it.live(
  "initialization refuses unused-allocation evidence with a different reason",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("evidence-reason"));
        const evidence = `${f.root}/evidence.json`;
        yield* registryIO(async () => {
          await unlink(journalFile(f.settings.stateRoot));
          await unlink(markerFile(f.settings.stateRoot));
          await writeFile(
            evidence,
            JSON.stringify({
              allocationUnused: true,
              accountId: "dummy-account",
              actor: "human",
              reason: "different reason",
            }),
            { mode: 0o600 },
          );
        });
        const service = yield* NativeSecretAdmin.make.pipe(
          Effect.provideService(BuilderRegistryConfig, f.settings),
          Effect.provideService(NativeStateOwnership, f.owner),
          Effect.provideService(NativeSecretAdminAuthority, {
            assertRoot: () => Effect.succeed(undefined),
          }),
        );
        expect(
          (yield* service
            .setup("initialize", "human", "requested reason", true, evidence)
            .pipe(Effect.flip)).code,
        ).toBe("allocation-evidence-invalid");
      }),
    ),
);
