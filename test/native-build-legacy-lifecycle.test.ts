import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createNativeBuildClient } from "../src/services/native-build-client.js";
import { waitUntil } from "./fixtures/native-build-wait.js";
import { observedStatusClient, setup } from "./native-build-client-helpers.js";

it.live(
  "startup re-tracks a code-less failure and close aborts its status flight permanently",
  () =>
    Effect.promise(async () => {
      const f = await setup();
      await mkdir(f.config.scratchRoot, { mode: 0o700 });
      const job = {
        job: "a".repeat(32),
        sessionId: "session-a",
        commit: f.commit,
        action: "archive",
        state: "failed",
      };
      await writeFile(
        join(f.config.scratchRoot, `${job.job}.json`),
        JSON.stringify(job),
        { mode: 0o600 },
      );
      const barrier = join(f.workspace, "release-status");
      await writeFile(
        f.configFile,
        JSON.stringify({
          trace: f.trace,
          statusBarrier: barrier,
          statusReceipt: { ...job, state: "running" },
        }),
      );
      const observed = await observedStatusClient(f.config);
      try {
        await observed.client.status(job.sessionId, job.job);
        await waitUntil(() => Bun.file(`${barrier}.entered`).exists());
        expect(observed.reads()).toBe(1);
        // No barrier release: close must abort and reap the waiting SSH process.
        await observed.client.close();
        expect(observed.completed()).toBe(1);
        await observed.client.status(job.sessionId, job.job);
        expect(observed.reads()).toBe(1);
      } finally {
        await writeFile(barrier, "release");
        await observed.client.close();
      }
    }),
);

it.live(
  "invalid records request broker cleanup and expire with orphaned quarantine files",
  () =>
    Effect.promise(async () => {
      const f = await setup();
      await mkdir(f.config.scratchRoot, { mode: 0o700 });
      const job = "a".repeat(32);
      const record = join(f.config.scratchRoot, `${job}.json`);
      await writeFile(record, "invalid JSON", { mode: 0o600 });
      let client = await createNativeBuildClient(f.config);
      try {
        expect(await readFile(f.trace, "utf8")).toContain(`cancel ${job}`);
        expect(await Bun.file(`${record}.invalid`).exists()).toBe(true);
        await client.close();
        await utimes(`${record}.invalid`, new Date(0), new Date(0));
        client = await createNativeBuildClient(f.config);
        expect(await Bun.file(`${record}.invalid`).exists()).toBe(false);
      } finally {
        await client.close();
      }
    }),
);
