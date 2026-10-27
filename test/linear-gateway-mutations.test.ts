import type * as LinearSdk from "@linear/sdk";
import { afterEach, vi } from "vitest";
import { suitePaths } from "./fixtures/paths.js";

const suitePath = suitePaths();

const sdkState = vi.hoisted(() => {
  type ActivityInput = {
    readonly content?: unknown;
    readonly signalMetadata?: unknown;
  };
  type CommentInput = {
    readonly issueId: string;
    readonly body: string;
  };
  type UpdateInput = {
    readonly plan?: unknown;
    readonly externalUrls?: unknown;
  };
  type Pending = {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: unknown) => void;
  };

  const state: {
    readonly activities: ActivityInput[];
    readonly activityPages: Array<{
      readonly nodes: ReadonlyArray<Record<string, unknown>>;
      readonly pageInfo: {
        readonly hasNextPage: boolean;
        readonly endCursor: string | null;
      };
    }>;
    readonly comments: CommentInput[];
    readonly updates: UpdateInput[];
    readonly pending: Pending[];
    readonly waiters: Array<{
      readonly count: number;
      readonly resolve: () => void;
    }>;
    readonly createdSessionInputs: Array<{ readonly issueId: string }>;
    readonly startedStates: Map<
      string,
      ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly position: number;
      }>
    >;
    teamCalls: number;
    issueHandler: (id: string) => Promise<unknown>;
    activityHandler: (input: ActivityInput) => Promise<unknown>;
  } = {
    activities: [],
    activityPages: [],
    comments: [],
    updates: [],
    pending: [],
    waiters: [],
    createdSessionInputs: [],
    startedStates: new Map(),
    teamCalls: 0,
    issueHandler: async () => undefined,
    activityHandler: async () => ({
      success: true,
      agentActivityId: "activity-id",
    }),
  };

  class TestLinearClient {
    issue(id: string): Promise<unknown> {
      return state.issueHandler(id);
    }
    createAgentActivity(input: ActivityInput): Promise<unknown> {
      state.activities.push(input);
      for (const waiter of state.waiters.splice(0)) {
        if (state.activities.length >= waiter.count) waiter.resolve();
        else state.waiters.push(waiter);
      }
      return state.activityHandler(input);
    }
    agentSession(_id: string): Promise<unknown> {
      return Promise.resolve({
        activities: (variables?: { readonly after?: string }) => {
          const previousPageIndex =
            variables?.after === undefined
              ? -1
              : state.activityPages.findIndex(
                  (page) => page.pageInfo.endCursor === variables.after,
                );
          const pageIndex =
            variables?.after === undefined
              ? 0
              : previousPageIndex < 0
                ? -1
                : previousPageIndex + 1;
          return Promise.resolve(
            state.activityPages[pageIndex] ?? {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          );
        },
      });
    }
    team(teamId: string): Promise<unknown> {
      state.teamCalls += 1;
      return Promise.resolve({
        states: () =>
          Promise.resolve({
            nodes: state.startedStates.get(teamId) ?? [],
          }),
      });
    }
    createComment(input: CommentInput): Promise<unknown> {
      state.comments.push(input);
      return Promise.resolve({
        success: true,
        comment: Promise.resolve({ id: "comment-id" }),
      });
    }
    updateAgentSession(
      _sessionId: string,
      input: UpdateInput,
    ): Promise<unknown> {
      state.updates.push(input);
      return Promise.resolve({ success: true });
    }

    agentSessionCreateOnIssue(input: { issueId: string }): Promise<unknown> {
      state.createdSessionInputs.push(input);
      return Promise.resolve({
        success: true,
        agentSessionId: "new-session-id",
      });
    }
  }

  return {
    state,
    TestLinearClient,
    reset: () => {
      state.activities.length = 0;
      state.comments.length = 0;
      state.updates.length = 0;
      state.activityPages.length = 0;
      state.pending.length = 0;
      state.waiters.length = 0;
      state.createdSessionInputs.length = 0;
      state.startedStates.clear();
      state.teamCalls = 0;
      state.issueHandler = async () => undefined;
      state.activityHandler = async () => ({
        success: true,
        agentActivityId: "activity-id",
      });
    },
    waitForActivity: (count: number) => {
      if (state.activities.length >= count) return Promise.resolve();
      const { promise, resolve } = Promise.withResolvers<void>();
      state.waiters.push({ count, resolve });
      return promise;
    },
  };
});

