import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  createNativeBuildClient,
  deliverNativeArtifact,
} from "../src/services/native-build-client.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const payload = "opaque-artifact";
const fakeSsh = `
import {appendFileSync,mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
const args=process.argv.slice(2), cfg=args[args.indexOf("-F")+1];
const config=JSON.parse(readFileSync(cfg,"utf8"));
const command=args.at(-1).split(" ");
appendFileSync(config.trace,JSON.stringify({args,env:Object.keys(process.env)})+"\\n");
if(command[0]==="run") {
 const input=await new Response(Bun.stdin.stream()).arrayBuffer();
 if(input.byteLength!==Number(command[5]))process.exit(2);
 if(!new TextDecoder().decode(input.slice(0,20)).includes("git bundle"))process.exit(3);
 if(config.verifyBundle) {
  const directory=mkdtempSync(join(dirname(config.trace),"native-bundle-")), bundle=join(directory,"source.bundle"), checkout=join(directory,"checkout");
  writeFileSync(bundle,new Uint8Array(input));
  const git=(...args)=>{const result=spawnSync("/usr/bin/git",args,{encoding:"utf8",env:{...process.env,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"}});if(result.status!==0)throw new Error(result.stderr);return result.stdout.trim()};
  git("init","--quiet",checkout);git("-C",checkout,"bundle","unbundle",bundle);
  writeFileSync(join(checkout,".git","shallow"),command[2]+"\\n");
  git("-C",checkout,"checkout","--quiet","--detach",command[2]);
  if(git("-C",checkout,"rev-parse","HEAD")!==command[2])process.exit(4);
 }
 const payload="${payload}";
 const receipt={job:command[1],commit:command[2],action:command[4],state:"succeeded",artifactSha256:createHash("sha256").update(payload).digest("hex"),artifactBytes:payload.length,...(config.receiptOverrides??{})};
 let serialized=JSON.stringify(receipt);
 if(config.rawArtifactBytes!==undefined)serialized=serialized.replace(/"artifactBytes":[^,}]+/, '"artifactBytes":'+config.rawArtifactBytes);
 console.log(serialized);
} else if(command[0]==="artifact") process.stdout.write(config.corrupt?"corrupted":"${payload}");
else console.log(JSON.stringify({job:command[1],state:"cancellation-requested"}));
`;

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

async function setup(rootName = "private") {
  const root = path(rootName);
  await chmod(root, 0o700);
  const configFile = join(root, "ssh.json");
  const trace = join(root, "trace.jsonl");
  await writeFile(configFile, JSON.stringify({ trace }), { mode: 0o600 });
  const executable = join(root, "ssh");
  await writeFile(executable, `#!${process.execPath}\n${fakeSsh}`, {
    mode: 0o700,
  });
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "source.txt"), "fixture");
  const git = (...args: string[]) => {
    const result = spawnSync("/usr/bin/git", ["-C", workspace, ...args], {
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  git("add", "source.txt");
  git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture");
  const config = {
    sshConfigFile: configFile,
    scratchRoot: join(root, "jobs"),
    sshExecutable: executable,
  };
  return {
    config,
    trace,
    workspace,
    commit: git("rev-parse", "HEAD"),
    configFile,
    git,
  };
}

async function settled(
  client: Awaited<ReturnType<typeof createNativeBuildClient>>,
  job: string,
  sessionId = "session-a",
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = await client.status(sessionId, job);
    if (["succeeded", "failed"].includes(receipt.state)) return receipt;
    await Bun.sleep(10);
  }
  throw new Error("Native fixture job didn't settle");
}

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
