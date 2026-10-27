import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  createNativeBuildClient,
  deliverNativeArtifact,
} from "../src/services/native-build-client.js";

import {
  path,
  payload,
  settled,
  setup,
} from "./native-build-client-helpers.js";

it.live("keeps native requests usable when an orphan cannot be pruned", () =>
  Effect.promise(async () => {
    const fixture = await setup();
    const client = await createNativeBuildClient({
      ...fixture.config,
      terminalRetentionMs: 60_000,
    });
    const orphan = join(
      fixture.config.scratchRoot,
      `${"f".repeat(32)}.tar.partial`,
    );
    try {
      await mkdir(orphan);
      await utimes(orphan, new Date(0), new Date(0));
      const request = {
        sessionId: "session-a",
        workspacePath: fixture.workspace,
        commit: fixture.commit,
        pullRequest: 12,
        action: "archive",
      };
      const first = await client.start(request);
      expect((await settled(client, first.job)).state).toBe("succeeded");
      await client.cancel("session-a", first.job);
      expect((await client.status("session-a", first.job)).state).toBe(
        "succeeded",
      );
      const next = await client.start({ ...request, sessionId: "session-b" });
      expect((await settled(client, next.job, "session-b")).state).toBe(
        "succeeded",
      );
      const trace = await readFile(fixture.trace, "utf8");
      expect(trace).toContain(`cancel ${first.job}`);
      await expect(client.close()).rejects.toThrow();
    } finally {
      await rm(orphan, { recursive: true, force: true });
      // A successful request clears the saved housekeeping failure before close.
      const next = await client.start({
        sessionId: "cleanup",
        workspacePath: fixture.workspace,
        commit: fixture.commit,
        pullRequest: 12,
        action: "archive",
      });
      await settled(client, next.job, "cleanup");
      await client.close();
    }
  }),
);

it.live(
  "delivers bounded job secrets only in SSH stdin, outside durable ownership",
  () =>
    Effect.promise(async () => {
      const fixture = await setup();
      const secret = "fixture-repository-job-identity";
      await writeFile(
        fixture.configFile,
        JSON.stringify({ trace: fixture.trace, expectedSecret: secret }),
      );
      const client = await createNativeBuildClient(fixture.config);
      try {
        const request = {
          sessionId: "session-a",
          workspacePath: fixture.workspace,
          commit: fixture.commit,
          pullRequest: 12,
          action: "archive",
        };
        for (const secretFiles of [
          { "../escape": secret },
          { identity: "x".repeat(65536) },
        ])
          await expect(
            client.start({ ...request, secretFiles }),
          ).rejects.toThrow();
        const job = await client.start({
          ...request,
          secretFiles: { "repository-age-identity": secret },
        });
        expect((await settled(client, job.job)).state).toBe("succeeded");
        expect(await readFile(fixture.trace, "utf8")).not.toContain(secret);
        expect(
          await readFile(
            join(fixture.config.scratchRoot, `${job.job}.json`),
            "utf8",
          ),
        ).not.toContain(secret);
        await expect(
          readFile(join(fixture.config.scratchRoot, `${job.job}.bundle`)),
        ).rejects.toThrow();
      } finally {
        await client.close();
      }
    }),
);

it.live(
  "streams a real Git bundle, scopes job access, and verifies artifact bytes",
  () =>
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
        await expect(client.status("session-b", job.job)).rejects.toThrow(
          "not found",
        );
        await expect(client.artifact("session-b", job.job)).rejects.toThrow(
          "not found",
        );
        const artifact = await client.artifact("session-a", job.job);
        try {
          expect(await readFile(artifact.path, "utf8")).toBe(payload);
          const cached = await client.artifact("session-a", job.job);
          expect(cached).toMatchObject({
            path: artifact.path,
            sha256: artifact.sha256,
            bytes: artifact.bytes,
          });
          cached.release();
        } finally {
          artifact.release();
        }
        const delivered = await deliverNativeArtifact(client, {
          sessionId: "session-a",
          job: job.job,
          workspacePath: fixture.workspace,
        });
        expect(await readFile(delivered.path, "utf8")).toBe(payload);
        expect(delivered.path.startsWith(fixture.workspace)).toBe(true);
        const calls = (await readFile(fixture.trace, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls[0].args).toContain("IdentityAgent=none");
        expect(calls[0].args).toContain("StrictHostKeyChecking=yes");
        expect(calls[0].env).not.toContain("GITHUB_TOKEN");
      } finally {
        await client.close();
      }
    }),
);

