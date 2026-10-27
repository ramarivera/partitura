import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import { leaseT3TestPorts } from "./t3-port-lease.js";

/** A range is exclusively leased across test workers and concurrent test runs.
 * It stays below Linux's ephemeral range, so outgoing test connections can't
 * consume it. There is no TCP probe followed by an unprotected bind. The real
 * launcher still skips foreign listeners; the CLI requires a fixed --port and
 * has no inherited-socket or bound-port discovery contract. */
export const t3TestPorts = () => {
  let lease: Awaited<ReturnType<typeof leaseT3TestPorts>> | undefined;
  beforeEach(async () => {
    lease = await leaseT3TestPorts();
  });
  afterEach(async () => {
    await lease?.release();
    lease = undefined;
  });
  return (count: number) => {
    if (!lease || !Number.isInteger(count) || count < 1 || count > 16)
      throw new Error("Invalid T3 test port lease");
    return lease.base;
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
