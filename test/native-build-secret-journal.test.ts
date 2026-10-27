import { chmod, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { registryIO } from "../src/services/builder-registry-files.js";
import { BuilderRegistryConfig } from "../src/services/config-native-build.js";
import {
  NativeSecretAdmin,
  NativeSecretAdminAuthority,
} from "../src/services/native-build-secret-admin.js";
import {
  journalFile,
  markerFile,
} from "../src/services/native-build-secret-journal.js";
import {
  budgetFit,
  emptySecretJournal,
} from "../src/services/native-build-secret-models.js";
import { NativeSecretError } from "../src/services/native-build-secret-protocol.js";
import {
  NativeStateConfig,
  NativeStateOwnership,
} from "../src/services/native-build-state-ownership.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const admin = (
  f: Effect.Success<ReturnType<typeof secretFixture>>,
  root = true,
) =>
  NativeSecretAdmin.make.pipe(
    Effect.provideService(BuilderRegistryConfig, f.settings),
    Effect.provideService(NativeStateOwnership, f.owner),
    Effect.provideService(NativeSecretAdminAuthority, {
      assertRoot: () =>
        root
          ? Effect.succeed(undefined)
          : Effect.fail(NativeSecretError.new("root-required")),
    }),
  );
for (const damage of [
  "missing-journal",
  "corrupt-journal",
  "missing-marker",
  "unsafe-mode",
] as const)
  it.effect(
    `ordinary startup fails closed on ${damage} without resetting allowance`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* secretFixture(path(damage));
          yield* f.budget.reserve("bootstrap", 12, f.source().source, "", 0);
          yield* registryIO(async () => {
            if (damage === "missing-journal")
              await unlink(journalFile(f.settings.stateRoot));
            if (damage === "corrupt-journal")
              await writeFile(
                journalFile(f.settings.stateRoot),
                '{"DUMMY-SENTINEL":',
              );
            if (damage === "missing-marker")
              await unlink(markerFile(f.settings.stateRoot));
            if (damage === "unsafe-mode")
              await chmod(journalFile(f.settings.stateRoot), 0o644);
          });
          const error = yield* f.openJournal.pipe(Effect.flip);
          expect(error.code).toBe("journal-repair-required");
          expect(JSON.stringify(error)).not.toContain("DUMMY");
          expect(f.journal.snapshot().charges).toHaveLength(1);
          if (damage === "missing-journal")
            expect(
              yield* registryIO(() => readdir(f.settings.stateRoot)),
            ).not.toContain("provider-journal.json");
        }),
      ),
  );

it.effect(
  "journal transactions reject oversized metadata before publishing it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("bounded"));
        const error = yield* f.journal
          .transaction((data) => {
            for (let i = 0; i < 321; i++) data.successes[`source-${i}`] = 0;
          }, 0)
          .pipe(Effect.flip);
        expect(error.code).toBe("provider-queue-full");
        expect(f.journal.snapshot().successes).toEqual({});
        expect((yield* f.openJournal).snapshot().successes).toEqual({});
      }),
    ),
);

it.live(
  "root-local repair requires root, acknowledgement and the shared exclusive state lock",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("authority"));
        expect((yield* admin(f, false).pipe(Effect.flip)).code).toBe(
          "root-required",
        );
        const service = yield* admin(f);
        expect(
          (yield* service
            .setup("repair", "human", "reason", false)
            .pipe(Effect.flip)).code,
        ).toBe("human-acknowledgement-required");
        const second = yield* NativeStateOwnership.make.pipe(
          Effect.provideService(NativeStateConfig, {
            stateRoot: f.settings.stateRoot,
            scratchRoot: f.settings.scratchRoot,
            cacheRoot: f.settings.cacheRoot,
            bytesPerBuilder: f.settings.perBuilderBytes,
            bytesTotal: f.settings.totalBytes,
          }),
          Effect.flip,
        );
        expect(second.reason).toBe("native-state-locked-or-unsafe");
      }),
    ),
);

it.live(
  "repair preserves marker and readable charges, archives privately and spends all buckets for 24h",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("repair"));
        const wall = Date.now();
        yield* f.journal.transaction((data) => {
          data.charges.push({
            at: wall,
            bucket: "agent",
            units: 4,
            org: "old-org",
          });
          data.cooldowns[f.source().source] = wall + 60000;
        }, wall);
        const before = yield* registryIO(() =>
          readFile(journalFile(f.settings.stateRoot), "utf8"),
        );
        const service = yield* admin(f);
        const result = yield* service.setup(
          "repair",
          "human",
          "corrupt-volume-replacement",
          true,
        );
        expect(result.conservativeUntil).not.toBeNull();
        const restored = (yield* f.openJournal).snapshot();
        expect(
          restored.charges.find((charge) => charge.org === "old-org")?.units,
        ).toBe(4);
        for (const bucket of ["bootstrap", "retry", "human", "agent"] as const)
          expect(
            budgetFit(
              restored,
              400,
              200,
              bucket,
              4,
              restored.highWater + 3600000,
            ),
          ).toBeGreaterThanOrEqual(restored.highWater + 86400000);
        const archive = (yield* registryIO(() =>
          readdir(f.settings.stateRoot),
        )).find((name) => name.endsWith(".archive"));
        expect(archive).toBeDefined();
        expect(
          yield* registryIO(() =>
            readFile(`${f.settings.stateRoot}/${archive}`, "utf8"),
          ),
        ).toBe(before);
        expect(
          yield* registryIO(() =>
            readFile(markerFile(f.settings.stateRoot), "utf8"),
          ),
        ).toBe("partitura-native-provider-v1\n");
        expect(JSON.stringify(restored)).not.toContain(f.record.privateKeyB64);
      }),
    ),
);

for (const unused of [false, true])
  it.live(
    `explicit initialization ${unused ? "accepts protected unused-allocation evidence" : "starts fully spent when prior usage is unknown"}`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* secretFixture(path(`initialize-${unused}`));
          yield* registryIO(async () => {
            await unlink(journalFile(f.settings.stateRoot));
            await unlink(markerFile(f.settings.stateRoot));
          });
          const service = yield* admin(f);
          const evidence = `${f.root}/evidence.json`;
          if (unused)
            yield* registryIO(() =>
              writeFile(
                evidence,
                JSON.stringify({
                  allocationUnused: true,
                  accountId: "dummy-account",
                  actor: "human",
                  reason: "dedicated unused test allocation",
                }),
                { mode: 0o600 },
              ),
            );
          const result = yield* service.setup(
            "initialize",
            "human",
            "new installation",
            true,
            unused ? evidence : undefined,
          );
          const loaded = (yield* f.openJournal).snapshot();
          expect(loaded.charges).toHaveLength(unused ? 0 : 4);
          expect(result.conservativeUntil === null).toBe(unused);
          expect(
            (yield* service
              .setup("initialize", "human", "repeat", true)
              .pipe(Effect.flip)).code,
          ).toBe("journal-already-initialized");
        }),
      ),
  );

it.live(
  "repair of corrupt data archives original bytes and never grants a fresh allowance",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("corrupt-repair"));
        yield* registryIO(() =>
          writeFile(journalFile(f.settings.stateRoot), "corrupt-public-state"),
        );
        yield* (yield* admin(f)).setup(
          "repair",
          "human",
          "repair corruption",
          true,
        );
        expect((yield* f.openJournal).snapshot().charges).toHaveLength(4);
        expect(emptySecretJournal(0).charges).toEqual([]);
      }),
    ),
);
