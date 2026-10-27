import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Redacted, Scope, Stream } from "effect";
import { connectT3 } from "../src/drivers/t3/rpc-client.js";
import type { FakeT3Server } from "./fixtures/fake-t3.js";

import {
  collectUntil,
  driverFor,
  openInput,
  runningRun,
  subscribeCount,
  THREAD_ID,
  take,
  waitUntil,
  withServer,
} from "./t3-driver-helpers.js";

describe("T3 driver control", () => {
  it.live("interrupts the active run", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const session = yield* driverFor(server).open(openInput);
      const handle = yield* session.sendTurn({
        clientRequestId: "d-1",
        text: "go",
        delivery: "auto",
      });
      runningRun(server);
      expect(yield* session.interrupt()).toBe("requested");
      expect(server.commandsOf("run.interrupt")[0]).toMatchObject({
        commandId: `symtest:${THREAD_ID}:interrupt:run-1`,
        runId: "run-1",
      });
      const outcome = yield* handle.outcome.pipe(Effect.timeout("5 seconds"));
      expect(outcome.status).toBe("interrupted");
      expect(yield* session.interrupt()).toBe("no_active_turn");
    }),
  );

  it.live("surfaces approvals and forwards the decision", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const session = yield* driverFor(server).open(openInput);
      yield* session.sendTurn({
        clientRequestId: "d-1",
        text: "go",
        delivery: "auto",
      });
      runningRun(server);
      server.updateRun(THREAD_ID, "run-1", { status: "waiting" });
      server.upsertItem(THREAD_ID, {
        id: "item-approval",
        runId: "run-1",
        type: "approval_request",
        status: "waiting",
        ordinal: 1,
        requestId: "req-1",
        requestKind: "command",
        prompt: "Run `rm -rf build`?",
        options: [
          { decision: "accept", label: "Allow once" },
          { decision: "acceptForSession", label: "Allow for session" },
          { decision: "decline", label: "Deny" },
        ],
      });
      server.upsertRequest(THREAD_ID, {
        id: "req-1",
        kind: "command",
        status: "pending",
      });
      const opened = yield* collectUntil(
        session,
        (event) => event._tag === "RequestOpened",
      );
      expect(opened.at(-1)).toMatchObject({
        _tag: "RequestOpened",
        requestId: "req-1",
        turnId: "run-1",
        kind: "approval",
        prompt: "Run `rm -rf build`?",
        options: [
          { label: "Allow once", value: "once" },
          { label: "Allow for session", value: "session" },
          { label: "Deny", value: "deny" },
        ],
      });
      expect((yield* session.snapshot).pendingRequests).toEqual([
        { requestId: "req-1", kind: "approval" },
      ]);

      yield* session.respond("req-1", { _tag: "Approve", scope: "session" });
      expect(server.commandsOf("runtime-request.respond")[0]).toMatchObject({
        commandId: `symtest:${THREAD_ID}:respond:req-1`,
        requestId: "req-1",
        decision: "acceptForSession",
      });
      const resolved = yield* take(session, 1);
      expect(resolved[0]).toMatchObject({
        _tag: "RequestResolved",
        requestId: "req-1",
        status: "resolved",
      });
    }),
  );

  it.live("surfaces questions and forwards answers or dismissal", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const session = yield* driverFor(server).open(openInput);
      yield* session.sendTurn({
        clientRequestId: "d-1",
        text: "go",
        delivery: "auto",
      });
      server.upsertItem(THREAD_ID, {
        id: "item-q",
        runId: "run-1",
        type: "user_input_request",
        status: "waiting",
        ordinal: 1,
        requestId: "req-q",
        questions: [
          {
            id: "q1",
            header: "Branch",
            question: "Which branch should I target?",
            options: [
              { label: "main", description: "Default branch" },
              { label: "next", description: "Release train", value: "next" },
            ],
          },
        ],
      });
      server.upsertRequest(THREAD_ID, {
        id: "req-q",
        kind: "user_input",
        status: "pending",
      });
      const opened = yield* collectUntil(
        session,
        (event) => event._tag === "RequestOpened",
      );
      expect(opened.at(-1)).toMatchObject({
        kind: "question",
        prompt: "Which branch should I target?",
        options: [
          { label: "main", value: "main" },
          { label: "next", value: "next" },
        ],
        questions: [
          {
            id: "q1",
            multiSelect: false,
            allowCustomAnswer: true,
          },
        ],
      });
      yield* session.respond("req-q", {
        _tag: "Answer",
        answers: { q1: "next" },
      });
      expect(server.commandsOf("runtime-request.respond")[0]).toMatchObject({
        requestId: "req-q",
        answers: { q1: "next" },
      });
      expect(
        server.commandsOf("runtime-request.respond")[0],
      ).not.toHaveProperty("decision");

      server.upsertRequest(THREAD_ID, {
        id: "req-q2",
        kind: "user_input",
        status: "pending",
      });
      yield* session.respond("req-q2", { _tag: "Dismiss" });
      expect(server.commandsOf("thread.user-input.dismiss")).toHaveLength(1);
    }),
  );

  it.live("adopts a dispatched message after a lost response", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const session = yield* driverFor(server).open(openInput);
      yield* waitUntil(() => subscribeCount(server) === 1, "subscription");
      server.dropResponses.add("orchestration.dispatchCommand");
      const handle = yield* session.sendTurn({
        clientRequestId: "delivery-lost",
        text: "go",
        delivery: "auto",
      });
      expect(handle).toMatchObject({ turnId: "run-1", adopted: true });
      expect(server.commandsOf("message.dispatch")).toHaveLength(1);

      // A webhook retry of the same delivery adopts without dispatching.
      const retried = yield* session.sendTurn({
        clientRequestId: "delivery-lost",
        text: "go",
        delivery: "auto",
      });
      expect(retried).toMatchObject({ turnId: "run-1", adopted: true });
      expect(server.commandsOf("message.dispatch")).toHaveLength(1);
      expect(server.thread(THREAD_ID).messages).toHaveLength(1);

      // The event stream survived the dropped socket.
      server.updateRun(THREAD_ID, "run-1", { status: "completed" });
      const outcome = yield* handle.outcome.pipe(Effect.timeout("5 seconds"));
      expect(outcome.status).toBe("completed");
    }),
  );

  it.live("retries idempotent commands once after a lost response", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const session = yield* driverFor(server).open(openInput);
      yield* session.sendTurn({
        clientRequestId: "d-1",
        text: "go",
        delivery: "auto",
      });
      runningRun(server);
      server.dropResponses.add("orchestration.dispatchCommand");
      expect(yield* session.interrupt("run-1")).toBe("requested");
      const interrupts = server.commandsOf("run.interrupt");
      expect(interrupts).toHaveLength(2);
      expect(interrupts[0]?.commandId).toBe(interrupts[1]?.commandId);
      expect(
        server
          .thread(THREAD_ID)
          .events.filter((stored) => stored.event.type === "run.updated"),
      ).toHaveLength(2);
    }),
  );

  it.live("fails the event stream after the reconnect budget", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const session = yield* driverFor(server, {
        maxReconnectAttempts: 2,
      }).open(openInput);
      const handle = yield* session.sendTurn({
        clientRequestId: "d-1",
        text: "go",
        delivery: "auto",
      });
      yield* take(session, 1);
      server.stop();
      const error = yield* session.events.pipe(
        Stream.runDrain,
        Effect.flip,
        Effect.timeout("5 seconds"),
      );
      expect(error).toMatchObject({
        _tag: "@Gateway/DriverError",
        reason: "lost",
      });
      const outcomeError = yield* Effect.flip(handle.outcome);
      expect(outcomeError.reason).toBe("lost");
    }),
  );
});

