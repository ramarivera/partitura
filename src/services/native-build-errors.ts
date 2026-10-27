import { Effect, Schema } from "effect";

/** Private causes stay in the typed error channel. Persist only fixed reasons. */
export class NativeOperationError extends Schema.TaggedError<NativeOperationError>()(
  "@Gateway/NativeOperationError",
  {
    reason: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Unknown),
  },
) {
  static new(reason: string, cause?: unknown) {
    return new NativeOperationError({
      reason,
      message: reason,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}
export const nativeError = (cause: unknown) =>
  cause instanceof NativeOperationError
    ? cause
    : NativeOperationError.new("native-operation-failed", cause);
export const nativeIO = <A>(operation: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: nativeError });
export const nativeTry = <A>(operation: () => A) =>
  Effect.try({ try: operation, catch: nativeError });

export type NativeResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: unknown };
export const nativeResult = <A>(
  promise: Promise<A>,
): Promise<NativeResult<A>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );

/** Attempt every finalizer, even if an earlier finalizer fails. */
export async function cleanupNative(
  actions: readonly (() => void | Promise<void>)[],
  cause?: unknown,
) {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw NativeOperationError.new(
      "native-cleanup-failed",
      new AggregateError(cause === undefined ? errors : [cause, ...errors]),
    );
}

export const nativeFailureCode = (error: unknown) =>
  error instanceof NativeOperationError
    ? error.reason
    : "native-operation-failed";
