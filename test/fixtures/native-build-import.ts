import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import type { LegacyNativeImport } from "../../deploy/mac-build/native-build-import.js";
import { nativeIO } from "../../src/services/native-build-errors.js";
import {
  fixturePayload,
  privateFixtureDirectory,
  type registryFixture,
} from "./native-build-registry.js";
export const legacyFixture = Effect.fn("Test.legacyFixture")(function* (
  fixture: Effect.Success<ReturnType<typeof registryFixture>>,
  name = "legacy",
) {
  const root = yield* nativeIO(() =>
    privateFixtureDirectory(fixture.root, name),
  );
  const id = "f".repeat(32),
    sessionId = "legacy-session";
  const record = {
    job: id,
    sessionId,
    commit: "e".repeat(40),
    action: "archive",
    state: "succeeded",
    artifactBytes: Buffer.byteLength(fixturePayload),
    artifactSha256: createHash("sha256").update(fixturePayload).digest("hex"),
  };
  const recordPath = join(root, `${id}.json`),
    artifactPath = join(root, `${id}.tar`);
  yield* nativeIO(() =>
    writeFile(recordPath, JSON.stringify(record), { mode: 0o600 }),
  );
  const originalOwner = {
    sessionId,
    organizationId: "owner-org",
    pullRequest: 9,
  };
  const input: LegacyNativeImport = {
    scratchRoot: root,
    privateKeyPath: fixture.keyPath,
    pins: fixture.metadata.hostKeys,
    builderId: "primary",
    source: fixture.metadata.source,
    hostId: fixture.metadata.hostId,
    hostname: fixture.metadata.hostname,
    sshUser: fixture.metadata.sshUser,
    port: fixture.metadata.port,
    suffix: "example.test",
    acknowledgeQuiesced: true,
    originalOwners: { [id]: originalOwner },
    resolveOwner: async () => originalOwner,
  };
  return { root, id, sessionId, record, recordPath, artifactPath, input };
});
