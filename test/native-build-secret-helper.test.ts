import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { registryIO } from "../src/services/builder-registry-files.js";
import {
  NativeBuildSecretHelper,
  NativeSecretHelperConfig,
  NativeSecretPipe,
} from "../src/services/native-build-secret-helper.js";
import {
  NativeSecretError,
  SecretFrames,
  secretFrame,
} from "../src/services/native-build-secret-protocol.js";
import { secretFixture } from "./fixtures/native-build-secret.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const node = execFileSync("node", ["-p", "process.execPath"], {
  encoding: "utf8",
}).trim();
const fakeHelper = (root: string, record: unknown, hang: boolean) => `
const fs=require("node:fs"), path=require("node:path");
const root=${JSON.stringify(root)}, record=${JSON.stringify(record)};
const countFile=path.join(root,"count"), count=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,"utf8"))+1:1;
fs.writeFileSync(countFile,String(count));
fs.writeFileSync(path.join(root,"process-"+count+".json"),JSON.stringify({pid:process.pid,argv:process.argv,env:process.env}));
let bytes=Buffer.alloc(0);
const emit=value=>{const p=Buffer.from(JSON.stringify(value)),h=Buffer.alloc(4);h.writeUInt32BE(p.length);process.stdout.write(Buffer.concat([h,p]));};
process.stdin.on("data",chunk=>{
 bytes=Buffer.concat([bytes,chunk]);
 while(bytes.length>=4 && bytes.length>=bytes.readUInt32BE()+4){
  const length=bytes.readUInt32BE(), request=JSON.parse(bytes.subarray(4,length+4));bytes=bytes.subarray(length+4);
  if(request.kind==="init"){fs.writeFileSync(path.join(root,"initialized"),"yes");process.stderr.write(request.auth.token??"no-token");emit({id:request.id,kind:"ready"});}
  else if(${hang} && count===1){while(true){}}
  else {fs.writeFileSync(path.join(root,"read-started"),"yes");emit({id:request.id,kind:"record",record});}
 }
});
`;
const fixture = Effect.fn("SecretHelperTest.fixture")(function* (
  name: string,
  hang = false,
) {
  const f = yield* secretFixture(path(name));
  const entrypoint = `${f.root}/helper.cjs`;
  yield* registryIO(() =>
    writeFile(entrypoint, fakeHelper(f.root, f.record, hang), { mode: 0o600 }),
  );
  const settings = {
    node,
    entrypoint,
    cwd: f.root,
    tokenFile: f.settings.tokenFile,
    vaultId: f.settings.vaultId,
    suffix: "example.test",
    qualified: true,
    // Leave process startup headroom under the full suite; the hung call remains bounded.
    deadlineMs: 1000,
    reapMs: 50,
  };
  const pipe = yield* NativeSecretPipe.make.pipe(
    Effect.provideService(NativeSecretHelperConfig, settings),
  );
  const helper = yield* NativeBuildSecretHelper.make.pipe(
    Effect.provideService(NativeSecretHelperConfig, settings),
    Effect.provideService(NativeSecretPipe, pipe),
  );
  return { ...f, settings, pipe, helper };
});

it.live(
  "parent deadline kills and reaps a CPU-hung helper before the next read",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture("hung", true);
        const costs: number[] = [];
        const reserve = (units: number) =>
          Effect.sync(() => {
            costs.push(units);
          });
        expect(
          (yield* f.helper.read("b".repeat(26), reserve).pipe(Effect.flip))
            .code,
        ).toBe("provider-timeout");
        const first = JSON.parse(
          yield* registryIO(() => readFile(`${f.root}/process-1.json`, "utf8")),
        ) as { pid: number };
        expect(() => process.kill(first.pid, 0)).toThrow();
        expect(yield* f.helper.read("b".repeat(26), reserve)).toEqual(f.record);
        expect(costs).toEqual([12, 12]);
      }),
    ),
);

