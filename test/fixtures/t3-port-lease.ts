import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeOperationError } from "../../src/services/native-build-errors.js";
import { lockNativeState } from "../../src/services/native-build-file-io.js";

/** The open descriptor holds flock, so process death releases ownership even
 * when the empty lock file survives. Never unlink a shared lock inode. */
export const leaseT3TestPorts = async (
  root = join(tmpdir(), `partitura-t3-test-ports-${process.getuid?.()}`),
) => {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const ephemeralStart = Number(
    (await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8"))
      .trim()
      .split(/\s+/u)[0],
  );
  const end = Math.min(20_000, ephemeralStart);
  for (let base = 10_000; base + 16 <= end; base += 16) {
    const directory = join(root, String(base));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      return { base, release: await lockNativeState(directory) };
    } catch (error) {
      if (
        !(error instanceof NativeOperationError) ||
        error.reason !== "native-state-locked-or-unsafe"
      )
        throw error;
    }
  }
  throw new Error("No exclusively leased T3 test port block");
};
