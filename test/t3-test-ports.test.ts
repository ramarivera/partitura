import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { testPaths } from "./fixtures/paths.js";
import { leaseT3TestPorts } from "./fixtures/t3-port-lease.js";
import { t3TestPorts } from "./fixtures/t3-ports.js";

const first = t3TestPorts();
const second = t3TestPorts();
const path = testPaths();
it("leases disjoint blocks for concurrent fixtures outside the outgoing connection range", () => {
  const a = first(8),
    b = second(8);
  expect(a + 8 <= b || b + 8 <= a).toBe(true);
  const ephemeral = Number(
    readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
      .trim()
      .split(/\s+/u)[0],
  );
  expect(a + 8).toBeLessThanOrEqual(ephemeral);
  expect(b + 8).toBeLessThanOrEqual(ephemeral);
});

it.live(
  "a killed owner's stale lease is reclaimed with an unwritable home",
  () =>
    Effect.promise(async () => {
      const temp = path("temporary");
      const home = path("home.file");
      await writeFile(home, "HOME is not writable storage", { mode: 0o400 });
      const module = new URL("./fixtures/t3-port-lease.ts", import.meta.url);
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `const {leaseT3TestPorts} = await import(${JSON.stringify(module.href)});
const lease = await leaseT3TestPorts();
console.log(lease.base);
await Bun.sleep(60_000);
await lease.release();`,
        ],
        {
          env: { ...process.env, TMPDIR: temp, HOME: home },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const root = join(temp, `partitura-t3-test-ports-${process.getuid?.()}`);
      let concurrent: Awaited<ReturnType<typeof leaseT3TestPorts>> | undefined;
      let recovered: Awaited<ReturnType<typeof leaseT3TestPorts>> | undefined;
      try {
        const reader = child.stdout.getReader();
        const first = await reader.read();
        reader.releaseLock();
        expect(first.done).toBe(false);
        const base = Number(new TextDecoder().decode(first.value).trim());
        expect(base).toBe(10_000);
        concurrent = await leaseT3TestPorts(root);
        expect(concurrent.base).not.toBe(base);
        child.kill("SIGKILL");
        await child.exited;
        // The dead owner's file remains, but the kernel released its lock.
        expect(
          await Bun.file(join(root, String(base), "owner.lock")).exists(),
        ).toBe(true);
        recovered = await leaseT3TestPorts(root);
        expect(recovered.base).toBe(base);
      } finally {
        child.kill("SIGKILL");
        await child.exited;
        await concurrent?.release();
        await recovered?.release();
      }
    }),
);
