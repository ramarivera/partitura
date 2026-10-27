import { Effect, Option, Result, Schema } from "effect";
import { ProjectId, TeamId, WorkspaceId } from "../domain/ids.js";
import type { AdminContext } from "./admin-context.js";
import { AdminError, clearAdminCookie, tokenHash } from "./admin-core.js";
import {
  optionalString,
  optionalStringArray,
  repositoryPayload,
  toApiRepository,
} from "./admin-payloads.js";
import {
  emptyResponse,
  json,
  parseJsonBody,
  redirect,
  text,
  toApiNixCache,
} from "./admin-responses.js";

export const repositoriesRoutes = (context: AdminContext) =>
  Effect.gen(function* () {
    const { deps, request, now, url, requireSession, requireMutation } =
      context;
    if (url.pathname === "/api/admin/nix-cache" && request.method === "GET") {
      const session = yield* requireSession(request);
      if (!deps.config.gatewayAdminOrganizationIds?.has(session.organizationId))
        return Option.some(text("Forbidden", 403));
      const entries = yield* deps.nixEnvironment.list();
      return Option.some(json({ entries: entries.map(toApiNixCache) }));
    }

    const nixCachePrune =
      /^\/api\/admin\/nix-cache\/([a-f0-9]{64})\/prune$/u.exec(url.pathname);
    if (nixCachePrune !== null && request.method === "POST") {
      const cacheKey = nixCachePrune[1];
      if (cacheKey === undefined) {
        return Option.some(text("Invalid Nix cache key", 400));
      }
      const session = yield* requireMutation(request);
      if (!deps.config.gatewayAdminOrganizationIds?.has(session.organizationId))
        return Option.some(text("Forbidden", 403));
      const pruned = yield* deps.nixEnvironment.prune(cacheKey);
      return Option.some(json({ pruned }));
    }

    if (
      url.pathname.startsWith("/api/admin/nix-cache/") &&
      request.method === "POST"
    ) {
      yield* requireMutation(request);
      return Option.some(text("Invalid Nix cache key", 400));
    }

    if (
      url.pathname === "/api/admin/repositories" &&
      request.method === "POST"
    ) {
      const session = yield* requireMutation(request);
      const body = yield* parseJsonBody(request);
      const payloadEither = repositoryPayload(body);
      if (Result.isFailure(payloadEither)) {
        return Option.some(text(payloadEither.failure, 400));
      }
      const payload = payloadEither.success;
      const repositoryId = yield* Schema.decodeUnknownEffect(WorkspaceId)(
        payload.id,
      ).pipe(
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new AdminError({
                message: "Invalid repository id",
                status: 400,
              }),
            ),
        }),
      );
      const teamIds = yield* Schema.decodeUnknownEffect(Schema.Array(TeamId))(
        payload.teamIds,
      ).pipe(
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new AdminError({ message: "Invalid team ids", status: 400 }),
            ),
        }),
      );
      const projectIds = yield* Schema.decodeUnknownEffect(
        Schema.Array(ProjectId),
      )(payload.projectIds).pipe(
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new AdminError({ message: "Invalid project ids", status: 400 }),
            ),
        }),
      );
      const repository = yield* deps.workspaceRepo.createRepository({
        organizationId: session.organizationId,
        id: repositoryId,
        url: payload.url,
        ref: payload.ref,
        teamIds,
        projectIds,
        labels: payload.labels,
        nixPackages: payload.nixPackages,
        isDefault: payload.isDefault ?? false,
        defaultDriver: payload.defaultDriver ?? "omp",
        now,
      });
      return Option.some(
        json({ repository: toApiRepository(repository) }, 201),
      );
    }

    if (url.pathname.startsWith("/api/admin/repositories/")) {
      const rawId = decodeURIComponent(
        url.pathname.slice("/api/admin/repositories/".length),
      );
      const id = yield* Schema.decodeUnknownEffect(WorkspaceId)(rawId).pipe(
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new AdminError({
                message: "Invalid repository id",
                status: 400,
              }),
            ),
        }),
      );

      if (request.method === "PUT") {
        const session = yield* requireMutation(request);
        const body = yield* parseJsonBody(request);
        const payloadEither = repositoryPayload(body);
        if (Result.isFailure(payloadEither)) {
          return Option.some(text(payloadEither.failure, 400));
        }
        const payload = payloadEither.success;
        if (payload.id !== id) {
          return Option.some(
            text("Repository id in body does not match path", 400),
          );
        }
        const teamIds = yield* Schema.decodeUnknownEffect(Schema.Array(TeamId))(
          payload.teamIds,
        ).pipe(
          Effect.catchTags({
            SchemaError: () =>
              Effect.fail(
                new AdminError({ message: "Invalid team ids", status: 400 }),
              ),
          }),
        );
        const projectIds = yield* Schema.decodeUnknownEffect(
          Schema.Array(ProjectId),
        )(payload.projectIds).pipe(
          Effect.catchTags({
            SchemaError: () =>
              Effect.fail(
                new AdminError({
                  message: "Invalid project ids",
                  status: 400,
                }),
              ),
          }),
        );
        const repository = yield* deps.workspaceRepo.updateRepository(
          session.organizationId,
          id,
          {
            url: payload.url,
            ref: payload.ref,
            teamIds,
            projectIds,
            labels: payload.labels,
            nixPackages: payload.nixPackages,
            ...(payload.defaultDriver === undefined
              ? {}
              : { defaultDriver: payload.defaultDriver }),
            ...(payload.isDefault !== undefined
              ? { isDefault: payload.isDefault }
              : {}),
            now,
          },
        );
        return Option.some(json({ repository: toApiRepository(repository) }));
      }

      if (request.method === "DELETE") {
        const session = yield* requireMutation(request);
        const deleted = yield* deps.workspaceRepo.deleteRepository(
          session.organizationId,
          id,
        );
        if (!deleted) {
          return Option.some(text("Not found", 404));
        }
        return Option.some(emptyResponse(204));
      }
    }

    if (url.pathname === "/api/admin/preview" && request.method === "POST") {
      const session = yield* requireMutation(request);
      const body = yield* parseJsonBody(request);
      const issueLabels = optionalStringArray(body.issueLabels, "issueLabels");
      if (Result.isFailure(issueLabels)) {
        return Option.some(text(issueLabels.failure, 400));
      }
      const projectLabels = optionalStringArray(
        body.projectLabels,
        "projectLabels",
      );
      if (Result.isFailure(projectLabels)) {
        return Option.some(text(projectLabels.failure, 400));
      }
      const resolution = yield* deps.workspace.resolve({
        organizationId: session.organizationId,
        teamId: optionalString(body.teamId),
        projectId: optionalString(body.projectId),
        repositoryId: optionalString(body.repositoryId),
        issueLabels: issueLabels.success,
        projectLabels: projectLabels.success,
      });
      return Option.some(
        json({
          kind: resolution.kind,
          repository:
            resolution.kind === "match"
              ? toApiRepository(resolution.repository)
              : null,
          repositories:
            resolution.kind === "ambiguous"
              ? resolution.repositories.map(toApiRepository)
              : null,
        }),
      );
    }

    if (url.pathname === "/api/admin/logout" && request.method === "POST") {
      const session = yield* requireMutation(request);
      yield* deps.adminSessionRepo.deleteAdminSession(
        tokenHash(session.rawToken),
      );
      return Option.some(
        redirect("/", 302, {
          "set-cookie": clearAdminCookie(deps.config),
        }),
      );
    }

    return Option.none<Response>();
  });
