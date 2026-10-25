import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  makeT3DeviceBackup,
  parseT3DeviceBackupConfig,
} from "../src/services/t3-device-backup.js";

const config = {
  baseUrl: "https://t3.example.test",
  tokenFile: "/run/secrets/t3-device-backup",
  workspaceRoot: "/srv/partitura-device",
  organizationHosts: { "org-a": ["mac"] },
  instanceId: "codex",
  model: "configured-model",
};
const fixture = () => {
  const requests: Array<{ method: string; payload: unknown }> = [];
  let sessions: Array<{ hostId: string; deviceId: string; threadId: string }> =
    [];
  let booted = false;
  let enabled = true;
  const device = {
    hostId: "mac",
    id: "sim-a",
    platform: "ios",
    name: "iPhone",
    version: "26.4",
    physical: false,
  };
  const request = (method: string, payload: unknown) =>
    Effect.sync(() => {
      requests.push({ method, payload });
      if (method === "device.list")
        return {
          hostStatus: "ready",
          agentAccessEnabled: enabled,
          devices: [
            { ...device, booted },
            { ...device, hostId: "foreign", id: "sim-b", booted: false },
            { ...device, id: "physical", booted: false, physical: true },
          ],
          sessions,
        };
      const args = payload as Record<string, unknown>;
      if (method === "orchestration.launchThread")
        return { threadId: args.threadId };
      if (method === "device.open") {
        const session = {
          hostId: String(args.hostId),
          deviceId: String(args.deviceId),
          threadId: String(args.threadId),
        };
        sessions.push(session);
        booted = true;
        return session;
      }
      if (method === "device.close") {
        sessions = sessions.filter((s) => s.threadId !== args.threadId);
        if (args.shutdown === true) booted = false;
        return null;
      }
      return { ok: true };
    });
  return {
    requests,
    backup: makeT3DeviceBackup(config, {
      request,
      projectId: "device-project",
    }),
    get sessions() {
      return sessions;
    },
    set sessions(value) {
      sessions = value;
    },
    set booted(value: boolean) {
      booted = value;
    },
    set enabled(value: boolean) {
      enabled = value;
    },
  };
};
const target = { hostId: "mac", deviceId: "sim-a" };

