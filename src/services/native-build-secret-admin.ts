import { Context, Effect, Layer, Schema } from "effect";
import { BuilderRegistryConfig } from "./config-native-build.js";
import {
  missingNativeFile,
  nativeFile,
  opaqueId,
  writeNativeFile,
} from "./native-build-file-io.js";
import { journalFile, markerFile } from "./native-build-secret-journal.js";
import {
  allocations,
  budgetLimits,
  emptySecretJournal,
  SecretJournalData,
} from "./native-build-secret-models.js";
import { NativeSecretError } from "./native-build-secret-protocol.js";
import { NativeStateOwnership } from "./native-build-state-ownership.js";

export class NativeSecretAdminAuthority extends Context.Service<NativeSecretAdminAuthority>()(
  "NativeSecretAdminAuthority",
  {
    make: Effect.sync(() => ({
      assertRoot: Effect.fn("NativeSecretAdmin.root")(function* () {
        if (process.geteuid?.() !== 0)
          return yield* Effect.fail(NativeSecretError.new("root-required"));
      }),
    })),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
const Evidence = Schema.Struct({
  allocationUnused: Schema.Literal(true),
  accountId: Schema.String.check(Schema.isMinLength(1)),
  actor: Schema.String,
  reason: Schema.String.check(Schema.isMinLength(1)),
});
const io = <A>(action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) =>
      cause instanceof NativeSecretError
        ? cause
        : NativeSecretError.new("journal-repair-required"),
  });
export class NativeSecretAdmin extends Context.Service<NativeSecretAdmin>()(
  "NativeSecretAdmin",
  {
    make: Effect.gen(function* () {
      const settings = yield* BuilderRegistryConfig;
      const authority = yield* NativeSecretAdminAuthority;
      yield* authority.assertRoot();
      const owner = yield* NativeStateOwnership; // Fails if any gateway still owns this root.
      if (owner.stateRoot !== settings.stateRoot)
        return yield* Effect.fail(
          NativeSecretError.new("journal-repair-required"),
        );
      return {
        setup: Effect.fn("NativeSecretAdmin.setup")(function* (
          action: "initialize" | "repair",
          actor: string,
          reason: string,
          acknowledge: boolean,
          evidenceFile?: string,
        ) {
          yield* authority.assertRoot();
          if (
            !acknowledge ||
            !actor.trim() ||
            !reason.trim() ||
            actor.length > 128 ||
            reason.length > 512
          )
            return yield* Effect.fail(
              NativeSecretError.new("human-acknowledgement-required"),
            );
          const root = settings.stateRoot,
            marker = markerFile(root),
            path = journalFile(root);
          const at = Date.now();
          let previous: Buffer | undefined;
          let existingMarker: Buffer | undefined;
          yield* io(async () => {
            try {
              previous = await nativeFile(path, 0o600, 16 * 1024 ** 2);
            } catch (cause) {
              if (!missingNativeFile(cause)) throw cause;
            }
            try {
              existingMarker = await nativeFile(marker, 0o600, 1024);
            } catch (cause) {
              if (!missingNativeFile(cause)) throw cause;
            }
          });
          if (action === "initialize" && (previous || existingMarker))
            return yield* Effect.fail(
              NativeSecretError.new("journal-already-initialized"),
            );
          if (
            action === "repair" &&
            existingMarker?.toString() !== "partitura-native-provider-v1\n"
          )
            return yield* Effect.fail(
              NativeSecretError.new("journal-repair-required"),
            );
          let unused = false;
          if (evidenceFile && action === "initialize") {
            const evidenceBytes = yield* io(() =>
              nativeFile(evidenceFile, [0o400, 0o600], 4096),
            );
            const evidence = yield* Effect.try({
              try: () =>
                Schema.decodeUnknownSync(Evidence)(
                  JSON.parse(evidenceBytes.toString()),
                  { onExcessProperty: "error" },
                ),
              catch: () => NativeSecretError.new("allocation-evidence-invalid"),
            });
            if (evidence.actor !== actor)
              return yield* Effect.fail(
                NativeSecretError.new("allocation-evidence-invalid"),
              );
            unused = true;
          }
          const data = emptySecretJournal(at);
          if (previous) {
            yield* io(() =>
              writeNativeFile(
                `${path}.${opaqueId()}.archive`,
                previous ?? Buffer.alloc(0),
                0o600,
              ),
            );
            // Archives preserve all readable usage even if the schema is corrupt.
            const decoded = yield* Effect.try({
              try: () =>
                Schema.decodeUnknownSync(SecretJournalData)(
                  JSON.parse(previous?.toString() ?? ""),
                ),
              catch: () => NativeSecretError.new("journal-corrupt"),
            }).pipe(Effect.result);
            if (decoded._tag === "Success") {
              data.charges = structuredClone(decoded.success.charges).slice(
                -9996,
              );
              data.highWater = Math.max(at, decoded.success.highWater);
              data.audit = structuredClone(decoded.success.audit).slice(-127);
              data.successes = { ...decoded.success.successes };
              data.startupStops = { ...decoded.success.startupStops };
            }
          }
          if (!unused) data.providerBackoff = data.highWater + 86400000;
          if (!unused)
            for (const bucket of Object.keys(
              allocations,
            ) as (keyof typeof allocations)[])
              data.charges.push({
                at: data.highWater,
                bucket,
                units: budgetLimits(
                  settings.dailyBudget,
                  settings.hourlyBudget,
                  bucket,
                )[0],
                org: "root-local-repair",
              });
          data.audit.push({ at: data.highWater, actor, reason, action });
          // Marker first: a crash can close reads, never create a fresh allowance.
          if (!existingMarker)
            yield* io(() =>
              writeNativeFile(marker, "partitura-native-provider-v1\n", 0o600),
            );
          yield* io(() =>
            writeNativeFile(
              path,
              JSON.stringify(data),
              0o600,
              action === "repair" && previous !== undefined,
            ),
          );
          yield* Effect.logInfo(
            "Native provider journal administration completed",
            { action },
          );
          return {
            action,
            conservativeUntil: unused ? null : data.highWater + 86400000,
          };
        }),
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(
        NativeSecretAdminAuthority.layer,
        NativeStateOwnership.layer,
      ),
    ),
  );
}