vi.mock("@linear/sdk", async () => {
  const actual = await vi.importActual<typeof LinearSdk>("@linear/sdk");
  return { ...actual, LinearClient: sdkState.TestLinearClient };
});

import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option, Redacted, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { LinearRateLimitError } from "../src/domain/errors.js";
import {
  AppUserId,
  IssueId,
  OrganizationId,
  SessionId,
} from "../src/domain/ids.js";
import type { AgentRun, Installation } from "../src/domain/models.js";
import { GatewayConfig } from "../src/services/config.js";
import { LinearGateway } from "../src/services/linear-gateway.js";
import {
  InstallationRepo,
  RunRepo,
} from "../src/services/store/repositories.js";

const organizationId = Schema.decodeUnknownSync(OrganizationId)(
  "11111111-1111-4111-8111-111111111111",
);
const sessionId = Schema.decodeUnknownSync(SessionId)(
  "22222222-2222-4222-8222-222222222222",
);
const appUserId = Schema.decodeUnknownSync(AppUserId)(
  "33333333-3333-4333-8333-333333333333",
);
const issueId = Schema.decodeUnknownSync(IssueId)(
  "44444444-4444-4444-8444-444444444444",
);
const run: AgentRun = {
  sessionId,
  organizationId,
  issueId: Option.some(issueId),
  repositoryId: Option.none(),
  state: "running",
  desiredState: "running",
  ompSessionId: Option.none(),
  ompSessionFile: Option.none(),
  workspacePath: Option.none(),
  teamId: Option.none(),
  projectId: Option.none(),
  attempt: 0,
  leaseOwner: Option.none(),
  leaseExpiresAt: Option.none(),
  lastActivityAt: Option.none(),
  terminalReason: Option.none(),
  nextAttemptAt: Option.none(),
  createdAt: 0,
  updatedAt: 0,
};
const installation: Installation = {
  organizationId,
  appUserId,
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: Date.now() + 3_600_000,
  scopes: [],
  revokedAt: Option.none(),
  accessibleTeamIds: Option.none(),
  canAccessAllPublicTeams: Option.none(),
};
const unusedRepoMethod = (..._args: ReadonlyArray<unknown>) => Effect.never;

const gatewayDependencies = Layer.mergeAll(
  Layer.succeed(
    RunRepo,
    RunRepo.of({
      get: () => Effect.succeed(Option.some(run)),
      create: unusedRepoMethod,
      createIfNoActiveForIssue: unusedRepoMethod,
      update: unusedRepoMethod,
      reopen: unusedRepoMethod,
      hasActiveForIssue: unusedRepoMethod,
      listNonTerminalByIssue: unusedRepoMethod,
      listRunnable: unusedRepoMethod,
      listCatchupCandidates: unusedRepoMethod,
      listCancellationPending: unusedRepoMethod,
      claimLease: unusedRepoMethod,
      renewLease: unusedRepoMethod,
      releaseLease: unusedRepoMethod,
      recoverInterruptedRuns: unusedRepoMethod,
    }),
  ),
  Layer.succeed(
    InstallationRepo,
    InstallationRepo.of({
      get: () => Effect.succeed(Option.some(installation)),
      put: unusedRepoMethod,
      revoke: unusedRepoMethod,
      applyPermissionChange: unusedRepoMethod,
      getRawEncryptedAccessToken: unusedRepoMethod,
      createOAuthState: unusedRepoMethod,
      consumeOAuthState: unusedRepoMethod,
    }),
  ),
  Layer.succeed(
    GatewayConfig,
    GatewayConfig.of({
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      linearClientId: "client-id",
      linearClientSecret: Redacted.make("client-secret"),
      linearWebhookSecret: Redacted.make("webhook-secret"),
      tokenEncryptionKey: Redacted.make("token-key"),
      publicUrl: new URL("https://localhost/"),
      logLevel: "info",
      logFile: Option.none(),
      databasePath: ":memory:",
      nixBinaryPath: "nix",
      nixpkgsFlakeRef:
        "github:NixOS/nixpkgs/0123456789abcdef0123456789abcdef01234567",
      nixRootsDir: suitePath("nix-roots"),
      nixGcMaxBytes: 1_000_000,
      workspaceRoot: suitePath("workspaces"),
      ompCliPath: "omp",
      port: 3000,
      leaseDurationMs: 60_000,
      reconcilerCatchupIntervalMs: 300_000,
      reconcilerCatchupMinAgeMs: 120_000,
      repositorySuggestionConfidenceThreshold: 0.8,
      reconcilerIntervalMs: 1_000,
      webhookReplayWindowMs: 60_000,
    }),
  ),
);

