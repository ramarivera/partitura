import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { waitUntil } from "./fixtures/native-build-wait.js";
import {
  observedStatusClient,
  payload,
  setup,
} from "./native-build-client-helpers.js";

it.live(
  "SSH loss followed by many running receipts still learns workflow failure and delivers its logs",
  () =>
    Effect.promise(async () => {
      const f = await setup();
      await writeFile(
        f.configFile,
        JSON.stringify({ trace: f.trace, crashRun: true }),
      );
      let at = 0;
      const observed = await observedStatusClient(f.config, () => at);
      const { client } = observed;
      try {
        const job = await client.start({
          sessionId: "session-a",
          workspacePath: f.workspace,
          commit: f.commit,
          pullRequest: 12,
          action: "archive",
        });
        await waitUntil(
          async () =>
            JSON.parse(
              await readFile(
                join(f.config.scratchRoot, `${job.job}.json`),
                "utf8",
              ),
            ).state === "failed",
        );
        await writeFile(
          f.configFile,
          JSON.stringify({
            trace: f.trace,
            statusReceipt: { ...job, state: "running", stage: "workflow" },
          }),
        );
        for (let round = 0; round < 6; round++) {
          const status = await client.status("session-a", job.job);
          expect(status.state).toBe("failed");
          expect(status.failureCode).toBeUndefined();
          await observed.settleStatus(job.job);
          expect(observed.reads()).toBe(round + 1);
          // Polling between scheduled reads remains entirely local.
          for (let poll = 0; poll < 20; poll++)
            await client.status("session-a", job.job);
          expect(observed.reads()).toBe(round + 1);
          at += 30_000;
        }
        await writeFile(
          f.configFile,
          JSON.stringify({
            trace: f.trace,
            statusReceipt: {
              ...job,
              state: "failed",
              stage: "workflow",
              failureCode: "workflow-failed",
              artifactSha256: createHash("sha256")
                .update(payload)
                .digest("hex"),
              artifactBytes: payload.length,
            },
          }),
        );
        await client.status("session-a", job.job);
        await observed.settleStatus(job.job);
        expect(observed.reads()).toBe(7);
        expect(await client.status("session-a", job.job)).toMatchObject({
          state: "failed",
          failureCode: "workflow-failed",
        });
        const artifact = await client.artifact("session-a", job.job);
        try {
          expect(await readFile(artifact.path, "utf8")).toBe(payload);
        } finally {
          artifact.release();
        }
        at += 1e9;
        await client.status("session-a", job.job);
        expect(observed.reads()).toBe(7);
      } finally {
        await client.close();
      }
    }),
);

it.live(
  "fixture waits tolerate readiness after one second and stop before the live-test deadline",
  () =>
    Effect.promise(async () => {
      let at = 0;
      const clock = {
        now: () => at,
        pause: async () => {
          at += 5;
        },
      };
      await waitUntil(async () => at >= 1_500, clock);
      expect(at).toBe(1_500);
      at = 0;
      await expect(waitUntil(async () => false, clock)).rejects.toThrow(
        "Fixture did not reach expected state",
      );
      expect(at).toBe(2_000);
    }),
);
