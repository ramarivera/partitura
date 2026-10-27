import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { Effect, Option } from "effect";
import { WorkspaceError } from "../domain/errors.js";
import type { RepositoryRecord } from "../domain/models.js";
import { isWithin } from "../util/paths.js";
import { enoent, workspaceFailure } from "./workspace-git.js";
import { parseMarker } from "./workspace-resolution.js";
export const lstatOrMissing = (
  path: string,
  sessionId: string,
  reason: WorkspaceError["reason"],
) =>
  Effect.tryPromise({
    try: () =>
      lstat(path).then(
        (stats) => Option.some(stats),
        (error) => {
          if (enoent(error)) return Option.none();
          throw error;
        },
      ),
    catch: workspaceFailure(`lstat failed for ${path}`, reason, sessionId),
  });

export const realpathOrFail = (
  path: string,
  sessionId: string,
  reason: WorkspaceError["reason"],
) =>
  Effect.tryPromise({
    try: () => realpath(path),
    catch: workspaceFailure(`realpath failed for ${path}`, reason, sessionId),
  });

export const mkdirOrFail = (path: string, sessionId: string) =>
  Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }),
    catch: workspaceFailure(
      `mkdir failed for ${path}`,
      "root_not_directory",
      sessionId,
    ),
  });

export const readFileOrFail = (path: string, sessionId: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: workspaceFailure(
      `read marker failed for ${path}`,
      "marker_mismatch",
      sessionId,
    ),
  });

export const writeMarker = (
  markerPath: string,
  repository: RepositoryRecord,
  sessionId: string,
) =>
  Effect.tryPromise({
    try: () =>
      writeFile(
        markerPath,
        JSON.stringify({
          repositoryId: repository.id,
          url: repository.url,
          ref: repository.ref,
        }),
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      ),
    catch: workspaceFailure(
      "write workspace marker failed",
      "git_failed",
      sessionId,
    ),
  });

export const ensureRoot = (root: string, sessionId: string) =>
  Effect.gen(function* () {
    const existing = yield* lstatOrMissing(
      root,
      sessionId,
      "root_not_directory",
    );
    if (Option.isSome(existing)) {
      if (existing.value.isSymbolicLink() || !existing.value.isDirectory()) {
        return yield* Effect.fail(
          new WorkspaceError({
            message: "Workspace root must be a real directory",
            sessionId,
            reason: "root_not_directory",
          }),
        );
      }
      return yield* realpathOrFail(root, sessionId, "root_not_directory");
    }
    yield* mkdirOrFail(root, sessionId);
    return yield* realpathOrFail(root, sessionId, "root_not_directory");
  });

export const validateExistingTarget = (
  canonicalRoot: string,
  target: string,
  sessionId: string,
) =>
  Effect.gen(function* () {
    const canonicalTarget = yield* realpathOrFail(
      target,
      sessionId,
      "path_escapes_root",
    );
    if (!isWithin(canonicalRoot, canonicalTarget)) {
      return yield* Effect.fail(
        new WorkspaceError({
          message: "Existing workspace resolves outside configured root",
          sessionId,
          reason: "path_escapes_root",
        }),
      );
    }
    return canonicalTarget;
  });

export const validateMarker = (
  markerPath: string,
  repository: RepositoryRecord,
  sessionId: string,
) =>
  Effect.gen(function* () {
    const raw = yield* readFileOrFail(markerPath, sessionId);
    const parsed = yield* Effect.try({
      try: () => parseMarker(JSON.parse(raw)),
      catch: workspaceFailure(
        "invalid workspace marker",
        "marker_mismatch",
        sessionId,
      ),
    });
    if (
      Option.isNone(parsed) ||
      parsed.value.repositoryId !== repository.id ||
      parsed.value.url !== repository.url
    ) {
      return yield* Effect.fail(
        new WorkspaceError({
          message: "Workspace repository identity mismatch",
          sessionId,
          reason: "marker_mismatch",
        }),
      );
    }
  });