it.live(
  "helper reuses its client, rereads token only on a permitted call, and does not leak it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture("private");
        const costs: number[] = [];
        const reserve = (units: number) =>
          Effect.sync(() => {
            costs.push(units);
          });
        yield* f.helper.read("b".repeat(26), reserve);
        yield* f.helper.read("b".repeat(26), reserve);
        const metadata = yield* registryIO(() =>
          readFile(`${f.root}/process-1.json`, "utf8"),
        );
        expect(metadata).not.toContain("DUMMY-TOKEN-SENTINEL");
        expect(metadata).not.toContain(f.native.key);
        expect(JSON.parse(metadata).env).toEqual({
          PATH: "/usr/bin:/bin",
          HOME: f.root,
          LANG: "C",
          LC_ALL: "C",
        });
        expect(costs).toEqual([12, 4]);
        yield* registryIO(async () => {
          await chmod(f.settings.tokenFile ?? "", 0o600);
          await writeFile(f.settings.tokenFile ?? "", "ROTATED-DUMMY-TOKEN");
          await chmod(f.settings.tokenFile ?? "", 0o400);
        });
        expect(
          yield* registryIO(() => readFile(`${f.root}/count`, "utf8")),
        ).toBe("1");
        yield* f.helper.read("b".repeat(26), reserve);
        expect(costs).toEqual([12, 4, 12]);
        expect(
          yield* registryIO(() => readFile(`${f.root}/count`, "utf8")),
        ).toBe("2");
        const state = JSON.stringify(f.journal.snapshot());
        expect(state).not.toContain("DUMMY");
        expect(state).not.toContain(f.native.key);
      }),
    ),
);

it.live(
  "unqualified live path refuses before launch, token access or budget debit",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* secretFixture(path("disabled"));
        const settings = {
          node: "/missing/node",
          entrypoint: "/missing/helper",
          cwd: "/missing",
          vaultId: "a".repeat(26),
          suffix: "example.test",
          qualified: false,
        };
        const pipe = yield* NativeSecretPipe.make.pipe(
          Effect.provideService(NativeSecretHelperConfig, settings),
        );
        const helper = yield* NativeBuildSecretHelper.make.pipe(
          Effect.provideService(NativeSecretHelperConfig, settings),
          Effect.provideService(NativeSecretPipe, pipe),
        );
        expect(
          (yield* helper
            .read("b".repeat(26), () => Effect.die("uncharged launch"))
            .pipe(Effect.flip)).code,
        ).toBe("provider-live-disabled");
        expect(pipe.alive()).toBe(false);
        expect(f.journal.snapshot().charges).toEqual([]);
      }),
    ),
);

it.effect(
  "length framing supports fragmentation and refuses oversized frames before allocation",
  () =>
    Effect.gen(function* () {
      const frame = secretFrame({ id: "a".repeat(32), kind: "ready" });
      const parser = new SecretFrames();
      expect(parser.push(frame.subarray(0, 3))).toEqual([]);
      expect(parser.push(frame.subarray(3))).toEqual([
        { id: "a".repeat(32), kind: "ready" },
      ]);
      const huge = Buffer.alloc(4);
      huge.writeUInt32BE(200000);
      expect(() => new SecretFrames().push(huge)).toThrow(NativeSecretError);
    }),
);

it.live(
  "Node loads the external JS/WASM without credentials or initialization",
  () =>
    Effect.gen(function* () {
      const result = yield* registryIO(
        () =>
          new Promise<string>((resolve, reject) => {
            try {
              const output = execFileSync(
                node,
                [
                  "-e",
                  'const fs=require("node:fs"),p=require("node:path");const sdk=require("@1password/sdk");const core=require.resolve("@1password/sdk-core");if(typeof sdk.createClient!=="function"||!fs.statSync(p.join(p.dirname(core),"core_bg.wasm")).isFile())throw Error("package");process.stdout.write("js-wasm-ok")',
                ],
                {
                  cwd: process.cwd(),
                  env: { PATH: "/usr/bin:/bin" },
                  encoding: "utf8",
                },
              );
              resolve(output);
            } catch {
              reject(new Error("offline-import-failed"));
            }
          }),
      );
      expect(result).toBe("js-wasm-ok");
    }),
);

it.live(
  "read-start publication happens after initialization and before the item get",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture("read-boundary");
        let marked = false;
        yield* f.helper.read(
          "b".repeat(26),
          () => Effect.void,
          () =>
            registryIO(async () => {
              expect(await readFile(`${f.root}/initialized`, "utf8")).toBe(
                "yes",
              );
              await expect(
                readFile(`${f.root}/read-started`),
              ).rejects.toThrow();
              marked = true;
            }),
        );
        expect(marked).toBe(true);
        expect(
          yield* registryIO(() => readFile(`${f.root}/read-started`, "utf8")),
        ).toBe("yes");
      }),
    ),
);
