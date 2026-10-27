import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Deferred, Effect } from "effect";
import { registryIO } from "../../src/services/builder-registry-files.js";
import { BuilderRegistryError } from "../../src/services/builder-registry-json.js";
import type {
  BuilderEntry,
  BuilderRegistrySnapshot,
} from "../../src/services/builder-registry-schema.js";
import type { BuilderCredential } from "../../src/services/builder-secret-provider.js";
import type { BuilderRegistrySettings } from "../../src/services/config-native-build.js";

export const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
export const entry = (
  id = "primary",
  enabled = true,
  secretRevision = 1,
): BuilderEntry => ({
  id,
  enabled,
  secretRevision,
  secretSource: { type: "file", name: `${id}.json` },
  minimumFreeBytes: 53_687_091_200,
});
export const document = (
  builders: readonly BuilderEntry[] = [entry()],
): BuilderRegistrySnapshot => ({
  version: 1,
  defaultBuilder: builders[0]?.id ?? null,
  selection: { fallback: "none", fallbackBuilders: [] },
  builders,
});
export const host = (number: number) =>
  `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`;

export const fakeBuilderAdapters = () => {
  const reads: string[] = [],
    checks: string[] = [];
  const blocks = new Map<string, Deferred.Deferred<void>>();
  const healthFailures = new Set<string>();
  const healthBlocks = new Map<string, Deferred.Deferred<void>>();
  const hosts = new Map<string, string>();
  const reserved = new Set<string>();
  const failures = new Set<string>();
  const generations = new Map<string, string>();
  let sequence = 0;
  const provider = {
    resolve: Effect.fn("FakeBuilder.resolve")(function* (item: BuilderEntry) {
      const key = `${item.id}:${item.secretRevision}`;
      reads.push(key);
      const block = blocks.get(key);
      if (block) yield* Deferred.await(block);
      if (failures.has(key))
        return yield* Effect.fail(
          BuilderRegistryError.new("builder-provider-unavailable"),
        );
      return {
        privateKey: "dummy memory-only key",
        transport: {
          source: `file:${item.id}.json`,
          hostId: hosts.get(key) ?? host(item.id === "primary" ? 1 : 2),
          hostname: `${item.id}.example.test`,
          port: 22,
          sshUser: "builder",
          hostKeys: [],
        },
      } satisfies BuilderCredential;
    }),
  };
  const identity = {
    retain: () => Effect.void,
    reserved: (id: string) => reserved.has(id),
    verify: Effect.fn("FakeBuilder.verify")(function* (
      item: BuilderEntry,
      credential: BuilderCredential,
    ) {
      checks.push(`${item.id}:${item.secretRevision}`);
      const block = healthBlocks.get(item.id);
      if (block) yield* Deferred.await(block);
      if (healthFailures.has(item.id))
        return yield* Effect.fail(
          BuilderRegistryError.new("builder-health-unavailable"),
        );
      const binding = `${item.id}:${item.secretRevision}:${credential.transport.hostId}`;
      const generationId =
        generations.get(binding) ?? String(++sequence).padStart(32, "0");
      generations.set(binding, generationId);
      return {
        generation: {
          id: generationId,
          builderId: item.id,
          transport: credential.transport,
          equalityTag: "a".repeat(64),
          createdAt: 0,
        },
        health: {
          protocolVersion: 2 as const,
          kind: "health",
          hostId: credential.transport.hostId,
          profile: "registry-only",
          epoch: "b".repeat(32),
          status: "ready" as const,
          accepting: true,
          capacity: 1,
          reasons: [],
          jobRootFreeBytes: 1024 ** 4,
          tartRootFreeBytes: 1024 ** 4,
          hostFloorBytes: 53_687_091_200,
        },
      };
    }),
  };
  return {
    provider,
    identity,
    reads,
    checks,
    blocks,
    healthBlocks,
    healthFailures,
    hosts,
    reserved,
    failures,
  };
};

export const builderFilesFixture = Effect.fn("BuilderFixture.files")(function* (
  root: string,
) {
  yield* registryIO(async () => {
    await chmod(root, 0o700);
    for (const name of [
      "state",
      "scratch",
      "cache",
      "secrets",
      "registry",
      "workers",
      "legacy",
      "backup",
    ])
      await mkdir(join(root, name), { mode: 0o700 });
  });
  const settings: BuilderRegistrySettings = {
    registryFile: join(root, "registry", "registry.json"),
    stateRoot: join(root, "state"),
    scratchRoot: join(root, "scratch"),
    cacheRoot: join(root, "cache"),
    fileSecretRoot: join(root, "secrets"),
    suffix: "example.test",
    perBuilderBytes: 8 * 1024 ** 3,
    totalBytes: 16 * 1024 ** 3,
    dailyBudget: 400,
    hourlyBudget: 200,
    otherRoots: [
      join(root, "workers"),
      join(root, "legacy"),
      join(root, "backup"),
    ],
  };
  const write = Effect.fn("BuilderFixture.write")((value: unknown) =>
    registryIO(() =>
      writeFile(settings.registryFile ?? "", bytes(value), { mode: 0o600 }),
    ),
  );
  return { settings, write, root };
});
