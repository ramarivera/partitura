import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { NativeOperationError } from "./native-build-errors.js";
import { nativeLimits } from "./native-build-models.js";
export async function hashNativeArtifact(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > nativeLimits.artifact
    )
      throw NativeOperationError.new("unsafe-native-artifact");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hash.update(chunk);
    return { sha256: hash.digest("hex"), bytes: info.size };
  } finally {
    await file.close();
  }
}
