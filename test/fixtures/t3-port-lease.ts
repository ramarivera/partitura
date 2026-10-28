import { readFile } from "node:fs/promises";
import { createServer } from "node:net";

/** A held Linux abstract socket owns the port block across TMPDIRs and
 * worktrees. Kernel ownership disappears on process death, with no lease file
 * or probe-then-bind window between cooperating launcher tests. */
export const leaseT3TestPorts = async () => {
  const ephemeralStart = Number(
    (await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8"))
      .trim()
      .split(/\s+/u)[0],
  );
  const end = Math.min(20_000, ephemeralStart);
  for (let base = 10_000; base + 16 <= end; base += 16) {
    const server = createServer();
    const acquired = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      });
      server.listen(
        `\0partitura-t3-test-ports-${process.getuid?.()}-${base}`,
        () => resolve(true),
      );
    });
    if (!acquired) continue;
    server.unref();
    return {
      base,
      release: () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    };
  }
  throw new Error("No exclusively leased T3 test port block");
};
