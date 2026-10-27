import { Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect";
import type {
  BuilderIdentityResult,
  BuilderRegistryIdentity,
} from "./builder-registry-identity.js";
import { BuilderRegistryError } from "./builder-registry-json.js";
import {
  type BuilderEntry,
  type BuilderRegistrySnapshot,
  credentialRevision,
  registrySemanticKey,
  sourceReference,
} from "./builder-registry-schema.js";
import type {
  BuilderCredential,
  BuilderSecretProvider,
} from "./builder-secret-provider.js";

type Provider = typeof BuilderSecretProvider.Service;
type Identity = typeof BuilderRegistryIdentity.Service;
interface Current {
  entry: BuilderEntry;
  ticket: number;
  credential?: BuilderCredential;
  identity?: BuilderIdentityResult;
  checkedAt: number;
  healthFailures: number;
  retryAt: number;
  duplicate: boolean;
  recheck: boolean;
  error: string | undefined;
}
export interface BuilderAdmission {
  readonly builderId: string;
  readonly generationId: string;
  readonly hostId: string;
  readonly signal: AbortSignal;
}
interface Preparation {
  readonly admission: BuilderAdmission;
  readonly controller: AbortController;
  readonly current: Current;
}
interface Work {
  readonly trigger: "startup" | "registry";
  readonly ticket: number;
  readonly entry: BuilderEntry;
  readonly credential?: BuilderCredential;
}

/** Desired publication, identity publication and admission share this one gate.
 * Provider and health IO never hold it. This controller isn't wired to production. */
export const makeBuilderRegistryState = Effect.fn("BuilderRegistry.state")(
  function* (
    provider: Provider,
    identity: Identity,
    now: () => number = Date.now,
    supersede: (
      ids: readonly string[],
      captured?: readonly string[],
    ) => Effect.Effect<void, BuilderRegistryError> = () => Effect.void,
    captureSupersede?: (ids: readonly string[]) => readonly string[],
  ) {
    const scope = yield* Scope.Scope;
    const gate = yield* Semaphore.make(1);
    const entries = new Map<string, Current>();
    const pending = new Map<string, Work>();
    const cancellations = new Map<string, Deferred.Deferred<void>>();
    const workers = new Map<string, Fiber.Fiber<void>>();
    const preparations = new Map<BuilderAdmission, Preparation>();
    const leases = new Map<string, Scope.Closeable>();
    let desired: BuilderRegistrySnapshot | undefined,
      semantic = "",
      revision = 0,
      ticket = 0;
    let error: string | undefined,
      stale = false;
    const failures = new Map<string, unknown>();
    const enqueue = (
      current: Current,
      read: boolean,
      trigger: "startup" | "registry" = "registry",
    ) => {
      pending.set(current.entry.id, {
        trigger,
        ticket: current.ticket,
        entry: current.entry,
        ...(!read && current.credential
          ? { credential: current.credential }
          : {}),
      });
    };
    const conflicts = () => {
      const counts = new Map<string, number>();
      for (const current of entries.values())
        if (current.entry.enabled && current.credential) {
          const hostId = current.credential.transport.hostId;
          counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
        }
      for (const current of entries.values()) {
        const duplicate =
          current.entry.enabled &&
          current.credential !== undefined &&
          (counts.get(current.credential.transport.hostId) ?? 0) > 1;
        if (
          current.duplicate &&
          !duplicate &&
          current.entry.enabled &&
          current.credential
        ) {
          current.recheck = true;
          current.ticket = ++ticket;
          enqueue(current, false);
        }
        current.duplicate = duplicate;
      }
    };
    const worker = Effect.fn("BuilderRegistry.resolve")(function* (id: string) {
      let initial = true;
      for (;;) {
        // Let a burst of accepted revisions replace pending work before another read.
        if (!initial) yield* Effect.yieldNow;
        initial = false;
        const work = pending.get(id);
        if (!work) return;
        pending.delete(id);
        const cancel = yield* Deferred.make<void>();
        cancellations.set(id, cancel);
        const live = () => {
          const current = entries.get(id);
          return current?.entry.enabled && current.ticket === work.ticket
            ? current
            : undefined;
        };
        let unpublished: Scope.Closeable | undefined;
        yield* Effect.gen(function* () {
          const credential =
            work.credential ??
            (yield* provider.resolve(work.entry, work.trigger));
          const accepted = yield* gate.withPermit(
            Effect.sync(() => {
              const current = live();
              if (!current) return false;
              current.credential = credential;
              conflicts();
              return true;
            }),
          );
          if (!accepted) return;
          // The lease holds the generation from verification through publication.
          const lease = yield* Scope.fork(scope);
          unpublished = lease;
          const verified = yield* Effect.gen(function* () {
            const verified = yield* identity.verify(
              work.entry,
              credential,
              lease,
            );
            if (
              verified.generation.builderId !== id ||
              verified.generation.transport.hostId !==
                credential.transport.hostId ||
              verified.health.kind !== "health" ||
              verified.health.hostId !== credential.transport.hostId ||
              verified.health.profile !== "registry-only"
            )
              return yield* Effect.fail(
                BuilderRegistryError.new("builder-identity-mismatch"),
              );
            return verified;
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(lease, exit) : Effect.void,
            ),
          );
          const replaced = yield* gate.withPermit(
            Effect.sync(() => {
              const current = live();
              if (!current) return lease;
              const previous = leases.get(id);
              leases.set(id, lease);
              unpublished = undefined;
              current.identity = verified;
              current.checkedAt = now();
              current.healthFailures = 0;
              current.retryAt = 0;
              current.recheck = false;
              current.error = undefined;
              failures.delete(id);
              conflicts();
              return previous;
            }),
          );
          if (replaced) yield* Scope.close(replaced, Exit.void);
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() =>
              unpublished ? Scope.close(unpublished, Exit.void) : Effect.void,
            ),
          ),
          Effect.raceFirst(Deferred.await(cancel)),
          Effect.ensuring(Effect.sync(() => cancellations.delete(id))),
          Effect.catch((cause) =>
            gate.withPermit(
              Effect.gen(function* () {
                const current = live();
                if (!current) return;
                current.error = cause.code;
                if (current.credential) {
                  current.retryAt =
                    now() +
                    Math.min(
                      120_000,
                      5000 * 2 ** Math.min(current.healthFailures, 5),
                    );
                  current.healthFailures = Math.min(
                    current.healthFailures + 1,
                    6,
                  );
                }
                failures.set(id, cause);
                yield* Effect.logWarning("Native builder resolution failed", {
                  builderId: id,
                  code: cause.code,
                });
              }),
            ),
          ),
        );
      }
    });
    const launch = Effect.fn("BuilderRegistry.launch")(function* () {
      for (const id of pending.keys())
        if (!workers.has(id)) {
          // Register before the child runs, and clear before completion wakes waiters.
          const fiber = yield* worker(id).pipe(
            Effect.ensuring(Effect.sync(() => workers.delete(id))),
            Effect.forkIn(scope, { startImmediately: false }),
          );
          workers.set(id, fiber);
        }
    });
    const reason = (current: Current): string | undefined => {
      if (stale || error || !desired) return "registry-admission-closed";
      if (!current.entry.enabled) return "builder-disabled";
      if (current.duplicate) return "duplicate-host";
      if (current.recheck || !current.identity || current.error)
        return current.error ?? "builder-not-ready";
      const health = current.identity.health;
      if (
        health.status !== "ready" ||
        !health.accepting ||
        health.capacity !== 1 ||
        health.runner ||
        health.reasons?.length
      )
        return "builder-health-blocked";
      const floor = Math.max(
        current.entry.minimumFreeBytes,
        health.hostFloorBytes ?? 0,
      );
      if (
        (health.jobRootFreeBytes ?? -1) < floor ||
        (health.tartRootFreeBytes ?? -1) < floor
      )
        return "builder-disk-policy";
      return undefined;
    };
    const publish = Effect.fn("BuilderRegistry.publish")(function* (
      snapshot: BuilderRegistrySnapshot,
      trigger: "startup" | "registry" = "registry",
      blocked: ReadonlySet<string> = new Set(),
    ) {
      const retired: Scope.Closeable[] = [];
      const obsolete: string[] = [];
      let obsoleteOperations: readonly string[] | undefined;
      const cancelOld: Deferred.Deferred<void>[] = [];
      const retire = (id: string) => {
        const lease = leases.get(id);
        if (lease) {
          leases.delete(id);
          retired.push(lease);
        }
      };
      const changed = yield* gate.withPermit(
        Effect.gen(function* () {
          if (stale) return false; // A stale mount requires recreation, never local repair.
          error = undefined;
          const key = `${registrySemanticKey(snapshot)}:${[...blocked].sort().join(",")}`;
          if (key === semantic) return false;
          obsolete.push(
            ...[...entries.values()]
              .filter((old) => {
                const next = snapshot.builders.find(
                  (entry) => entry.id === old.entry.id,
                );
                return (
                  !next ||
                  (old.entry.enabled && !next.enabled) ||
                  credentialRevision(next) !== credentialRevision(old.entry)
                );
              })
              .map((old) => old.entry.id),
          );
          obsoleteOperations = captureSupersede?.(obsolete);
          for (const id of obsolete) {
            const cancel = cancellations.get(id);
            if (cancel) cancelOld.push(cancel);
          }
          desired = structuredClone(snapshot);
          semantic = key;
          revision++;
          const incoming = new Set(snapshot.builders.map((entry) => entry.id));
          for (const [id] of entries)
            if (!incoming.has(id)) {
              entries.delete(id);
              pending.delete(id);
              failures.delete(id);
              retire(id);
            }
          for (const entry of snapshot.builders) {
            const old = entries.get(entry.id);
            const read =
              entry.enabled &&
              (!old?.entry.enabled ||
                credentialRevision(old.entry) !== credentialRevision(entry) ||
                old.error === "budget-capacity");
            const current: Current =
              read || !old
                ? {
                    entry,
                    ticket: ++ticket,
                    checkedAt: 0,
                    healthFailures: 0,
                    retryAt: 0,
                    duplicate: false,
                    recheck: false,
                    error: undefined,
                  }
                : { ...old, entry };
            entries.set(entry.id, current);
            if (read || !entry.enabled) retire(entry.id);
            if (!entry.enabled) {
              current.ticket = ++ticket;
              pending.delete(entry.id);
            } else if (blocked.has(entry.id)) {
              current.error = "budget-capacity";
              pending.delete(entry.id);
            } else if (read) enqueue(current, true, trigger);
          }
          for (const preparation of preparations.values())
            if (!entries.get(preparation.admission.builderId)?.entry.enabled)
              preparation.controller.abort();
          conflicts();
          return true;
        }),
      );
      // Safety state is published before best-effort provider cleanup.
      if (obsolete.length)
        yield* supersede(obsolete, obsoleteOperations).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "Native provider supersession could not be persisted",
              { code: error.code },
            ),
          ),
        );
      for (const cancel of cancelOld)
        yield* Deferred.succeed(cancel, undefined);
      yield* Effect.forEach(retired, (lease) => Scope.close(lease, Exit.void));
      yield* launch();
      return changed;
    });
    const reserved = (current: Current) => {
      const hostId = current.credential?.transport.hostId;
      return (
        hostId !== undefined &&
        (identity.reserved(hostId) ||
          [...preparations.values()].some(
            (item) => item.admission.hostId === hostId,
          ))
      );
    };
    const refreshHealth = Effect.fn("BuilderRegistry.checkHealth")(function* (
      id: string,
      admissionCheck = false,
      forced = false,
    ) {
      yield* gate.withPermit(
        Effect.sync(() => {
          const current = entries.get(id);
          if (
            current?.entry.enabled &&
            current.credential &&
            (forced || now() >= current.retryAt) &&
            (!admissionCheck || !reserved(current)) &&
            !pending.has(id) &&
            !workers.has(id)
          ) {
            current.recheck = true;
            current.ticket = ++ticket;
            enqueue(current, false);
          }
        }),
      );
      yield* launch();
      const flight = workers.get(id);
      // This worker belongs to the registry scope, including when another caller
      // already started it. A timed-out waiter must not cancel shared resolution.
      if (forced && flight) yield* Fiber.join(flight);
    });
    const awaitIdle = Effect.fn("BuilderRegistry.awaitIdle")(function* () {
      while (workers.size || pending.size) {
        yield* launch();
        yield* Effect.forEach([...workers.values()], Fiber.join);
      }
    });
    const admit = Effect.fn("BuilderRegistry.admit")(function* (
      target?: string,
    ) {
      const candidates =
        target !== undefined
          ? [target]
          : !desired || desired.defaultBuilder === null
            ? []
            : [
                desired.defaultBuilder,
                ...(desired.selection.fallback === "before-submission"
                  ? desired.selection.fallbackBuilders
                  : []),
              ];
      for (const id of candidates) {
        const eligible = yield* gate.withPermit(
          Effect.sync(() => {
            const current = entries.get(id);
            return current && !reserved(current);
          }),
        );
        if (!eligible) continue;
        const current = entries.get(id);
        if (
          current &&
          (!current.identity ||
            current.error ||
            now() - current.checkedAt > 15_000)
        ) {
          yield* refreshHealth(id, true);
          const flight = workers.get(id);
          if (flight) yield* Fiber.join(flight);
        }
        const acquired = yield* Effect.acquireRelease(
          gate.withPermit(
            Effect.gen(function* () {
              const current = entries.get(id);
              if (!current || reason(current) || !current.identity)
                return undefined;
              const hostId = current.identity.generation.transport.hostId;
              if (reserved(current)) return undefined;
              // Pin the generation before publication can retire its current lease.
              yield* identity.retain(current.identity.generation.id);
              const controller = new AbortController();
              const admission: BuilderAdmission = {
                builderId: id,
                generationId: current.identity.generation.id,
                hostId,
                signal: controller.signal,
              };
              preparations.set(admission, {
                admission,
                controller,
                current: structuredClone(current),
              });
              return admission;
            }),
          ),
          (admission) =>
            Effect.sync(() => {
              if (admission) {
                preparations.get(admission)?.controller.abort();
                preparations.delete(admission);
              }
            }),
        );
        if (acquired) {
          return acquired;
        }
      }
      return yield* Effect.fail(
        BuilderRegistryError.new("registry-admission-closed"),
      );
    });
    const submit = Effect.fn("BuilderRegistry.submit")(function* <A, E, R>(
      admission: BuilderAdmission,
      transition: (minimumFreeBytes: number) => Effect.Effect<A, E, R>,
    ) {
      const preparing = preparations.get(admission);
      if (
        preparing?.current.credential &&
        !admission.signal.aborted &&
        now() - preparing.current.checkedAt > 15_000
      ) {
        // Preparation can outlast admission health. Check the admitted immutable
        // credential, outside the publication gate, without any item read.
        const checked = yield* identity.verify(
          preparing.current.entry,
          preparing.current.credential,
        );
        if (
          checked.generation.id !== admission.generationId ||
          checked.health.hostId !== admission.hostId
        )
          return yield* Effect.fail(
            BuilderRegistryError.new("registry-submission-closed"),
          );
        yield* gate.withPermit(
          Effect.sync(() => {
            preparing.current.identity = checked;
            preparing.current.checkedAt = now();
          }),
        );
      }
      return yield* gate.withPermit(
        Effect.gen(function* () {
          const preparation = preparations.get(admission),
            current = entries.get(admission.builderId);
          if (
            !preparation ||
            admission.signal.aborted ||
            !current?.entry.enabled ||
            stale ||
            current.duplicate ||
            preparation.current.duplicate ||
            preparation.current.recheck
          )
            return yield* Effect.fail(
              BuilderRegistryError.new("registry-submission-closed"),
            );
          // A source edit doesn't retarget an already admitted generation. Policy always uses the latest floor.
          const policy = { ...preparation.current, entry: current.entry };
          if (reason(policy))
            return yield* Effect.fail(
              BuilderRegistryError.new("registry-submission-closed"),
            );
          // The durable transition and its in-memory handoff are one interrupt-safe
          // operation. The callback must only commit ownership, never run SSH.
          return yield* transition(current.entry.minimumFreeBytes).pipe(
            Effect.tap(() => Effect.sync(() => preparations.delete(admission))),
            Effect.uninterruptible,
          );
        }),
      );
    });
    return {
      needsRefresh: (id: string, generationId: string) => {
        const current = entries.get(id);
        if (current?.identity?.generation.id === generationId) {
          current.error = "needs-refresh";
          current.retryAt = 0;
        }
      },
      enabled: (id: string) =>
        !stale && !error && entries.get(id)?.entry.enabled === true,
      matchesSource: (source: {
        builderId: string;
        source: string;
        revision: number;
      }) => {
        const entry = entries.get(source.builderId)?.entry;
        return (
          desired === undefined ||
          (!!entry &&
            sourceReference(entry.secretSource) === source.source &&
            entry.secretRevision === source.revision)
        );
      },
      // Private control-plane access. HTTP and tools must project sanitized fields.
      current: (id: string) => {
        const current = entries.get(id);
        return current === undefined ? undefined : structuredClone(current);
      },
      recordHealth: Effect.fn("BuilderRegistry.recordHealth")(
        (
          id: string,
          generationId: string,
          health: BuilderIdentityResult["health"],
          failure?: string,
        ) =>
          gate.withPermit(
            Effect.sync(() => {
              const current = entries.get(id);
              if (
                !current?.identity ||
                current.identity.generation.id !== generationId
              )
                return;
              const error =
                failure ||
                health.kind !== "health" ||
                health.hostId !==
                  current.identity.generation.transport.hostId ||
                health.profile !== "registry-only"
                  ? (failure ?? "builder-identity-mismatch")
                  : undefined;
              const checkedAt = now();
              current.error = error;
              if (!error) {
                current.identity = { ...current.identity, health };
                current.checkedAt = checkedAt;
              }
              // Share the verified observation, never a mutable admission object.
              for (const preparation of preparations.values()) {
                if (
                  preparation.admission.generationId !== generationId ||
                  !preparation.current.identity
                )
                  continue;
                preparation.current.error = error;
                if (!error) {
                  preparation.current.identity = structuredClone({
                    ...preparation.current.identity,
                    health,
                  });
                  preparation.current.checkedAt = checkedAt;
                }
              }
            }),
          ),
      ),
      installCredential: Effect.fn("BuilderRegistry.installCredential")(
        function* (
          id: string,
          revision: number,
          credential: BuilderCredential,
        ) {
          yield* gate.withPermit(
            Effect.sync(() => {
              const current = entries.get(id);
              if (
                !current?.entry.enabled ||
                current.entry.secretRevision !== revision ||
                sourceReference(current.entry.secretSource) !==
                  credential.transport.source
              )
                return;
              current.credential = credential;
              current.recheck = true;
              current.ticket = ++ticket;
              enqueue(current, false);
            }),
          );
          yield* launch();
        },
      ),
      publish,
      refreshHealth,
      awaitIdle,
      admit,
      submit,
      fault: Effect.fn("BuilderRegistry.fault")((cause: BuilderRegistryError) =>
        gate.withPermit(
          Effect.sync(() => {
            error = cause.code;
            failures.set("registry", cause);
            if (cause.code === "registry-mount-stale") stale = true;
            for (const item of preparations.values()) item.controller.abort();
          }),
        ),
      ),
      snapshot: () => ({
        revision,
        desired: desired === undefined ? undefined : structuredClone(desired),
        error,
        entries: [...entries.values()].map((current) => ({
          id: current.entry.id,
          available: reason(current) === undefined && !reserved(current),
          reason:
            reason(current) ??
            (reserved(current) ? "builder-reserved" : undefined),
          generationId: current.identity?.generation.id,
          hostId: current.credential?.transport.hostId,
        })),
      }),
    };
  },
);
