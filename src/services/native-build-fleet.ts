import { Clock, Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { BuilderRegistry } from "./builder-registry.js";
import { sourceReference } from "./builder-registry-schema.js";
import { GatewayConfig, organizationAllowed } from "./config.js";
import { nativeTry } from "./native-build-errors.js";
import {
  type FleetActor,
  FleetDecommission,
  FleetReconcile,
  FleetRefresh,
  NativeFleetError,
} from "./native-build-fleet-models.js";
import { NativeBuildFleetRecovery } from "./native-build-fleet-recovery.js";
import {
  NativeBuildSecretCache,
  sourceKey,
} from "./native-build-secret-cache.js";
import { NativeSecretJournal } from "./native-build-secret-journal.js";
import {
  allocations,
  budgetLimits,
  day,
  hour,
  type SecretSource,
} from "./native-build-secret-models.js";
import {
  NativeBuildStateService,
  unresolvedRecovery,
} from "./native-build-state.js";
import {
  NativeBuildTransport,
  NativeTransportError,
} from "./native-build-transport.js";

const fixedCode = (code: string | undefined) =>
  code !== undefined && /^[a-z][a-z0-9-]{0,63}$/u.test(code) ? code : undefined;
/** Shared authority and operation boundary for browser controls and per-run tools.
 * Deliberately not assembled in the conductor until slice 8. */
export class NativeBuildFleet extends Context.Service<NativeBuildFleet>()(
  "NativeBuildFleet",
  {
    make: Effect.gen(function* () {
      const config = yield* GatewayConfig;
      const registry = yield* BuilderRegistry;
      const cache = yield* NativeBuildSecretCache;
      const state = yield* NativeBuildStateService;
      const journal = yield* NativeSecretJournal;
      const transport = yield* NativeBuildTransport;
      const recovery = yield* NativeBuildFleetRecovery;
      const scope = yield* Scope.Scope;
      const controls = new Map<
        string,
        {
          id: string;
          done: boolean;
          kind: "health" | "reconcile" | "decommission";
          code?: string | undefined;
          outcome?: string;
        }
      >();
      const control = (kind: "health" | "reconcile" | "decommission") => {
        for (const [id, item] of controls)
          if (controls.size >= 128 && item.done) controls.delete(id);
        if (controls.size >= 128) return undefined;
        const item = {
          id: crypto.randomUUID().replaceAll("-", ""),
          done: false,
          kind,
        };
        controls.set(item.id, item);
        return item;
      };
      const healthFlights = new Set<string>();
      const healthStarts = new Map<string, number>();
      const authorize = Effect.fn("NativeBuildFleet.authorize")(function* (
        actor: FleetActor,
        human = false,
      ) {
        if (
          (human && actor.kind !== "human") ||
          !organizationAllowed(config, actor.organizationId) ||
          !config.gatewayAdminOrganizationIds?.has(actor.organizationId)
        )
          return yield* Effect.fail(
            NativeFleetError.new("fleet-forbidden", 403),
          );
      });
      const inventory = (all: boolean, id?: string): SecretSource[] => {
        const desired = registry.snapshot().desired?.builders ?? [];
        const selected: SecretSource[] = desired
          .filter((entry) => (all ? entry.enabled : entry.id === id))
          .map((entry) => ({
            builderId: entry.id,
            revision: entry.secretRevision,
            source: sourceReference(entry.secretSource),
            retained: false,
          }));
        if (all)
          for (const job of state.snapshot().jobs.filter(unresolvedRecovery)) {
            const generation = state
              .snapshot()
              .generations.find(
                (generation) => generation.id === job.generationId,
              );
            if (!generation) continue;
            const entry = desired.find(
              (entry) =>
                entry.id === job.builderId &&
                sourceReference(entry.secretSource) ===
                  generation.transport.source,
            );
            selected.push({
              builderId: job.builderId,
              revision: entry?.secretRevision ?? 0,
              source: generation.transport.source,
              retained: true,
            });
          }
        const distinct = new Map<string, SecretSource>();
        for (const source of selected)
          if (!distinct.has(source.source)) distinct.set(source.source, source);
          else if (source.retained)
            distinct.set(source.source, {
              ...(distinct.get(source.source) ?? source),
              retained: true,
            });
        return [...distinct.values()];
      };
      const completions = new Set<string>();
      const attachCompletion = Effect.fn("NativeBuildFleet.attachCompletion")(
        function* (operationId: string) {
          if (completions.has(operationId)) return;
          completions.add(operationId);
          yield* cache.wait(operationId).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                // Private work includes source identity, unlike sanitized public progress.
                const operation = journal
                  .snapshot()
                  .operations.find((item) => item.id === operationId);
                for (const work of operation?.sources ?? []) {
                  if (work.status !== "succeeded") continue;
                  const credential = cache.cached(work);
                  if (!credential) continue;
                  yield* transport.restore(work.source, [
                    credential.privateKey,
                    ...(credential.retiringPrivateKey
                      ? [credential.retiringPrivateKey]
                      : []),
                  ]);
                  for (const entry of registry.snapshot().desired?.builders ??
                    [])
                    if (
                      sourceReference(entry.secretSource) === work.source &&
                      entry.secretRevision === work.revision
                    )
                      yield* registry.installCredential(
                        entry.id,
                        work.revision,
                        credential,
                      );
                }
              }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("Native fleet refresh completion unavailable", {
                operationId,
                code: "code" in error ? error.code : error.reason,
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                completions.delete(operationId);
              }),
            ),
            Effect.interruptible,
            Effect.forkIn(scope),
          );
        },
      );
      // Durable operations outlive the request and the gateway process that accepted them.
      for (const operation of journal.snapshot().operations)
        if (
          operation.sources.some(
            (work) => work.status === "pending" || work.status === "running",
          )
        )
          yield* attachCompletion(operation.id);
      const refresh = Effect.fn("NativeBuildFleet.refresh")(function* (
        actor: FleetActor,
        input: unknown,
      ) {
        yield* authorize(actor);
        const request = yield* Schema.decodeUnknownEffect(FleetRefresh)(input, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(() =>
            NativeFleetError.new("fleet-invalid-request", 400),
          ),
        );
        const sources = inventory(
          request.scope === "all",
          request.scope === "builder" ? request.builder : undefined,
        );
        if (!sources.length)
          return yield* Effect.fail(
            NativeFleetError.new("fleet-builder-not-found", 404),
          );
        const operationId = yield* cache
          .accept(
            actor.kind,
            sources,
            actor.organizationId,
            request.scope === "all",
          )
          .pipe(
            Effect.mapError((error) =>
              NativeFleetError.new(
                fixedCode(error.code) ?? "fleet-unavailable",
                ["provider-submission-limited", "provider-queue-full"].includes(
                  error.code,
                )
                  ? 429
                  : 503,
              ),
            ),
          );
        yield* attachCompletion(operationId);
        return { operationId };
      }, Effect.uninterruptible);
      const progress = Effect.fn("NativeBuildFleet.progress")(function* (
        actor: FleetActor,
        id: string,
      ) {
        yield* authorize(actor);
        const control = controls.get(id);
        if (control) return { ...control };
        const operation = cache.progress(id);
        if (!operation)
          return yield* Effect.fail(
            NativeFleetError.new("fleet-operation-not-found", 404),
          );
        return {
          ...operation,
          kind: journal.snapshot().operations.find((item) => item.id === id)
            ?.kind,
          sources: operation.sources.map((work) => ({
            ...work,
            code: fixedCode(work.code),
          })),
        };
      });
      const checkHealth = Effect.fn("NativeBuildFleet.checkHealth")(function* (
        actor: FleetActor,
        id: string,
      ) {
        yield* authorize(actor);
        const current = registry.current(id);
        if (!current?.credential)
          return yield* Effect.fail(
            NativeFleetError.new("fleet-builder-unavailable", 409),
          );
        const generation = current.identity?.generation;
        const hostId = current.credential.transport.hostId;
        const now = yield* Clock.currentTimeMillis;
        if (
          healthFlights.size >= 4 ||
          healthFlights.has(hostId) ||
          now - (healthStarts.get(hostId) ?? -Infinity) < 15000
        )
          return yield* Effect.fail(
            NativeFleetError.new("fleet-health-limited", 429),
          );
        if (healthStarts.size >= 256 && !healthStarts.has(hostId)) {
          for (const [host, at] of healthStarts)
            if (now - at >= 15000) healthStarts.delete(host);
          if (healthStarts.size >= 256)
            return yield* Effect.fail(
              NativeFleetError.new("fleet-capacity", 429),
            );
        }
        const item = control("health");
        if (!item)
          return yield* Effect.fail(
            NativeFleetError.new("fleet-capacity", 429),
          );
        healthStarts.set(hostId, now);
        healthFlights.add(hostId);
        const operationId = item.id;
        yield* Effect.scoped(
          Effect.gen(function* () {
            if (!generation) {
              // A failed first check still has a validated cached credential. Join
              // only this builder's cached-health worker, never a provider read.
              yield* registry.refreshHealth(id, false, true);
              const checked = registry.current(id);
              if (!checked?.identity || checked.error)
                return yield* Effect.fail(
                  NativeFleetError.new(
                    checked?.error ?? "fleet-builder-unavailable",
                  ),
                );
              yield* recovery.observe(id, checked.identity.health);
              return;
            }
            yield* Effect.acquireRelease(
              nativeTry(() => state.retainGeneration(generation.id)),
              (release) => Effect.sync(release),
            );
            const health = yield* transport.envelope(
              generation,
              "health",
              undefined,
              { timeout: 12000 },
            );
            if (health.kind !== "health")
              return yield* Effect.fail(
                NativeFleetError.new(
                  health.kind === "error"
                    ? (fixedCode(health.code) ?? "fleet-health-unavailable")
                    : "protocol-mismatch",
                ),
              );
            yield* recovery.observe(id, health);
            yield* registry.recordHealth(id, generation.id, health);
          }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: 12000,
            orElse: () =>
              Effect.fail(NativeFleetError.new("fleet-health-timeout")),
          }),
          Effect.catch((error) =>
            Effect.gen(function* () {
              const code =
                error instanceof NativeTransportError
                  ? error.reason
                  : error instanceof NativeFleetError
                    ? error.code
                    : "unavailable";
              controls.set(item.id, {
                ...item,
                code: fixedCode(code),
              });
              if (generation)
                yield* registry.recordHealth(
                  id,
                  generation.id,
                  current.identity?.health ?? {
                    protocolVersion: 2,
                    kind: "error",
                    hostId,
                  },
                  code,
                );
              yield* Effect.logWarning("Native fleet health unavailable", {
                builderId: id,
                code,
              });
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              healthFlights.delete(hostId);
              item.done = true;
              const recorded = controls.get(item.id);
              if (recorded) controls.set(item.id, { ...recorded, done: true });
            }),
          ),
          Effect.interruptible,
          Effect.forkIn(scope),
        );
        return { operationId };
      }, Effect.uninterruptible);
      const fleet = Effect.fn("NativeBuildFleet.fleet")(function* (
        actor: FleetActor,
      ) {
        yield* authorize(actor);
        const view = registry.snapshot();
        const data = state.snapshot();
        const provider = journal.snapshot();
        const now = Math.max(
          provider.highWater,
          yield* Clock.currentTimeMillis,
        );
        const sources = inventory(true);
        const capacity = yield* cache.capacity(sources);
        const buckets = Object.keys(allocations).map((bucket) => {
          const name = bucket as keyof typeof allocations;
          const [daily, hourly] = budgetLimits(
            config.nativeBuildRegistry?.dailyBudget ?? 400,
            config.nativeBuildRegistry?.hourlyBudget ?? 200,
            name,
          );
          const used = (window: number) =>
            provider.charges
              .filter(
                (charge) => charge.bucket === name && charge.at > now - window,
              )
              .reduce((sum, charge) => sum + charge.units, 0);
          return {
            bucket,
            dailyRemaining: Math.max(0, daily - used(day)),
            hourlyRemaining: Math.max(0, hourly - used(hour)),
          };
        });
        const entries = [...view.entries];
        for (const job of data.jobs.filter(unresolvedRecovery))
          if (!entries.some((entry) => entry.id === job.builderId))
            entries.push({
              id: job.builderId,
              available: false,
              reason: "builder-removed",
              generationId: undefined,
              hostId: job.verifiedHostId,
            });
        for (const item of data.fleet?.maintenance.filter(
          (item) => item.state === "pending",
        ) ?? [])
          if (!entries.some((entry) => entry.id === item.builderId))
            entries.push({
              id: item.builderId,
              available: false,
              reason: "builder-removed",
              generationId: undefined,
              hostId: item.hostId,
            });
        return {
          revision: view.revision,
          reloadError: fixedCode(view.error),
          capacityError: fixedCode(view.capacityError),
          watchDegraded: view.watchDegraded,
          audit:
            data.fleet?.audit
              .slice(-20)
              .map(
                ({
                  at,
                  builderId,
                  hostId,
                  action,
                  reason,
                  evidenceReference,
                  before,
                  after,
                  outcome,
                  epoch,
                }) => ({
                  at,
                  builderId,
                  hostId,
                  action,
                  reason,
                  evidenceReference,
                  before,
                  after,
                  outcome,
                  epoch,
                }),
              ) ?? [],
          capacity,
          buckets,
          scratch: state.accounting(),
          entries: entries.map((entry) => {
            const current = registry.current(entry.id);
            const health = current?.identity?.health;
            const recent = provider.operations
              .slice()
              .reverse()
              .map((operation) => ({
                kind: operation.kind,
                work: operation.sources.find(
                  (work) => work.builderId === entry.id,
                ),
              }))
              .find((item) => item.work !== undefined);
            const work = recent?.work;
            return {
              ...entry,
              drainingGenerations: data.generations
                .filter(
                  (generation) =>
                    generation.builderId === entry.id &&
                    generation.id !== entry.generationId,
                )
                .map((generation) => ({
                  id: generation.id,
                  hostId: generation.transport.hostId,
                })),
              reason: fixedCode(entry.reason),
              enabled: current?.entry.enabled,
              minimumFreeBytes: current?.entry.minimumFreeBytes,
              checkedAt: current?.checkedAt,
              profile: health?.profile,
              status: health?.status,
              jobRootFreeBytes: health?.jobRootFreeBytes,
              tartRootFreeBytes: health?.tartRootFreeBytes,
              hostFloorBytes: health?.hostFloorBytes,
              credential: work
                ? {
                    trigger: recent?.kind,
                    lastSuccessAt: provider.successes[sourceKey(work)],
                    status: work.status,
                    code: fixedCode(work.code),
                    deadline: work.deadline,
                    nextFit: work.nextFit,
                    readStartedAt: work.readStartedAt,
                    completedAt: work.completedAt,
                  }
                : undefined,
              recoveries: data.jobs
                .filter(
                  (job) =>
                    (job.builderId === entry.id ||
                      job.verifiedHostId === entry.hostId) &&
                    unresolvedRecovery(job),
                )
                .slice(0, 64)
                .map((job) => ({
                  id: job.jobId,
                  hostId: job.verifiedHostId,
                  state: job.recovery.state,
                  reason: job.recovery.lastReason,
                  observation: job.recovery.observation,
                  returnEventUsed: job.recovery.returnEventUsed,
                })),
              maintenance:
                data.fleet?.maintenance
                  .filter(
                    (item) =>
                      (item.builderId === entry.id ||
                        item.hostId === entry.hostId) &&
                      item.state === "pending",
                  )
                  .map(({ id, hostId, state }) => ({ id, hostId, state })) ??
                [],
              retired:
                entry.hostId !== undefined &&
                data.fleet?.retiredHosts.includes(entry.hostId) === true,
            };
          }),
        };
      });
      const humanAction = Effect.fn("NativeBuildFleet.humanAction")(function* (
        actor: FleetActor,
        id: string,
        input: unknown,
        action: "reconcile" | "decommission",
      ) {
        yield* authorize(actor, true);
        const checked = yield* Schema.decodeUnknownEffect(
          action === "reconcile" ? FleetReconcile : FleetDecommission,
        )(input, { onExcessProperty: "error" }).pipe(
          Effect.mapError(() =>
            NativeFleetError.new("fleet-invalid-request", 400),
          ),
        );
        const item = control(action);
        if (!item)
          return yield* Effect.fail(
            NativeFleetError.new("fleet-capacity", 429),
          );
        const operationId = item.id;
        // Human recovery returns only after its durable result. The HTTP adapter still
        // uses 202; the audit records the final outcome before a hold can be released.
        yield* recovery.act(actor, id, checked, action).pipe(
          Effect.mapError((error) =>
            error instanceof NativeFleetError
              ? error
              : NativeFleetError.new("fleet-unavailable"),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              item.done = true;
              if (Exit.isFailure(exit))
                controls.set(item.id, { ...item, code: "fleet-action-failed" });
            }),
          ),
          Effect.tap((result) =>
            Effect.sync(() =>
              controls.set(item.id, {
                ...item,
                done: true,
                outcome: result.outcome,
              }),
            ),
          ),
        );
        item.done = true;
        return { operationId };
      });
      return { refresh, progress, fleet, checkHealth, humanAction };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(NativeBuildFleetRecovery.layer),
  );
}
