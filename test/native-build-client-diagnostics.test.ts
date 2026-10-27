import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { createNativeBuildClient } from "../src/services/native-build-client.js";

import { payload, settled, setup } from "./native-build-client-helpers.js";

for (const [stage, failureCode] of [
  ["unlock", "unlock-failed"],
  ["capacity", "host-capacity-unavailable"],
  ["disk-preflight", "host-disk-space-unavailable"],
  ["disk-post-transfer", "host-disk-space-unavailable"],
  ["cleanup", "execution-interrupted"],
  ["receiving", "receive-interrupted"],
  ["keychain-policy", "keychain-policy-unavailable"],
] as const) {
  it.live(`preserves ${failureCode} through the native gateway`, () =>
    Effect.promise(async () => {
      const fixture = await setup();
      await writeFile(
        fixture.configFile,
        JSON.stringify({
          trace: fixture.trace,
          exitCode: 1,
          receiptOverrides: { state: "failed", stage, failureCode },
        }),
      );
      const client = await createNativeBuildClient(fixture.config);
      try {
        const job = await client.start({
          sessionId: "session-a",
          workspacePath: fixture.workspace,
          commit: fixture.commit,
          pullRequest: 12,
          action: "archive",
        });
        expect(await settled(client, job.job)).toMatchObject({
          state: "failed",
          stage,
          failureCode,
        });
        await expect(client.artifact("session-a", job.job)).rejects.toThrow(
          "no deliverable artifact",
        );
      } finally {
        await client.close();
      }
    }),
  );
}

for (const invalid of [
  false,
  true,
  "foreign-job",
  "wrong-stage",
  "success-exit",
  "transport-exit",
  "post-transfer",
  "workflow",
] as const) {
  it.live(
    `validates pre-input disk refusal after a broken stdin: ${invalid}`,
    () =>
      Effect.promise(async () => {
        const fixture = await setup();
        // An incompressible bundle larger than a pipe forces the writer to still
        // be streaming when the fake broker exits without consuming input.
        await writeFile(
          join(fixture.workspace, "large.bin"),
          randomBytes(2 * 1024 * 1024),
        );
        fixture.git("add", "large.bin");
        fixture.git(
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--quiet",
          "-m",
          "large input",
        );
        await writeFile(
          fixture.configFile,
          JSON.stringify({
            trace: fixture.trace,
            earlyRefusal: true,
            exitCode:
              invalid === "success-exit"
                ? 0
                : invalid === "transport-exit"
                  ? 255
                  : 1,
            invalidOutput: invalid === true,
            receiptOverrides:
              invalid === "foreign-job"
                ? { job: "f".repeat(32) }
                : invalid === "wrong-stage"
                  ? { stage: "capacity" }
                  : invalid === "post-transfer"
                    ? { stage: "disk-post-transfer" }
                    : invalid === "workflow"
                      ? {
                          stage: "workflow",
                          failureCode: "workflow-failed",
                          workflowExitCode: 1,
                          artifactBytes: payload.length,
                          artifactSha256: "a".repeat(64),
                        }
                      : {},
          }),
        );
        const client = await createNativeBuildClient(fixture.config);
        try {
          const job = await client.start({
            sessionId: "session-a",
            workspacePath: fixture.workspace,
            commit: fixture.git("rev-parse", "HEAD"),
            pullRequest: 12,
            action: "archive",
          });
          const result = await settled(client, job.job);
          expect(result.state).toBe("failed");
          if (invalid === false)
            expect(result).toMatchObject({
              failureCode: "host-disk-space-unavailable",
              stage: "disk-preflight",
            });
          else {
            expect(result.failureCode).toBeUndefined();
            expect(result.stage).toBeUndefined();
            await expect(client.artifact("session-a", job.job)).rejects.toThrow(
              "no deliverable artifact",
            );
          }
        } finally {
          await client.close();
        }
      }),
  );
}

it.live("delivers repository logs from a failed workflow", () =>
  Effect.promise(async () => {
    const fixture = await setup();
    await writeFile(
      fixture.configFile,
      JSON.stringify({
        trace: fixture.trace,
        exitCode: 1,
        failedArtifact: true,
        receiptOverrides: {
          state: "failed",
          stage: "workflow",
          cause: "CalledProcessError",
          failureCode: "workflow-failed",
          workflowExitCode: 3,
        },
      }),
    );
    const client = await createNativeBuildClient(fixture.config);
    try {
      const job = await client.start({
        sessionId: "session-a",
        workspacePath: fixture.workspace,
        commit: fixture.commit,
        pullRequest: 12,
        action: "archive",
      });
      expect(await settled(client, job.job)).toMatchObject({
        state: "failed",
        stage: "workflow",
        failureCode: "workflow-failed",
        workflowExitCode: 3,
        artifactBytes: payload.length,
      });
      const artifact = await client.artifact("session-a", job.job);
      try {
        expect(await readFile(artifact.path, "utf8")).toBe(payload);
      } finally {
        artifact.release();
      }
    } finally {
      await client.close();
    }
  }),
);

