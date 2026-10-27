/** Ask the kernel for an unused range instead of deriving ports from a PID.
 * Probe every port because the launcher reserves a contiguous pool. The child
 * binds the selected port after these short-lived probes close. */
export const unusedT3PortRange = (count: number): number => {
  if (!Number.isInteger(count) || count < 1 || count > 64)
    throw new Error("Invalid test port count");
  for (let attempt = 0; attempt < 32; attempt++) {
    const probes: Bun.Server<undefined>[] = [];
    try {
      const first = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("test port reservation"),
      });
      probes.push(first);
      const base = first.port;
      if (base === undefined || base < 1024 || base + count > 65536) continue;
      for (let offset = 1; offset < count; offset++)
        probes.push(
          Bun.serve({
            hostname: "127.0.0.1",
            port: base + offset,
            fetch: () => new Response("test port reservation"),
          }),
        );
      return base;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          error.code === "EADDRINUSE"
        )
      )
        throw error;
    } finally {
      for (const probe of probes) probe.stop(true);
    }
  }
  throw new Error("No unused T3 test port range");
};
