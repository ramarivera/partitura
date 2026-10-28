import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { NativeBuildJob } from "../src/services/native-build-legacy-receipt.js";
import {
  LEGACY_NATIVE_BUILD_RECEIPT_GRACE_MS,
  LEGACY_NATIVE_BUILD_RUN_TIMEOUT_MS,
  legacyReceiptRefresh,
} from "../src/services/native-build-legacy-status.js";

const jobFixture = (): NativeBuildJob => ({
  job: "a".repeat(32),
  sessionId: "session-a",
  commit: "b".repeat(40),
  action: "archive",
  state: "failed",
});

it("only success or a pre-ownership disk refusal proves cancel can be suppressed", () => {
  const refresh = legacyReceiptRefresh({
    read: async () => {
      throw new Error("must remain local");
    },
    save: async () => {},
    retain: () => () => {},
    current: () => true,
  });
  const job = jobFixture();
  // Even receipt confirmation alone says nothing about outstanding obligations.
  refresh.confirm(job.job);
  expect(refresh.confirmed(job)).toBe(false);
  for (const diagnostic of [
    { stage: "boot", failureCode: "host-key-unavailable" },
    { stage: "cleanup", failureCode: "cleanup-required" },
    { stage: "unlock", failureCode: "unlock-failed" },
    { stage: "capacity", failureCode: "host-capacity-unavailable" },
    { stage: "disk-post-transfer", failureCode: "host-disk-space-unavailable" },
    { stage: "workflow", failureCode: "workflow-failed" },
    { stage: "cleanup", failureCode: "execution-interrupted" },
    { stage: "receiving", failureCode: "receive-interrupted" },
    { stage: "keychain-policy", failureCode: "keychain-policy-unavailable" },
  ] as const)
    expect(refresh.confirmed({ ...job, ...diagnostic })).toBe(false);
  expect(
    refresh.confirmed({
      ...job,
      stage: "disk-preflight",
      failureCode: "host-disk-space-unavailable",
    }),
  ).toBe(true);
  expect(refresh.confirmed({ ...job, state: "succeeded" })).toBe(true);
});

it.live(
  "offline status refresh is single-flight, nonblocking and bounded by backoff and four failures",
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
        at = 1_000_000; // Still inside the lifetime cap; only the failure budget stops reads.
        for (let poll = 0; poll < 20; poll++) await refresh.poll(job);
        expect(reads).toBe(4);
      } finally {
        gate.reject(new Error("test closed"));
        await refresh.close();
      }
    }),
);

it.live(
  "running receipts reset intermittent failures and their retry backoff before workflow failure",
  () =>
    Effect.promise(async () => {
      const job = jobFixture();
      let at = 0,
        reads = 0,
        writes = 0;
      const refresh = legacyReceiptRefresh({
        read: async () => {
          reads++;
          if (reads > 12)
            return JSON.stringify({
              ...job,
              stage: "workflow",
              failureCode: "workflow-failed",
            });
          if (reads % 2 === 1) throw new Error("intermittent SSH failure");
          return JSON.stringify({ ...job, state: "running" });
        },
        save: async () => {
          writes++;
        },
        retain: () => () => {},
        current: () => true,
        now: () => at,
      });
      try {
        refresh.track(job.job);
        for (let round = 0; round < 6; round++) {
          await refresh.poll(job); // One failure, followed by a valid running read.
          expect(reads).toBe(round * 2 + 1);
          at += 999;
          expect(refresh.poll(job)).toBeUndefined();
          at++;
          await refresh.poll(job);
          expect(reads).toBe(round * 2 + 2);
          at += 29_999;
          expect(refresh.poll(job)).toBeUndefined();
          at++;
        }
        await refresh.poll(job);
        expect(reads).toBe(13);
        expect(writes).toBe(1);
        expect(job).toMatchObject({
          state: "failed",
          failureCode: "workflow-failed",
        });
      } finally {
        await refresh.close();
      }
    }),
);

