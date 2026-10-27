import { join } from "node:path";
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import {
  type DatabaseError,
  LinearApiError,
  type NixEnvironmentError,
  type RpcProtocolError,
} from "../src/domain/errors.js";
import {
  AppUserId,
  IssueId,
  OrganizationId,
  SessionId,
} from "../src/domain/ids.js";
import type { Installation } from "../src/domain/models.js";
import { GatewayConfig } from "../src/services/config.js";
import {
  GitHubApp,
  type GitHubAppTokenService,
} from "../src/services/github-app.js";
import { LinearGateway } from "../src/services/linear-gateway.js";
import { McpOAuth } from "../src/services/mcp-oauth.js";
import { NativeBuildFleet } from "../src/services/native-build-fleet.js";
import { NixEnvironment } from "../src/services/nix-environment.js";
import { ActivityProjector } from "../src/services/projector.js";
import {
  type RpcEvent,
  type RpcHostToolCall,
  type RpcHostToolDefinition,
  type RpcHostToolResult,
  RpcWorker,
  type RpcWorkerHandle,
} from "../src/services/rpc-worker.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  AgentSettingsRepo,
  InstallationRepo,
  McpServerRepo,
  ProjectionRepo,
  PromptTemplateRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import {
  SqliteClient,
  SqliteClientLive,
  type SqliteClientShape,
} from "../src/services/store/sqlite-client.js";
import { WorkerIdentityRepo } from "../src/services/store/worker-identity-repo.js";
import { TokenCrypto } from "../src/services/token-crypto.js";
import { testPaths } from "./fixtures/paths.js";

