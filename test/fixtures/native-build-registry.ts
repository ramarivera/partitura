import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { opaqueId } from "../../src/services/native-build-files.js";
import {
  type NativeGeneration,
  type NativeRegistryJob,
  type NativeStateOptions,
  newRecovery,
  openNativeBuildState,
} from "../../src/services/native-build-state.js";
import { createNativeBuildTransport } from "../../src/services/native-build-transport.js";
import { testAwait } from "./native-build-effects.js";

export const fixtureHost = "11111111-1111-4111-8111-111111111111";
export const fixturePayload = "opaque archive bytes";
export async function fixturePrivateKey(path: string) {
  const result = spawnSync("/usr/bin/ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    path,
  ]);
  if (result.status !== 0) throw new Error("fixture-key-generation-failed");
  return readFile(path, "utf8");
}
const fakeSsh = `
import {readFileSync,writeFileSync,appendFileSync,existsSync} from "node:fs";
import {join,dirname} from "node:path";
import {createHash} from "node:crypto";
const root=dirname(process.argv[1]);
const plan=JSON.parse(readFileSync(join(root,"plan.json"),"utf8"));
const args=process.argv.slice(2),command=args.at(-1), parts=command.split(" ");
if(args.length!==4 || args[0]!=="-F" || args[2]!=="partitura-native" || !args[1].endsWith("/config") || typeof command!=="string") throw new Error("invalid-fixture-ssh-argv");
const config=readFileSync(args[1],"utf8");
appendFileSync(join(root,"trace.jsonl"),JSON.stringify({command,args,env:process.env,hostname:config.match(/HostName (.+)/)[1]})+"\\n");
const epochFile=join(root,"epoch");
const hostId=plan.hostId;
let epoch=plan.epoch??(existsSync(epochFile)?readFileSync(epochFile,"utf8"):"a".repeat(32));
const emit=(kind,fields={})=>console.log(JSON.stringify({protocolVersion:2,hostId,kind,...fields}));
if(plan.unavailable) process.exit(255);
if(parts[0]==="health") {emit("health",{brokerRevision:"b".repeat(64),capabilities:["health","status","reconcile","run-v2"],profile:"registry-only",epoch,status:plan.healthBusy?"busy":"ready",accepting:!plan.healthBusy,capacity:plan.healthBusy?0:1,reasons:plan.healthBusy?["runner-active"]:[],jobRootFreeBytes:1e12,tartRootFreeBytes:1e12,hostFloorBytes:53687091200});}
else if(parts[0]==="run-v2") {
 const identity={job:parts[1],commit:parts[2],action:parts[4],attempt:parts[8]};
 if(plan.busyRefusal || plan.refusal) {emit("refused",{...identity,accepted:false,code:plan.refusal??"host-busy"});process.exit(1);}
 const input=Buffer.from(await new Response(Bun.stdin.stream()).arrayBuffer());
 if(input.length!==Number(parts[5])+Number(parts[6])) throw new Error("fixture-input-length");
 if(plan.expectedSecret!==undefined && input.subarray(0,Number(parts[6])).toString()!==plan.expectedSecret) throw new Error("fixture-secret-order");
 if(plan.expectedBundle!==undefined && input.subarray(Number(parts[6])).toString()!==plan.expectedBundle) throw new Error("fixture-bundle-order");
 const receipt={...identity,state:"succeeded",artifactBytes:Buffer.byteLength("${fixturePayload}"),artifactSha256:createHash("sha256").update("${fixturePayload}").digest("hex")};
 writeFileSync(join(root,parts[1]+".json"),JSON.stringify(receipt));
 if(plan.lostRun) process.exit(255);
 emit("known",receipt);
} else if(parts[0]==="cancel") emit("cancellation-requested",{job:parts[1]});
else if(parts[0]==="reconcile") {
 if(plan.busy) emit("busy",{job:parts[1],runner:{job:parts[1],attempt:"c".repeat(32),stage:"receiving",heartbeat:plan.heartbeat??Date.now()/1000}});
 else if(plan.cleanup) {emit(plan.cleanup,{job:parts[1]});process.exit(1);}
 else {epoch=epoch==="b".repeat(32)?"c".repeat(32):"b".repeat(32);writeFileSync(epochFile,epoch);emit(plan.unknown?"reconciled-unknown":"reconciled-terminal",{job:parts[1],epoch,nonce:"d".repeat(32),reconciledJobs:[parts[1]]});}
} else if(parts[0]==="status") {
 try {emit("known",JSON.parse(readFileSync(join(root,parts[1]+".json"),"utf8")));}
 catch {emit("unknown-job",{job:parts[1],tombstonePresent:true,inconsistentDirectory:false});}
} else if(parts[0]==="artifact") process.stdout.write(plan.corrupt?"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx":"${fixturePayload}");
`;

