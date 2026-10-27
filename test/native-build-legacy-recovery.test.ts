import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createNativeBuildClient } from "../src/services/native-build-client.js";
import { setup } from "./native-build-client-helpers.js";

const waitUntil = async (ready: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await ready()) return;
    await Bun.sleep(5);
  }
  throw new Error("Fixture did not reach expected state");
};

it.live(
  "cancel reaches a still-running broker after the SSH run fails locally",
  () =>
    Effect.promise(async () => {
      const f = await setup();
      await writeFile(
        f.configFile,
        JSON.stringify({ trace: f.trace, crashRun: true }),
      );
      const client = await createNativeBuildClient(f.config);
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
        expect(await client.status("session-a", job.job)).toMatchObject({
          state: "failed",
        });
        await waitUntil(async () =>
          (await readFile(f.trace, "utf8")).includes(`status ${job.job}`),
        );
        expect(await client.cancel("session-a", job.job)).toMatchObject({
          state: "failed",
          cancellationRequested: true,
        });
        expect(await readFile(f.trace, "utf8")).toContain(`cancel ${job.job}`);
      } finally {
        await client.close();
      }
    }),
);

it.live(
  "a persisted interruption can still request idempotent broker cleanup",
  () =>
    Effect.promise(async () => {
      const f = await setup();
      await mkdir(f.config.scratchRoot, { mode: 0o700 });
      const job = {
        job: "a".repeat(32),
        sessionId: "session-a",
        commit: f.commit,
        action: "archive",
        state: "interrupted",
      };
      await writeFile(
        join(f.config.scratchRoot, `${job.job}.json`),
        JSON.stringify(job),
        { mode: 0o600 },
      );
      const client = await createNativeBuildClient(f.config);
      try {
        expect(await client.cancel(job.sessionId, job.job)).toMatchObject({
          state: "interrupted",
          cancellationRequested: true,
        });
        expect(await readFile(f.trace, "utf8")).toContain(`cancel ${job.job}`);
      } finally {
        await client.close();
      }
    }),
);

it.live(
  "a corrupt diagnostic record is quarantined without disabling healthy jobs on later boots",
  () =>
    Effect.promise(async () => {
      const f = await setup();
      await mkdir(f.config.scratchRoot, { mode: 0o700 });
      const good = {
        job: "b".repeat(32),
        sessionId: "session-a",
        commit: f.commit,
        action: "archive",
        state: "succeeded",
      };
      const bad = {
        ...good,
        job: "a".repeat(32),
        state: "failed",
        stage: "boot",
        failureCode: "execution-interrupted",
      };
      const badPath = join(f.config.scratchRoot, `${bad.job}.json`);
      await writeFile(badPath, JSON.stringify(bad), { mode: 0o600 });
      await writeFile(
        join(f.config.scratchRoot, `${good.job}.json`),
        JSON.stringify(good),
        { mode: 0o600 },
      );
      for (let boot = 0; boot < 2; boot++) {
        const client = await createNativeBuildClient(f.config);
        try {
          expect(await client.status(good.sessionId, good.job)).toMatchObject(
            good,
          );
          await expect(client.status(bad.sessionId, bad.job)).rejects.toThrow(
            "not found",
          );
          expect(
            JSON.parse(await readFile(`${badPath}.invalid`, "utf8")),
          ).toEqual(bad);
        } finally {
          await client.close();
        }
      }
    }),
);

it.live(
  "an in-flight status refresh holds retention until its receipt is saved",
  () =>
    Effect.promise(async () => {
      const f = await setup();
      await writeFile(
        f.configFile,
        JSON.stringify({ trace: f.trace, crashRun: true }),
      );
      const client = await createNativeBuildClient({
        ...f.config,
        terminalRetentionMs: 60_000,
      });
      const barrier = join(f.workspace, "release-status");
      try {
        const request = {
          sessionId: "session-a",
          workspacePath: f.workspace,
          commit: f.commit,
          pullRequest: 12,
          action: "archive",
        };
        const job = await client.start(request);
        const path = join(f.config.scratchRoot, `${job.job}.json`);
        await waitUntil(
          async () =>
            JSON.parse(await readFile(path, "utf8")).state === "failed",
        );
        await writeFile(
          f.configFile,
          JSON.stringify({
            trace: f.trace,
            statusBarrier: barrier,
            statusReceipt: {
              ...job,
              state: "failed",
              stage: "cleanup",
              failureCode: "execution-interrupted",
            },
          }),
        );
        await client.status("session-a", job.job);
        await waitUntil(() => Bun.file(`${barrier}.entered`).exists());
        await utimes(path, new Date(0), new Date(0));
        // A different request prunes while the remote receipt is held at the barrier.
        const other = await client.start({
          ...request,
          sessionId: "session-b",
        });
        expect(await Bun.file(path).exists()).toBe(true);
        await writeFile(barrier, "release");
        await waitUntil(
          async () =>
            JSON.parse(await readFile(path, "utf8")).failureCode ===
            "execution-interrupted",
        );
        await utimes(path, new Date(0), new Date(0));
        await client.status("session-b", other.job);
        expect(await Bun.file(path).exists()).toBe(false);
      } finally {
        await writeFile(barrier, "release");
        await client.close();
      }
    }),
);