export const createAuthorityFixture = () => {
  const testPath = testPaths();
  let authorityTestRoot = "";

  const testConfigProvider = (
    githubEnabled = false,
    valuesOverride: ReadonlyArray<readonly [string, string]> = [],
  ) => {
    const values: Array<readonly [string, string]> = [
      ["WORKER_SANDBOX_MODE", "native"],
      ["LINEAR_CLIENT_ID", "test-client"],
      ["LINEAR_CLIENT_SECRET", "test-secret"],
      ["LINEAR_WEBHOOK_SECRET", "test-webhook-secret"],
      ["TOKEN_ENCRYPTION_KEY", "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="],
      ["PUBLIC_URL", "http://localhost:3000"],
      [
        "NIXPKGS_FLAKE_REF",
        "github:NixOS/nixpkgs/0123456789012345678901234567890123456789",
      ],
      ["WORKSPACE_ROOT", authorityTestRoot],
    ];
    if (githubEnabled) {
      values.push(
        ["GITHUB_APP_ID", "test-app"],
        ["GITHUB_APP_PRIVATE_KEY", "test-private-key"],
      );
    }
    return ConfigProvider.fromUnknown(
      Object.fromEntries(new Map([...values, ...valuesOverride])),
      { preserveEmptyStrings: true },
    );
  };

  let workerEventListener: ((event: RpcEvent) => void) | undefined;

  let projectionWaiter: Deferred.Deferred<void, never> | undefined;

  let projectionExpected = 0;

  const projectorEvents: Array<{
    readonly sessionId: string;
    readonly sequence: number;
    readonly event: RpcEvent;
  }> = [];

  const projectorThoughts: Array<{
    readonly sessionId: string;
    readonly sourceKey: string;
    readonly text: string;
  }> = [];

  const projectorElicitations: Array<{
    readonly sessionId: string;
    readonly sourceKey: string;
    readonly text: string;
    readonly options: ReadonlyArray<string> | undefined;
  }> = [];

  const projectorTerminals: Array<{
    readonly sessionId: string;
    readonly sourceKey: string;
    readonly kind: string;
    readonly text: string;
  }> = [];

  const toolExternalUrlCalls: Array<{
    readonly sessionId: string;
    readonly urls: ReadonlyArray<{
      readonly label: string;
      readonly url: string;
    }>;
  }> = [];

  let linearIssueLabels: ReadonlyArray<string> = [];

  let linearIssueTeamId: string | null = null;

  let linearIssueProjectId: string | null = null;

  let linearProjectLabels: ReadonlyArray<string> = [];

  let linearIssueReads = 0;

  let linearIssueLookupFails = false;

  let linearIssueStateType = "started";

  let elicitationWaiter: Deferred.Deferred<void, never> | undefined;

  const signalProjection = (): void => {
    if (
      projectionWaiter !== undefined &&
      projectorEvents.length >= projectionExpected
    ) {
      Deferred.doneUnsafe(projectionWaiter, Effect.void);
      projectionWaiter = undefined;
    }
  };

  const signalElicitation = (): void => {
    if (elicitationWaiter !== undefined) {
      Deferred.doneUnsafe(elicitationWaiter, Effect.yieldNow);
      elicitationWaiter = undefined;
    }
  };

  let terminalFailure: DatabaseError | undefined;

  const mockProjector = ActivityProjector.of({
    thought: (sessionId, sourceKey, text) =>
      Effect.sync(() => {
        projectorThoughts.push({ sessionId, sourceKey, text });
        return true;
      }),
    deviation: () => Effect.succeed(true),
    elicitation: (sessionId, sourceKey, text, options) =>
      Effect.sync(() => {
        projectorElicitations.push({ sessionId, sourceKey, text, options });
        signalElicitation();
        return true;
      }),
    terminal: (sessionId, sourceKey, kind, text) =>
      Effect.gen(function* () {
        projectorTerminals.push({ sessionId, sourceKey, kind, text });
        if (terminalFailure !== undefined)
          return yield* Effect.fail(terminalFailure);
        return true;
      }),
    plan: () => Effect.succeed(true),
    externalUrls: () => Effect.succeed(true),
    flushPending: () => Effect.succeed(0),
    projectRpcEvent: (sessionId, sequence, event) =>
      Effect.sync(() => {
        projectorEvents.push({ sessionId, sequence, event: event as RpcEvent });
        signalProjection();
      }),
  });

  const workerPrompts: Array<string> = [];

  let registeredHostTools: ReadonlyArray<RpcHostToolDefinition> = [];

  let hostToolListener:
    | ((
        request: RpcHostToolCall,
      ) => Effect.Effect<RpcHostToolResult, never, never>)
    | undefined;

  let workerStopBlock:
    | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
    | undefined;

  let hostToolRegistrationError: RpcProtocolError | undefined;

  const orderEvents: Array<string> = [];

  const mockWorker: RpcWorkerHandle = {
    sessionId: Effect.succeed(Option.none()),
    sessionFile: Effect.succeed(Option.none()),
    isStreaming: Effect.succeed(false),
    start: () => Effect.void,
    stop: () =>
      Effect.gen(function* () {
        if (workerStopBlock !== undefined) {
          yield* Deferred.succeed(workerStopBlock.entered, undefined);
          yield* Deferred.await(workerStopBlock.release);
        }
        orderEvents.push("worker-stopped");
      }),
    prompt: (message) =>
      Effect.sync(() => {
        workerPrompts.push(message);
        return true;
      }),
    steer: () => Effect.void,
    followUp: () => Effect.void,
    setHostTools: (tools) =>
      Effect.gen(function* () {
        if (hostToolRegistrationError !== undefined) {
          return yield* Effect.fail(hostToolRegistrationError);
        }
        registeredHostTools = tools;
      }),
    onHostToolCall: (listener) =>
      Effect.sync(() => {
        hostToolListener = listener;
        return () =>
          Effect.sync(() => {
            if (hostToolListener === listener) hostToolListener = undefined;
          });
      }),
    abort: () => Effect.void,
    getState: () => Effect.succeed({}),
    respondToUi: () => Effect.void,
    onEvent: (listener) =>
      Effect.sync(() => {
        workerEventListener = listener;
        return () =>
          Effect.sync(() => {
            if (workerEventListener === listener)
              workerEventListener = undefined;
          });
      }),
  };

  const mockRpcWorker = RpcWorker.of({
    spawn: (input) =>
      Effect.sync(() => {
        workerSpawnInputs.push(input);
        return mockWorker;
      }),
  });

  const workerSpawnInputs: Array<{
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env?: Record<string, string | undefined>;
    readonly injectedEnv?: Record<string, string>;
  }> = [];

  let nixPathEntries: ReadonlyArray<string> = [];

  let nixPrepareError: NixEnvironmentError | undefined;

  let nixPrepareBlock:
    | { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> }
    | undefined;

  const nixPreparedRepositories: Array<string> = [];

  const mockNixEnvironment = NixEnvironment.of({
    enforceBudget: () =>
      Effect.succeed({ removed: 0, sizeBytes: 0, withinBudget: true }),
    prepare: (repository) => {
      nixPreparedRepositories.push(repository.id);
      if (nixPrepareError !== undefined) return Effect.fail(nixPrepareError);
      return Effect.gen(function* () {
        if (nixPrepareBlock !== undefined) {
          yield* Deferred.succeed(nixPrepareBlock.entered, undefined);
          yield* Deferred.await(nixPrepareBlock.release);
        }
        return {
          cacheKey: "test-cache",
          storePaths: [],
          pathEntries: nixPathEntries,
          reused: false,
        };
      });
    },
    list: () => Effect.succeed([]),
    prune: () => Effect.succeed(false),
  });

  const toolCommentCalls: Array<{
    readonly sessionId: string;
    readonly body: string;
  }> = [];

  const workspaceWriteCalls: Array<{ readonly operation: string }> = [];

  let commentEnteredSignal: Deferred.Deferred<void> | undefined;

  let commentRelease: Deferred.Deferred<void> | undefined;

  const mockToolsGateway = LinearGateway.of({
    createActivity: () => Effect.die(new Error("unused in authority tests")),
    updateSession: () => Effect.die(new Error("unused in authority tests")),
    createIssueComment: (input) =>
      Effect.gen(function* () {
        if (commentEnteredSignal !== undefined) {
          Deferred.doneUnsafe(commentEnteredSignal, Effect.void);
        }
        if (commentRelease !== undefined) {
          yield* Deferred.await(commentRelease);
        }
        toolCommentCalls.push(input);
        orderEvents.push("comment-completed");
        return `comment-${toolCommentCalls.length}`;
      }),
    refreshInstallation: () =>
      Effect.die(new Error("unused in authority tests")),
    listSessionActivities: () =>
      Effect.die(new Error("unused in authority tests")),
    getIssue: () => {
      linearIssueReads++;
      return linearIssueLookupFails
        ? Effect.fail(
            new LinearApiError({
              message: "issue lookup unavailable",
              operation: "getIssue",
            }),
          )
        : Effect.succeed({
            id: "issue-1",
            identifier: "AUTH-1",
            title: "Authority issue",
            description: null,
            stateId: "state-started",
            stateName: "In Progress",
            stateType: linearIssueStateType,
            delegateId: "authority-app-user",
            url: null,
            teamId: linearIssueTeamId,
            projectId: linearIssueProjectId,
            projectLabels: linearProjectLabels,
            labels: linearIssueLabels,
          });
    },
    updateIssue: () => Effect.void,
    workspaceRead: (input: {
      readonly operation: string;
      readonly input: unknown;
    }) => Effect.succeed({ operation: input.operation, input: input.input }),
    workspaceWrite: (input: { readonly operation: string }) =>
      Effect.sync(() => {
        workspaceWriteCalls.push(input);
        return { ok: true };
      }),
    addSessionExternalUrls: (input: {
      readonly sessionId: string;
      readonly urls: ReadonlyArray<{
        readonly label: string;
        readonly url: string;
      }>;
    }) =>
      Effect.sync(() => {
        toolExternalUrlCalls.push(input);
      }),
    teamStartedStates: () => Effect.succeed([]),
    repositorySuggestions: () => Effect.succeed([]),
    createSessionOnIssue: () =>
      Effect.die(new Error("unused in authority tests")),
  });

  const withAuthority = <A, E>(
    effect: (
      db: SqliteClientShape["db"],
    ) => Effect.Effect<
      A,
      E,
      | SessionAuthority
      | AgentSettingsRepo
      | RunRepo
      | RunInputRepo
      | RunEventRepo
      | InstallationRepo
      | McpServerRepo
      | McpOAuth
      | TokenCrypto
      | PromptTemplateRepo
      | ProjectionRepo
      | WorkspaceRepo
      | NixEnvironment
      | GitHubApp
      | ActivityProjector
      | RpcWorker
    >,
    options?: {
      readonly afterShutdown?: (db: SqliteClientShape["db"]) => void;
      readonly config?: ReadonlyArray<readonly [string, string]>;
      readonly configOverride?:
        | ((config: GatewayConfig["Service"]) => GatewayConfig["Service"])
        | undefined;
      readonly withLinearGateway?: boolean;
      readonly nativeFleet?: NativeBuildFleet["Service"];
      readonly githubApp?: GitHubAppTokenService;
      readonly workerUid?: string;
      readonly workerIdentityRepo?: WorkerIdentityRepo["Service"];
    },
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        authorityTestRoot = testPath("temporary");
        linearIssueLookupFails = false;
        linearIssueLabels = [];
        linearIssueTeamId = null;
        linearIssueProjectId = null;
        linearProjectLabels = [];
        linearIssueReads = 0;
        linearIssueStateType = "started";
        toolExternalUrlCalls.length = 0;
        terminalFailure = undefined;
        workerEventListener = undefined;
        hostToolListener = undefined;

        projectionWaiter = undefined;
        elicitationWaiter = undefined;
        registeredHostTools = [];
        hostToolRegistrationError = undefined;
        workerStopBlock = undefined;
        projectionExpected = 0;
        projectorEvents.length = 0;
        projectorThoughts.length = 0;
        projectorElicitations.length = 0;
        workerSpawnInputs.length = 0;
        workerPrompts.length = 0;
        nixPreparedRepositories.length = 0;
        nixPathEntries = [];
        nixPrepareError = undefined;
        nixPrepareBlock = undefined;
        projectorTerminals.length = 0;
        toolCommentCalls.length = 0;
        workspaceWriteCalls.length = 0;
        orderEvents.length = 0;
        commentEnteredSignal = undefined;
        commentRelease = undefined;
        const sqliteContext = yield* Layer.build(SqliteClientLive(":memory:"));
        const sqlite = Context.get(sqliteContext, SqliteClient);
        const githubAppOverride: Layer.Layer<GitHubApp> =
          options?.githubApp === undefined
            ? (Layer.empty as Layer.Layer<GitHubApp>)
            : Layer.succeed(
                GitHubApp,
                options.githubApp as GitHubApp["Service"],
              );
        const linearGatewayOverride: Layer.Layer<LinearGateway> =
          options?.withLinearGateway === true
            ? Layer.succeed(LinearGateway, mockToolsGateway)
            : (Layer.empty as Layer.Layer<LinearGateway>);
        const gatewayConfig =
          options?.configOverride === undefined
            ? GatewayConfig.layer
            : Layer.effect(
                GatewayConfig,
                GatewayConfig.pipe(Effect.map(options.configOverride)),
              ).pipe(Layer.provide(GatewayConfig.layer));
        const dependencies = Layer.mergeAll(
          gatewayConfig,
          TokenCrypto.layer,
          AgentSettingsRepo.layer,
          InstallationRepo.layer,
          McpServerRepo.layer,
          McpOAuth.layer,
          PromptTemplateRepo.layer,
          ProjectionRepo.layer,
          RunEventRepo.layer,
          RunInputRepo.layer,
          RunRepo.layer,
          WorkspaceRepo.layer,
          options?.workerIdentityRepo !== undefined
            ? Layer.succeed(WorkerIdentityRepo, options.workerIdentityRepo)
            : options?.workerUid === undefined
              ? WorkerIdentityRepo.layer
              : Layer.succeed(WorkerIdentityRepo, {
                  acquire: () => Effect.succeed(options.workerUid),
                  release: () => Effect.void,
                }),
          GitHubApp.layer,
          githubAppOverride,
          Layer.succeed(ActivityProjector, mockProjector),
          Layer.succeed(RpcWorker, mockRpcWorker),
          Layer.succeed(NixEnvironment, mockNixEnvironment),
          linearGatewayOverride,
          ...(options?.nativeFleet
            ? [Layer.succeed(NativeBuildFleet, options.nativeFleet)]
            : []),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(SqliteClient, sqlite),
              ConfigProvider.layer(
                testConfigProvider(
                  options?.githubApp !== undefined,
                  options?.config,
                ),
              ),
            ),
          ),
        );
        const authority = SessionAuthority.layerWithoutDependencies.pipe(
          Layer.provide(dependencies),
        );
        const result = yield* effect(sqlite.db).pipe(
          Effect.provide(Layer.mergeAll(dependencies, authority)),
        );
        yield* Effect.sync(() => options?.afterShutdown?.(sqlite.db));
        return result;
      }),
    );

  const testSessionId =
    Schema.decodeUnknownSync(SessionId)("authority-session");

  const testIssueId = Schema.decodeUnknownSync(IssueId)("authority-issue");

  const testOrganizationId = Schema.decodeUnknownSync(OrganizationId)(
    "authority-organization",
  );

  const install = (organizationId: OrganizationId): Installation => ({
    organizationId,
    appUserId: Schema.decodeUnknownSync(AppUserId)("authority-app-user"),
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 3_600_000,
    scopes: ["read"],
    revokedAt: Option.none(),
    accessibleTeamIds: Option.none(),
    canAccessAllPublicTeams: Option.none(),
  });

  const seedInterrupted = (
    sid: SessionId,
    state: "starting" | "running" | "waiting" | "orphaned" = "orphaned",
  ) =>
    Effect.gen(function* () {
      yield* InstallationRepo.use((service) =>
        service.put(install(testOrganizationId)),
      );
      yield* RunRepo.use((service) =>
        service.create({
          sessionId: sid,
          organizationId: testOrganizationId,
          issueId: Option.none(),
        }),
      );
      yield* RunRepo.use((service) =>
        service.update(sid, {
          state,
          workspacePath: Option.some(authorityTestRoot),
          ompSessionFile: Option.some(join(authorityTestRoot, "session.jsonl")),
        }),
      );
    });

  return {
    testPath,
    get authorityTestRoot() {
      return authorityTestRoot;
    },
    get workerEventListener() {
      return workerEventListener;
    },
    set workerEventListener(value: typeof workerEventListener) {
      workerEventListener = value;
    },
    get projectionWaiter() {
      return projectionWaiter;
    },
    set projectionWaiter(value: typeof projectionWaiter) {
      projectionWaiter = value;
    },
    get projectionExpected() {
      return projectionExpected;
    },
    set projectionExpected(value: typeof projectionExpected) {
      projectionExpected = value;
    },
    projectorEvents,
    projectorThoughts,
    projectorElicitations,
    projectorTerminals,
    toolExternalUrlCalls,
    get linearIssueLabels() {
      return linearIssueLabels;
    },
    set linearIssueLabels(value: typeof linearIssueLabels) {
      linearIssueLabels = value;
    },
    get linearIssueTeamId() {
      return linearIssueTeamId;
    },
    set linearIssueTeamId(value: typeof linearIssueTeamId) {
      linearIssueTeamId = value;
    },
    get linearIssueProjectId() {
      return linearIssueProjectId;
    },
    set linearIssueProjectId(value: typeof linearIssueProjectId) {
      linearIssueProjectId = value;
    },
    get linearProjectLabels() {
      return linearProjectLabels;
    },
    set linearProjectLabels(value: typeof linearProjectLabels) {
      linearProjectLabels = value;
    },
    get linearIssueReads() {
      return linearIssueReads;
    },
    get linearIssueLookupFails() {
      return linearIssueLookupFails;
    },
    set linearIssueLookupFails(value: typeof linearIssueLookupFails) {
      linearIssueLookupFails = value;
    },
    get linearIssueStateType() {
      return linearIssueStateType;
    },
    set linearIssueStateType(value: typeof linearIssueStateType) {
      linearIssueStateType = value;
    },
    get elicitationWaiter() {
      return elicitationWaiter;
    },
    set elicitationWaiter(value: typeof elicitationWaiter) {
      elicitationWaiter = value;
    },
    get terminalFailure() {
      return terminalFailure;
    },
    set terminalFailure(value: typeof terminalFailure) {
      terminalFailure = value;
    },
    workerPrompts,
    get registeredHostTools() {
      return registeredHostTools;
    },
    get hostToolListener() {
      return hostToolListener;
    },
    get workerStopBlock() {
      return workerStopBlock;
    },
    set workerStopBlock(value: typeof workerStopBlock) {
      workerStopBlock = value;
    },
    get hostToolRegistrationError() {
      return hostToolRegistrationError;
    },
    set hostToolRegistrationError(value: typeof hostToolRegistrationError) {
      hostToolRegistrationError = value;
    },
    orderEvents,
    workerSpawnInputs,
    get nixPathEntries() {
      return nixPathEntries;
    },
    set nixPathEntries(value: typeof nixPathEntries) {
      nixPathEntries = value;
    },
    get nixPrepareError() {
      return nixPrepareError;
    },
    set nixPrepareError(value: typeof nixPrepareError) {
      nixPrepareError = value;
    },
    get nixPrepareBlock() {
      return nixPrepareBlock;
    },
    set nixPrepareBlock(value: typeof nixPrepareBlock) {
      nixPrepareBlock = value;
    },
    nixPreparedRepositories,
    toolCommentCalls,
    workspaceWriteCalls,
    get commentEnteredSignal() {
      return commentEnteredSignal;
    },
    set commentEnteredSignal(value: typeof commentEnteredSignal) {
      commentEnteredSignal = value;
    },
    get commentRelease() {
      return commentRelease;
    },
    set commentRelease(value: typeof commentRelease) {
      commentRelease = value;
    },
    withAuthority,
    testSessionId,
    testIssueId,
    testOrganizationId,
    install,
    seedInterrupted,
  };
};
