import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  type GatewayEndpointState,
  updateGatewayEndpoint,
} from "../deploy/tailscale/gateway-supervisor.js";

describe("Tailscale gateway supervisor", () => {
  it("restarts after the sidecar health listener stays unreachable", () => {
    let state: GatewayEndpointState = { unreachableSince: null };

    const outage = updateGatewayEndpoint(state, false, 1_000);
    state = outage.state;
    expect(outage.restart).toBe(false);

    const briefRecovery = updateGatewayEndpoint(state, true, 60_999);
    state = briefRecovery.state;
    expect(briefRecovery.restart).toBe(false);
    expect(state.unreachableSince).toBeNull();

    const sustainedOutage = updateGatewayEndpoint(
      updateGatewayEndpoint({ unreachableSince: null }, false, 1_000).state,
      false,
      61_000,
    );
    expect(sustainedOutage.restart).toBe(true);
  });

  it("does not restart when the loopback listener responds again", () => {
    const initial = updateGatewayEndpoint(
      { unreachableSince: null },
      false,
      1_000,
    );
    const responds = updateGatewayEndpoint(initial.state, true, 120_000);

    expect(responds.restart).toBe(false);
    expect(responds.state.unreachableSince).toBeNull();
  });

  it.live(
    "stops the child for container restart after the loopback listener is lost",
    () =>
      Effect.promise(async () => {
        let endpointResponds = true;
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: async () => {
            if (!endpointResponds) await Bun.sleep(100);
            return new Response("sidecar health", { status: 503 });
          },
        });
        const childScript = [
          'process.on("SIGTERM", () => { console.log("child-term"); process.exit(0); });',
          'console.log("child-ready");',
          "setInterval(() => {}, 1_000);",
        ].join(" ");
        const runnerScript = `
      const { runGatewaySupervisor } = await import(${JSON.stringify(new URL("../deploy/tailscale/gateway-supervisor.ts", import.meta.url).href)});
      await runGatewaySupervisor(
        ${JSON.stringify([process.execPath, "-e", childScript])},
        {
          healthUrl: ${JSON.stringify(`http://127.0.0.1:${server.port}/healthz`)},
          healthPollMs: 5,
          outageGraceMs: 30,
          healthTimeoutMs: 5,
          childShutdownGraceMs: 100,
        },
      );
    `;
        const supervisor = Bun.spawn([process.execPath, "-e", runnerScript], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const output: string[] = [];
        let resolveReady!: () => void;
        const ready = new Promise<void>((resolve) => {
          resolveReady = resolve;
        });
        const pumpOutput = (async () => {
          const reader = supervisor.stdout.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { value, done } = await reader.read();
            if (done) return;
            output.push(decoder.decode(value));
            if (output.join("").includes("child-ready")) resolveReady();
          }
        })();

        try {
          await Promise.race([
            ready,
            Bun.sleep(2_000).then(() => {
              throw new Error("gateway child did not start");
            }),
          ]);
          await Bun.sleep(80);
          expect(supervisor.exitCode).toBeNull();
          endpointResponds = false;
          const exitCode = await Promise.race([
            supervisor.exited,
            Bun.sleep(2_000).then(() => {
              supervisor.kill("SIGKILL");
              throw new Error("gateway supervisor did not restart its child");
            }),
          ]);
          await pumpOutput;

          expect(exitCode).toBe(0);
          expect(output.join("")).toContain("child-term");
        } finally {
          if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
          server.stop(true);
        }
      }),
  );
});

describe("Tailscale sandbox wiring", () => {
  it.live(
    "forwards runtime selection and mounts the broker directory without creating it",
    () =>
      Effect.promise(async () => {
        const compose = Schema.decodeUnknownSync(
          Schema.Struct({
            services: Schema.Struct({
              gateway: Schema.Struct({
                environment: Schema.Record(Schema.String, Schema.String),
                volumes: Schema.Array(
                  Schema.Union([
                    Schema.String,
                    Schema.Struct({
                      type: Schema.String,
                      source: Schema.String,
                      target: Schema.String,
                      read_only: Schema.Boolean,
                      bind: Schema.Struct({ create_host_path: Schema.Boolean }),
                    }),
                  ]),
                ),
              }),
              tailscale: Schema.Struct({
                volumes: Schema.Array(Schema.String),
              }),
            }),
          }),
        )(
          Bun.YAML.parse(
            await Bun.file(
              new URL("../deploy/tailscale/compose.yaml", import.meta.url),
            ).text(),
          ),
        );
        const gateway = compose.services.gateway;
        expect(gateway.environment.WORKER_SANDBOX_MODE).toBe(
          `\${WORKER_SANDBOX_MODE:-firecracker}`,
        );
        expect(gateway.environment.SESSION_SANDBOX_BROKER_SOCKET).toBe(
          `\${SESSION_SANDBOX_BROKER_SOCKET:-/run/partitura-sandbox/broker.sock}`,
        );
        expect(
          gateway.volumes.filter((volume) => typeof volume !== "string"),
        ).toEqual([
          {
            type: "bind",
            source: `\${SESSION_SANDBOX_BROKER_DIR:-/run/partitura-sandbox}`,
            target: "/run/partitura-sandbox",
            read_only: true,
            bind: { create_host_path: false },
          },
        ]);
        expect(
          compose.services.tailscale.volumes.some((volume) =>
            volume.includes("partitura-sandbox"),
          ),
        ).toBe(false);
      }),
  );
});
