import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { openDriverWorker } from "../src/drivers/worker-adapter.js";
import type { RpcEvent } from "../src/services/rpc-worker.js";

import {
  collectUntil,
  driverFor,
  openInput,
  runningRun,
  subscribeCount,
  THREAD_ID,
  tags,
  waitUntil,
  withServer,
} from "./t3-driver-helpers.js";

describe("T3 driver turns and events", () => {
  it.live(
    "keeps a run alive on suppressed streaming updates, then interrupts on silence",
    () =>
      Effect.gen(function* () {
        const server = yield* withServer;
        const worker = yield* openDriverWorker(
          driverFor(server),
          openInput,
          undefined,
          1_000,
        );
        const events: RpcEvent[] = [];
        yield* worker.onEvent((event) => events.push(event));
        yield* waitUntil(() => subscribeCount(server) === 1, "subscription");
        yield* worker.prompt("long command and reasoning", "streaming-input");
        runningRun(server);
        server.upsertItem(THREAD_ID, {
          id: "long-command",
          runId: "run-1",
          type: "command_execution",
          status: "running",
          ordinal: 1,
          input: "long-command",
          output: "starting",
        });
        yield* waitUntil(
          () => events.some((event) => event.type === "tool_execution_start"),
          "initial tool event",
        );
        const projectedCount = events.length;
        for (let index = 0; index < 25; index++) {
          yield* Effect.sleep(100);
          const acksBefore = server.clientFrames.filter(
            (frame) => frame._tag === "Ack",
          ).length;
          for (const type of [
            "command_execution",
            "reasoning",
            "assistant_message",
          ]) {
            server.upsertItem(THREAD_ID, {
              id: type === "command_execution" ? "long-command" : type,
              runId: "run-1",
              type,
              status: "running",
              ordinal: 1,
              input: "long-command",
              output: `progress ${index}`,
              text: `streaming ${index}`,
              messageId: "assistant-message",
              streaming: true,
            });
          }
          yield* waitUntil(
            () =>
              server.clientFrames.filter((frame) => frame._tag === "Ack")
                .length >=
              acksBefore + 3,
            "streaming acknowledgements",
          );
          expect(server.commandsOf("run.interrupt")).toHaveLength(0);
          expect(events).toHaveLength(projectedCount);
        }
        server.upsertItem(THREAD_ID, {
          id: "long-command",
          runId: "run-1",
          type: "command_execution",
          status: "completed",
          ordinal: 1,
          input: "long-command",
          output: "finished",
          exitCode: 0,
        });
        yield* waitUntil(
          () =>
            events.some(
              (event) =>
                event.type === "error" &&
                event.message === "T3 stalled for 1000ms",
            ),
          "silent run watchdog",
        );
        expect(server.commandsOf("run.interrupt")).toHaveLength(1);
        expect(server.commandsOf("run.interrupt")[0]).toMatchObject({
          runId: "run-1",
        });
      }),
  );

  it.live("gives quiet tools a bounded longer idle budget", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const worker = yield* openDriverWorker(
        driverFor(server),
        openInput,
        undefined,
        200,
        1_000,
      );
      const events: RpcEvent[] = [];
      yield* worker.onEvent((event) => events.push(event));
      yield* waitUntil(() => subscribeCount(server) === 1, "subscription");
      yield* worker.prompt("quiet installation", "quiet-tool-input");
      runningRun(server);
      server.upsertItem(THREAD_ID, {
        id: "quiet-command",
        runId: "run-1",
        type: "command_execution",
        status: "running",
        ordinal: 1,
        input: "install",
        output: "",
      });
      yield* waitUntil(
        () => events.some((event) => event.type === "tool_execution_start"),
        "tool start",
      );
      yield* Effect.sleep(500);
      expect(server.commandsOf("run.interrupt")).toHaveLength(0);
      yield* waitUntil(
        () =>
          events.some(
            (event) =>
              event.type === "error" &&
              event.message === "T3 stalled for 1000ms",
          ),
        "hung tool watchdog",
      );
      expect(server.commandsOf("run.interrupt")).toHaveLength(1);
    }),
  );

  it.live("maps a full run onto normalized events and an outcome", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const session = yield* driverFor(server).open(openInput);
      yield* waitUntil(() => subscribeCount(server) === 1, "subscription");
      const collector = yield* Effect.forkChild(
        collectUntil(session, (event) => event._tag === "TurnEnded"),
      );

      const handle = yield* session.sendTurn({
        clientRequestId: "delivery-1",
        text: "Fix the flaky test",
        delivery: "auto",
      });
      expect(handle).toMatchObject({
        turnId: "run-1",
        delivery: "started",
        adopted: false,
      });
      expect(server.commandsOf("message.dispatch")[0]).toMatchObject({
        commandId: `symtest:${THREAD_ID}:dispatch:delivery-1`,
        messageId: `symtest:${THREAD_ID}:message:delivery-1`,
        createdBy: "user",
        creationSource: "web",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      });

      runningRun(server);
      server.upsertItem(THREAD_ID, {
        id: "item-reasoning",
        runId: "run-1",
        type: "reasoning",
        status: "completed",
        ordinal: 1,
        text: "Looking at the test",
        streaming: false,
      });
      server.upsertItem(THREAD_ID, {
        id: "item-cmd",
        runId: "run-1",
        type: "command_execution",
        status: "running",
        ordinal: 2,
        input: "bun test",
      });
      server.upsertItem(THREAD_ID, {
        id: "item-cmd",
        runId: "run-1",
        type: "command_execution",
        status: "completed",
        ordinal: 2,
        input: "bun test",
        output: "1 failed",
        exitCode: 1,
      });
      server.upsertItem(THREAD_ID, {
        id: "item-todo",
        runId: "run-1",
        type: "todo_list",
        status: "running",
        ordinal: 3,
        planId: "plan-1",
        steps: [
          { id: "s1", text: "Reproduce", status: "completed" },
          { id: "s2", text: "Fix", status: "running" },
        ],
      });
      server.emitUnknown(THREAD_ID);
      server.upsertItem(THREAD_ID, {
        id: "item-answer",
        runId: "run-1",
        type: "assistant_message",
        status: "running",
        ordinal: 4,
        messageId: "assistant-1",
        text: "Fixed",
        streaming: true,
      });
      server.upsertItem(THREAD_ID, {
        id: "item-answer",
        runId: "run-1",
        type: "assistant_message",
        status: "completed",
        ordinal: 4,
        messageId: "assistant-1",
        text: "Fixed the race in the test.",
        streaming: false,
      });
      server.updateRun(THREAD_ID, "run-1", { status: "completed" });

      const events = yield* Fiber.join(collector);
      expect(tags(events)).toEqual([
        "TurnStarted",
        "Thinking",
        "ToolStarted",
        "ToolEnded",
        "Plan",
        "AssistantMessage",
        "TurnEnded",
      ]);
      expect(events[3]).toMatchObject({
        name: "command",
        isError: true,
        result: "1 failed",
        key: `t3:${THREAD_ID}:item:item-cmd:ended`,
      });
      expect(events[4]).toMatchObject({
        steps: [
          { content: "Reproduce", status: "completed" },
          { content: "Fix", status: "inProgress" },
        ],
      });
      const outcome = yield* handle.outcome;
      expect(outcome).toEqual({
        turnId: "run-1",
        status: "completed",
        finalText: "Fixed the race in the test.",
        error: null,
      });
      expect(events.at(-1)).toMatchObject({ outcome });
      const keys = events.map((event) => event.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const event of events) expect(event.cursor).toMatch(/^\d+$/u);
    }),
  );

  it.live.each(["preparing", "starting", "waiting"] as const)(
    "queues a steer request while the active run is %s",
    (status) =>
      Effect.gen(function* () {
        const server = yield* withServer;
        const session = yield* driverFor(server).open(openInput);
        yield* session.sendTurn({
          clientRequestId: "starting-first",
          text: "first",
          delivery: "start",
        });
        server.updateRun(THREAD_ID, "run-1", { status });
        const queued = yield* session.sendTurn({
          clientRequestId: "starting-follow-up",
          text: "follow up",
          delivery: "steer",
        });
        expect(queued).toMatchObject({ turnId: "run-2", delivery: "queued" });
        expect(
          server.commandsOf("message.dispatch").at(-1)?.dispatchMode,
        ).toEqual({ type: "queue_after_active" });
      }),
  );

  it.live("queues behind an active run and steers into it", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const session = yield* driverFor(server).open(openInput);
      const first = yield* session.sendTurn({
        clientRequestId: "d-1",
        text: "first",
        delivery: "start",
      });
      runningRun(server);
      const queued = yield* session.sendTurn({
        clientRequestId: "d-2",
        text: "second",
        delivery: "auto",
      });
      expect(queued).toMatchObject({ turnId: "run-2", delivery: "queued" });
      const steered = yield* session.sendTurn({
        clientRequestId: "d-3",
        text: "also consider this",
        delivery: "steer",
      });
      expect(steered).toMatchObject({
        turnId: first.turnId,
        delivery: "steered",
      });
      expect(
        server.commandsOf("message.dispatch").map((c) => c.dispatchMode),
      ).toEqual([
        { type: "start_immediately" },
        { type: "queue_after_active" },
        { type: "steer_active", targetRunId: "run-1" },
      ]);
      const busy = yield* Effect.flip(
        session.sendTurn({
          clientRequestId: "d-4",
          text: "forced start",
          delivery: "start",
        }),
      );
      expect(busy).toMatchObject({
        reason: "rejected",
        submission: "not-submitted",
      });

      const snapshot = yield* session.snapshot;
      expect(snapshot.activeTurnId).toBe("run-1");
      expect(snapshot.turns).toEqual([
        { turnId: "run-1", status: "running", clientRequestId: "d-1" },
        { turnId: "run-2", status: "queued", clientRequestId: "d-2" },
      ]);
      expect([...snapshot.acceptedClientRequestIds].sort()).toEqual([
        "d-1",
        "d-2",
        "d-3",
      ]);
    }),
  );
});
