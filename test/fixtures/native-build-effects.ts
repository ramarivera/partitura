import { Effect, type Scope } from "effect";
import { NativeOperationError } from "../../src/services/native-build-errors.js";
/** Filesystem assertions use promises; domain operations stay Effects. */
export function testAwait<A, E, R>(
  value: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R>;
export function testAwait<A>(
  value: PromiseLike<A>,
): Effect.Effect<A, NativeOperationError>;
export function testAwait<A, E, R>(
  value: PromiseLike<A> | Effect.Effect<A, E, R>,
): Effect.Effect<A, E | NativeOperationError, R> {
  return Effect.isEffect(value)
    ? value
    : Effect.tryPromise({
        try: () => Promise.resolve(value),
        catch: (cause) => NativeOperationError.new("test-io-failed", cause),
      });
}
export const testRejects = <A, E>(
  value: PromiseLike<A> | Effect.Effect<A, E, Scope.Scope>,
): Promise<A> =>
  Effect.isEffect(value)
    ? Effect.runPromise(Effect.scoped(value))
    : Promise.resolve(value);
