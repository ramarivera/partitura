import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { createNativeBuildClient } from "../src/services/native-build-client.js";
import { testPaths } from "./fixtures/paths.js";

export const path = testPaths();
export const payload = "opaque-artifact";
const fakeSsh = `
import {appendFileSync,existsSync,mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
const args=process.argv.slice(2), cfg=args[args.indexOf("-F")+1];
const config=JSON.parse(readFileSync(cfg,"utf8"));
const command=args.at(-1).split(" ");
appendFileSync(config.trace,JSON.stringify({args,env:Object.keys(process.env)})+"\\n");
if(command[0]==="run") {
 if(config.earlyRefusal) {
  console.log(config.invalidOutput?"invalid-json":JSON.stringify({job:command[1],commit:command[2],action:command[4],state:"failed",stage:"disk-preflight",failureCode:"host-disk-space-unavailable",...config.receiptOverrides}));
  process.exit(config.exitCode??1);
 }
 const received=await new Response(Bun.stdin.stream()).arrayBuffer();
 const secretLength=Number(command[6]??0);
 if(received.byteLength!==Number(command[5])+secretLength)process.exit(2);
 if(secretLength && JSON.parse(new TextDecoder().decode(received.slice(0,secretLength)))["repository-age-identity"]!==config.expectedSecret)process.exit(5);
 const input=received.slice(secretLength);
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
 const artifact={artifactSha256:createHash("sha256").update(payload).digest("hex"),artifactBytes:payload.length};
 const failed=config.receiptOverrides?.state==="failed";
 const receipt={job:command[1],commit:command[2],action:command[4],state:"succeeded",...(failed&&!config.failedArtifact?{}:artifact),...(config.receiptOverrides??{})};
 if(config.crashRun) process.exit(255);
 let serialized=JSON.stringify(receipt);
 if(config.rawArtifactBytes!==undefined)serialized=serialized.replace(/"artifactBytes":[^,}]+/, '"artifactBytes":'+config.rawArtifactBytes);
 console.log(serialized);
 process.exit(config.exitCode??0);
} else if(command[0]==="status" && config.statusReceipt) {
 if(config.statusBarrier) {
  writeFileSync(config.statusBarrier+".entered", "ready");
  while(!existsSync(config.statusBarrier)) await Bun.sleep(5);
 }
 console.log(JSON.stringify({job:command[1],...config.statusReceipt}));
}
else if(command[0]==="artifact") process.stdout.write(config.corrupt?"corrupted":"${payload}");
else console.log(JSON.stringify({job:command[1],state:"cancellation-requested"}));
`;

export async function setup(rootName = "private") {
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

export async function settled(
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
