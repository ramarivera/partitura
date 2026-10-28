import { Database } from "bun:sqlite";
import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { nativeIO } from "../../src/services/native-build-errors.js";
import {
  nativeDirectory,
  nativeFile,
} from "../../src/services/native-build-file-io.js";
import { NativeBuildFiles } from "../../src/services/native-build-files.js";
import { NativeBuildProcesses } from "../../src/services/native-build-process.js";
import {
  type NativeStateOptions,
  openNativeBuildState,
} from "../../src/services/native-build-state.js";
import { createNativeBuildTransport } from "../../src/services/native-build-transport.js";
import {
  protectedCodePath,
  validateRollbackLaunchContext,
} from "./native-build-admin.js";
import { importLegacyNativeSlot } from "./native-build-import.js";
import {
  decodeNativeImportPlan,
  NativeImportOwners,
  type NativeImportPlan,
} from "./native-build-import-config.js";

/** Current ownership comes from a read-only, consistent durable DB snapshot.
 * A protected original snapshot alone is never enough to import a tenant job. */
export function currentNativeImportOwner(db: Database, sessionId: string) {
  const run = db
    .query<{ organization_id: string }, [string]>(
      "SELECT organization_id FROM agent_run WHERE session_id = ?",
    )
    .get(sessionId);
  if (!run) return undefined;
  const pulls = new Set<number>();
  for (const row of db
    .query<{ payload_json: string }, [string]>(
      "SELECT payload_json FROM run_event WHERE session_id = ? AND kind = 'action'",
    )
    .all(sessionId)) {
    try {
      const event: unknown = JSON.parse(row.payload_json);
      const parsed = Schema.decodeUnknownSync(
        Schema.Struct({
          request: Schema.Struct({
            content: Schema.Struct({
              action: Schema.String,
              parameter: Schema.String,
            }),
          }),
        }),
      )(event);
      const content = parsed.request.content;
      if (
        content.action !== "native_build_start" &&
        !content.action.endsWith("__native_build_start")
      )
        continue;
      const input = Schema.decodeUnknownSync(
        Schema.Struct({
          pullRequest: Schema.Number.check(
            Schema.isInt(),
            Schema.isGreaterThan(0),
          ),
        }),
      )(JSON.parse(content.parameter));
      pulls.add(input.pullRequest);
    } catch {
      /* Unrelated or incomplete action events aren't ownership evidence. */
    }
  }
  const pullRequest = [...pulls][0];
  return pulls.size === 1 && pullRequest !== undefined
    ? { organizationId: run.organization_id, pullRequest }
    : undefined;
}

async function openImportDatabase(path: string) {
  await nativeDirectory(dirname(path));
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = path + suffix;
    const info = await lstat(candidate).catch((error: unknown) => {
      if (
        suffix &&
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return undefined;
      throw error;
    });
    if (!info) continue;
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (await realpath(candidate)) !== candidate
    )
      throw new Error("unsafe-native-import-database");
  }
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA query_only = ON; BEGIN");
    const active = db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM agent_run WHERE state NOT IN ('succeeded','failed','canceled')",
      )
      .get();
    if (active?.n !== 0) throw new Error("native-import-active-runs");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Offline migration only. The caller stops the gateway before acknowledging it.
 * The native state lock prevents a second registry owner, not a legacy gateway. */
export const executeNativeImport = Effect.fn("NativeImportOperator.execute")(
  function* (
    plan: NativeImportPlan,
    gatewayStopped: boolean,
    filesystem?: NativeStateOptions["filesystem"],
  ) {
    if (!gatewayStopped)
      return yield* Effect.fail(new Error("native-import-stop-required"));
    const owners = yield* nativeIO(async () =>
      Schema.decodeUnknownSync(NativeImportOwners)(
        JSON.parse(
          (
            await nativeFile(
              plan.ownerSnapshotPath,
              [0o400, 0o600],
              4 * 1024 ** 2,
            )
          ).toString(),
        ),
        { onExcessProperty: "error" },
      ),
    );
    const db = yield* Effect.acquireRelease(
      nativeIO(() => openImportDatabase(plan.databasePath)),
      (db) => Effect.sync(() => db.close()),
    );
    const inputs = plan.slots.map((slot) => ({
      ...slot.transport,
      builderId: slot.builderId,
      scratchRoot: slot.legacyRoot,
      privateKeyPath: slot.privateKeyPath,
      pins: slot.transport.hostKeys,
      suffix: plan.suffix,
      acknowledgeQuiesced: true as const,
      originalOwners: owners.originalOwners,
      resolveOwner: async (sessionId: string) =>
        currentNativeImportOwner(db, sessionId),
    }));
    const otherRoots = [
      ...new Set([
        ...plan.otherRoots,
        ...plan.slots.map((slot) => slot.legacyRoot),
      ]),
    ];
    const state = yield* openNativeBuildState({
      stateRoot: plan.stateRoot,
      scratchRoot: plan.scratchRoot,
      cacheRoot: plan.cacheRoot,
      bytesPerBuilder: plan.bytesPerBuilder,
      bytesTotal: plan.bytesTotal,
      otherRoots,
      ...(filesystem ? { filesystem } : {}),
    });
    const transport = yield* createNativeBuildTransport(state, {
      suffix: plan.suffix,
    });
    let imported = 0;
    for (const input of inputs)
      imported += (yield* importLegacyNativeSlot(state, transport, input))
        .importedJobs.length;
    return { imported, slots: inputs.length };
  },
  Effect.scoped,
);

export async function runNativeImportOperator(args = process.argv.slice(2)) {
  try {
    if (
      process.getuid?.() !== 0 ||
      args.length !== 3 ||
      args[0] !== "--config" ||
      !args[1] ||
      args[2] !== "--gateway-stopped"
    )
      throw new Error("invalid-native-import-launch");
    validateRollbackLaunchContext({
      cwd: process.cwd(),
      execArgv: process.execArgv,
      environment: process.env,
    });
    await protectedCodePath(process.execPath);
    await protectedCodePath(import.meta.filename);
    const configPath = args[1];
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const plan = yield* nativeIO(async () =>
            decodeNativeImportPlan(
              JSON.parse(
                (
                  await nativeFile(configPath, [0o400, 0o600], 65_536)
                ).toString(),
              ),
            ),
          );
          return yield* executeNativeImport(plan, true);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(NativeBuildFiles.layer, NativeBuildProcesses.layer),
          ),
        ),
      ),
    );
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      "native-import-refused; check stopped gateway, protected config, durable owners, roots and pins",
    );
    process.exitCode = 1;
  }
}
if (import.meta.main) runNativeImportOperator();
