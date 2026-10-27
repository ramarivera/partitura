import { WorkspaceError } from "../domain/errors.js";

export const enoent = (error: unknown): error is Error & { code: "ENOENT" } =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const workspaceFailure =
  (message: string, reason: WorkspaceError["reason"], sessionId: string) =>
  (cause: unknown) =>
    new WorkspaceError({
      message,
      sessionId,
      reason,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
