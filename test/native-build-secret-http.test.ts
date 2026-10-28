import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { testPaths } from "./fixtures/paths.js";

const paths = testPaths();

import { NativeSecretHttp } from "../src/services/native-build-secret-http.js";

for (const fault of [
  "reset",
  "timeout",
  "429",
  "429-retry",
  "500",
  "502",
  "503",
  "json",
  "401",
  "403",
])
  it.live(
    `HTTP cap fences swallowed ${fault} failures at init 8 and read 4`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const original = globalThis.fetch;
          let calls = 0;
          globalThis.fetch = Object.assign(
            async () => {
              calls++;
              if (fault === "reset")
                throw Object.assign(new Error("dummy reset"), {
                  code: "ECONNRESET",
                });
              if (fault === "timeout")
                throw new DOMException("dummy timeout", "TimeoutError");
              return new Response(fault === "json" ? "{" : "{}", {
                status:
                  fault === "json"
                    ? 200
                    : fault === "429-retry"
                      ? 429
                      : Number(fault),
                headers: fault === "429-retry" ? { "Retry-After": "600" } : {},
              });
            },
            { preconnect: () => {} },
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              globalThis.fetch = original;
            }),
          );
          const http = yield* NativeSecretHttp.make;
          for (const limit of [8, 4]) {
            const before = calls;
            const result = yield* http
              .run(limit, async () => {
                // Deliberately worse than the SDK: swallow every error and retry, even
                // after the operation has been refused. No ninth/fifth transport call.
                for (let attempt = 0; attempt < 50; attempt++) {
                  try {
                    await (await fetch("https://offline.invalid")).json();
                  } catch {
                    /* hostile retry simulation */
                  }
                }
              })
              .pipe(Effect.result);
            expect(result._tag).toBe("Failure");
            expect(calls - before).toBe(limit);
          }
        }),
      ),
  );

it.live(
  "hang deadline aborts transport and prevents late retries from charging the next operation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const original = globalThis.fetch;
        let calls = 0;
        let signal: AbortSignal | null | undefined;
        let finish!: (response: Response) => void;
        globalThis.fetch = Object.assign(
          async (
            _input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1],
          ) => {
            calls++;
            signal = init?.signal;
            return new Promise<Response>((resolve) => {
              finish = resolve;
            });
          },
          { preconnect: () => {} },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            globalThis.fetch = original;
          }),
        );
        const http = yield* NativeSecretHttp.make;
        let late!: Promise<unknown>;
        const result = yield* http
          .run(
            4,
            async () => {
              await fetch("https://offline.invalid");
              late = fetch("https://offline.invalid").catch(() => "refused");
              await late;
            },
            25,
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.code).toBe("provider-timeout");
        expect(signal?.aborted).toBe(true);
        yield* http.run(4, async () => {
          finish(new Response("{}"));
          await new Promise<void>((resolve) => setImmediate(resolve));
          await late;
        });
        expect(calls).toBe(1);
      }),
    ),
);

it.live(
  "only active operations can fetch, with redirects disabled and caller abort preserved",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const original = globalThis.fetch;
        const initSeen: RequestInit[] = [];
        globalThis.fetch = Object.assign(
          async (
            _input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1],
          ) => {
            initSeen.push(init ?? {});
            return new Response("{}");
          },
          { preconnect: () => {} },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            globalThis.fetch = original;
          }),
        );
        const http = yield* NativeSecretHttp.make;
        yield* Effect.promise(() =>
          expect(fetch("https://offline.invalid")).rejects.toMatchObject({
            code: "provider-unavailable",
          }),
        );
        const caller = new AbortController();
        yield* http.run(4, async () => {
          await fetch(
            new Request("https://offline.invalid", { signal: caller.signal }),
          );
          caller.abort();
          expect(initSeen[0]?.signal?.aborted).toBe(true);
          expect(initSeen[0]?.redirect).toBe("error");
        });
        expect(initSeen.length).toBe(1);
      }),
    ),
);

it.live(
  "built helper enforces cold 12 and warm 4 even when a vendor swallows fetch refusals",
  () =>
    Effect.promise(async () => {
      const { spawnSync } = await import("node:child_process");
      const { mkdir, writeFile, readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const { secretFrame, SecretFrames } = await import(
        "../src/services/native-build-secret-protocol.js"
      );
      const root = paths("bounded-helper");
      const entry = join(root, "helper.js");
      const preload = join(root, "preload.cjs");
      const ledger = join(root, "calls");
      const sdk = join(root, "node_modules/@1password/sdk");
      await mkdir(sdk, { recursive: true });
      await writeFile(
        join(sdk, "package.json"),
        JSON.stringify({ type: "module", exports: "./index.js" }),
      );
      await writeFile(
        join(sdk, "index.js"),
        `
export class RateLimitExceededError extends Error {}
export class AuthExpiredError extends Error {}
export class DesktopSessionExpiredError extends Error {}
export async function createClient() {
 for(let i=0;i<Number(process.env.INIT_CALLS);i++) await fetch('https://offline.invalid');
 return { items: { get: async () => {
  for(let i=0;i<50;i++) { try { await fetch('https://offline.invalid'); } catch { /* adversarial vendor retries */ } }
  throw new Error('dummy vendor exhausted');
 } } };
}
`,
      );
      await writeFile(
        preload,
        `const fs=require('node:fs');globalThis.fetch=async()=>{fs.appendFileSync(${JSON.stringify(ledger)},'x');return new Response('{}')};`,
      );
      const built = await Bun.build({
        entrypoints: ["src/native-build-secret-helper.ts"],
        target: "node",
        external: ["@1password/sdk"],
        outdir: root,
        naming: "helper.js",
      });
      expect(built.success).toBe(true);
      const init = secretFrame({
        id: "a".repeat(32),
        kind: "init",
        access: "runtime",
        auth: { type: "token", token: "dummy-offline-only" },
        vaultId: "a".repeat(26),
        suffix: "invalid",
      });
      const read = secretFrame({
        id: "b".repeat(32),
        kind: "read",
        itemId: "b".repeat(26),
      });
      for (const initial of [8, 0]) {
        await writeFile(ledger, "");
        const run = spawnSync(process.execPath, ["--require", preload, entry], {
          input: Buffer.concat([init, read]),
          cwd: root,
          env: { PATH: "/usr/bin:/bin", INIT_CALLS: String(initial) },
          timeout: 2000,
        });
        expect(run.status).toBe(0);
        expect(run.stderr.toString()).toBe("");
        expect(new SecretFrames().push(run.stdout)).toEqual([
          { id: "a".repeat(32), kind: "ready" },
          { id: "b".repeat(32), kind: "error", code: "provider-unavailable" },
        ]);
        expect((await readFile(ledger, "utf8")).length).toBe(initial + 4);
      }
    }),
);
