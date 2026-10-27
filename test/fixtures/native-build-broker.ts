import { Effect } from "effect";
import {
  type BrokerEnvelope,
  type NativeBrokerTransport,
  NativeTransportError,
} from "../../src/services/native-build-transport.js";
export function memoryBroker(
  clock: () => number,
  advance?: (milliseconds: number) => void,
) {
  const calls: { generationId: string; command: string }[] = [];
  const settings = {
    unavailable: false,
    unavailableDelay: 0,
    busy: false,
    fresh: true,
    cleanup: "",
    badHealthEpoch: false,
    healthError: false,
    healthFailure: "" as "" | NativeTransportError["reason"],
  };
  const transport: NativeBrokerTransport = {
    hasCredential: () => true,
    artifact: () => Effect.fail(NativeTransportError.new("unavailable")),
    envelope: (generation, command, job) =>
      Effect.try({
        try: (): BrokerEnvelope => {
          calls.push({ generationId: generation.id, command });
          if (settings.unavailable) {
            advance?.(settings.unavailableDelay);
            throw NativeTransportError.new("unavailable");
          }
          const base = {
            protocolVersion: 2 as const,
            hostId: generation.transport.hostId,
          };
          if (command === "health") {
            if (settings.healthFailure)
              throw NativeTransportError.new(settings.healthFailure);
            if (settings.healthError)
              return {
                ...base,
                kind: "error",
                code: "broker-state-unavailable",
              };
            return {
              ...base,
              kind: "health",
              profile: "registry-only",
              status: "ready",
              accepting: true,
              capacity: 1,
              reasons: [],
              epoch: (settings.badHealthEpoch ? "f" : "a").repeat(32),
            };
          }
          if (!job) throw NativeTransportError.new("protocol-mismatch");
          if (command.startsWith("cancel "))
            return { ...base, kind: "cancellation-requested", job: job.jobId };
          if (settings.cleanup)
            return { ...base, kind: settings.cleanup, job: job.jobId };
          if (settings.busy)
            return {
              ...base,
              kind: "busy",
              job: job.jobId,
              runner: {
                job: job.jobId,
                attempt: job.attempt,
                stage: "receiving",
                heartbeat: (clock() - (settings.fresh ? 0 : 120_000)) / 1000,
              },
            };
          return {
            ...base,
            kind: "reconciled-unknown",
            job: job.jobId,
            epoch: "a".repeat(32),
            nonce: "c".repeat(32),
            reconciledJobs: [job.jobId],
          };
        },
        catch: (error) =>
          error instanceof NativeTransportError
            ? error
            : NativeTransportError.new("unavailable", error),
      }),
  };
  return { calls, settings, transport };
}