describe("T3 remote device backup", () => {
  it("uses existing T3 discovery and control with a run-owned idle thread and no inference", async () => {
    const f = fixture();
    const listed = await Effect.runPromise(
      f.backup.call("org-a", "run-a", { operation: "list" }),
    );
    expect(listed).toMatchObject({ devices: [{ id: "sim-a", busy: false }] });
    expect(f.requests.map((r) => r.method)).toEqual(["device.list"]);
    await Effect.runPromise(
      f.backup.call("org-a", "run-a", { operation: "open", ...target }),
    );
    const launch = f.requests.find(
      (r) => r.method === "orchestration.launchThread",
    );
    expect(launch?.payload).toMatchObject({
      projectId: "device-project",
      workspaceStrategy: { type: "root" },
      runtimeMode: "approval-required",
    });
    expect(launch?.payload).not.toHaveProperty("initialMessage");
    await Effect.runPromise(
      f.backup.call("org-a", "run-a", {
        operation: "launch-app",
        ...target,
        appId: "com.apple.Preferences",
        threadId: "foreign",
        organizationId: "foreign",
      }),
    );
    expect(f.requests.at(-1)).toEqual({
      method: "device.action",
      payload: { ...target, type: "launchApp", appId: "com.apple.Preferences" },
    });
    await Effect.runPromise(
      f.backup.call("org-a", "run-a", { operation: "close", ...target }),
    );
    expect(f.requests.at(-1)).toMatchObject({
      method: "device.close",
      payload: { ...target, shutdown: true },
    });
    expect(f.sessions).toEqual([]);
  });

  it("refuses foreign organizations, hosts, physical devices and unopened control", async () => {
    const f = fixture();
    for (const [org, args] of [
      ["org-b", { operation: "list" }],
      ["org-a", { operation: "open", hostId: "foreign", deviceId: "sim-b" }],
      ["org-a", { operation: "open", hostId: "mac", deviceId: "physical" }],
      ["org-a", { operation: "detail", ...target }],
    ] as const)
      expect(
        Result.isFailure(
          await Effect.runPromise(
            Effect.result(f.backup.call(org, "run-a", args)),
          ),
        ),
      ).toBe(true);
    expect(f.requests.every((r) => r.method === "device.list")).toBe(true);
  });

  it("doesn't adopt a booted or another thread's device, or change device consent", async () => {
    const f = fixture();
    f.booted = true;
    expect(
      Result.isFailure(
        await Effect.runPromise(
          Effect.result(
            f.backup.call("org-a", "run-a", { operation: "open", ...target }),
          ),
        ),
      ),
    ).toBe(true);
    f.booted = false;
    f.sessions = [{ ...target, threadId: "human-thread" }];
    expect(
      Result.isFailure(
        await Effect.runPromise(
          Effect.result(
            f.backup.call("org-a", "run-a", { operation: "open", ...target }),
          ),
        ),
      ),
    ).toBe(true);
    f.sessions = [];
    f.enabled = false;
    expect(
      Result.isFailure(
        await Effect.runPromise(
          Effect.result(
            f.backup.call("org-a", "run-a", { operation: "open", ...target }),
          ),
        ),
      ),
    ).toBe(true);
    expect(f.requests.every((r) => r.method === "device.list")).toBe(true);
  });

  it("recovers run ownership from T3 state and cleans only that run after a restart", async () => {
    const f = fixture();
    await Effect.runPromise(
      f.backup.call("org-a", "run-a", { operation: "open", ...target }),
    );
    f.sessions = [
      ...f.sessions,
      { hostId: "mac", deviceId: "another-device", threadId: "human-thread" },
    ];
    const request = (method: string, payload: unknown) => {
      if (method === "device.list")
        return Effect.succeed({
          hostStatus: "ready",
          agentAccessEnabled: true,
          devices: [],
          sessions: f.sessions,
        });
      f.requests.push({ method, payload });
      return Effect.succeed(null);
    };
    const restarted = makeT3DeviceBackup(config, {
      request,
      projectId: "device-project",
    });
    const before = f.requests.length;
    await Effect.runPromise(restarted.release("org-a", "run-b"));
    expect(f.requests).toHaveLength(before);
    await Effect.runPromise(restarted.release("org-a", "run-a"));
    expect(f.requests.slice(before)).toHaveLength(1);
    expect(f.requests.at(-1)).toMatchObject({
      method: "device.close",
      payload: { ...target, shutdown: true },
    });
  });

  it("releases its session without shutting down a device another thread attached to", async () => {
    const f = fixture();
    await Effect.runPromise(
      f.backup.call("org-a", "run-a", { operation: "open", ...target }),
    );
    f.sessions = [...f.sessions, { ...target, threadId: "another-thread" }];
    await Effect.runPromise(f.backup.release("org-a", "run-a"));
    expect(f.requests.at(-1)).toMatchObject({
      method: "device.close",
      payload: { ...target, shutdown: false },
    });
    expect(f.sessions).toEqual([{ ...target, threadId: "another-thread" }]);
  });

  it("rejects malformed configuration without forwarding credentials or accepting arbitrary endpoints", () => {
    expect(parseT3DeviceBackupConfig(JSON.stringify(config))).toEqual(config);
    for (const override of [
      { baseUrl: "http://remote.test" },
      { baseUrl: "https://user:secret@remote.test" },
      { tokenFile: "relative" },
      { workspaceRoot: "/a/../b" },
      { organizationHosts: { "org-a": [] } },
    ])
      expect(() =>
        parseT3DeviceBackupConfig(JSON.stringify({ ...config, ...override })),
      ).toThrow();
  });
});