describe("T3 Effect v4 transport lifecycle", () => {
  const connect = (server: FakeT3Server) =>
    connectT3({
      baseUrl: server.baseUrl,
      token: Effect.succeed(Redacted.make(server.token)),
      pingIntervalMs: 1_000,
      requestTimeoutMs: 2_000,
    });

  it.live("allows a resumed RPC waiter to close its own connection scope", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      yield* driverFor(server).open(openInput);
      const scope = yield* Scope.fork(yield* Effect.scope);
      const connection = yield* connect(server).pipe(Scope.provide(scope));
      const projection = yield* connection
        .request("orchestration.getThreadProjection", { threadId: THREAD_ID })
        .pipe(Effect.tap(() => Scope.close(scope, Exit.void)));
      expect(projection).toMatchObject({ thread: { id: THREAD_ID } });
      expect(connection.isOpen()).toBe(false);
      const closed = yield* connection.closed;
      expect(closed.message).toBe("T3 connection closed by the gateway");
      const rejected = yield* Effect.flip(
        connection.request("orchestration.getThreadProjection", {
          threadId: THREAD_ID,
        }),
      );
      expect(rejected.sent).toBe(false);
      expect(
        server.clientFrames.filter((frame) => frame._tag === "Interrupt"),
      ).toHaveLength(0);
    }),
  );

  it.live(
    "acks a consumed chunk and interrupts the subscription on early exit",
    () =>
      Effect.gen(function* () {
        const server = yield* withServer;
        yield* driverFor(server).open(openInput);
        const connection = yield* connect(server);
        const values = yield* connection
          .stream("orchestration.subscribeThread", { threadId: THREAD_ID })
          .pipe(Stream.take(1), Stream.runCollect);
        expect(values).toHaveLength(1);
        expect(values[0]).toMatchObject({ kind: "snapshot" });
        yield* waitUntil(
          () => server.clientFrames.some((frame) => frame._tag === "Interrupt"),
          "stream interrupt",
        );
        const interrupt = server.clientFrames.find(
          (frame) => frame._tag === "Interrupt",
        );
        if (interrupt === undefined)
          throw new Error("expected stream interrupt");
        expect(server.clientFrames).toContainEqual({
          _tag: "Ack",
          requestId: interrupt.requestId,
        });
        expect(connection.isOpen()).toBe(true);
        const projection = yield* connection.request(
          "orchestration.getThreadProjection",
          { threadId: THREAD_ID },
        );
        expect(projection).toMatchObject({ thread: { id: THREAD_ID } });
      }),
  );

  it.live(
    "skips empty chunks and drains buffered values before a successful Exit",
    () =>
      Effect.gen(function* () {
        const server = yield* withServer;
        yield* driverFor(server).open(openInput);
        const connection = yield* connect(server);
        const collector = yield* Effect.forkChild(
          connection
            .stream("orchestration.subscribeThread", { threadId: THREAD_ID })
            .pipe(Stream.runCollect),
        );
        yield* waitUntil(
          () => subscribeCount(server) === 2,
          "transport subscription",
        );
        server.sendToSubscriptions(THREAD_ID, [
          { _tag: "Chunk", values: [] },
          { _tag: "Chunk", values: [{ kind: "synchronized" }] },
          { _tag: "Exit", exit: { _tag: "Success", value: null } },
        ]);
        const values = yield* Fiber.join(collector);
        expect(values).toHaveLength(2);
        expect(values[0]).toMatchObject({ kind: "snapshot" });
        expect(values[1]).toEqual({ kind: "synchronized" });
      }),
  );

  it.live("preserves a server failure Exit after buffered stream values", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      yield* driverFor(server).open(openInput);
      const connection = yield* connect(server);
      const received: unknown[] = [];
      const collector = yield* Effect.forkChild(
        connection
          .stream("orchestration.subscribeThread", { threadId: THREAD_ID })
          .pipe(
            Stream.runForEach((value) =>
              Effect.sync(() => {
                received.push(value);
              }),
            ),
            Effect.flip,
          ),
      );
      yield* waitUntil(
        () => subscribeCount(server) === 2,
        "transport subscription",
      );
      server.sendToSubscriptions(THREAD_ID, [
        { _tag: "Chunk", values: [{ kind: "synchronized" }] },
        {
          _tag: "Exit",
          exit: {
            _tag: "Failure",
            cause: [
              {
                _tag: "Fail",
                error: {
                  _tag: "SubscribeError",
                  message: "subscription rejected",
                },
              },
            ],
          },
        },
      ]);
      const error = yield* Fiber.join(collector);
      expect(error.reason).toBe("rejected");
      expect(error.remoteTag).toBe("SubscribeError");
      expect(error.sent).toBe(true);
      expect(received).toHaveLength(2);
      expect(received[1]).toEqual({ kind: "synchronized" });
    }),
  );
});
