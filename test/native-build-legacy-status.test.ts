import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { NativeBuildJob } from "../src/services/native-build-legacy-receipt.js";
import { legacyReceiptRefresh } from "../src/services/native-build-legacy-status.js";

const jobFixture = (): NativeBuildJob => ({
  job: "a".repeat(32),
  sessionId: "session-a",
  commit: "b".repeat(40),
  action: "archive",
  state: "failed",
});

it.live(
  "uncertain status refresh is single-flight, nonblocking and bounded by backoff and four attempts",
  () =>
    Effect.promise(async () => {
      let at = 0,
        reads = 0,
        leases = 0;
      const gate = Promise.withResolvers<string>();
      const job = jobFixture();
      const refresh = legacyReceiptRefresh({
        read: () => {
          reads++;
          return reads === 1
            ? gate.promise
            : Promise.reject(new Error("offline"));
        },
        save: async () => {
          throw new Error("must not persist offline status");
        },
        retain: () => {
          leases++;
          return () => {
            leases--;
          };
        },
        current: () => true,
        now: () => at,
      });
      try {
        refresh.track(job.job);
        const flight = refresh.poll(job);
        // A slow SSH read can outlast every retry interval without spawning another.
        at = 10_000;
        for (let poll = 0; poll < 20; poll++)
          expect(refresh.poll(job)).toBe(flight);
        expect(reads).toBe(1);
        expect(leases).toBe(1);
        gate.reject(new Error("offline"));
        await flight;
        expect(leases).toBe(0);
        expect(refresh.poll(job)).toBeUndefined();
        expect(reads).toBe(1);
        for (const next of [11_000, 16_000, 46_000]) {
          at = next;
          await refresh.poll(job);
        }
        expect(reads).toBe(4);
        at = 1e9;
        for (let poll = 0; poll < 20; poll++) await refresh.poll(job);
        expect(reads).toBe(4);
      } finally {
        gate.reject(new Error("test closed"));
        await refresh.close();
      }
    }),
);

it.live(
  "a confirmed code-less failed receipt stops refresh and allows terminal cancel suppression",
  () =>
    Effect.promise(async () => {
      const job = jobFixture();
      let reads = 0;
      const refresh = legacyReceiptRefresh({
        read: async () => {
          reads++;
          return JSON.stringify({ ...job, stage: "clone" });
        },
        save: async () => {},
        retain: () => () => {},
        current: () => true,
      });
      try {
        refresh.track(job.job);
        await refresh.poll(job);
        expect(refresh.confirmed(job)).toBe(true);
        for (let poll = 0; poll < 20; poll++) await refresh.poll(job);
        expect(reads).toBe(1);
      } finally {
        await refresh.close();
      }
    }),
);

it.live("an inconsistent refetched diagnostic never reaches persistence", () =>
  Effect.promise(async () => {
    const job = jobFixture();
    let writes = 0;
    const refresh = legacyReceiptRefresh({
      read: async () =>
        JSON.stringify({
          ...job,
          stage: "boot",
          failureCode: "execution-interrupted",
        }),
      save: async () => {
        writes++;
      },
      retain: () => () => {},
      current: () => true,
    });
    try {
      refresh.track(job.job);
      await refresh.poll(job);
      expect(writes).toBe(0);
      expect(job.failureCode).toBeUndefined();
    } finally {
      await refresh.close();
    }
  }),
);

it.live("a retired job cannot be re-created by a delayed receipt", () =>
  Effect.promise(async () => {
    const job = jobFixture();
    const gate = Promise.withResolvers<string>();
    let current = true,
      writes = 0;
    const refresh = legacyReceiptRefresh({
      read: () => gate.promise,
      save: async () => {
        writes++;
      },
      retain: () => () => {},
      current: () => current,
    });
    try {
      refresh.track(job.job);
      const flight = refresh.poll(job);
      current = false;
      gate.resolve(
        JSON.stringify({
          ...job,
          stage: "cleanup",
          failureCode: "execution-interrupted",
        }),
      );
      await flight;
      expect(writes).toBe(0);
      expect(job.failureCode).toBeUndefined();
    } finally {
      gate.resolve("{}");
      await refresh.close();
    }
  }),
);