for (const malformed of [
  { stage: "not-a-stage" },
  { stage: "workflow", failureCode: "workflow-failed" },
  { artifactBytes: 1 },
  { artifactSha256: "not-a-hash" },
  { bootExitCode: 0 },
  { workflowExitCode: 0 },
] as const)
  it.live(
    `malformed running receipt spends the error budget: ${JSON.stringify(malformed)}`,
    () =>
      Effect.promise(async () => {
        const job = jobFixture();
        let at = 0,
          reads = 0;
        const refresh = legacyReceiptRefresh({
          read: async () => {
            reads++;
            return JSON.stringify({ ...job, state: "running", ...malformed });
          },
          save: async () => {
            throw new Error("must not save malformed running receipt");
          },
          retain: () => () => {},
          current: () => true,
          now: () => at,
        });
        try {
          refresh.track(job.job);
          for (const next of [0, 1_000, 6_000, 36_000]) {
            at = next;
            await refresh.poll(job);
          }
          expect(reads).toBe(4);
          at = 1_000_000;
          for (let poll = 0; poll < 20; poll++) await refresh.poll(job);
          expect(reads).toBe(4);
          expect(job).toEqual(jobFixture());
        } finally {
          await refresh.close();
        }
      }),
  );

it.live(
  "running receipts get one final due lookup after the tracking deadline then stop",
  () =>
    Effect.promise(async () => {
      const job = jobFixture();
      const started = 123_456;
      let at = started,
        reads = 0;
      const refresh = legacyReceiptRefresh({
        read: async () => {
          reads++;
          return JSON.stringify({ ...job, state: "running" });
        },
        save: async () => {
          throw new Error("must not save a running receipt");
        },
        retain: () => () => {},
        current: () => true,
        now: () => at,
      });
      try {
        refresh.track(job.job);
        await refresh.poll(job);
        expect(reads).toBe(1);
        at = started + LEGACY_NATIVE_BUILD_RUN_TIMEOUT_MS;
        await refresh.poll(job);
        expect(reads).toBe(2); // The post-timeout grace still permits a final receipt.
        at += LEGACY_NATIVE_BUILD_RECEIPT_GRACE_MS - 1;
        await refresh.poll(job);
        expect(reads).toBe(3);
        at++;
        // The prior backoff still applies; crossing the deadline doesn't bypass it.
        for (let poll = 0; poll < 20; poll++)
          expect(refresh.poll(job)).toBeUndefined();
        at += 30_000;
        await refresh.poll(job);
        expect(reads).toBe(4);
        at += 86_400_000;
        expect(refresh.poll(job)).toBeUndefined();
        expect(reads).toBe(4);
        expect(job).toEqual(jobFixture());
      } finally {
        await refresh.close();
      }
    }),
);

it.live(
  "a confirmed code-less failed receipt stops refresh but still permits broker cleanup",
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
        expect(refresh.confirmed(job)).toBe(false);
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

it.live(
  "four SSH failures after the receipt deadline exhaust late lookups",
  () =>
    Effect.promise(async () => {
      let at = 0;
      let reads = 0;
      const job = jobFixture();
      const refresh = legacyReceiptRefresh({
        read: async () => {
          reads++;
          throw new Error("offline");
        },
        save: async () => {
          throw new Error("must not save an unavailable receipt");
        },
        retain: () => () => {},
        current: () => true,
        now: () => at,
      });
      try {
        refresh.track(job.job);
        at =
          LEGACY_NATIVE_BUILD_RUN_TIMEOUT_MS +
          LEGACY_NATIVE_BUILD_RECEIPT_GRACE_MS +
          60_000;
        for (const backoff of [1_000, 5_000, 30_000, 30_000]) {
          await refresh.poll(job);
          expect(refresh.poll(job)).toBeUndefined();
          at += backoff;
        }
        expect(reads).toBe(4);
        at += 24 * 60 * 60 * 1_000;
        for (let count = 0; count < 20; count++) await refresh.poll(job);
        expect(reads).toBe(4);
        expect(job.failureCode).toBeUndefined();
      } finally {
        await refresh.close();
      }
    }),
);
