import { Duration, Effect, Option, Ref, Semaphore } from "effect";
import type { SessionId } from "../domain/ids.js";

export const makeProcessingGate = (
  processingGates: Ref.Ref<
    Map<SessionId, { semaphore: Semaphore.Semaphore; users: number }>
  >,
) => {
  return <A, E, R>(sessionId: SessionId, effect: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const candidate = yield* Semaphore.make(1);
        const semaphore = yield* Ref.modify(processingGates, (gates) => {
          const entry = gates.get(sessionId) ?? {
            semaphore: candidate,
            users: 0,
          };
          const next = new Map(gates).set(sessionId, {
            ...entry,
            users: entry.users + 1,
          });
          return [entry.semaphore, next] as const;
        });
        return yield* restore(semaphore.withPermits(1)(effect)).pipe(
          Effect.ensuring(
            Ref.update(processingGates, (gates) => {
              const next = new Map(gates);
              const entry = next.get(sessionId);
              if (entry !== undefined) {
                if (entry.users === 1) next.delete(sessionId);
                else next.set(sessionId, { ...entry, users: entry.users - 1 });
              }
              return next;
            }),
          ),
        );
      }),
    );
};

const CANCEL_GATE_TIMEOUT_MS = 30_000;

export const makeMutationGates = (
  sessionMutationGatesRef: Ref.Ref<ReadonlyMap<SessionId, Semaphore.Semaphore>>,
  stopDeferralCountsRef: Ref.Ref<
    ReadonlyMap<SessionId, ReadonlyMap<string, number>>
  >,
) => {
  const sessionMutationGate = (
    sessionId: SessionId,
  ): Effect.Effect<Semaphore.Semaphore, never, never> =>
    Ref.modify(sessionMutationGatesRef, (gates) => {
      const existing = gates.get(sessionId);
      if (existing !== undefined) return [existing, gates];
      const created = Semaphore.makeUnsafe(1);
      const next = new Map(gates);
      next.set(sessionId, created);
      return [created, next];
    });
  const withSessionMutationGate = <A, E, R>(
    sessionId: SessionId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(sessionMutationGate(sessionId), (gate) =>
      gate.withPermits(1)(effect),
    );
  const withCancelMutationGate = <A, E, R>(
    sessionId: SessionId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const gate = yield* sessionMutationGate(sessionId);
      const acquired = yield* gate
        .take(1)
        .pipe(
          Effect.as(true),
          Effect.timeoutOption(Duration.millis(CANCEL_GATE_TIMEOUT_MS)),
        );
      if (Option.isNone(acquired)) {
        yield* Effect.logWarning("authority.cancel_gate_timeout").pipe(
          Effect.annotateLogs({
            event: "authority.cancel_gate_timeout",
            sessionId,
            timeoutMs: CANCEL_GATE_TIMEOUT_MS,
          }),
        );
        return yield* effect;
      }
      return yield* effect.pipe(
        Effect.ensuring(gate.release(1).pipe(Effect.asVoid)),
      );
    });
  const releaseMutationGate = (
    sessionId: SessionId,
  ): Effect.Effect<void, never, never> =>
    Ref.update(sessionMutationGatesRef, (gates) => {
      const next = new Map(gates);
      next.delete(sessionId);
      return next;
    });
  const recordStopDeferral = (
    sessionId: SessionId,
    inputId: string,
  ): Effect.Effect<number, never, never> =>
    Ref.modify(stopDeferralCountsRef, (counts) => {
      const next = new Map(counts);
      const sessionCounts = new Map(next.get(sessionId) ?? []);
      const count = (sessionCounts.get(inputId) ?? 0) + 1;
      sessionCounts.set(inputId, count);
      next.set(sessionId, sessionCounts);
      return [count, next];
    });
  const clearSessionStopDeferrals = (
    sessionId: SessionId,
  ): Effect.Effect<void, never, never> =>
    Ref.update(stopDeferralCountsRef, (counts) => {
      const next = new Map(counts);
      next.delete(sessionId);
      return next;
    });

  return {
    withSessionMutationGate,
    withCancelMutationGate,
    releaseMutationGate,
    recordStopDeferral,
    clearSessionStopDeferrals,
  };
};
