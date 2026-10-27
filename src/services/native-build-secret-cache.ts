import {
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Queue,
  Schema,
  Semaphore,
} from "effect";
import {
  type BuilderCredential,
  normalizeBuilderFileRecord,
} from "./builder-secret-record.js";
import { BuilderRegistryConfig } from "./config-native-build.js";
import { opaqueId } from "./native-build-file-io.js";
import { NativeSecretBudget } from "./native-build-secret-budget.js";
import { NativeSecretJournal } from "./native-build-secret-journal.js";
import {
  type SecretBucket,
  type SecretJournalData,
  type SecretOperation,
  SecretSource,
  type SecretWork,
} from "./native-build-secret-models.js";
import { NativeSecretError } from "./native-build-secret-protocol.js";
import { NativeSecretSourceReader } from "./native-build-secret-reader.js";

export type SecretTrigger = "startup" | "registry" | "human" | "agent";
export const sourceKey = (source: Pick<SecretSource, "source" | "revision">) =>
  `${source.source}@${source.revision}`;
export class NativeSecretScheduling extends Context.Reference<boolean>(
  "NativeSecretScheduling",
  { defaultValue: () => true },
) {}
const runnable = <T extends { work: SecretWork }>(items: readonly T[]) => {
  const ordered = [...items].sort(
    (a, b) =>
      Number(b.work.retained) - Number(a.work.retained) ||
      a.work.builderId.localeCompare(b.work.builderId),
  );
  const distinct = new Map<string, T>();
  for (const item of ordered)
    if (!distinct.has(sourceKey(item.work)))
      distinct.set(sourceKey(item.work), item);
  return [...distinct.values()].slice(0, 64);
};
const terminal = (work: SecretWork) =>
  work.status !== "pending" && work.status !== "running";
const transient = new Set([
  "provider-unavailable",
  "provider-timeout",
  "provider-rate-limited",
  "provider-budget-exhausted",
  "startup-crash-backoff",
]);
const retryDelay = (attempts: number) =>
  Math.min(600000, 30000 * 2 ** Math.min(5, Math.max(0, attempts - 1)));

