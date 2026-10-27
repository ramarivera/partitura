import { Data, Duration, Effect, Redacted, Schedule, Stream } from "effect";
import type {
  AgentEvent,
  AgentSession,
  OpenSessionInput,
} from "../src/drivers/driver.js";
import {
  makeT3Driver,
  type T3DriverOptions,
} from "../src/drivers/t3/driver.js";
import { FakeT3Server } from "./fixtures/fake-t3.js";

export const withServer = Effect.acquireRelease(
  Effect.sync(() => new FakeT3Server()),
  (server) => Effect.sync(() => server.stop()),
);

export const driverFor = (
  server: FakeT3Server,
  overrides: Partial<T3DriverOptions> = {},
) =>
  makeT3Driver({
    baseUrl: server.baseUrl,
    token: Effect.succeed(Redacted.make(server.token)),
    projectId: "project-1",
    modelSelection: {
      instanceId: "codex-cliproxy",
      model: "gpt-6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    idNamespace: "symtest",
    reconnectBaseDelayMs: 10,
    reconnectMaxDelayMs: 50,
    pingIntervalMs: 1_000,
    requestTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
    ...overrides,
  });

export const openInput: OpenSessionInput = {
  sessionKey: "session-abc",
  title: "ENG-1 Fix the flaky test",
  workspace: { _tag: "ProjectRoot" },
};
export const THREAD_ID = "symtest-session-abc";

export class T3TestError extends Data.TaggedError("T3TestError")<{
  readonly message: string;
}> {}

export const waitUntil = (condition: () => boolean, label: string) =>
  Effect.suspend(() =>
    condition()
      ? Effect.void
      : Effect.fail(new T3TestError({ message: `waiting for ${label}` })),
  ).pipe(
    Effect.retry(
      Schedule.spaced(Duration.millis(5)).pipe(
        Schedule.upTo({ duration: Duration.seconds(3) }),
      ),
    ),
    Effect.orDie,
  );

export const subscribeCount = (server: FakeT3Server) =>
  server.requestsFor("orchestration.subscribeThread").length;

/** Collects events until (and including) the first one matching `last`. */
export const collectUntil = (
  session: AgentSession,
  last: (event: AgentEvent) => boolean,
) =>
  session.events.pipe(
    Stream.takeUntil(last),
    Stream.runCollect,
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () =>
        Effect.fail(
          new T3TestError({ message: "timed out collecting events" }),
        ),
    }),
  );

export const take = (session: AgentSession, count: number) =>
  session.events.pipe(
    Stream.take(count),
    Stream.runCollect,
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () =>
        Effect.fail(
          new T3TestError({ message: `timed out taking ${count} events` }),
        ),
    }),
  );

export const tags = (events: ReadonlyArray<AgentEvent>) =>
  events.map((event) => event._tag);

export const runningRun = (server: FakeT3Server, runId = "run-1") =>
  server.updateRun(THREAD_ID, runId, { status: "running" });
