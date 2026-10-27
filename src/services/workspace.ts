import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, opendir, rename } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { Clock, Context, Effect, Layer, Option, Semaphore } from "effect";
import {
  type DatabaseError,
  type RowDecodeError,
  WorkspaceError,
} from "../domain/errors.js";
import type { OrganizationId } from "../domain/ids.js";
import type { RepositoryRecord } from "../domain/models.js";
import { isWithin } from "../util/paths.js";
import { acquireCloneLock } from "./clone-lock.js";
import { GatewayConfig } from "./config.js";
import { GitHubApp, type GitHubAppTokenService } from "./github-app.js";
import { startGitHubGitBroker } from "./github-git-broker.js";
import { WorkspaceRepo } from "./store/repositories.js";
import {
  prepareWorkerWorkspace,
  sealWorkerWorkspaceSync,
  workerUidRange,
} from "./worker-security.js";
import {
  needsWorkspaceIdentity,
  removeWorkerWorkspace,
} from "./workspace-process.js";

export { isWithin } from "../util/paths.js";

import {
  ensureRoot,
  lstatOrMissing,
  realpathOrFail,
  validateExistingTarget,
  validateMarker,
  writeMarker,
} from "./workspace-files.js";
import {
  runGit,
  runGitOutput,
  unsetGitHubExtraHeader,
  workspaceFailure,
} from "./workspace-git.js";
import {
  isHttpsGitHubRepositoryUrl,
  mintGitHubExtraHeader,
  parseContext,
  parseRepositorySuggestionCandidate,
  type RepositoryResolution,
  resolveFromRepositories,
  safeSessionKey,
  type WorkspaceRepoShape,
} from "./workspace-resolution.js";

