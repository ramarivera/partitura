import { writeFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { makeT3DeviceBackup } from "../src/services/t3-device-backup.js";
import { sendT3DeviceInput } from "../src/services/t3-device-input.js";
import { suitePaths } from "./fixtures/paths.js";

const testPath = suitePaths();
const tokenPath = testPath("device-input-token.txt");
writeFileSync(tokenPath, "test-token");

const hub = (
  platform: "ios" | "android",
  unavailable = false,
  admit = true,
) => {
  const messages: Array<string | Buffer> = [];
  const paths: string[] = [];
  let tickets = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      paths.push(url.pathname + url.search);
      if (url.pathname === "/api/auth/websocket-ticket") {
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        tickets++;
        return Response.json({
          ticket: "one-use",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      if (url.pathname.endsWith("stream.mjpeg")) return new Response("frame");
      expect(url.searchParams.get("wsTicket")).toBe("one-use");
      expect(url.searchParams.get("hostId")).toBe("mac");
      expect(url.searchParams.get("device")).toBe("sim-a");
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        if (platform === "ios") {
          const config = Buffer.from(
            JSON.stringify({
              width: 390,
              height: 844,
              inputUnavailable: unavailable,
            }),
          );
          ws.sendBinary(Buffer.concat([Buffer.from([0x82]), config]));
          if (admit) ws.sendBinary(Buffer.from([0x83]));
          else ws.close(1008, "input refused");
        }
      },
      message(_ws, message) {
        messages.push(
          typeof message === "string" ? message : Buffer.from(message),
        );
      },
    },
  });
  return {
    paths,
    messages,
    get tickets() {
      return tickets;
    },
    baseUrl: new URL(`http://127.0.0.1:${server.port}`),
    stop: () => server.stop(true),
  };
};

const target = { hostId: "mac", id: "sim-a", platform: "ios" as const };
const token = Effect.succeed(Redacted.make("test-token"));
const decoded = (message: string | Buffer | undefined) => {
  if (!Buffer.isBuffer(message)) throw new Error("Expected binary HID packet");
  return { tag: message[0], body: JSON.parse(message.subarray(1).toString()) };
};

