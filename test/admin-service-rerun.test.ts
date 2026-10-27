import { Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { LinearRateLimitError } from "../src/domain/errors.js";
import { OrganizationId, SessionId } from "../src/domain/ids.js";
import type { AgentRun } from "../src/domain/models.js";
import { type AdminDeps, createAdminHandle } from "../src/services/admin.js";
import { RunInputRepo, RunRepo } from "../src/services/store/repositories.js";
import {
  config,
  deps,
  issueId,
  organizationId,
  projectId,
  repositoryId,
  request,
  run,
  teamId,
  token,
  unreachable,
} from "./admin-service-helpers.js";

describe("POST /api/admin/runs/:id/rerun", () => {
  const terminalRun: AgentRun = {
    sessionId: Schema.decodeUnknownSync(SessionId)(
      "22222222-2222-4222-8222-222222222222",
    ),
    organizationId,
    issueId: Option.some(issueId),
    repositoryId: Option.some(repositoryId),
    state: "succeeded",
    desiredState: "running",
    ompSessionId: Option.none(),
    ompSessionFile: Option.none(),
    workspacePath: Option.none(),
    teamId: Option.some(teamId),
    projectId: Option.some(projectId),
    attempt: 0,
    leaseOwner: Option.none(),
    leaseExpiresAt: Option.none(),
    lastActivityAt: Option.none(),
    terminalReason: Option.none(),
    nextAttemptAt: Option.none(),
    createdAt: 0,
    updatedAt: 0,
  };

  it("rejects unauthenticated and un-CSRF requests", async () => {
    const noCookie = new Request(
      new URL(
        "/api/admin/runs/22222222-2222-4222-8222-222222222222/rerun",
        config.publicUrl,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect((await run(noCookie)).status).toBe(401);

    const noCsrf = new Request(
      new URL(
        "/api/admin/runs/22222222-2222-4222-8222-222222222222/rerun",
        config.publicUrl,
      ),
      {
        method: "POST",
        headers: {
          Cookie: `omp_gateway_admin=${token}`,
          Origin: config.publicUrl.toString(),
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    expect((await run(noCsrf)).status).toBe(403);
  });

  it("rejects reruns for runs without an issue or with an active run", async () => {
    const noIssue: AgentRun = {
      ...terminalRun,
      sessionId: Schema.decodeUnknownSync(SessionId)(
        "33333333-3333-4333-8333-333333333333",
      ),
      issueId: Option.none(),
    };
    const noIssueHandle = createAdminHandle({
      ...deps,
      runRepo: RunRepo.of({
        ...deps.runRepo,
        get: () => Effect.succeed(Option.some(noIssue)),
      }),
    });
    const noIssueResponse = await Effect.runPromise(
      noIssueHandle(
        request(
          "/api/admin/runs/33333333-3333-4333-8333-333333333333/rerun",
          {},
        ),
      ),
    );
    const noIssueResponseValue = Option.getOrElse(noIssueResponse, () => null);
    expect(noIssueResponseValue?.status).toBe(409);
    expect(await noIssueResponseValue?.text()).toBe(
      "Run is not linked to an issue",
    );
    let createSessionCalls = 0;
    const activeHandle = createAdminHandle({
      ...deps,
      runRepo: RunRepo.of({
        ...deps.runRepo,
        get: () => Effect.succeed(Option.some(terminalRun)),
        hasActiveForIssue: () => Effect.succeed(true),
        createIfNoActiveForIssue: () => Effect.succeed("active"),
      }),
      linearGateway: {
        createSessionOnIssue: () => {
          createSessionCalls += 1;
          return Effect.succeed("55555555-5555-4555-8555-555555555555");
        },
      },
    });
    const activeResponse = await Effect.runPromise(
      activeHandle(
        request(
          "/api/admin/runs/22222222-2222-4222-8222-222222222222/rerun",
          {},
        ),
      ),
    );
    expect(createSessionCalls).toBe(0);
    const activeResponseValue = Option.getOrElse(activeResponse, () => null);
    expect(activeResponseValue?.status).toBe(409);
    expect(await activeResponseValue?.text()).toBe(
      "A run for this issue is already active",
    );
  });
  it("rejects nonterminal reruns before creating a Linear session", async () => {
    let createSessionCalls = 0;
    const nonterminalRun: AgentRun = {
      ...terminalRun,
      state: "running",
    };
    const nonterminalHandle = createAdminHandle({
      ...deps,
      runRepo: RunRepo.of({
        ...deps.runRepo,
        get: () => Effect.succeed(Option.some(nonterminalRun)),
      }),
      linearGateway: {
        createSessionOnIssue: () => {
          createSessionCalls += 1;
          return Effect.succeed("55555555-5555-4555-8555-555555555555");
        },
      },
    });
    const response = await Effect.runPromise(
      nonterminalHandle(
        request(
          "/api/admin/runs/22222222-2222-4222-8222-222222222222/rerun",
          {},
        ),
      ),
    );
    const responseValue = Option.getOrElse(response, () => null);
    expect(responseValue?.status).toBe(409);
    expect(await responseValue?.text()).toBe("Run is not terminal");
    expect(createSessionCalls).toBe(0);
  });
  it("returns 404 for runs belonging to another organization", async () => {
    const foreignRun: AgentRun = {
      ...terminalRun,
      organizationId: Schema.decodeUnknownSync(OrganizationId)(
        "99999999-9999-4999-8999-999999999999",
      ),
    };
    const foreignHandle = createAdminHandle({
      ...deps,
      runRepo: RunRepo.of({
        ...deps.runRepo,
        get: () => Effect.succeed(Option.some(foreignRun)),
      }),
      linearGateway: {
        createSessionOnIssue: () =>
          Effect.die(new Error("must not be called cross-org")),
      },
    });
    const response = await Effect.runPromise(
      foreignHandle(
        request(
          "/api/admin/runs/22222222-2222-4222-8222-222222222222/rerun",
          {},
        ),
      ),
    );
    expect(Option.getOrElse(response, () => null)?.status).toBe(404);
  });

  it("creates a new session, run, and dedupe-safe created input", async () => {
    const created: {
      sessionId?: string;
      createdRun?: boolean;
      enqueued?: boolean;
      createdRunInput?: unknown;
      createdInputId?: unknown;
      createdInputBody?: string;
      payload?: unknown;
    } = {};
    const callOrder: Array<string> = [];
    let reconcilerTriggers = 0;
    const newSessionId = "55555555-5555-4555-8555-555555555555";
    const rerunHandle = createAdminHandle({
      ...deps,
      runRepo: RunRepo.of({
        ...deps.runRepo,
        get: () => Effect.succeed(Option.some(terminalRun)),
        hasActiveForIssue: () => Effect.succeed(false),
        createIfNoActiveForIssue: (input) => {
          callOrder.push("run");
          created.createdRunInput = input;
          created.sessionId = input.sessionId;
          created.createdRun = true;
          return Effect.succeed("created");
        },
      }),
      runInputRepo: RunInputRepo.of({
        ...deps.runInputRepo,
        enqueue: (input) => {
          created.createdInputId = input.id;
          created.createdInputBody = input.body;
          created.payload = input.payload;
          created.enqueued = true;
          return Effect.succeed(true);
        },
      }),
      promptTemplateRepo: {
        get: () => {
          callOrder.push("template");
          return Effect.succeed(
            Option.some({
              organizationId,
              kind: "created" as const,
              body: "{{userRequest}}\n{{issueContext}}\n{{threadComment}}\n{{previousComments}}\n{{guidance}}",
              updatedAt: 1,
            }),
          );
        },
        upsert: unreachable,
        remove: unreachable,
        list: unreachable,
      } as unknown as AdminDeps["promptTemplateRepo"],
      linearGateway: {
        createSessionOnIssue: () => {
          callOrder.push("session");
          return Effect.succeed(newSessionId);
        },
      },
      reconciler: {
        ...deps.reconciler,
        trigger: () => {
          reconcilerTriggers += 1;
          return Effect.void;
        },
      },
    });
    const response = await Effect.runPromise(
      rerunHandle(
        request(
          "/api/admin/runs/22222222-2222-4222-8222-222222222222/rerun",
          {},
        ),
      ),
    );
    const res = Option.getOrElse(response, () => null);
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ sessionId: newSessionId });
    expect(callOrder).toEqual(["template", "session", "run"]);
    expect(created.sessionId).toBe(newSessionId);
    expect(created.createdRun).toBe(true);
    expect(created.enqueued).toBe(true);
    expect(created.createdInputBody).toBe(
      "User request:\nWork on the issue below.\nIssue context:\nIssue: 44444444-4444-4444-8444-444444444444",
    );
    expect(reconcilerTriggers).toBe(1);
    const createdInput = created.createdRunInput as {
      organizationId: unknown;
      issueId: unknown;
      repositoryId: unknown;
      teamId: unknown;
      projectId: unknown;
    };
    expect(createdInput.organizationId).toBe(organizationId);
    expect(createdInput.issueId).toEqual(Option.some(issueId));
    expect(createdInput.repositoryId).toEqual(Option.some(repositoryId));
    expect(createdInput.teamId).toEqual(Option.some(teamId));
    expect(createdInput.projectId).toEqual(Option.some(projectId));
    expect(created.createdInputId).toBe(`${newSessionId}:created`);
    const payload = created.payload as Record<string, unknown>;
    expect(payload.repositoryId).toBe(repositoryId);
    expect(payload.automationDelegated).toBe(false);
  });
  it("serializes overlapping reruns for the same issue before creating a session", async () => {
    let active = false;
    let createSessionCalls = 0;
    let releaseFirst = () => {};
    let signalFirstStarted = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const newSessionId = "55555555-5555-4555-8555-555555555555";
    const rerunHandle = createAdminHandle({
      ...deps,
      runRepo: RunRepo.of({
        ...deps.runRepo,
        get: () => Effect.succeed(Option.some(terminalRun)),
        hasActiveForIssue: () => Effect.succeed(active),
        createIfNoActiveForIssue: () => {
          if (active) return Effect.succeed("active");
          active = true;
          return Effect.succeed("created");
        },
      }),
      runInputRepo: RunInputRepo.of({
        ...deps.runInputRepo,
        enqueue: () => Effect.succeed(true),
      }),
      linearGateway: {
        createSessionOnIssue: () => {
          createSessionCalls += 1;
          signalFirstStarted();
          return createSessionCalls === 1
            ? Effect.promise(() => firstReleased.then(() => newSessionId))
            : Effect.succeed(newSessionId);
        },
      },
    });

    const firstResponsePromise = Effect.runPromise(
      rerunHandle(
        request(
          "/api/admin/runs/22222222-2222-4222-8222-222222222222/rerun",
          {},
        ),
      ),
    );
    await firstStarted;
    const secondResponsePromise = Effect.runPromise(
      rerunHandle(
        request(
          "/api/admin/runs/22222222-2222-4222-8222-222222222222/rerun",
          {},
        ),
      ),
    );
    releaseFirst();
    const [firstResponse, secondResponse] = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);
    const first = Option.getOrElse(firstResponse, () => null);
    const second = Option.getOrElse(secondResponse, () => null);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(409);
    expect(createSessionCalls).toBe(1);
  });
  it("maps Linear rate limits to 429 with retry delay", async () => {
    const rateLimitHandle = createAdminHandle({
      ...deps,
      runRepo: RunRepo.of({
        ...deps.runRepo,
        get: () => Effect.succeed(Option.some(terminalRun)),
        hasActiveForIssue: () => Effect.succeed(false),
      }),
      linearGateway: {
        createSessionOnIssue: () =>
          Effect.fail(
            new LinearRateLimitError({
              message: "Linear rate limit exceeded",
              retryAfterMs: 12_345,
            }),
          ),
      },
    });
    const response = await Effect.runPromise(
      rateLimitHandle(
        request(
          "/api/admin/runs/22222222-2222-4222-8222-222222222222/rerun",
          {},
        ),
      ),
    );
    const responseValue = Option.getOrElse(response, () => null);
    expect(responseValue?.status).toBe(429);
    expect(await responseValue?.text()).toContain("12345ms");
  });
});