export {
  assertT3GitCredentials,
  persistGitHubExtraHeader,
  removeGitHubExtraHeaders,
  runGitOutput,
  unsetGitHubExtraHeader,
} from "./workspace-git.js";
export {
  isHttpsGitHubRepositoryUrl,
  parseRepositorySuggestionCandidate,
  type RepositoryResolution,
  type RepositorySuggestionCandidate,
  safeSessionKey,
  type WorkspaceRepoShape,
} from "./workspace-resolution.js";
export const makeWorkspace = (input: {
  readonly workspaceRoot: string;
  readonly gitTimeoutMs?: number;
  readonly repo: WorkspaceRepoShape;
  readonly githubApp: GitHubAppTokenService | undefined;
}) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(runtime);
    const hostKey = createHash("sha256")
      .update(hostname())
      .digest("hex")
      .slice(0, 16);
    // Ownership lives in the name, so even a crash between mkdir and the first
    // write leaves enough information for recovery. Never infer death from age.
    const stagingRecoveryGate = yield* Semaphore.make(1);
    let stagingRecovered = false;
    let stagingRetryAt = 0;
    const recoverStaging = (workerUid: string | undefined) =>
      stagingRecoveryGate.withPermits(1)(
        Effect.gen(function* () {
          if (
            stagingRecovered ||
            (yield* Clock.currentTimeMillis) < stagingRetryAt
          )
            return;
          yield* ensureRoot(input.workspaceRoot, "startup").pipe(
            Effect.flatMap((root) =>
              Effect.tryPromise({
                try: async () => {
                  const entries = await opendir(root);
                  let scanned = 0;
                  let removed = 0;
                  for await (const entry of entries) {
                    if (++scanned > 10_000 || removed >= 100) break;
                    const lockedOwner =
                      /^\.[a-f0-9]{32}-clone-v2-([a-f0-9]{32})-[A-Za-z0-9]+$/u.exec(
                        entry.name,
                      );
                    if (lockedOwner !== null && entry.isDirectory()) {
                      const ownerId = lockedOwner[1];
                      if (ownerId === undefined) continue;
                      const lock = await acquireCloneLock(root, ownerId);
                      if (lock === undefined) continue;
                      try {
                        await removeWorkerWorkspace(
                          join(root, entry.name),
                          root,
                          workerUid,
                        );
                        removed++;
                      } finally {
                        await lock.release();
                      }
                      continue;
                    }
                    const owner =
                      /^\.[a-f0-9]{32}-clone-([a-f0-9]{16})-([1-9][0-9]*)-[A-Za-z0-9]+$/u.exec(
                        entry.name,
                      );
                    if (
                      owner === null ||
                      owner[1] !== hostKey ||
                      !entry.isDirectory()
                    )
                      continue;
                    const pid = Number(owner[2]);
                    if (!Number.isSafeInteger(pid)) continue;
                    try {
                      process.kill(pid, 0);
                      continue;
                    } catch (error) {
                      if (
                        !(
                          error instanceof Error &&
                          "code" in error &&
                          error.code === "ESRCH"
                        )
                      )
                        continue;
                    }
                    // Dead owners cannot publish these random, per-clone names.
                    // Forced removal is idempotent when multiple gateways clean up.
                    await removeWorkerWorkspace(
                      join(root, entry.name),
                      root,
                      workerUid,
                    );
                    removed++;
                  }
                },
                catch: workspaceFailure(
                  "recover abandoned clones",
                  "git_failed",
                  "startup",
                ),
              }),
            ),
            Effect.tap(() =>
              Effect.sync(() => {
                stagingRecovered = true;
              }),
            ),
            Effect.catch((error) =>
              Effect.gen(function* () {
                stagingRetryAt = (yield* Clock.currentTimeMillis) + 30_000;
                yield* Effect.logWarning(
                  "workspace.staging_recovery_failed",
                ).pipe(
                  Effect.annotateLogs({
                    event: "workspace.staging_recovery_failed",
                    error: String(error),
                  }),
                );
              }),
            ),
          );
        }),
      );
    const git = (
      args: ReadonlyArray<string>,
      cwd: string | undefined,
      sessionId: string,
    ) => runGit(args, cwd, sessionId, input.gitTimeoutMs);
    const hasGitRepository = (
      target: string,
      sessionId: string,
    ): Effect.Effect<boolean, WorkspaceError> =>
      Effect.promise(() =>
        lstat(join(target, ".git")).then(
          (info) =>
            !info.isSymbolicLink() && (info.isDirectory() || info.isFile()),
          () => false,
        ),
      ).pipe(
        Effect.flatMap((ownsGit) =>
          ownsGit
            ? runGitOutput(["rev-parse", "--git-dir"], target, sessionId).pipe(
                Effect.as(true),
              )
            : Effect.succeed(false),
        ),
        Effect.catchIf(
          (error) => error.message.includes("not a git repository"),
          () => Effect.succeed(false),
        ),
      );
    const resolve = Effect.fn("Workspace.resolve")(function* (
      context: unknown,
    ): Effect.fn.Return<RepositoryResolution, DatabaseError | RowDecodeError> {
      const parsed = parseContext(context);
      if (Option.isNone(parsed)) {
        yield* Effect.logWarning(
          "Workspace resolve rejected: invalid context",
        ).pipe(
          Effect.annotateLogs({
            reason: "invalid_context",
          }),
        );
        return { kind: "none" };
      }

      if (parsed.value.organizationId === null) {
        return { kind: "none" };
      }

      const repositories = yield* input.repo.listRepositories(
        parsed.value.organizationId as OrganizationId,
      );
      const resolution = resolveFromRepositories(parsed.value, repositories);

      yield* Effect.annotateCurrentSpan({
        "workspace.organization_id": parsed.value.organizationId,
        "workspace.resolution_kind": resolution.kind,
      });

      if (resolution.kind === "match") {
        yield* Effect.logInfo("Repository resolved").pipe(
          Effect.annotateLogs({
            event: "repository.resolved",
            organizationId: parsed.value.organizationId,
            repositoryId: resolution.repository.id,
            repositoryUrl: resolution.repository.url,
          }),
        );
      } else if (resolution.kind === "ambiguous") {
        yield* Effect.logInfo("Repository resolution ambiguous").pipe(
          Effect.annotateLogs({
            event: "repository.ambiguous",
            organizationId: parsed.value.organizationId,
            repositoryIds: resolution.repositories.map((r) => r.id),
          }),
        );
      }

      return resolution;
    });
    const refreshGitHubExtraHeader = Effect.fn(
      "Workspace.refreshGitHubExtraHeader",
    )(function* (
      sessionId: string,
      _repository: RepositoryRecord,
      target: string,
    ): Effect.fn.Return<void, WorkspaceError> {
      yield* configureGitIdentity(sessionId, target);
      // Installation tokens stay in the gateway. Workers get a session-bound
      // Git broker URL at launch, never a credential in repository config.
      yield* unsetGitHubExtraHeader(target, sessionId, input.gitTimeoutMs);
    });

    const clearGitBrokerConfig = Effect.fn("Workspace.clearGitBrokerConfig")(
      function* (
        sessionId: string,
        target: string,
      ): Effect.fn.Return<void, WorkspaceError> {
        const hasGitDir = yield* hasGitRepository(target, sessionId);
        if (!hasGitDir) return;
        const entries = yield* runGitOutput(
          [
            "config",
            "--local",
            "--get-regexp",
            "^url\\.http://[^[:space:]]*/git/[A-Za-z0-9_-]+/[^/[:space:]]+/[^/[:space:]]+\\.insteadOf$",
          ],
          target,
          sessionId,
          input.gitTimeoutMs,
          undefined,
          true,
        );
        const keys = entries
          .split(/\r?\n/u)
          .map((entry) => entry.slice(0, entry.indexOf(" ")))
          .filter((key) => key.length > 0);
        yield* Effect.forEach(
          keys,
          (key) =>
            git(["config", "--local", "--unset-all", key], target, sessionId),
          { discard: true },
        );
      },
    );

    const configureGitBroker = Effect.fn("Workspace.configureGitBroker")(
      function* (
        sessionId: string,
        target: string,
        broker: ReturnType<typeof startGitHubGitBroker>,
        relayBaseUrl?: string,
      ): Effect.fn.Return<void, WorkspaceError> {
        const hasGitDir = yield* hasGitRepository(target, sessionId);
        if (!hasGitDir) return;
        const config =
          relayBaseUrl === undefined
            ? { key: broker.gitConfigKey, value: broker.gitConfigValue }
            : broker.gitConfigFor(relayBaseUrl);
        yield* clearGitBrokerConfig(sessionId, target);
        // A long-lived shallow checkout may no longer contain an advertised
        // branch tip. Negotiate common objects before packing instead of
        // resending the entire snapshot through the bounded session broker.
        yield* git(
          ["config", "--local", "--replace-all", "push.negotiate", "true"],
          target,
          sessionId,
        );
        yield* git(
          ["config", "--local", "--replace-all", config.key, config.value],
          target,
          sessionId,
        );
      },
    );

    const openGitBroker = Effect.fn("Workspace.openGitBroker")(function* (
      sessionId: string,
      repository: RepositoryRecord,
      bindHost?: string,
    ) {
      if (!isHttpsGitHubRepositoryUrl(repository.url)) return undefined;
      const candidate = parseRepositorySuggestionCandidate(repository.url);
      if (
        candidate === null ||
        candidate.hostname.toLowerCase() !== "github.com"
      )
        return undefined;
      const [owner, repositoryName] = candidate.repositoryFullName.split("/");
      if (!owner || !repositoryName) return undefined;
      const acquireToken =
        input.githubApp === undefined
          ? Effect.succeed(undefined)
          : input.githubApp
              .getInstallationToken(
                owner,
                repositoryName,
                repository.organizationId,
              )
              .pipe(
                Effect.catch((error) =>
                  error.reason === "not_installed"
                    ? Effect.succeed(undefined)
                    : Effect.fail(
                        workspaceFailure(
                          "Could not acquire GitHub installation credentials",
                          "git_failed",
                          sessionId,
                        )(error),
                      ),
                ),
              );
      // Fail startup on denied credentials, then use the App service's expiring
      // cache for each request so long runs can push after the first hour.
      yield* acquireToken;
      return yield* Effect.try({
        try: () =>
          startGitHubGitBroker({
            repository,
            tokenForRequest: (signal) => runPromise(acquireToken, { signal }),
            ...(bindHost === undefined ? {} : { bindHost }),
          }),
        catch: workspaceFailure(
          "Could not start GitHub Git broker",
          "git_failed",
          sessionId,
        ),
      });
    });

    const configureGitIdentity = Effect.fn("Workspace.configureGitIdentity")(
      function* (
        sessionId: string,
        target: string,
      ): Effect.fn.Return<void, WorkspaceError> {
        if (input.githubApp === undefined) return;
        // Without its own .git, `git config --local` would walk up and write
        // into whatever repository encloses the target.
        const ownsGitDir = yield* Effect.promise(() =>
          lstat(join(target, ".git")).then(
            (info) =>
              !info.isSymbolicLink() && (info.isDirectory() || info.isFile()),
            () => false,
          ),
        );
        if (!ownsGitDir) return;
        const identity = yield* input.githubApp.getBotIdentity().pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            error.reason === "disabled"
              ? Effect.succeed(Option.none())
              : Effect.logWarning("workspace.git_identity_lookup_failed").pipe(
                  Effect.annotateLogs({
                    event: "workspace.git_identity_lookup_failed",
                    sessionId,
                    reason: error.reason,
                    error: error.message,
                  }),
                  Effect.as(Option.none()),
                ),
          ),
        );
        if (Option.isNone(identity)) return;
        // runGit enters the checkout owner's uid before touching its local config.
        // Identity is best-effort: a missing author must not fail workspace setup.
        yield* Effect.forEach(
          [
            ["user.name", identity.value.name],
            ["user.email", identity.value.email],
          ] as const,
          ([key, value]) =>
            git(
              ["config", "--local", "--replace-all", key, value],
              target,
              sessionId,
            ),
          { discard: true },
        ).pipe(
          Effect.catch((error) =>
            Effect.logWarning("workspace.git_identity_config_failed").pipe(
              Effect.annotateLogs({
                event: "workspace.git_identity_config_failed",
                sessionId,
                error: error.message,
              }),
            ),
          ),
        );
      },
    );

    const clearGitHubExtraHeader = (
      sessionId: string,
      target: string,
    ): Effect.Effect<void, never> =>
      Effect.andThen(
        unsetGitHubExtraHeader(target, sessionId, input.gitTimeoutMs),
        clearGitBrokerConfig(sessionId, target).pipe(Effect.ignore),
      );

    const materialize = Effect.fn("Workspace.materialize")(function* (
      sessionId: string,
      repository: RepositoryRecord,
      workerUid?: string,
    ): Effect.fn.Return<string, WorkspaceError> {
      if (workerUidRange(process.env) !== undefined && workerUid === undefined)
        return yield* Effect.fail(
          new WorkspaceError({
            message: "Missing per-session worker uid",
            sessionId,
            reason: "git_failed",
          }),
        );
      yield* Effect.annotateCurrentSpan({
        "workspace.session_id": sessionId,
        "workspace.repository_id": repository.id,
      });

      if (
        !isHttpsGitHubRepositoryUrl(repository.url) ||
        repository.ref.startsWith("-") ||
        /[\r\n\0]/u.test(repository.ref)
      ) {
        return yield* Effect.fail(
          new WorkspaceError({
            message: "Repository must be an HTTPS GitHub URL with a valid ref",
            sessionId,
            reason: "git_failed",
          }),
        );
      }
      yield* recoverStaging(workerUid);
      const canonicalRoot = yield* ensureRoot(input.workspaceRoot, sessionId);
      const target = join(canonicalRoot, safeSessionKey(sessionId));

      if (!isWithin(canonicalRoot, target)) {
        return yield* Effect.fail(
          new WorkspaceError({
            message: "Workspace path escapes configured root",
            sessionId,
            reason: "path_escapes_root",
          }),
        );
      }

      const targetStats = yield* lstatOrMissing(
        target,
        sessionId,
        "target_not_directory",
      );
      const markerPath = join(target, ".linear-gateway-workspace.json");

      if (Option.isSome(targetStats)) {
        if (
          targetStats.value.isSymbolicLink() ||
          !targetStats.value.isDirectory()
        ) {
          return yield* Effect.fail(
            new WorkspaceError({
              message: "Workspace target is not a real directory",
              sessionId,
              reason: "target_not_directory",
            }),
          );
        }

        const canonicalTarget = yield* validateExistingTarget(
          canonicalRoot,
          target,
          sessionId,
        );
        const marker = yield* lstatOrMissing(
          markerPath,
          sessionId,
          "marker_mismatch",
        );
        if (Option.isSome(marker)) {
          if (marker.value.isSymbolicLink() || !marker.value.isFile()) {
            return yield* Effect.fail(
              new WorkspaceError({
                message: "Workspace marker is not a real file",
                sessionId,
                reason: "marker_mismatch",
              }),
            );
          }
          yield* validateMarker(markerPath, repository, sessionId);
          yield* Effect.tryPromise({
            try: () => prepareWorkerWorkspace(canonicalTarget, workerUid),
            catch: workspaceFailure(
              "Could not assign workspace ownership",
              "git_failed",
              sessionId,
            ),
          });
          yield* refreshGitHubExtraHeader(
            sessionId,
            repository,
            canonicalTarget,
          );

          yield* Effect.logInfo("Workspace ready (reused)").pipe(
            Effect.annotateLogs({
              event: "workspace.ready",
              repositoryId: repository.id,
              path: canonicalTarget,
              reused: true,
            }),
          );

          return canonicalTarget;
        }
        // A missing marker can also mean an agent removed an untracked file.
        // Preserve user work even when the old checkout cannot be reused.
        yield* Effect.tryPromise({
          try: () => {
            if (needsWorkspaceIdentity())
              sealWorkerWorkspaceSync(canonicalTarget);
            return rename(
              canonicalTarget,
              join(
                canonicalRoot,
                `.stale-${safeSessionKey(sessionId)}-${crypto.randomUUID()}`,
              ),
            );
          },
          catch: workspaceFailure(
            "preserve marker-less workspace",
            "git_failed",
            sessionId,
          ),
        });
      }

      let githubExtraHeader: string | undefined;
      const repositoryCandidate = parseRepositorySuggestionCandidate(
        repository.url,
      );
      if (input.githubApp !== undefined) {
        if (isHttpsGitHubRepositoryUrl(repository.url)) {
          githubExtraHeader = yield* mintGitHubExtraHeader(
            input.githubApp,
            repository,
            sessionId,
          );
        } else if (
          repositoryCandidate?.hostname.toLowerCase() === "github.com"
        ) {
          yield* Effect.logDebug(
            "GitHub credentials skipped for SSH repository URL; SSH repositories are unsupported for GitHub App credentials",
          );
        } else {
          yield* Effect.logDebug(
            "GitHub credentials skipped for non-GitHub repository",
          );
        }
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const cloneOwner = randomBytes(16).toString("hex");
          yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: async () => {
                const lock = await acquireCloneLock(canonicalRoot, cloneOwner);
                if (lock === undefined)
                  throw new Error("Clone owner collision");
                return lock;
              },
              catch: workspaceFailure(
                "acquire clone ownership",
                "git_failed",
                sessionId,
              ),
            }),
            (lock) => Effect.promise(() => lock.release()),
          );
          const staging = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                mkdtemp(
                  join(
                    canonicalRoot,
                    `.${safeSessionKey(sessionId)}-clone-v2-${cloneOwner}-`,
                  ),
                ),
              catch: workspaceFailure(
                "create clone directory",
                "git_failed",
                sessionId,
              ),
            }),
            (path) =>
              Effect.tryPromise({
                try: () =>
                  removeWorkerWorkspace(path, canonicalRoot, workerUid),
                catch: workspaceFailure(
                  "remove clone staging",
                  "git_failed",
                  sessionId,
                ),
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("workspace.staging_cleanup_failed").pipe(
                    Effect.annotateLogs({ sessionId, error: error.message }),
                  ),
                ),
              ),
          );
          const cloneArgs = [
            "clone",
            "--no-checkout",
            // Checkout runs without gateway credentials. Fetch complete blobs
            // now so it never needs an authenticated promisor download.
            "--depth=1",
            "--",
            repository.url,
            staging,
          ];
          yield* runGit(
            cloneArgs,
            undefined,
            sessionId,
            input.gitTimeoutMs,
            githubExtraHeader,
          );
          if (workerUid)
            yield* Effect.tryPromise({
              try: () => prepareWorkerWorkspace(staging, workerUid),
              catch: workspaceFailure(
                "Could not assign workspace ownership",
                "git_failed",
                sessionId,
              ),
            });
          yield* Effect.gen(function* () {
            yield* runGit(
              ["fetch", "--depth=1", "--", "origin", repository.ref],
              staging,
              sessionId,
              input.gitTimeoutMs,
              githubExtraHeader,
            );
            yield* git(
              ["checkout", "--detach", "--force", "FETCH_HEAD", "--"],
              staging,
              sessionId,
            );
            yield* configureGitIdentity(sessionId, staging);
            yield* writeMarker(
              join(staging, ".linear-gateway-workspace.json"),
              repository,
              sessionId,
            );
          });

          yield* Effect.tryPromise({
            try: () => rename(staging, target),
            catch: workspaceFailure(
              "publish cloned workspace",
              "git_failed",
              sessionId,
            ),
          });
        }),
      );

      const finalTarget = yield* realpathOrFail(
        target,
        sessionId,
        "path_escapes_root",
      );
      if (!isWithin(canonicalRoot, finalTarget)) {
        return yield* Effect.fail(
          new WorkspaceError({
            message: "Materialized workspace resolves outside configured root",
            sessionId,
            reason: "path_escapes_root",
          }),
        );
      }

      yield* Effect.logInfo("Workspace ready").pipe(
        Effect.annotateLogs({
          event: "workspace.ready",
          repositoryId: repository.id,
          path: finalTarget,
          reused: false,
        }),
      );

      return finalTarget;
    });

    return {
      resolve,
      materialize,
      refreshGitHubExtraHeader,
      openGitBroker,
      configureGitBroker,
      clearGitBrokerConfig,
      clearGitHubExtraHeader,
    };
  });
export class Workspace extends Context.Service<Workspace>()("Workspace", {
  make: Effect.gen(function* () {
    const config = yield* GatewayConfig;
    const repo = yield* WorkspaceRepo;
    const githubApp =
      config.githubAppId !== undefined &&
      config.githubAppPrivateKey !== undefined
        ? yield* GitHubApp
        : undefined;
    return yield* makeWorkspace({
      workspaceRoot: config.workspaceRoot,
      gitTimeoutMs: config.gitTimeoutMs ?? 120_000,
      repo,
      githubApp,
    });
  }),
}) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide([GatewayConfig.layer, WorkspaceRepo.layer, GitHubApp.layer]),
  );
}
