import { Schema } from "effect";
import type { NativeBuildJob } from "./native-build-legacy-receipt.js";

const messages = {
  "execution-interrupted":
    "Native build execution was interrupted. The final broker outcome may still be pending.",
  "workflow-failed": "The native build workflow failed.",
  "cleanup-required":
    "Native build cleanup is required before the host can be reused.",
  "host-key-unavailable": "The native build host key is unavailable.",
  "unlock-failed": "The native build keychain could not be unlocked.",
  "host-capacity-unavailable":
    "The native build host has insufficient capacity.",
  "host-disk-space-unavailable":
    "The native build host has insufficient disk space.",
  "receive-interrupted": "The native build source transfer was interrupted.",
  "keychain-policy-unavailable":
    "The native build keychain policy is unavailable.",
} satisfies Record<NonNullable<NativeBuildJob["failureCode"]>, string>;

/** Presentation only: a lost session must not become a confirmed terminal
 * receipt. Keep receipt lookup and idempotent broker cancellation available. */
export const legacyNativeFailure = (job: NativeBuildJob) => {
  if (job.state !== "failed") return undefined;
  const failureCode = job.failureCode ?? "execution-interrupted";
  return { failureCode, message: messages[failureCode] };
};

/** Only fixed diagnostics may cross the host-tool error boundary. */
export class NativeArtifactFailure extends Schema.TaggedError<NativeArtifactFailure>()(
  "@Gateway/NativeArtifactFailure",
  {
    diagnostic: Schema.Struct({
      failureCode: Schema.String,
      message: Schema.String,
    }),
    message: Schema.String,
  },
) {
  static unavailable(
    diagnostic: NonNullable<ReturnType<typeof legacyNativeFailure>>,
  ) {
    return new NativeArtifactFailure({
      diagnostic,
      message: `Native build has no deliverable artifact: ${diagnostic.failureCode}. ${diagnostic.message}`,
    });
  }
}
