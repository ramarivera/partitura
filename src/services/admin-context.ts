import { Effect, Option } from "effect";
import {
  ADMIN_COOKIE,
  type AdminDeps,
  AdminError,
  findCookieValue,
  tokenHash,
  validateCsrf,
  validateOrigin,
} from "./admin-core.js";
import { organizationAllowed } from "./config.js";

export const createAdminContext = (
  deps: AdminDeps,
  request: Request,
  now: number,
  url: URL,
) => {
  const requireSession = (req: Request) =>
    Effect.gen(function* () {
      const rawToken = findCookieValue(req, ADMIN_COOKIE);
      if (rawToken === null) {
        return yield* Effect.fail(
          new AdminError({ message: "Unauthorized", status: 401 }),
        );
      }
      const session = yield* deps.adminSessionRepo.get(
        tokenHash(rawToken),
        now,
      );
      if (
        Option.isNone(session) ||
        !organizationAllowed(deps.config, session.value.organizationId)
      ) {
        return yield* Effect.fail(
          new AdminError({ message: "Unauthorized", status: 401 }),
        );
      }
      return {
        organizationId: session.value.organizationId,
        rawToken,
        csrfTokenHash: session.value.csrfTokenHash,
      };
    });

  const requireMutation = (req: Request) =>
    Effect.gen(function* () {
      const session = yield* requireSession(req);
      if (!validateOrigin(deps.config, req)) {
        return yield* Effect.fail(
          new AdminError({ message: "Forbidden", status: 403 }),
        );
      }
      if (!validateCsrf(req, session.csrfTokenHash)) {
        return yield* Effect.fail(
          new AdminError({ message: "Forbidden", status: 403 }),
        );
      }
      return session;
    });

  return { deps, request, now, url, requireSession, requireMutation };
};
export type AdminContext = ReturnType<typeof createAdminContext>;
