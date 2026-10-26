const HEALTH_URL = "http://127.0.0.1:9002/healthz";
const HEALTH_POLL_MS = 5_000;
const OUTAGE_GRACE_MS = 60_000;
const HEALTH_TIMEOUT_MS = 2_000;
const CHILD_SHUTDOWN_GRACE_MS = 10_000;

export type GatewaySupervisorOptions = {
  readonly healthUrl?: string;
  readonly healthPollMs?: number;
  readonly outageGraceMs?: number;
  readonly healthTimeoutMs?: number;
  readonly childShutdownGraceMs?: number;
};

export type GatewayEndpointState = { readonly unreachableSince: number | null };

export function updateGatewayEndpoint(
  state: GatewayEndpointState,
  reachable: boolean,
  now: number,
  outageGraceMs = OUTAGE_GRACE_MS,
): { readonly state: GatewayEndpointState; readonly restart: boolean } {
  if (reachable) {
    return {
      state: { unreachableSince: null },
      restart: false,
    };
  }
  const unreachableSince = state.unreachableSince ?? now;
  return {
    state: { unreachableSince },
    restart: now - unreachableSince >= outageGraceMs,
  };
}

async function sidecarEndpointReachable(
  healthUrl: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    // Any HTTP response proves the listener is in this network namespace.
    await fetch(healthUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

export async function runGatewaySupervisor(
  commandAndArgs: readonly string[],
  options: GatewaySupervisorOptions = {},
): Promise<void> {
  // Options keep real-process tests local and fast; Compose uses these defaults.
  const healthUrl = options.healthUrl ?? HEALTH_URL;
  const healthPollMs = options.healthPollMs ?? HEALTH_POLL_MS;
  const outageGraceMs = options.outageGraceMs ?? OUTAGE_GRACE_MS;
  const healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  const childShutdownGraceMs =
    options.childShutdownGraceMs ?? CHILD_SHUTDOWN_GRACE_MS;
  const [command, ...args] = commandAndArgs;
  if (!command) throw new Error("gateway supervisor requires a command");

  const child = Bun.spawn([command, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  let childHasExited = false;
  const childExit = child.exited.then((code) => {
    childHasExited = true;
    return code;
  });
  let stopCode: number | null = null;
  let state: GatewayEndpointState = { unreachableSince: null };

  const stopChild = (code: number): void => {
    if (stopCode !== null) return;
    stopCode = code;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), childShutdownGraceMs);
    void child.exited.then(() => clearTimeout(timer));
  };

  process.once("SIGTERM", () => stopChild(143));
  process.once("SIGINT", () => stopChild(130));

  void (async () => {
    while (stopCode === null && !childHasExited) {
      const reachable = await sidecarEndpointReachable(
        healthUrl,
        healthTimeoutMs,
      );
      if (childHasExited) break;
      const result = updateGatewayEndpoint(
        state,
        reachable,
        Date.now(),
        outageGraceMs,
      );
      state = result.state;
      if (result.restart) stopChild(0);
      if (stopCode === null) await Bun.sleep(healthPollMs);
    }
  })();

  const childExitCode = await childExit;
  process.exitCode = stopCode ?? childExitCode;
}

if (import.meta.main) await runGatewaySupervisor(Bun.argv.slice(2));
