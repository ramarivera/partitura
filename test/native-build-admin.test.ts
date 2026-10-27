import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  projectLegacyDiskRecord,
  rollbackLegacyDiskRecords,
} from "../deploy/mac-build/native-build-admin.js";
import { LegacyJobSchema } from "./fixtures/native-build-legacy.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const record = {
  job: "a".repeat(32),
  sessionId: "original-session",
  commit: "b".repeat(40),
  action: "archive",
  state: "failed",
  failureCode: "host-disk-space-unavailable",
  stage: "disk-preflight",
};

for (const stage of ["disk-preflight", "disk-post-transfer"]) {
  it(`projects ${stage} into the frozen baseline decoder without changing ownership or terminal state`, () => {
    const input = { ...record, stage };
    expect(() => Schema.decodeUnknownSync(LegacyJobSchema)(input)).toThrow();
    const output = projectLegacyDiskRecord(input);
    expect(Schema.decodeUnknownSync(LegacyJobSchema)(output)).toEqual({
      ...input,
      failureCode: "host-capacity-unavailable",
      stage: "capacity",
    });
    expect(input.stage).toBe(stage);
  });
}

it("rejects unfinished, corrupt and inconsistent disk projections", () => {
  for (const invalid of [
    null,
    {},
    { ...record, state: "running" },
    { ...record, state: "starting" },
    { ...record, state: "succeeded" },
    { ...record, state: "interrupted" },
    { ...record, stage: "capacity" },
    { ...record, failureCode: "unlock-failed" },
    { ...record, bootExitCode: 1 },
    { ...record, workflowExitCode: 1 },
    { ...record, artifactBytes: 1, artifactSha256: "f".repeat(64) },
    { ...record, futureUnknownOwner: "must-not-discard" },
  ])
    expect(() => projectLegacyDiskRecord(invalid)).toThrow();
  for (const state of ["failed", "succeeded", "interrupted"]) {
    const legacy = {
      job: record.job,
      sessionId: record.sessionId,
      commit: record.commit,
      action: record.action,
      state,
    };
    expect(projectLegacyDiskRecord(legacy)).toEqual(legacy);
  }
});

async function roots() {
  const root = path("rollback");
  await chmod(root, 0o700);
  const legacyRoot = join(root, "legacy"),
    backupRoot = join(root, "backups");
  await mkdir(legacyRoot, { mode: 0o700 });
  await mkdir(backupRoot, { mode: 0o700 });
  return { legacyRoot, backupRoot, gatewayStopped: true };
}

it.live(
  "backs up exact bytes, projects disk records and quarantines corrupt input outside legacy state",
  () =>
    Effect.promise(async () => {
      const options = await roots();
      const name = `${record.job}.json`,
        corrupt = `${"c".repeat(32)}.json`;
      const original = `  ${JSON.stringify(record)}\n`;
      await writeFile(join(options.legacyRoot, name), original, {
        mode: 0o600,
      });
      await writeFile(join(options.legacyRoot, corrupt), "{broken", {
        mode: 0o600,
      });
      const result = await rollbackLegacyDiskRecords(options);
      expect(result.projected).toEqual([record.job]);
      expect(result.quarantined).toEqual(["c".repeat(32)]);
      expect(
        await readFile(join(result.backup, "originals", name), "utf8"),
      ).toBe(original);
      expect(
        await readFile(join(result.backup, "originals", corrupt), "utf8"),
      ).toBe("{broken");
      expect(
        await readFile(join(result.backup, "quarantine", corrupt), "utf8"),
      ).toBe("{broken");
      expect(await readdir(options.legacyRoot)).toEqual([name]);
      expect(
        Schema.decodeUnknownSync(LegacyJobSchema)(
          JSON.parse(await readFile(join(options.legacyRoot, name), "utf8")),
        ),
      ).toEqual({
        ...record,
        stage: "capacity",
        failureCode: "host-capacity-unavailable",
      });
      expect(
        (await lstat(join(result.backup, "originals", name))).mode & 0o777,
      ).toBe(0o600);
      expect((await lstat(result.backup)).mode & 0o777).toBe(0o700);
    }),
);

it.live(
  "refuses all mutation when any record is unfinished and requires the offline acknowledgement",
  () =>
    Effect.promise(async () => {
      const options = await roots();
      const target = join(options.legacyRoot, `${record.job}.json`);
      const original = JSON.stringify(record);
      await writeFile(target, original, { mode: 0o600 });
      await expect(
        rollbackLegacyDiskRecords({ ...options, gatewayStopped: false }),
      ).rejects.toThrow("acknowledgement");
      await writeFile(
        join(options.legacyRoot, `${"c".repeat(32)}.json`),
        JSON.stringify({ ...record, state: "starting" }),
        { mode: 0o600 },
      );
      await expect(rollbackLegacyDiskRecords(options)).rejects.toThrow(
        "unfinished-native-job",
      );
      expect(await readFile(target, "utf8")).toBe(original);
      expect(await readdir(options.backupRoot)).toEqual([]);
    }),
);

it.live(
  "rejects unsafe links, overlapping backups, mismatched identity and concurrent offline invocations",
  () =>
    Effect.promise(async () => {
      const options = await roots();
      await expect(
        rollbackLegacyDiskRecords({
          ...options,
          backupRoot: options.legacyRoot,
        }),
      ).rejects.toThrow("disjoint");
      const lock = join(options.legacyRoot, ".native-build-admin.lock");
      await writeFile(lock, "", { mode: 0o600 });
      await expect(rollbackLegacyDiskRecords(options)).rejects.toThrow();
      expect(await readdir(options.backupRoot)).toEqual([]);
      const other = path("other");
      await chmod(other, 0o700);
      const name = `${record.job}.json`;
      await symlink(
        join(options.backupRoot, "not-a-record"),
        join(other, name),
      );
      await expect(
        rollbackLegacyDiskRecords({ ...options, legacyRoot: other }),
      ).rejects.toThrow();
      const mismatch = path("mismatch");
      await chmod(mismatch, 0o700);
      await writeFile(
        join(mismatch, name),
        JSON.stringify({ ...record, job: "f".repeat(32) }),
        { mode: 0o600 },
      );
      expect(
        (await rollbackLegacyDiskRecords({ ...options, legacyRoot: mismatch }))
          .quarantined,
      ).toEqual([record.job]);
    }),
);
