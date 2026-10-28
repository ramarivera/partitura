import { Database } from "bun:sqlite";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { decodeNativeImportPlan } from "../deploy/mac-build/native-build-import-config.js";
import {
  currentNativeImportOwner,
  executeNativeImport,
} from "../deploy/mac-build/native-build-import-operator.js";
import { NativeBuildFiles } from "../src/services/native-build-files.js";
import { NativeBuildProcesses } from "../src/services/native-build-process.js";
import { legacyFixture } from "./fixtures/native-build-import.js";
import { registryFixture } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
const fixture = Effect.fn("Test.importOperator")(function* (name: string) {
  const f = yield* registryFixture(path(name));
  const legacy = yield* legacyFixture(f);
  const databasePath = join(f.root, "gateway.sqlite");
  const db = new Database(databasePath, { create: true });
  db.exec(
    "CREATE TABLE agent_run(session_id TEXT, organization_id TEXT, repository_id TEXT, state TEXT); CREATE TABLE run_event(session_id TEXT, kind TEXT, payload_json TEXT)",
  );
  db.query("INSERT INTO agent_run VALUES (?,?,?,?)").run(
    legacy.sessionId,
    "owner-org",
    "repo-1",
    "succeeded",
  );
  const insert = (pullRequest: number) =>
    db.query("INSERT INTO run_event VALUES (?,?,?)").run(
      legacy.sessionId,
      "action",
      JSON.stringify({
        request: {
          content: {
            action: "mcp__linear__native_build_start",
            parameter: JSON.stringify({
              pullRequest,
              commit: legacy.record.commit,
              action: legacy.record.action,
            }),
          },
        },
      }),
    );
  insert(9);
  db.close();
  yield* Effect.promise(() => chmod(databasePath, 0o600));
  const ownerSnapshotPath = join(f.root, "owners.json");
  yield* Effect.promise(() =>
    writeFile(
      ownerSnapshotPath,
      JSON.stringify({
        originalOwners: Object.fromEntries(
          Object.entries(legacy.input.originalOwners).map(([id, owner]) => [
            id,
            { ...owner, repositoryId: "repo-1", commit: legacy.record.commit },
          ]),
        ),
        unresolved: [],
      }),
      { mode: 0o600 },
    ),
  );
  const plan = decodeNativeImportPlan({
    databasePath,
    ownerSnapshotPath,
    stateRoot: f.options.stateRoot,
    scratchRoot: f.options.scratchRoot,
    cacheRoot: f.options.cacheRoot,
    otherRoots: [legacy.root],
    bytesPerBuilder: f.options.bytesPerBuilder,
    bytesTotal: f.options.bytesTotal,
    suffix: "example.test",
    slots: [
      {
        builderId: "primary",
        legacyRoot: legacy.root,
        privateKeyPath: f.keyPath,
        transport: f.metadata,
      },
    ],
  });
  yield* f.state.close();
  return { f, legacy, plan };
});
const run = (
  name: string,
  test: (
    f: Effect.Success<ReturnType<typeof fixture>>,
  ) => Effect.Effect<
    void,
    unknown,
    import("effect").Scope.Scope | NativeBuildFiles | NativeBuildProcesses
  >,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* test(yield* fixture(name));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NativeBuildFiles.layer, NativeBuildProcesses.layer),
      ),
    ),
  );

