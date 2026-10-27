import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Context, Effect } from "effect";
import { importLegacyNativeSlot } from "../deploy/mac-build/native-build-import.js";
import { createNativeBuildClient } from "../src/services/native-build-client.js";
import { NativeBuildTransport } from "../src/services/native-build-transport.js";
import { cutoverFixture } from "./fixtures/native-build-cutover.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { testPaths } from "./fixtures/paths.js";
import { settled, setup } from "./native-build-client-helpers.js";

const path = testPaths();
it.live(
  "both legacy slots import into separate registry generations and their original stores still support deliberate rollback",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("both-slots"));
        const registry = yield* f.boot();
        yield* registry.registry.awaitIdle();
        for (const builder of ["primary", "backup"] as const) {
          const legacy = yield* testAwait(setup(`migration-${builder}`));
          const open = () => testAwait(createNativeBuildClient(legacy.config));
          const client = yield* Effect.acquireRelease(open(), (client) =>
            testAwait(client.close()).pipe(Effect.orDie),
          );
          const sessionId = `${builder}-session`;
          const start = yield* testAwait(
            client.start({
              sessionId,
              workspacePath: legacy.workspace,
              commit: legacy.commit,
              pullRequest: 12,
              action: "archive",
            }),
          );
          expect(
            (yield* testAwait(settled(client, start.job, sessionId))).state,
          ).toBe("succeeded");
          const artifact = yield* testAwait(
            client.artifact(sessionId, start.job),
          );
          artifact.release();
          yield* testAwait(client.close());
          const recordPath = join(
            legacy.config.scratchRoot,
            `${start.job}.json`,
          );
          const original = yield* testAwait(readFile(recordPath));
          const owner = { sessionId, organizationId: "org-a", pullRequest: 12 };
          const record = builder === "primary" ? f.primary : f.backup;
          yield* importLegacyNativeSlot(
            registry.state,
            Context.get(registry.context, NativeBuildTransport),
            {
              scratchRoot: legacy.config.scratchRoot,
              privateKeyPath: f.native.keyPath,
              pins: record.hostKeys,
              builderId: builder,
              source: `file:${builder}.json`,
              hostId: record.hostId,
              hostname: record.hostname,
              sshUser: record.sshUser,
              port: record.port,
              suffix: f.settings.suffix,
              acknowledgeQuiesced: true,
              originalOwners: { [start.job]: owner },
              resolveOwner: async () => owner,
            },
          );
          const imported = yield* registry.jobs.status(
            "org-a",
            sessionId,
            start.job,
          );
          expect(imported.builderId).toBe(builder);
          expect(imported.imported).toBe(true);
          const delivered = yield* registry.jobs.artifact(
            "org-a",
            sessionId,
            start.job,
          );
          expect(delivered.sha256).toBe(artifact.sha256);
          delivered.release();
          expect(yield* testAwait(readFile(recordPath))).toEqual(original);
          const rollback = yield* Effect.acquireRelease(open(), (client) =>
            testAwait(client.close()).pipe(Effect.orDie),
          );
          expect(
            (yield* testAwait(rollback.status(sessionId, start.job))).state,
          ).toBe("succeeded");
          const oldArtifact = yield* testAwait(
            rollback.artifact(sessionId, start.job),
          );
          expect(oldArtifact.sha256).toBe(artifact.sha256);
          oldArtifact.release();
        }
        expect(
          registry.state
            .snapshot()
            .jobs.map((job) => job.builderId)
            .sort(),
        ).toEqual(["backup", "primary"]);
        expect(registry.state.snapshot().jobs[0]?.generationId).not.toBe(
          registry.state.snapshot().jobs[1]?.generationId,
        );
      }),
    ),
);