it.live("cancelling during bundle preparation fences remote submission", () =>
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
      await client.cancel("session-a", job.job);
      expect((await client.status("session-a", job.job)).state).toBe(
        "interrupted",
      );
      expect(await readFile(fixture.trace, "utf8")).toContain(
        `cancel ${job.job}`,
      );
      expect(await readFile(fixture.trace, "utf8")).not.toContain(
        `run ${job.job}`,
      );
    } finally {
      await client.close();
    }
  }),
);

it.live("reserves a session before asynchronous job persistence", () =>
  Effect.promise(async () => {
    const fixture = await setup();
    const client = await createNativeBuildClient(fixture.config);
    try {
      const starts = await Promise.allSettled([
        client.start({
          sessionId: "session-a",
          workspacePath: fixture.workspace,
          commit: fixture.commit,
          pullRequest: 12,
          action: "archive",
        }),
        client.start({
          sessionId: "session-a",
          workspacePath: fixture.workspace,
          commit: fixture.commit,
          pullRequest: 12,
          action: "another-action",
        }),
      ]);
      expect(
        starts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        starts.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      const started = starts.find((result) => result.status === "fulfilled");
      if (started?.status !== "fulfilled") throw new Error("No job started");
      expect((await settled(client, started.value.job)).state).toBe(
        "succeeded",
      );
    } finally {
      await client.close();
    }
  }),
);

it.live("bundles the requested shallow commit and checks it out exactly", () =>
  Effect.promise(async () => {
    const fixture = await setup();
    const requestedCommit = fixture.commit;
    fixture.git(
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "newer head",
    );
    const latestCommit = fixture.git("rev-parse", "HEAD");
    const shallowWorkspace = join(path("private"), "shallow-workspace");
    const clone = spawnSync(
      "/usr/bin/git",
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        `file://${fixture.workspace}`,
        shallowWorkspace,
      ],
      { encoding: "utf8" },
    );
    if (clone.status !== 0) throw new Error(clone.stderr);
    const fetch = spawnSync(
      "/usr/bin/git",
      [
        "-C",
        shallowWorkspace,
        "fetch",
        "--quiet",
        "--depth=1",
        `file://${fixture.workspace}`,
        requestedCommit,
      ],
      { encoding: "utf8" },
    );
    if (fetch.status !== 0) throw new Error(fetch.stderr);
    expect(
      await readFile(join(shallowWorkspace, ".git", "shallow"), "utf8"),
    ).toContain(requestedCommit);
    const shallowHead = spawnSync(
      "/usr/bin/git",
      ["-C", shallowWorkspace, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    if (shallowHead.status !== 0) throw new Error(shallowHead.stderr);
    expect(shallowHead.stdout.trim()).toBe(latestCommit);

    await writeFile(
      fixture.configFile,
      JSON.stringify({ trace: fixture.trace, verifyBundle: true }),
    );
    const client = await createNativeBuildClient(fixture.config);
    try {
      const job = await client.start({
        sessionId: "session-a",
        workspacePath: shallowWorkspace,
        commit: requestedCommit,
        pullRequest: 12,
        action: "release-ios-preview",
      });
      expect((await settled(client, job.job)).state).toBe("succeeded");
    } finally {
      await client.close();
    }
  }),
);

it.live("retains a terminal job while a consumer holds its artifact", () =>
  Effect.promise(async () => {
    const fixture = await setup();
    const client = await createNativeBuildClient({
      ...fixture.config,
      terminalRetentionMs: 100,
    });
    let artifact: Awaited<ReturnType<typeof client.artifact>> | undefined;
    try {
      const job = await client.start({
        sessionId: "session-a",
        workspacePath: fixture.workspace,
        commit: fixture.commit,
        pullRequest: 12,
        action: "archive",
      });
      expect((await settled(client, job.job)).state).toBe("succeeded");
      artifact = await client.artifact("session-a", job.job);
      const staleFiles = [
        join(fixture.config.scratchRoot, `${job.job}.bundle`),
        join(fixture.config.scratchRoot, `${job.job}.json.new`),
        join(fixture.config.scratchRoot, `${job.job}.tar.stale.partial`),
      ];
      await Promise.all(staleFiles.map((file) => writeFile(file, "stale")));
      await Bun.sleep(120);
      expect((await client.status("session-a", job.job)).state).toBe(
        "succeeded",
      );
      await Promise.all(
        staleFiles.map((file) => expect(readFile(file)).resolves.toBeDefined()),
      );
      artifact.release();
      await Bun.sleep(120);
      await expect(client.status("session-a", job.job)).rejects.toThrow(
        "not found",
      );
      await Promise.all(
        staleFiles.map((file) => expect(readFile(file)).rejects.toThrow()),
      );
    } finally {
      artifact?.release();
      await client.close();
    }
  }),
);

it.live("fences artifact acquisition once terminal-job retirement starts", () =>
  Effect.promise(async () => {
    const fixture = await setup();
    const client = await createNativeBuildClient({
      ...fixture.config,
      terminalRetentionMs: 100,
    });
    try {
      const job = await client.start({
        sessionId: "session-a",
        workspacePath: fixture.workspace,
        commit: fixture.commit,
        pullRequest: 12,
        action: "archive",
      });
      expect((await settled(client, job.job)).state).toBe("succeeded");
      await Bun.sleep(120);
      const [status, artifact] = await Promise.allSettled([
        client.status("session-a", job.job),
        client.artifact("session-a", job.job),
      ]);
      expect(status.status).toBe("rejected");
      expect(artifact.status).toBe("rejected");
      if (artifact.status === "fulfilled") artifact.value.release();
      await expect(client.status("session-a", job.job)).rejects.toThrow(
        "not found",
      );
    } finally {
      await client.close();
    }
  }),
);

it.live("coalesces concurrent terminal and orphan-file pruning", () =>
  Effect.promise(async () => {
    const fixture = await setup();
    const client = await createNativeBuildClient({
      ...fixture.config,
      terminalRetentionMs: 100,
    });
    try {
      const job = await client.start({
        sessionId: "session-a",
        workspacePath: fixture.workspace,
        commit: fixture.commit,
        pullRequest: 12,
        action: "archive",
      });
      expect((await settled(client, job.job)).state).toBe("succeeded");
      const orphanFiles = Array.from({ length: 96 }, (_, index) =>
        join(
          fixture.config.scratchRoot,
          `${"b".repeat(32)}.tar.orphan-${index}`,
        ),
      );
      await Promise.all(orphanFiles.map((file) => writeFile(file, "stale")));
      await Bun.sleep(120);

      const results = await Promise.allSettled([
        client.status("session-a", job.job),
        client.status("session-a", job.job),
        client.cancel("session-a", job.job),
        client.close(),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const failures = results.filter((result) => result.status === "rejected");
      expect(failures).toHaveLength(3);
      expect(
        failures.every(
          (result) =>
            result.reason instanceof Error &&
            result.reason.message.includes("not found"),
        ),
      ).toBe(true);
      await Promise.all(
        orphanFiles.map((file) => expect(readFile(file)).rejects.toThrow()),
      );
    } finally {
      await client.close();
    }
  }),
);

it.live("waits for a current prune before leasing a fresh artifact", () =>
  Effect.promise(async () => {
    const fixture = await setup();
    const client = await createNativeBuildClient({
      ...fixture.config,
      terminalRetentionMs: 5_000,
    });
    try {
      const job = await client.start({
        sessionId: "session-a",
        workspacePath: fixture.workspace,
        commit: fixture.commit,
        pullRequest: 12,
        action: "archive",
      });
      expect((await settled(client, job.job)).state).toBe("succeeded");
      const [status, artifact] = await Promise.all([
        client.status("session-a", job.job),
        client.artifact("session-a", job.job),
      ]);
      try {
        expect(status.state).toBe("succeeded");
        expect(await readFile(artifact.path, "utf8")).toBe(payload);
      } finally {
        artifact.release();
      }
    } finally {
      await client.close();
    }
  }),
);