const gatewayLayer = LinearGateway.layerWithoutDependencies.pipe(
  Layer.provide(gatewayDependencies),
);
const getGateway = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* LinearGateway;
    }).pipe(Effect.provide(gatewayLayer)),
  );

const activityBody = (content: unknown): string | undefined => {
  if (
    typeof content !== "object" ||
    content === null ||
    Array.isArray(content) ||
    !("body" in content)
  ) {
    return undefined;
  }
  return typeof content.body === "string" ? content.body : undefined;
};

beforeEach(() => sdkState.reset());
afterEach(() => vi.unstubAllGlobals());

describe("LinearGateway parity", () => {
  it("forwards persisted plan and external URL fields verbatim", async () => {
    const gateway = await getGateway();
    const plan = [{ content: "plan secret", status: "completed" }];
    const externalUrls = [
      { label: "private label", url: "https://example.test/private" },
    ];

    await Effect.runPromise(
      gateway
        .updateSession({ sessionId, plan, externalUrls })
        .pipe(Effect.provide(gatewayLayer)),
    );

    expect(sdkState.state.updates).toEqual([{ plan, externalUrls }]);
  });

  it("posts deviation text as an issue comment with the app installation", async () => {
    const gateway = await getGateway();

    const commentId = await Effect.runPromise(
      gateway
        .createIssueComment({
          sessionId,
          body: "### Agent deviation report\n\nUsed the safe fallback.",
        })
        .pipe(Effect.provide(gatewayLayer)),
    );

    expect(commentId).toBe("comment-id");
    expect(sdkState.state.comments).toEqual([
      {
        issueId,
        body: "### Agent deviation report\n\nUsed the safe fallback.",
      },
    ]);
  });

  it("executes three same-organization requests in order", async () => {
    const gateway = await getGateway();
    sdkState.state.activityHandler = (_input) =>
      (() => {
        const { promise, resolve, reject } = Promise.withResolvers<unknown>();
        sdkState.state.pending.push({ resolve, reject });
        return promise;
      })();

    const first = Effect.runPromise(
      gateway
        .createActivity({
          sessionId,
          content: { type: "thought", body: "one" },
        })
        .pipe(Effect.provide(gatewayLayer)),
    );
    await sdkState.waitForActivity(1);
    const second = Effect.runPromise(
      gateway
        .createActivity({
          sessionId,
          content: { type: "thought", body: "two" },
        })
        .pipe(Effect.provide(gatewayLayer)),
    );
    const third = Effect.runPromise(
      gateway
        .createActivity({
          sessionId,
          content: { type: "thought", body: "three" },
        })
        .pipe(Effect.provide(gatewayLayer)),
    );

    expect(sdkState.state.activities).toHaveLength(1);
    sdkState.state.pending
      .shift()
      ?.resolve({ success: true, agentActivityId: "one" });
    await sdkState.waitForActivity(2);
    expect(
      sdkState.state.activities.map((activity) =>
        activityBody(activity.content),
      ),
    ).toEqual(["one", "two"]);
    sdkState.state.pending
      .shift()
      ?.resolve({ success: true, agentActivityId: "two" });
    await sdkState.waitForActivity(3);
    expect(
      sdkState.state.activities.map((activity) =>
        activityBody(activity.content),
      ),
    ).toEqual(["one", "two", "three"]);
    sdkState.state.pending
      .shift()
      ?.resolve({ success: true, agentActivityId: "three" });
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("does not let an interrupted waiter bypass the active organization request", async () => {
    sdkState.state.activityHandler = () => {
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      sdkState.state.pending.push({ resolve, reject });
      return promise;
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const gateway = yield* LinearGateway;
        const first = yield* gateway
          .createActivity({
            sessionId,
            content: { type: "thought", body: "one" },
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => sdkState.waitForActivity(1));

        const interrupted = yield* gateway
          .createActivity({
            sessionId,
            content: { type: "thought", body: "two" },
          })
          .pipe(Effect.forkChild);
        const third = yield* gateway
          .createActivity({
            sessionId,
            content: { type: "thought", body: "three" },
          })
          .pipe(Effect.forkChild);
        yield* Fiber.interrupt(interrupted).pipe(
          Effect.forkChild({ startImmediately: true }),
          Effect.asVoid,
        );

        expect(sdkState.state.activities).toHaveLength(1);
        sdkState.state.pending.shift()?.resolve({
          success: true,
          agentActivityId: "one",
        });
        yield* Effect.promise(() => sdkState.waitForActivity(2));
        expect(
          sdkState.state.activities.map((activity) =>
            activityBody(activity.content),
          ),
        ).toEqual(["one", "three"]);
        sdkState.state.pending.shift()?.resolve({
          success: true,
          agentActivityId: "three",
        });
        yield* Fiber.join(first);
        yield* Fiber.join(third);
      }).pipe(Effect.provide(gatewayLayer)),
    );
  });

  it("retries a 429 once and surfaces the typed rate-limit failure", async () => {
    const gateway = await getGateway();
    let attempts = 0;
    sdkState.state.activityHandler = async () => {
      attempts += 1;
      throw { status: 429, retryAfter: 0 };
    };

    const exit = await Effect.runPromiseExit(
      gateway
        .createActivity({
          sessionId,
          content: { type: "thought", body: "rate limited" },
        })
        .pipe(Effect.provide(gatewayLayer)),
    );

    expect(attempts).toBe(2);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons).toHaveLength(1);
      const reason = exit.cause.reasons[0];
      expect(reason?._tag).toBe("Fail");
      if (reason?._tag === "Fail")
        expect(reason.error).toBeInstanceOf(LinearRateLimitError);
    }
  });
});

