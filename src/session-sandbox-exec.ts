import { createConnection } from "node:net";

interface ReadRequest {
  readonly operation: "exec";
  readonly sessionId: string;
  readonly workerUid: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Record<string, string>;
}

const socketPath = process.env.PARTITURA_SANDBOX_BROKER_SOCKET;
if (!socketPath) throw new Error("Sandbox broker socket is not configured");

const commandArgs = process.argv.slice(2);
const argv = commandArgs[0] === "--" ? commandArgs.slice(1) : commandArgs;
const sessionId = process.env.PARTITURA_SANDBOX_SESSION_ID;
const workerUid = process.env.PARTITURA_SANDBOX_WORKER_UID;
const cwd = process.env.PARTITURA_SANDBOX_CWD;
const envJson = process.env.PARTITURA_SANDBOX_ENV;
if (!sessionId || !workerUid || !cwd || !envJson || argv.length === 0)
  throw new Error("Sandbox exec request is incomplete");
const env = JSON.parse(envJson) as Record<string, string>;
const request: ReadRequest = {
  operation: "exec",
  sessionId,
  workerUid,
  argv,
  cwd,
  env,
};

const socket = createConnection({ path: socketPath });
const chunks: Buffer[] = [];
const waiters: Array<() => void> = [];
let ended = false;
const markEnded = () => {
  ended = true;
  for (const wake of waiters.splice(0)) wake();
};
socket.on("data", (chunk: Buffer) => {
  chunks.push(chunk);
  waiters.shift()?.();
});
socket.on("end", markEnded);
socket.on("close", markEnded);
socket.on("error", (error) => {
  markEnded();
  process.stderr.write(`sandbox broker connection failed: ${error.message}\n`);
  process.exitCode = 1;
});

const write = (bytes: Buffer): Promise<void> =>
  new Promise((resolve, reject) =>
    socket.write(bytes, (error) => (error ? reject(error) : resolve())),
  );

const readExact = async (size: number): Promise<Buffer> => {
  while (chunks.reduce((total, chunk) => total + chunk.length, 0) < size) {
    if (ended) throw new Error("Sandbox broker closed the stream");
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  const output = Buffer.allocUnsafe(size);
  let written = 0;
  while (written < size) {
    const first = chunks[0];
    if (!first) throw new Error("Sandbox stream buffer underflow");
    const length = Math.min(first.length, size - written);
    first.copy(output, written, 0, length);
    written += length;
    if (length === first.length) chunks.shift();
    else chunks[0] = first.subarray(length);
  }
  return output;
};

const writeFrame = async (kind: "I" | "C", data = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5);
  header.write(kind, 0, "ascii");
  header.writeUInt32BE(data.length, 1);
  await write(Buffer.concat([header, data]));
};

const run = async () => {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  await write(Buffer.from(`${JSON.stringify(request)}\n`));
  const inputPump = (async () => {
    for await (const item of process.stdin) {
      const data = Buffer.isBuffer(item) ? item : Buffer.from(item);
      await writeFrame("I", data);
    }
    await writeFrame("C");
  })();
  void inputPump.catch(() => undefined);

  while (true) {
    const header = await readExact(5);
    const kind = header.toString("ascii", 0, 1);
    const length = header.readUInt32BE(1);
    if (kind === "X") {
      process.exitCode = length;
      break;
    }
    if ((kind !== "O" && kind !== "E") || length > 4 * 1024 * 1024)
      throw new Error("Sandbox broker sent an invalid frame");
    const data = await readExact(length);
    (kind === "O" ? process.stdout : process.stderr).write(data);
  }
  socket.end();
};

await run()
  .catch((error: unknown) => {
    process.stderr.write(
      `sandbox worker failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    socket.destroy();
  })
  .finally(() => process.stdin.destroy());
