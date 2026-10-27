import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Redacted, Scope } from "effect";
import { httpJson } from "../src/drivers/t3/rpc-client.js";

import {
  collectUntil,
  driverFor,
  openInput,
  subscribeCount,
  THREAD_ID,
  tags,
  take,
  waitUntil,
  withServer,
} from "./t3-driver-helpers.js";

describe("T3 driver auth and protocol", () => {
  it.live(
    "times out and aborts HTTP requests whose JSON body stalls after headers",
    () =>
      Effect.gen(function* () {
        let bodyStarted = false;
        let aborted = false;
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              port: 0,
              hostname: "127.0.0.1",
              fetch: () =>
                new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      bodyStarted = true;
                      controller.enqueue(
                        new TextEncoder().encode('{"partial":'),
                      );
                    },
                    cancel() {
                      aborted = true;
                    },
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        );
        const error = yield* httpJson(
          "environment",
          new URL(`http://127.0.0.1:${server.port}/stalled-body`),
          { method: "GET" },
          200,
        ).pipe(Effect.timeout("2 seconds"), Effect.flip);
        expect(bodyStarted).toBe(true);
        expect(error).toMatchObject({
          reason: "timeout",
          method: "environment",
          sent: true,
        });
        yield* waitUntil(() => aborted, "HTTP body cancellation");
      }),
  );

  it.live("probes the descriptor and exchanges the bearer for a ticket", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const result = yield* driverFor(server).probe;
      expect(result.detail).toContain("0.1.2-nightly.20261021.3473");
      expect(result.detail).toContain("protocol 2");
      expect(server.tickets.size).toBe(1);
    }),
  );

  it.live("reports a rejected bearer as an auth error", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const driver = driverFor(server, {
        token: Effect.succeed(Redacted.make("wrong-token")),
      });
      const probe = yield* Effect.flip(driver.probe);
      expect(probe.reason).toBe("auth");
      expect(probe.message).not.toContain("wrong-token");
      const open = yield* Effect.flip(driver.open(openInput));
      expect(open.reason).toBe("auth");
      expect(open.submission).toBe("not-submitted");
      expect(server.threads.size).toBe(0);
    }),
  );

  it.live("connects with a single-use ticket and protocol 2", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      yield* driverFor(server).open(openInput);
      expect(server.upgrades[0]).toEqual({ protocol: "2", ticketOk: true });
    }),
  );
});

describe("T3 driver launch", () => {
  it.live("launches one thread per session key, idempotently", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const driver = driverFor(server);
      const first = yield* Scope.make();
      const session = yield* driver.open(openInput).pipe(Scope.provide(first));
      expect(session.ref).toEqual({
        driver: "t3",
        nativeId: THREAD_ID,
        locator: { projectId: "project-1", origin: server.baseUrl.origin },
      });
      yield* Scope.close(first, Exit.void);

      yield* driver.open(openInput);
      const launches = server.requestsFor("orchestration.launchThread");
      expect(launches).toHaveLength(2);
      expect(launches[0]?.payload).toEqual(launches[1]?.payload);
      expect(launches[0]?.payload).toMatchObject({
        commandId: `symtest:${THREAD_ID}:launch`,
        threadId: THREAD_ID,
        projectId: "project-1",
        title: "ENG-1 Fix the flaky test",
        creationSource: "web",
        modelSelection: {
          instanceId: "codex-cliproxy",
          model: "gpt-6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
      });
      expect(launches[0]?.payload).not.toHaveProperty("reuseExistingThread");
      expect(server.threads.size).toBe(1);
    }),
  );

  it.live("adopts a launched thread after a lost launch response", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      server.dropResponses.add("orchestration.launchThread");
      const session = yield* driverFor(server).open({
        ...openInput,
        workspace: { _tag: "DriverWorktree", baseRef: "main", branch: "eng-1" },
      });
      expect(session.ref.nativeId).toBe(THREAD_ID);
      expect(server.requestsFor("orchestration.launchThread")).toHaveLength(1);
      expect(server.thread(THREAD_ID).launch.workspaceStrategy).toEqual({
        type: "worktree",
        baseRef: "main",
        branch: "eng-1",
      });
    }),
  );

  it.live("hashes session keys that are unsafe as ids", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const session = yield* driverFor(server).open({
        ...openInput,
        sessionKey: "linear/session with spaces",
      });
      expect(session.ref.nativeId).toMatch(/^symtest-[0-9a-f]{32}$/u);
    }),
  );
});

