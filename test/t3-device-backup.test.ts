import { writeFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  makeT3DeviceBackup,
  parseT3DeviceBackupConfig,
  t3DeviceBackupResult,
} from "../src/services/t3-device-backup.js";
import { suitePaths } from "./fixtures/paths.js";

const config = {
  baseUrl: "https://t3.example.test",
  tokenFile: "/run/secrets/t3-device-backup",
  workspaceRoot: "/srv/partitura-device",
  organizationHosts: { "org-a": ["mac"] },
  instanceId: "codex",
  model: "configured-model",
};
const testPath = suitePaths();
const credentialPath = testPath("t3-test-token.txt");
writeFileSync(credentialPath, "dedicated-test-token");
const fixture = (
  http?: (url: URL, init: RequestInit) => Promise<Response>,
  platform = "ios",
) => {
  const requests: Array<{ method: string; payload: unknown }> = [];
  let sessions: Array<{ hostId: string; deviceId: string; threadId: string }> =
    [];
  let booted = false;
  let enabled = true;
  const device = {
    hostId: "mac",
    id: "sim-a",
    platform,
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
    backup: makeT3DeviceBackup(
      { ...config, tokenFile: credentialPath },
      {
        request,
        ...(http ? { fetch: http } : {}),
        projectId: "device-project",
      },
    ),
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
  it("inspects only run-owned devices through authenticated bounded T3 proxy requests", async () => {
    const requests: Array<{
      url: string;
      method: string | undefined;
      authorization: string | null;
      redirect: string | undefined;
    }> = [];
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    const f = fixture(async (url, init) => {
      requests.push({
        url: url.toString(),
        method: init.method,
        authorization: new Headers(init.headers).get("authorization"),
        redirect: init.redirect,
      });
      return url.pathname.endsWith("/ax")
        ? Response.json([{ AXLabel: "Settings", children: [] }])
        : new Response(png);
    });
    await expect(
      Effect.runPromise(
        f.backup.call("org-a", "other-run", {
          operation: "screenshot",
          ...target,
        }),
      ),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
    await Effect.runPromise(
      f.backup.call("org-a", "run-a", { operation: "open", ...target }),
    );
    const image = await Effect.runPromise(
      f.backup.call("org-a", "run-a", { operation: "screenshot", ...target }),
    );
    const result = t3DeviceBackupResult(image);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(target) },
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
    ]);
    expect(result.details).toBeUndefined();
    const ax = await Effect.runPromise(
      f.backup.call("org-a", "run-a", {
        operation: "accessibility",
        ...target,
      }),
    );
    expect(ax).toMatchObject({ accessibility: [{ AXLabel: "Settings" }] });
    expect(requests).toEqual([
      {
        url: "https://t3.example.test/api/device-hub/vendor/serve-sim/api/screenshot?hostId=mac&device=sim-a",
        method: "POST",
        authorization: "Bearer dedicated-test-token",
        redirect: "manual",
      },
      {
        url: "https://t3.example.test/api/device-hub/vendor/serve-sim/helper/sim-a/ax?hostId=mac",
        method: "GET",
        authorization: "Bearer dedicated-test-token",
        redirect: "manual",
      },
    ]);
    f.sessions = [{ ...target, threadId: "foreign" }];
    await expect(
      Effect.runPromise(
        f.backup.call("org-a", "run-a", {
          operation: "accessibility",
          ...target,
        }),
      ),
    ).rejects.toThrow();
    expect(requests).toHaveLength(2);
  });

  it("uses the existing Android accessibility endpoint for owned emulators", async () => {
    let requested = "";
    const f = fixture(async (url) => {
      requested = url.toString();
      return Response.json({ nodes: [{ text: "Settings" }] });
    }, "android");
    await Effect.runPromise(
      f.backup.call("org-a", "run-a", { operation: "open", ...target }),
    );
    const result = await Effect.runPromise(
      f.backup.call("org-a", "run-a", {
        operation: "accessibility",
        ...target,
      }),
    );
    expect(result).toMatchObject({
      accessibility: { nodes: [{ text: "Settings" }] },
    });
    expect(requested).toBe(
      "https://t3.example.test/api/device-hub/vendor/serve-emu/api/accessibility?hostId=mac&device=sim-a",
    );
  });

  it("refuses redirected, malformed and oversized device inspection responses", async () => {
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: "https://foreign.test" },
      }),
      new Response("not PNG"),
      new Response("x".repeat(512 * 1024 + 1)),
      Response.json({ error: "AX unavailable" }),
    ];
    for (let index = 0; index < responses.length; index++) {
      const response = responses[index];
      if (!response) throw new Error("Missing response fixture");
      const f = fixture(async () => response);
      await Effect.runPromise(
        f.backup.call("org-a", "run-a", { operation: "open", ...target }),
      );
      await expect(
        Effect.runPromise(
          f.backup.call("org-a", "run-a", {
            operation: index === 3 ? "accessibility" : "screenshot",
            ...target,
          }),
        ),
      ).rejects.toThrow("inspection failed");
    }
  });

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