export const registryFixture = Effect.fn("Test.registryFixture")(function* (
  root: string,
  quotas: Partial<NativeStateOptions> = {},
) {
  yield* testAwait(chmod(root, 0o700));
  const keyPath = join(root, "dummy-key");
  const result = spawnSync("/usr/bin/ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    keyPath,
  ]);
  if (result.status !== 0) throw new Error("fixture-key-generation-failed");
  const key = yield* testAwait(readFile(keyPath, "utf8"));
  const publicKey = (yield* testAwait(
    readFile(`${keyPath}.pub`, "utf8"),
  )).split(" ");
  const type = publicKey[0],
    base64 = publicKey[1];
  if (!type || !base64) throw new Error("invalid-fixture-key");
  const metadata = {
    source: "file:primary.json",
    hostId: fixtureHost,
    hostname: "builder.example.test",
    sshUser: "builder",
    port: 2222,
    hostKeys: [{ type, base64 }],
  };
  const options: NativeStateOptions = {
    stateRoot: join(root, "state"),
    scratchRoot: join(root, "scratch"),
    cacheRoot: join(root, "cache"),
    bytesPerBuilder: 4 * 1024 ** 3,
    bytesTotal: 8 * 1024 ** 3,
    filesystem: async () => ({ type: 0x01021994, bavail: 1e9, bsize: 4096 }),
    ...quotas,
  };
  const state = yield* testAwait(openNativeBuildState(options));
  const generation = yield* testAwait(
    state.addGeneration("primary", metadata, key),
  );
  const executable = join(root, "ssh");
  yield* testAwait(
    writeFile(executable, `#!${process.execPath}\n${fakeSsh}`, {
      mode: 0o700,
    }),
  );
  const planPath = join(root, "plan.json");
  const plan = async (value: Record<string, unknown>) =>
    writeFile(planPath, JSON.stringify({ hostId: fixtureHost, ...value }), {
      mode: 0o600,
    });
  yield* testAwait(plan({}));
  const transport = yield* testAwait(
    createNativeBuildTransport(state, {
      suffix: "example.test",
      executable,
    }),
  );
  yield* testAwait(transport.materialize(generation, key));
  return {
    root,
    state,
    generation,
    key,
    keyPath,
    metadata,
    options,
    transport,
    executable,
    plan,
    trace: async () =>
      (await readFile(join(root, "trace.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              command: string;
              args: string[];
              env: Record<string, string>;
              hostname: string;
            },
        ),
  };
});

export function registryJob(
  generation: NativeGeneration,
  overrides: Partial<NativeRegistryJob> = {},
): NativeRegistryJob {
  return {
    version: 1,
    jobId: opaqueId(),
    organizationId: "org-a",
    sessionId: "session-a",
    builderId: generation.builderId,
    generationId: generation.id,
    verifiedHostId: generation.transport.hostId,
    commit: "e".repeat(40),
    pullRequest: 7,
    action: "archive",
    attempt: opaqueId(),
    epoch: "a".repeat(32),
    submissionExpiresAt: 0,
    state: "starting",
    recovery: newRecovery(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

export async function privateFixtureDirectory(root: string, name: string) {
  const path = join(root, name);
  await mkdir(path, { mode: 0o700 });
  return path;
}