describe("T3 driver reconnect", () => {
  it.live("resubscribes from afterSequence without duplicates", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const session = yield* driverFor(server).open(openInput);
      yield* waitUntil(() => subscribeCount(server) === 1, "subscription");
      const handle = yield* session.sendTurn({
        clientRequestId: "d-1",
        text: "go",
        delivery: "auto",
      });
      server.upsertItem(THREAD_ID, {
        id: "item-reasoning",
        runId: "run-1",
        type: "reasoning",
        status: "completed",
        ordinal: 1,
        text: "thinking",
        streaming: false,
      });
      const before = yield* take(session, 2);
      expect(tags(before)).toEqual(["TurnStarted", "Thinking"]);
      const cursorBefore = Number(before.at(-1)?.cursor);

      server.closeAllSockets();
      server.upsertItem(THREAD_ID, {
        id: "item-cmd",
        runId: "run-1",
        type: "command_execution",
        status: "completed",
        ordinal: 2,
        input: "ls",
        output: "ok",
        exitCode: 0,
      });
      server.updateRun(THREAD_ID, "run-1", { status: "completed" });

      const after = yield* collectUntil(
        session,
        (event) => event._tag === "TurnEnded",
      );
      expect(tags(after)).toEqual(["ToolStarted", "ToolEnded", "TurnEnded"]);
      const resume = server.requestsFor("orchestration.subscribeThread")[1];
      expect(resume?.payload.afterSequence).toBeGreaterThanOrEqual(
        cursorBefore,
      );
      expect(server.upgrades.length).toBeGreaterThanOrEqual(2);
      expect((yield* handle.outcome).status).toBe("completed");
    }),
  );

  it.live("reconciles a snapshot fallback without re-emitting", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const session = yield* driverFor(server).open(openInput);
      yield* waitUntil(() => subscribeCount(server) === 1, "subscription");
      yield* session.sendTurn({
        clientRequestId: "d-1",
        text: "go",
        delivery: "auto",
      });
      server.upsertItem(THREAD_ID, {
        id: "item-cmd",
        runId: "run-1",
        type: "command_execution",
        status: "running",
        ordinal: 1,
        input: "make",
      });
      const before = yield* take(session, 2);
      expect(tags(before)).toEqual(["TurnStarted", "ToolStarted"]);

      server.forceSnapshotOnResume = true;
      server.closeAllSockets();
      server.upsertItem(THREAD_ID, {
        id: "item-cmd",
        runId: "run-1",
        type: "command_execution",
        status: "failed",
        ordinal: 1,
        input: "make",
        output: "boom",
      });
      server.upsertItem(THREAD_ID, {
        id: "item-error",
        runId: "run-1",
        type: "error",
        status: "completed",
        ordinal: 2,
        failure: {
          class: "provider_error",
          message: "provider crashed",
          code: null,
          retryable: false,
        },
      });
      server.updateRun(THREAD_ID, "run-1", { status: "failed" });

      const after = yield* collectUntil(
        session,
        (event) => event._tag === "TurnEnded",
      );
      expect(tags(after)).toEqual(["ToolEnded", "Error", "TurnEnded"]);
      expect(after.at(-1)).toMatchObject({
        outcome: { status: "failed", error: "provider crashed" },
      });
    }),
  );

  it.live("resumes a persisted session from its cursor", () =>
    Effect.gen(function* () {
      const server = yield* withServer;
      const driver = driverFor(server);
      const firstScope = yield* Scope.make();
      const first = yield* driver
        .open(openInput)
        .pipe(Scope.provide(firstScope));
      yield* first.sendTurn({
        clientRequestId: "d-1",
        text: "go",
        delivery: "auto",
      });
      const seen = yield* take(first, 1);
      yield* Scope.close(firstScope, Exit.void);

      server.updateRun(THREAD_ID, "run-1", { status: "completed" });
      const resumed = yield* driver.open({
        ...openInput,
        resume: { ref: first.ref, cursor: seen[0]?.cursor ?? "0" },
      });
      const events = yield* take(resumed, 1);
      expect(tags(events)).toEqual(["TurnEnded"]);
      expect(server.requestsFor("orchestration.launchThread")).toHaveLength(1);
      expect(
        server.requestsFor("orchestration.subscribeThread").at(-1)?.payload,
      ).toEqual({
        threadId: THREAD_ID,
        afterSequence: Number(seen[0]?.cursor),
      });
    }),
  );
});
