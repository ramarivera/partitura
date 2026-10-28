import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { decodeBrokerEnvelope } from "../src/services/native-build-protocol.js";
import { cleanNativeHealth } from "../src/services/native-build-receipt.js";
import { registryFixture } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();

it.live("broker maintenance diagnostics decode and keep recovery blocked", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* registryFixture(path("broker-health"));
      const denied = {
        protocolVersion: 2,
        hostId: fixture.metadata.hostId,
        kind: "error",
        code: "storage-access-denied",
        storageAccessHint:
          "Enable Remote Login > Allow full disk access for remote users. This macOS setting cannot be set by a script.",
      };
      const decode = (value: unknown) =>
        decodeBrokerEnvelope(`${JSON.stringify(value)}\n`, fixture.generation);
      expect(decode(denied).storageAccessHint).toContain("Remote Login");
      expect(() =>
        decode({ ...denied, code: "storage-permission-denied" }),
      ).toThrow();
      expect(() =>
        decode({ ...denied, storageAccessHint: "untrusted text" }),
      ).toThrow();
      for (const reason of [
        "storage-access-denied",
        "storage-permission-denied",
        "maintenance-stale",
        "inventory-unavailable",
        "inventory-invalid",
        "inventory-incomplete",
        "runner-owner-missing",
        "runner-owner-unavailable",
        "runner-owner-alive",
        "runner-owner-ambiguous",
        "keychain-relock-pending",
        "cleanup-required",
      ]) {
        const health = decodeBrokerEnvelope(
          `${JSON.stringify({
            protocolVersion: 2,
            hostId: fixture.metadata.hostId,
            kind: "health",
            brokerRevision: "b".repeat(64),
            capabilities: ["health", "status", "reconcile", "run-v2"],
            profile: "registry-only",
            epoch: "a".repeat(32),
            status: "blocked",
            accepting: false,
            capacity: 0,
            reasons: [reason],
            ...(reason === "storage-access-denied"
              ? {
                  storageAccessHint:
                    "Enable Remote Login > Allow full disk access for remote users. This macOS setting cannot be set by a script.",
                }
              : {}),
            jobRootFreeBytes: null,
            tartRootFreeBytes: null,
            hostFloorBytes: 53687091200,
          })}\n`,
          fixture.generation,
        );
        expect(health.reasons).toEqual([reason]);
        expect(cleanNativeHealth(health)).toBe(false);
        if (reason === "storage-access-denied")
          expect(health.storageAccessHint).toContain("Remote Login");
      }
    }),
  ),
);