it.live("preserves only validated failed-job diagnostics across restart", () =>
  Effect.promise(async () => {
    const fixture = await setup();
    await writeFile(
      fixture.configFile,
      JSON.stringify({
        trace: fixture.trace,
        exitCode: 1,
        receiptOverrides: {
          state: "failed",
          stage: "boot",
          bootExitCode: 1,
          failureCode: "host-key-unavailable",
          cause: "private fixture detail",
          log: "private fixture detail",
        },
      }),
    );
    const client = await createNativeBuildClient(fixture.config);
    const job = await client.start({
      sessionId: "session-a",
      workspacePath: fixture.workspace,
      commit: fixture.commit,
      pullRequest: 12,
      action: "archive",
    });
    const expected = {
      ...job,
      state: "failed",
      stage: "boot",
      bootExitCode: 1,
      failureCode: "host-key-unavailable",
    };
    try {
      expect(await settled(client, job.job)).toEqual(expected);
      await expect(client.artifact("session-a", job.job)).rejects.toThrow(
        "no deliverable artifact",
      );
    } finally {
      await client.close();
    }
    const restarted = await createNativeBuildClient(fixture.config);
    try {
      expect(await restarted.status("session-a", job.job)).toEqual(expected);
      expect(
        await readFile(
          join(fixture.config.scratchRoot, `${job.job}.json`),
          "utf8",
        ),
      ).not.toContain("private fixture detail");
    } finally {
      await restarted.close();
    }
  }),
);

it.live(
  "loads both disk diagnostics after restart and rejects inconsistent persisted fields",
  () =>
    Effect.promise(async () => {
      for (const stage of ["disk-preflight", "disk-post-transfer", "boot"]) {
        const fixture = await setup(`persisted-${stage}`);
        await mkdir(fixture.config.scratchRoot, { mode: 0o700 });
        const job = {
          job: "a".repeat(32),
          sessionId: "session-a",
          commit: fixture.commit,
          action: "archive",
          state: "failed",
          failureCode: "host-disk-space-unavailable",
          stage,
        };
        await writeFile(
          join(fixture.config.scratchRoot, `${job.job}.json`),
          JSON.stringify(job),
          { mode: 0o600 },
        );
        if (stage === "boot") {
          await expect(createNativeBuildClient(fixture.config)).rejects.toThrow(
            "Inconsistent",
          );
        } else {
          const client = await createNativeBuildClient(fixture.config);
          try {
            expect(await client.status("session-a", job.job)).toEqual(job);
          } finally {
            await client.close();
          }
        }
      }
    }),
);

it.live("rejects foreign, untrusted and transport failure diagnostics", () =>
  Effect.promise(async () => {
    for (const [index, invalid] of [
      { exitCode: 255 },
      { exitCode: 0 },
      { receiptOverrides: { commit: "f".repeat(40) } },
      { receiptOverrides: { job: "f".repeat(32) } },
      { receiptOverrides: { action: "foreign" } },
      { receiptOverrides: { failureCode: "private fixture detail" } },
      { receiptOverrides: { stage: "private fixture detail" } },
      { receiptOverrides: { bootExitCode: 1.5 } },
      { receiptOverrides: { stage: "workflow" } },
      { receiptOverrides: { state: "succeeded" } },
      { receiptOverrides: { failureCode: "workflow-failed" } },
      { receiptOverrides: { workflowExitCode: 1 } },
      { receiptOverrides: { failureCode: "host-disk-space-unavailable" } },
      { receiptOverrides: { stage: "disk-preflight" } },
      { receiptOverrides: { stage: "disk-post-transfer" } },
      {
        receiptOverrides: {
          stage: "workflow",
          failureCode: "workflow-failed",
          workflowExitCode: 256,
        },
      },
      {
        receiptOverrides: {
          artifactSha256: "a".repeat(64),
          artifactBytes: 1,
        },
      },
    ].entries()) {
      const fixture = await setup(`invalid-failure-${index}`);
      await writeFile(
        fixture.configFile,
        JSON.stringify({
          trace: fixture.trace,
          exitCode: invalid.exitCode ?? 1,
          receiptOverrides: {
            state: "failed",
            stage: "boot",
            bootExitCode: 1,
            failureCode: "host-key-unavailable",
            ...invalid.receiptOverrides,
          },
        }),
      );
      const client = await createNativeBuildClient(fixture.config);
      try {
        const job = await client.start({
          sessionId: "session-a",
          workspacePath: fixture.workspace,
          commit: fixture.commit,
          pullRequest: 12,
          action: "archive",
        });
        expect(await settled(client, job.job)).toEqual({
          ...job,
          state: "failed",
        });
      } finally {
        await client.close();
      }
    }
  }),
);

