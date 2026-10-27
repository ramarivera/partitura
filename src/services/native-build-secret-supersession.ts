import { Effect } from "effect";
import type { NativeSecretJournal } from "./native-build-secret-journal.js";
import type {
  SecretOperation,
  SecretSource,
  SecretWork,
} from "./native-build-secret-models.js";

/** Private scheduling fences. Recovery refreshes remain independent of desired
 * admission; persisted ordinary work must be revalidated before any dispatch. */
export const makeNativeSecretSupersession = (
  journal: NativeSecretJournal["Service"],
  now: () => number,
) => {
  const key = (op: SecretOperation, work: SecretWork) =>
    `${op.id}:${work.builderId}:${work.source}@${work.revision}`;
  const obsolete = new Set<string>();
  let desired: ((source: SecretSource) => boolean) | undefined;
  const mismatched = (work: SecretWork) =>
    !work.retained && desired?.(work) === false;
  const restored = new Set(
    journal
      .snapshot()
      .operations.flatMap((op) =>
        op.sources
          .filter(
            (work) =>
              !work.retained && ["pending", "running"].includes(work.status),
          )
          .map((work) => key(op, work)),
      ),
  );
  const capture = (ids: readonly string[]) => {
    const selected = new Set(ids);
    return journal
      .snapshot()
      .operations.flatMap((op) =>
        op.sources
          .filter(
            (work) =>
              !work.retained &&
              selected.has(work.builderId) &&
              work.status === "pending",
          )
          .map((work) => key(op, work)),
      );
  };
  const flush = Effect.fn("NativeBuildSecretCache.flushObsolete")(function* () {
    for (const op of journal.snapshot().operations)
      for (const work of op.sources)
        if (work.status === "pending" && mismatched(work))
          obsolete.add(key(op, work));
    if (!obsolete.size) return;
    const selected = new Set(obsolete);
    yield* journal.transaction((data, at) => {
      for (const op of data.operations)
        for (const work of op.sources)
          if (selected.has(key(op, work)) && work.status === "pending") {
            work.status = "superseded";
            work.completedAt = at;
          }
    }, now());
    for (const id of selected) obsolete.delete(id);
  });
  return {
    capture,
    observeDesired: (predicate: (source: SecretSource) => boolean) => {
      desired = predicate;
      return () => {
        if (desired === predicate) desired = undefined;
      };
    },
    blocked: (op: SecretOperation, work: SecretWork) =>
      obsolete.has(key(op, work)) ||
      restored.has(key(op, work)) ||
      mismatched(work),
    held: (op: SecretOperation, work: SecretWork) =>
      restored.has(key(op, work)),
    flush,
    supersede: Effect.fn("NativeBuildSecretCache.fenceSupersession")(function* (
      ids: readonly string[],
      captured = capture(ids),
    ) {
      for (const id of captured) obsolete.add(id);
      yield* flush();
    }),
    revalidate: Effect.fn("NativeBuildSecretCache.revalidatePending")(
      function* (sources: readonly SecretSource[]) {
        if (!restored.size) return;
        const selected = new Set(restored);
        yield* journal.transaction((data, at) => {
          for (const op of data.operations)
            for (const work of op.sources)
              if (
                selected.has(key(op, work)) &&
                work.status === "pending" &&
                !sources.some(
                  (source) =>
                    source.builderId === work.builderId &&
                    source.source === work.source &&
                    source.revision === work.revision,
                )
              ) {
                work.status = "superseded";
                work.completedAt = at;
              }
        }, now());
        for (const id of selected) restored.delete(id);
      },
    ),
  };
};