/** Durable operations contain public source references only. Secret snapshots never leave this map. */
export class NativeBuildSecretCache extends Context.Service<NativeBuildSecretCache>()(
  "NativeBuildSecretCache",
  {
    make: Effect.gen(function* () {
      const journal = yield* NativeSecretJournal;
      const budget = yield* NativeSecretBudget;
      const reader = yield* NativeSecretSourceReader;
      const settings = yield* BuilderRegistryConfig;
      const clock = yield* Clock.Clock;
      const now = () => clock.currentTimeMillisUnsafe();
      const wake = yield* Queue.dropping<void>(1);
      let changed = yield* Deferred.make<void>();
      const notify = Effect.fn("NativeBuildSecretCache.notify")(function* () {
        const previous = changed;
        changed = yield* Deferred.make<void>();
        yield* Deferred.succeed(previous, undefined);
      });
      const dispatch = yield* Semaphore.make(1);
      const cache = new Map<string, BuilderCredential>();
      let cycleRecorded = false;
      // A crash after dispatch is ambiguous and already charged. Only startup may retry.
      yield* journal.transaction((data, at) => {
        for (const operation of data.operations)
          for (const work of operation.sources)
            if (work.status === "running") {
              work.status =
                operation.kind === "startup" &&
                work.attempts < 8 &&
                work.deadline > at
                  ? "pending"
                  : "failed";
              work.code = "provider-unavailable";
              work.nextFit = Math.max(at, data.cooldowns[work.source] ?? 0);
              if (operation.kind === "startup" && work.status === "failed")
                data.startupStops[sourceKey(work)] = {
                  code: work.code,
                  createdAt: work.createdAt,
                  deadline: work.deadline,
                  attempts: work.attempts,
                  nextFit: work.nextFit,
                };
            }
      }, now());
      const progress = (id: string) => {
        const snapshot = journal.snapshot();
        const operation = snapshot.operations.find((item) => item.id === id);
        if (!operation) return undefined;
        return {
          id,
          acceptedAt: operation.acceptedAt,
          deadline: Math.min(
            operation.deadline,
            ...operation.sources.map((work) => work.deadline),
          ),
          done: operation.sources.every(terminal),
          sources: operation.sources.map((work) => ({
            builderId: work.builderId,
            revision: work.revision,
            status: work.status,
            attempts: work.attempts,
            nextFit: work.nextFit,
            code: work.code,
            readStartedAt: work.readStartedAt,
            completedAt: work.completedAt,
            lastSuccessAt: snapshot.successes[sourceKey(work)],
          })),
        };
      };
      const capacity = Effect.fn("NativeBuildSecretCache.capacity")(function* (
        sources: readonly SecretSource[],
      ) {
        const count = new Set(
          [
            ...sources,
            ...journal
              .snapshot()
              .operations.flatMap((op) =>
                op.sources.filter((work) => work.retained && !terminal(work)),
              ),
          ]
            .filter((item) => item.source.startsWith("onepassword:"))
            .map((item) => item.source),
        ).size;
        const pending = new Set(
          journal
            .snapshot()
            .operations.filter((op) => op.kind === "startup")
            .flatMap((op) =>
              op.sources
                .filter(
                  (work) =>
                    work.status === "pending" &&
                    work.attempts === 0 &&
                    work.source.startsWith("onepassword:"),
                )
                .map((work) => work.source),
            ),
        ).size;
        return yield* budget.capacity(
          count,
          pending ? 8 + 4 * pending : 0,
          now(),
        );
      });
      const accept = Effect.fn("NativeBuildSecretCache.accept")(function* (
        kind: SecretTrigger,
        sources: readonly SecretSource[],
        org: string,
        all = false,
      ) {
        if (
          !sources.length ||
          sources.length > 320 ||
          ((kind === "agent" || kind === "human") && !org)
        )
          return yield* Effect.fail(
            NativeSecretError.new("provider-operation-invalid"),
          );
        const checked = yield* Schema.decodeUnknownEffect(
          Schema.Array(SecretSource),
        )(sources, { onExcessProperty: "error" }).pipe(
          Effect.mapError(() =>
            NativeSecretError.new("provider-operation-invalid"),
          ),
        );
        if (kind === "startup" || kind === "registry") {
          const pool = yield* capacity(sources);
          if (!pool.sufficient)
            return yield* Effect.fail(NativeSecretError.new("budget-capacity"));
        }
        const id = yield* journal.transaction((data, at) => {
          while (data.operations.length >= 128) {
            const index = data.operations.findIndex((op) =>
              op.sources.every(terminal),
            );
            if (index < 0) break;
            data.operations.splice(index, 1);
          }
          if (
            data.operations.length >= 128 ||
            Object.keys(data.startupStops).length > 320
          )
            throw NativeSecretError.new("provider-queue-full");
          if (kind === "human" || kind === "agent") {
            const calls = data.submissions.filter(
              (call) => call.org === org && call.at > at - 60000,
            );
            if (calls.length >= 10)
              throw NativeSecretError.new(
                "provider-submission-limited",
                (calls[0]?.at ?? at) + 60000,
              );
            const lastAll = data.submissions.filter((call) => call.all).at(-1);
            if (all && lastAll && lastAll.at + 300000 > at)
              throw NativeSecretError.new(
                "provider-submission-limited",
                lastAll.at + 300000,
              );
            data.submissions.push({ at, org, all });
          }
          const distinct = new Map(
            checked.map((source) => [source.source, source]),
          );
          const selected = [...distinct.values()].sort(
            (a, b) =>
              Number(b.retained) - Number(a.retained) ||
              a.builderId.localeCompare(b.builderId),
          );
          const unfinished = data.operations.flatMap((operation) =>
            operation.sources.filter((work) => !terminal(work)),
          );
          if (
            new Set([...unfinished, ...selected].map((work) => work.source))
              .size > 320
          )
            throw NativeSecretError.new("provider-queue-full");
          // Registry events replace obsolete work that has not dispatched; they never retarget a read already begun.
          if (kind === "registry")
            for (const old of unfinished)
              if (
                old.status === "pending" &&
                selected.some(
                  (source) =>
                    source.builderId === old.builderId &&
                    sourceKey(source) !== sourceKey(old),
                )
              )
                old.status = "superseded";
          const work = selected.map((source): SecretWork => {
            const key = sourceKey(source);
            const previous = data.operations
              .filter((op) => op.kind === "startup")
              .flatMap((op) => op.sources)
              .filter((work) => sourceKey(work) === key)
              .at(-1);
            const stopped =
              kind === "startup" ? data.startupStops[key] : undefined;
            const resume =
              kind === "startup" &&
              previous &&
              previous.status !== "succeeded" &&
              previous.status !== "superseded" &&
              !(
                previous.status === "failed" &&
                (data.successes[key] ?? -1) >
                  (previous.completedAt ?? previous.createdAt)
              );
            const cachedNoop = kind === "agent" && cache.has(key);
            return {
              ...source,
              createdAt:
                stopped?.createdAt ?? (resume ? previous.createdAt : at),
              deadline:
                stopped?.deadline ??
                (resume ? previous.deadline : at + 7200000),
              attempts: stopped?.attempts ?? (resume ? previous.attempts : 0),
              status: stopped
                ? "failed"
                : cachedNoop
                  ? "cached-noop"
                  : resume && terminal(previous)
                    ? "failed"
                    : "pending",
              nextFit: stopped?.nextFit ?? (resume ? previous.nextFit : at),
              ...(stopped ? { code: stopped.code } : {}),
              ...(resume && previous.code ? { code: previous.code } : {}),
            };
          });
          const operation: SecretOperation = {
            id: opaqueId(),
            kind,
            org,
            all,
            acceptedAt: at,
            deadline: at + 7200000,
            sources: work,
          };
          data.operations.push(operation);
          return operation.id;
        }, now());
        yield* Queue.offer(wake, undefined);
        yield* notify();
        return id;
      });
      const tick = Effect.fn("NativeBuildSecretCache.tick")(
        () =>
          dispatch.withPermit(
            Effect.gen(function* () {
              const expired = new Map<
                string,
                { builderId: string; code: string; nextFit: number }
              >();
              const selected = yield* journal.transaction((data, at) => {
                for (const operation of data.operations)
                  for (const work of operation.sources)
                    if (work.status === "pending" && work.deadline <= at) {
                      work.status = "failed";
                      work.code = work.code ?? "provider-startup-expired";
                      work.completedAt = at;
                      if (operation.kind === "startup")
                        expired.set(sourceKey(work), {
                          builderId: work.builderId,
                          code: work.code,
                          nextFit: work.nextFit,
                        });
                      if (operation.kind === "startup")
                        data.startupStops[sourceKey(work)] = {
                          code: work.code,
                          createdAt: work.createdAt,
                          deadline: work.deadline,
                          attempts: work.attempts,
                          nextFit: work.nextFit,
                        };
                    }
                const candidates = data.operations.flatMap((operation) =>
                  operation.sources
                    .filter((work) => work.status === "pending")
                    .map((work) => ({ operation, work })),
                );
                const queue = runnable(candidates);
                const ready = queue.find(({ work }) => work.nextFit <= at);
                return ready
                  ? { operation: ready.operation, work: ready.work }
                  : undefined;
              }, now());
              yield* Effect.forEach([...expired.values()], (attention) =>
                Effect.logWarning(
                  "Native provider startup expired; human resolution required",
                  attention,
                ),
              );
              if (!selected) return;
              const { operation, work } = selected,
                key = sourceKey(work);
              let started: number | undefined;
              let dispatched = false;
              const bucket: SecretBucket =
                operation.kind === "startup"
                  ? work.attempts
                    ? "retry"
                    : "bootstrap"
                  : operation.kind === "agent"
                    ? "agent"
                    : "human";
              const markWork = (
                data: SecretJournalData,
                at: number,
                reading: boolean,
              ) => {
                let matched = false;
                for (const op of data.operations)
                  for (const candidate of op.sources) {
                    if (
                      sourceKey(candidate) !== key ||
                      !(
                        candidate.status === "pending" ||
                        (reading &&
                          candidate.status === "running" &&
                          candidate.readStartedAt === undefined)
                      )
                    )
                      continue;
                    matched = true;
                    if (candidate.status === "pending") {
                      candidate.attempts++;
                      delete candidate.readStartedAt;
                      delete candidate.code;
                    }
                    candidate.status = "running";
                    if (reading) candidate.readStartedAt = at;
                  }
                if (!matched)
                  throw NativeSecretError.new("provider-operation-superseded");
              };
              const mark = Effect.fn("NativeBuildSecretCache.started")(
                function* () {
                  const at = yield* journal.transaction((data, at) => {
                    markWork(data, at, true);
                    return at;
                  }, now());
                  dispatched = true;
                  started = at;
                },
              );
              yield* Effect.gen(function* () {
                if (
                  operation.kind === "startup" &&
                  work.source.startsWith("onepassword:") &&
                  !cycleRecorded
                ) {
                  const fit = yield* budget.startupCycle(now());
                  if (fit > now())
                    return yield* Effect.fail(
                      NativeSecretError.new("startup-crash-backoff", fit),
                    );
                  cycleRecorded = true;
                }
                if (!work.source.startsWith("onepassword:")) {
                  yield* mark();
                }
                const record = yield* reader.read(
                  work.source,
                  (units) =>
                    budget
                      .reserve(
                        bucket,
                        units,
                        work.source,
                        operation.org,
                        now(),
                        (data) =>
                          data.operations.some((op) =>
                            op.sources.some(
                              (candidate) =>
                                sourceKey(candidate) === key &&
                                candidate.status === "pending",
                            ),
                          ),
                        (data, at) => markWork(data, at, false),
                      )
                      .pipe(
                        Effect.tap(() =>
                          Effect.sync(() => {
                            dispatched = true;
                          }),
                        ),
                      ),
                  () => mark(),
                );
                if (started === undefined) yield* mark(); // File sources have the same operation semantics and no provider debit.
                const credential = yield* normalizeBuilderFileRecord(
                  Buffer.from(JSON.stringify(record)),
                  work.source,
                  settings.suffix,
                ).pipe(
                  Effect.mapError(() =>
                    NativeSecretError.new("builder-record-invalid"),
                  ),
                );
                yield* journal.transaction((data, at) => {
                  if (
                    Object.keys(data.successes).length >= 320 &&
                    data.successes[key] === undefined
                  )
                    throw NativeSecretError.new("provider-queue-full");
                  data.successes[key] = at;
                  delete data.startupStops[key];
                  for (const op of data.operations)
                    for (const candidate of op.sources)
                      if (
                        candidate.status === "running" &&
                        sourceKey(candidate) === key &&
                        candidate.readStartedAt === started
                      ) {
                        candidate.status = "succeeded";
                        candidate.completedAt = at;
                        delete candidate.code;
                      }
                }, now());
                cache.set(key, credential);
              }).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    yield* journal.transaction((data, at) => {
                      if (error.code === "provider-rate-limited")
                        data.providerBackoff = Math.max(
                          data.providerBackoff,
                          at + 900000,
                          error.nextFit ?? 0,
                        );
                      for (const op of data.operations)
                        for (const candidate of op.sources) {
                          if (
                            sourceKey(candidate) !== key ||
                            (!dispatched
                              ? candidate.status !== "pending"
                              : candidate.status !== "running" ||
                                candidate.readStartedAt !== started)
                          )
                            continue;
                          candidate.code = error.code;
                          const fit = Math.max(
                            at +
                              (candidate.attempts
                                ? retryDelay(candidate.attempts)
                                : 1),
                            error.nextFit ?? 0,
                            data.cooldowns[candidate.source] ?? 0,
                            data.providerBackoff,
                          );
                          const retry = !dispatched
                            ? error.code === "provider-budget-exhausted" ||
                              error.code === "startup-crash-backoff"
                            : op.kind === "startup" &&
                              transient.has(error.code) &&
                              candidate.attempts < 8;
                          candidate.status =
                            retry && fit < candidate.deadline
                              ? "pending"
                              : "failed";
                          candidate.nextFit = fit;
                          if (candidate.status === "failed") {
                            candidate.completedAt = at;
                            if (op.kind === "startup")
                              data.startupStops[key] = {
                                code: error.code,
                                createdAt: candidate.createdAt,
                                deadline: candidate.deadline,
                                attempts: candidate.attempts,
                                nextFit: candidate.nextFit,
                              };
                          }
                        }
                    }, now());
                    yield* Effect.logWarning(
                      "Native provider operation needs attention",
                      {
                        builderId: work.builderId,
                        code: error.code,
                        nextFit: error.nextFit,
                      },
                    );
                  }),
                ),
              );
            }),
          ),
        Effect.ensuring(notify()),
      );
      const supersede = Effect.fn("NativeBuildSecretCache.supersede")(
        function* (builderIds: readonly string[]) {
          const ids = new Set(builderIds);
          yield* journal.transaction((data, at) => {
            for (const operation of data.operations)
              for (const work of operation.sources)
                if (
                  !work.retained &&
                  ids.has(work.builderId) &&
                  work.status === "pending"
                ) {
                  work.status = "superseded";
                  work.completedAt = at;
                }
          }, now());
          yield* Queue.offer(wake, undefined);
          yield* notify();
        },
      );
      const wait = Effect.fn("NativeBuildSecretCache.wait")(function* (
        id: string,
      ) {
        for (;;) {
          const signal = changed;
          const state = progress(id);
          if (!state)
            return yield* Effect.fail(
              NativeSecretError.new("provider-operation-missing"),
            );
          if (state.done) return state;
          if (now() >= state.deadline)
            return yield* Effect.fail(
              NativeSecretError.new("provider-operation-expired"),
            );
          yield* Effect.raceFirst(
            Deferred.await(signal),
            Effect.sleep(state.deadline - now()),
          );
        }
      });
      if (yield* NativeSecretScheduling)
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              yield* tick();
              const pending = journal
                .snapshot()
                .operations.flatMap((operation) =>
                  operation.sources.filter((work) => work.status === "pending"),
                );
              const next = Math.min(
                ...runnable(pending.map((work) => ({ work }))).map(
                  ({ work }) => work.nextFit,
                ),
                ...pending.map((work) => work.deadline),
              );
              if (!Number.isFinite(next)) yield* Queue.take(wake);
              else if (next <= now()) yield* Effect.yieldNow;
              else
                yield* Effect.raceFirst(
                  Queue.take(wake),
                  Effect.sleep(Math.max(1, next - now())),
                );
            }).pipe(
              Effect.catch((error) =>
                Effect.logError("Native provider scheduler iteration failed", {
                  code: error.code,
                }).pipe(Effect.andThen(Effect.sleep(1000))),
              ),
            ),
          ),
        );
      return {
        accept,
        tick,
        wait,
        progress,
        capacity,
        supersede,
        cached: (source: SecretSource) => cache.get(sourceKey(source)),
        retainNeeded: Effect.fn("NativeBuildSecretCache.retainNeeded")(
          function* (sources: readonly SecretSource[]) {
            // Assembly supplies the full enabled + retained-recovery inventory, never just a UI page or desired registry alone.
            const checked = yield* Schema.decodeUnknownEffect(
              Schema.Array(SecretSource).check(Schema.isMaxLength(320)),
            )(sources, { onExcessProperty: "error" }).pipe(
              Effect.mapError(() =>
                NativeSecretError.new("provider-operation-invalid"),
              ),
            );
            const retained = yield* journal.transaction((data) => {
              const keys = new Set([
                ...checked.map(sourceKey),
                ...data.operations.flatMap((op) =>
                  op.sources.filter((work) => !terminal(work)).map(sourceKey),
                ),
              ]);
              for (const key of Object.keys(data.successes))
                if (!keys.has(key)) delete data.successes[key];
              for (const key of Object.keys(data.startupStops))
                if (!keys.has(key)) delete data.startupStops[key];
              data.operations = data.operations.filter(
                (op) =>
                  !op.sources.every(
                    (work) => terminal(work) && !keys.has(sourceKey(work)),
                  ),
              );
              return keys;
            }, now());
            for (const key of cache.keys())
              if (!retained.has(key)) cache.delete(key);
          },
        ),
        resolve: Effect.fn("NativeBuildSecretCache.resolve")(function* (
          source: SecretSource,
          trigger: "startup" | "registry",
        ) {
          // Startup can reuse this process's completed source. Each accepted registry edit remains a read trigger, including revision rollback.
          const cached = cache.get(sourceKey(source));
          if (cached && trigger === "startup") return cached;
          const id = yield* accept(trigger, [source], "");
          const result = yield* wait(id);
          const credential = cache.get(sourceKey(source));
          if (
            !credential ||
            result.sources.some((work) => work.status !== "succeeded")
          )
            return yield* Effect.fail(
              NativeSecretError.new(
                result.sources[0]?.code ?? "provider-unavailable",
                result.sources[0]?.nextFit,
              ),
            );
          return credential;
        }),
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(
      Layer.mergeAll(NativeSecretBudget.layer, NativeSecretSourceReader.layer),
    ),
  );
}