it.live("rejects native build receipts for another commit or action", () =>
  Effect.promise(async () => {
    for (const [index, receiptOverrides] of [
      { commit: "f".repeat(40) },
      { action: "native-smoke" },
    ].entries()) {
      const fixture = await setup(`private-${index}`);
      await writeFile(
        fixture.configFile,
        JSON.stringify({ trace: fixture.trace, receiptOverrides }),
      );
      const client = await createNativeBuildClient(fixture.config);
      try {
        const job = await client.start({
          sessionId: "session-a",
          workspacePath: fixture.workspace,
          commit: fixture.commit,
          pullRequest: 12,
          action: "archive",
        });
        expect((await settled(client, job.job)).state).toBe("failed");
      } finally {
        await client.close();
      }
    }
  }),
);

it.live(
  "rejects non-finite, fractional, negative, and oversized receipt sizes",
  () =>
    Effect.promise(async () => {
      for (const [index, rawArtifactBytes] of [
        "1e400",
        "1.5",
        "-1",
        "2147483649",
      ].entries()) {
        const fixture = await setup(`private-${index}`);
        await writeFile(
          fixture.configFile,
          JSON.stringify({ trace: fixture.trace, rawArtifactBytes }),
        );
        const client = await createNativeBuildClient(fixture.config);
        try {
          const job = await client.start({
            sessionId: "session-a",
            workspacePath: fixture.workspace,
            commit: fixture.commit,
            pullRequest: 12,
            action: "archive",
          });
          expect((await settled(client, job.job)).state).toBe("failed");
        } finally {
          await client.close();
        }
      }
    }),
);

it.live("rejects corrupt artifacts and insecure transport configuration", () =>
  Effect.promise(async () => {
    const fixture = await setup();
    const client = await createNativeBuildClient(fixture.config);
    try {
      const job = await client.start({
        sessionId: "session-a",
        workspacePath: fixture.workspace,
        commit: fixture.commit,
        pullRequest: 12,
        action: "archive",
      });
      expect((await settled(client, job.job)).state).toBe("succeeded");
      await writeFile(
        fixture.configFile,
        JSON.stringify({ trace: fixture.trace, corrupt: true }),
      );
      await expect(client.artifact("session-a", job.job)).rejects.toThrow(
        "differs",
      );
      await chmod(fixture.configFile, 0o644);
      await expect(createNativeBuildClient(fixture.config)).rejects.toThrow(
        "Unsafe",
      );
    } finally {
      await client.close();
    }
  }),
);

it.live("replaces a corrupt cached artifact from the broker", () =>
  Effect.promise(async () => {
    const fixture = await setup();
    const client = await createNativeBuildClient(fixture.config);
    try {
      const job = await client.start({
        sessionId: "session-a",
        workspacePath: fixture.workspace,
        commit: fixture.commit,
        pullRequest: 12,
        action: "archive",
      });
      expect((await settled(client, job.job)).state).toBe("succeeded");
      const original = await client.artifact("session-a", job.job);
      original.release();
      await writeFile(original.path, "stale-corrupt-cache");

      const refreshed = await client.artifact("session-a", job.job);
      try {
        expect(await readFile(refreshed.path, "utf8")).toBe(payload);
      } finally {
        refreshed.release();
      }
      const artifactFetches = (await readFile(fixture.trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.args.at(-1) === `artifact ${job.job}`);
      expect(artifactFetches).toHaveLength(2);
    } finally {
      await client.close();
    }
  }),
);

it.live(
  "cancels interrupted persisted jobs during recovery and validates ownership",
  () =>
    Effect.promise(async () => {
      const fixture = await setup();
      await mkdir(fixture.config.scratchRoot, { mode: 0o700 });
      const job = "a".repeat(32);
      await writeFile(
        join(fixture.config.scratchRoot, `${job}.json`),
        JSON.stringify({
          job,
          sessionId: "session-a",
          commit: fixture.commit,
          action: "archive",
          state: "running",
        }),
        { mode: 0o600 },
      );
      const client = await createNativeBuildClient(fixture.config);
      expect((await client.status("session-a", job)).state).toBe("interrupted");
      expect(await readFile(fixture.trace, "utf8")).toContain(`cancel ${job}`);
      await client.close();
      await writeFile(
        join(fixture.config.scratchRoot, `${job}.json`),
        JSON.stringify({ job: "../escape", sessionId: "session-a" }),
      );
      await expect(createNativeBuildClient(fixture.config)).rejects.toThrow();
    }),
);
