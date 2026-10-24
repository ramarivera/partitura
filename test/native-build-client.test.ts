import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
import {appendFileSync,readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const args=process.argv.slice(2), cfg=args[args.indexOf("-F")+1];
const config=JSON.parse(readFileSync(cfg,"utf8"));
const command=args.at(-1).split(" ");
appendFileSync(config.trace,JSON.stringify({args,env:Object.keys(process.env)})+"\\n");
if(command[0]==="run") {
 const input=await new Response(Bun.stdin.stream()).arrayBuffer();
 if(input.byteLength!==Number(command[5]))process.exit(2);
 if(!new TextDecoder().decode(input.slice(0,20)).includes("git bundle"))process.exit(3);
 const payload="${payload}";
 const receipt={job:command[1],commit:command[2],action:command[4],state:"succeeded",artifactSha256:createHash("sha256").update(payload).digest("hex"),artifactBytes:payload.length,...(config.receiptOverrides??{})};
 let serialized=JSON.stringify(receipt);
 if(config.rawArtifactBytes!==undefined)serialized=serialized.replace(/"artifactBytes":[^,}]+/, '"artifactBytes":'+config.rawArtifactBytes);
 console.log(serialized);
} else if(command[0]==="artifact") process.stdout.write(config.corrupt?"corrupted":"${payload}");
else console.log(JSON.stringify({job:command[1],state:"cancellation-requested"}));
`;

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
  };
}

async function settled(
  client: Awaited<ReturnType<typeof createNativeBuildClient>>,
  job: string,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const receipt = await client.status("session-a", job);
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
        expect(await readFile(artifact.path, "utf8")).toBe(payload);
        expect(await client.artifact("session-a", job.job)).toEqual(artifact);
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