describe("LinearGateway.getIssue project enrichment", () => {
  for (const stage of ["project", "project-labels"] as const) {
    for (const failure of [
      "unavailable",
      "rate-limited",
      "persistent-rate-limit",
    ] as const) {
      effectIt.live(`handles ${failure} during ${stage} enrichment`, () =>
        Effect.gen(function* () {
          let attempts = 0;
          sdkState.state.issueHandler = async (id) => {
            attempts += 1;
            const load = async () => {
              if (failure === "unavailable")
                throw new Error("project unavailable");
              if (failure === "persistent-rate-limit" || attempts === 1)
                throw { status: 429, retryAfter: 0 };
            };
            return {
              id,
              identifier: "TEST-1",
              title: "Issue snapshot",
              description: "Still available",
              stateId: "state-started",
              state: Promise.resolve({
                id: "state-started",
                name: "Started",
                type: "started",
              }),
              delegateId: "app-user",
              url: "https://linear.app/test/issue/TEST-1",
              teamId: "api-team",
              projectId: "api-project",
              labels: async () => ({ nodes: [{ name: "issue-label" }] }),
              get project() {
                return (async () => {
                  if (stage === "project") await load();
                  return {
                    id: "api-project",
                    labels: async () => {
                      if (stage === "project-labels") await load();
                      return { nodes: [{ name: "project-label" }] };
                    },
                  };
                })();
              },
            };
          };
          const gateway = yield* LinearGateway;
          const result = yield* Effect.result(
            gateway.getIssue({ sessionId, issueId }),
          );
          expect(attempts).toBe(failure === "unavailable" ? 1 : 2);
          if (failure === "persistent-rate-limit") {
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect(result.failure).toBeInstanceOf(LinearRateLimitError);
          } else {
            expect(result._tag).toBe("Success");
            if (result._tag === "Success")
              expect(result.success).toEqual({
                id: issueId,
                identifier: "TEST-1",
                title: "Issue snapshot",
                description: "Still available",
                stateId: "state-started",
                stateName: "Started",
                stateType: "started",
                delegateId: "app-user",
                url: "https://linear.app/test/issue/TEST-1",
                teamId: "api-team",
                projectId: "api-project",
                projectLabels:
                  failure === "unavailable" ? [] : ["project-label"],
                labels: ["issue-label"],
              });
          }
        }).pipe(Effect.provide(gatewayLayer)),
      );
    }
  }
});

describe("LinearGateway.createSessionOnIssue", () => {
  it("creates an agent session on an issue and returns the new session id", async () => {
    sdkState.reset();
    const gateway = await getGateway();
    const newSessionId = await Effect.runPromise(
      gateway
        .createSessionOnIssue({
          organizationId: String(organizationId),
          issueId: String(issueId),
        })
        .pipe(Effect.provide(gatewayLayer)),
    );
    expect(newSessionId).toBe("new-session-id");
    expect(sdkState.state.createdSessionInputs).toEqual([
      { issueId: String(issueId) },
    ]);
  });
});