describe("T3 device input proxy", () => {
  it.live("rejects invalid coordinates before obtaining a ticket", () =>
    Effect.promise(async () => {
      const server = hub("ios");
      try {
        for (const x of [-0.1, 1.1, NaN, Infinity]) {
          await expect(
            Effect.runPromise(
              sendT3DeviceInput({
                baseUrl: server.baseUrl,
                token,
                device: target,
                input: { type: "tap", x, y: 0 },
              }),
            ),
          ).rejects.toThrow("Invalid device input");
        }
        expect(server.paths).toEqual([]);
      } finally {
        server.stop();
      }
    }),
  );

  it.live(
    "never sends input without admission or reconnects after refusal",
    () =>
      Effect.promise(async () => {
        const server = hub("ios", false, false);
        try {
          await expect(
            Effect.runPromise(
              sendT3DeviceInput({
                baseUrl: server.baseUrl,
                token,
                device: target,
                input: { type: "key", key: "Enter" },
              }),
            ),
          ).rejects.toThrow("closed");
          expect(server.messages).toEqual([]);
          expect(server.tickets).toBe(1);
        } finally {
          server.stop();
        }
      }),
  );
  it.live(
    "waits for iOS input admission and sends one bounded tap through the authenticated proxy",
    () =>
      Effect.promise(async () => {
        const server = hub("ios");
        try {
          const result = await Effect.runPromise(
            sendT3DeviceInput({
              baseUrl: server.baseUrl,
              token,
              device: target,
              input: { type: "tap", x: 0.25, y: 0.5 },
            }),
          );
          expect(result).toEqual({ dispatched: true, observed: false });
          // Socket closure completes after queued frames reach the peer.
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(server.messages.map(decoded)).toEqual([
            { tag: 3, body: { type: "begin", x: 0.25, y: 0.5 } },
            { tag: 3, body: { type: "end", x: 0.25, y: 0.5 } },
          ]);
          expect(server.tickets).toBe(1);
          expect(
            server.paths.some((p) =>
              p.startsWith("/api/device-hub/vendor/serve-sim/helper/ws?"),
            ),
          ).toBe(true);
        } finally {
          server.stop();
        }
      }),
  );

  it.live("refuses unavailable input before dispatch without retrying", () =>
    Effect.promise(async () => {
      const server = hub("ios", true);
      try {
        await expect(
          Effect.runPromise(
            sendT3DeviceInput({
              baseUrl: server.baseUrl,
              token,
              device: target,
              input: { type: "tap", x: 0, y: 1 },
            }),
          ),
        ).rejects.toThrow("unavailable");
        expect(server.messages).toEqual([]);
        expect(server.tickets).toBe(1);
      } finally {
        server.stop();
      }
    }),
  );

  it.live(
    "validates the complete text before any dispatch and releases iOS modifiers",
    () =>
      Effect.promise(async () => {
        const server = hub("ios");
        try {
          await expect(
            Effect.runPromise(
              sendT3DeviceInput({
                baseUrl: server.baseUrl,
                token,
                device: target,
                input: { type: "text", text: "a🌍" },
              }),
            ),
          ).rejects.toThrow("ASCII");
          expect(server.paths).toEqual([]);
          await Effect.runPromise(
            sendT3DeviceInput({
              baseUrl: server.baseUrl,
              token,
              device: target,
              input: { type: "text", text: "A!\n" },
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(server.messages.map(decoded)).toEqual([
            ...[4, 30].flatMap((usage) => [
              { tag: 6, body: { type: "down", usage: 225 } },
              { tag: 6, body: { type: "down", usage } },
              { tag: 6, body: { type: "up", usage } },
              { tag: 6, body: { type: "up", usage: 225 } },
            ]),
            { tag: 6, body: { type: "down", usage: 40 } },
            { tag: 6, body: { type: "up", usage: 40 } },
          ]);
        } finally {
          server.stop();
        }
      }),
  );

  it.live(
    "uses Android input framing and rejects oversized text before opening a socket",
    () =>
      Effect.promise(async () => {
        const server = hub("android");
        const device = { ...target, platform: "android" as const };
        try {
          await expect(
            Effect.runPromise(
              sendT3DeviceInput({
                baseUrl: server.baseUrl,
                token,
                device,
                input: { type: "text", text: "🌍".repeat(76) },
              }),
            ),
          ).rejects.toThrow();
          expect(server.paths).toEqual([]);
          await Effect.runPromise(
            sendT3DeviceInput({
              baseUrl: server.baseUrl,
              token,
              device,
              input: { type: "text", text: "hello 🌍" },
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(server.messages).toEqual([
            JSON.stringify({ type: "text", text: "hello 🌍" }),
          ]);
        } finally {
          server.stop();
        }
      }),
  );

  it.live(
    "routes input through the backup owner check and refuses foreign or disabled access before touching the proxy",
    () =>
      Effect.promise(async () => {
        const server = hub("ios");
        let owner = "foreign";
        let enabled = true;
        const backup = makeT3DeviceBackup(
          {
            baseUrl: server.baseUrl.toString(),
            tokenFile: tokenPath,
            workspaceRoot: "/srv/backup",
            organizationHosts: { org: ["mac"] },
            instanceId: "codex",
            model: "configured-model",
          },
          {
            projectId: "project",
            request: (method, payload) =>
              Effect.sync(() => {
                if (method === "device.list")
                  return {
                    hostStatus: "ready",
                    agentAccessEnabled: enabled,
                    devices: [
                      {
                        ...target,
                        name: "iPhone",
                        version: "26.4",
                        booted: true,
                        physical: false,
                      },
                    ],
                    sessions: [
                      { hostId: "mac", deviceId: "sim-a", threadId: owner },
                    ],
                  };
                if (method === "orchestration.launchThread") {
                  if (
                    typeof payload !== "object" ||
                    payload === null ||
                    !("threadId" in payload)
                  )
                    throw new Error("Missing thread");
                  return { threadId: payload.threadId };
                }
                return null;
              }),
          },
        );
        const call = () =>
          Effect.runPromise(
            backup.call("org", "run", {
              operation: "input",
              hostId: "mac",
              deviceId: "sim-a",
              input: { type: "key", key: "Enter" },
            }),
          );
        try {
          await expect(call()).rejects.toThrow("another thread");
          expect(server.paths).toEqual([]);
          // The owner is server-derived from organization and session, not tool input.
          const { createHash } = await import("node:crypto");
          owner = `partitura-device-${createHash("sha256")
            .update(JSON.stringify(["org", "run"]))
            .digest("hex")}`;
          enabled = false;
          await expect(call()).rejects.toThrow("disabled");
          expect(server.paths).toEqual([]);
          enabled = true;
          expect(await call()).toEqual({
            hostId: "mac",
            deviceId: "sim-a",
            dispatched: true,
            observed: false,
          });
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(server.messages.map(decoded)).toEqual([
            { tag: 6, body: { type: "down", usage: 40 } },
            { tag: 6, body: { type: "up", usage: 40 } },
          ]);
        } finally {
          server.stop();
        }
      }),
  );
});
