import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";

/** A range is exclusively leased across test workers and concurrent test runs.
 * It stays below Linux's ephemeral range, so outgoing test connections can't
 * consume it. There is no TCP probe followed by an unprotected bind. The real
 * launcher still skips foreign listeners; the CLI requires a fixed --port and
 * has no inherited-socket or bound-port discovery contract. */
export const t3TestPorts = () => {
  const root = join(
    homedir(),
    "dev/agentic-scratchpads/partitura/t3-test-port-leases",
  );
  let lease: string | undefined;
  let base: number | undefined;
  beforeEach(() => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const ephemeralStart = Number(
      readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8")
        .trim()
        .split(/\s+/u)[0],
    );
    const end = Math.min(20_000, ephemeralStart);
    for (let candidate = 10_000; candidate + 16 <= end; candidate += 16) {
      const path = join(root, `${candidate}.lock`);
      try {
        closeSync(openSync(path, "wx", 0o600));
        lease = path;
        base = candidate;
        return;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      }
    }
    throw new Error("No exclusively leased T3 test port block");
  });
  afterEach(() => {
    if (lease) unlinkSync(lease);
    lease = undefined;
    base = undefined;
  });
  return (count: number) => {
    if (!base || !Number.isInteger(count) || count < 1 || count > 16)
      throw new Error("Invalid T3 test port lease");
    return base;
  };
};

/** Hold every old PID-derived port throughout a real launch, not just during
 * an assertion about which formula the test used. */
export const occupyOldT3Range = (base: number, count: number) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const listeners: Bun.Server<undefined>[] = [];
      try {
        for (let offset = 0; offset < count; offset++) {
          try {
            listeners.push(
              Bun.serve({
                hostname: "127.0.0.1",
                port: base + offset,
                fetch: () => new Response("occupied"),
              }),
            );
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "EADDRINUSE"
              )
            )
              throw error;
          }
        }
        return listeners;
      } catch (error) {
        for (const listener of listeners) listener.stop(true);
        throw error;
      }
    }),
    (listeners) =>
      Effect.sync(() => {
        for (const listener of listeners) listener.stop(true);
      }),
  );