it.live(
  "offline operator preserves owners and originals and can resume the same import",
  () =>
    run("import-cli-success", (f) =>
      Effect.gen(function* () {
        const original = yield* Effect.promise(() =>
          readFile(f.legacy.recordPath),
        );
        expect(
          yield* executeNativeImport(f.plan, true, f.f.options.filesystem),
        ).toEqual({ matchedJobs: 1, slots: 1 });
        expect(
          yield* executeNativeImport(f.plan, true, f.f.options.filesystem),
        ).toEqual({ matchedJobs: 1, slots: 1 });
        expect(
          yield* Effect.promise(() => readFile(f.legacy.recordPath)),
        ).toEqual(original);
        const metadata = JSON.parse(
          yield* Effect.promise(() =>
            readFile(join(f.plan.stateRoot, "metadata.json"), "utf8"),
          ),
        );
        expect(metadata.jobs[0]).toMatchObject({
          organizationId: "owner-org",
          sessionId: f.legacy.sessionId,
          pullRequest: 9,
          imported: true,
        });
      }),
    ),
);
for (const failure of [
  "active",
  "tenant",
  "repository",
  "proof",
  "unsafe-db",
  "pr",
  "acknowledgement",
] as const) {
  it.live(`offline operator refuses ${failure} without importing jobs`, () =>
    run(`import-cli-${failure}`, (f) =>
      Effect.gen(function* () {
        const db = new Database(f.plan.databasePath);
        if (failure === "active")
          db.exec("UPDATE agent_run SET state='running'");
        if (failure === "repository")
          db.exec("UPDATE agent_run SET repository_id='other-repo'");
        if (failure === "tenant")
          db.exec("UPDATE agent_run SET organization_id='other-org'");
        if (failure === "pr")
          db.query("UPDATE run_event SET payload_json=?").run(
            JSON.stringify({
              request: {
                content: {
                  action: "native_build_start",
                  parameter: '{"pullRequest":10}',
                },
              },
            }),
          );
        db.close();
        if (failure === "unsafe-db")
          yield* Effect.promise(() => chmod(f.plan.databasePath, 0o644));
        if (failure === "proof") {
          const owners = JSON.parse(
            yield* Effect.promise(() =>
              readFile(f.plan.ownerSnapshotPath, "utf8"),
            ),
          );
          owners.originalOwners[f.legacy.id].commit = "a".repeat(40);
          yield* Effect.promise(() =>
            writeFile(f.plan.ownerSnapshotPath, JSON.stringify(owners)),
          );
        }
        const result = yield* executeNativeImport(
          f.plan,
          failure !== "acknowledgement",
          f.f.options.filesystem,
        ).pipe(Effect.exit);
        expect(result._tag).toBe("Failure");
        const metadata = JSON.parse(
          yield* Effect.promise(() =>
            readFile(join(f.plan.stateRoot, "metadata.json"), "utf8"),
          ),
        );
        expect(metadata.jobs).toEqual([]);
      }),
    ),
  );
}
it("durable owner lookup refuses multiple PR claims in a session", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE agent_run(session_id TEXT, organization_id TEXT, repository_id TEXT);CREATE TABLE run_event(session_id TEXT,kind TEXT,payload_json TEXT);INSERT INTO agent_run VALUES ('s','o','r')",
    );
    for (const pullRequest of [1, 2])
      db.query("INSERT INTO run_event VALUES ('s','action',?)").run(
        JSON.stringify({
          request: {
            content: {
              action: "native_build_start",
              parameter: JSON.stringify({ pullRequest }),
            },
          },
        }),
      );
    expect(
      currentNativeImportOwner(db, "s", {
        ["a".repeat(32)]: {
          sessionId: "s",
          organizationId: "o",
          repositoryId: "r",
          commit: "e".repeat(40),
          pullRequest: 1,
        },
      }),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});

it.live("verified PR bindings survive expired action events", () =>
  run("import-cli-expired-events", (f) =>
    Effect.gen(function* () {
      const db = new Database(f.plan.databasePath);
      db.exec("DELETE FROM run_event");
      db.close();
      expect(
        yield* executeNativeImport(f.plan, true, f.f.options.filesystem),
      ).toEqual({ matchedJobs: 1, slots: 1 });
    }),
  ),
);

it.live(
  "offline import accepts the gateway's traversable excluded workspace parent",
  () =>
    run("import-cli-worker-parent", (f) =>
      Effect.gen(function* () {
        const workers = path("excluded-workspaces");
        yield* Effect.promise(() => chmod(workers, 0o755));
        expect(
          yield* executeNativeImport(
            { ...f.plan, otherRoots: [...f.plan.otherRoots, workers] },
            true,
            f.f.options.filesystem,
          ),
        ).toEqual({ matchedJobs: 1, slots: 1 });
      }),
    ),
);
