import { Effect, Option, Schema } from "effect";
import { renderNativeBuildersPage } from "../admin-ui/native-builders.js";
import type { AdminContext } from "./admin-context.js";
import {
  AdminError,
  deriveCsrfToken,
  HTML_SECURITY_HEADERS,
  SECURITY_HEADERS,
  tokenHash,
} from "./admin-core.js";
import { json } from "./admin-responses.js";
import {
  FleetBuilderId,
  FleetOpaqueId,
  NativeFleetError,
} from "./native-build-fleet-models.js";

const body = Effect.fn("Admin.nativeBuildersBody")(function* (
  request: Request,
) {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    return yield* Effect.fail(
      NativeFleetError.new("fleet-invalid-request", 400),
    );
  const reader = request.body?.getReader();
  if (!reader)
    return yield* Effect.fail(
      NativeFleetError.new("fleet-invalid-request", 400),
    );
  return yield* Effect.acquireUseRelease(
    Effect.succeed(reader),
    (reader) =>
      Effect.gen(function* () {
        let size = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const part = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: () => NativeFleetError.new("fleet-invalid-request", 400),
          });
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 4096)
            return yield* Effect.fail(
              NativeFleetError.new("fleet-invalid-request", 400),
            );
          chunks.push(part.value);
        }
        return yield* Effect.try({
          try: () =>
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
            ),
          catch: () => NativeFleetError.new("fleet-invalid-request", 400),
        });
      }),
    (reader) =>
      Effect.tryPromise({
        try: () => reader.cancel(),
        catch: () => NativeFleetError.new("fleet-invalid-request", 400),
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("Native fleet request stream cancellation failed"),
        ),
        Effect.ensuring(Effect.sync(() => reader.releaseLock())),
      ),
  );
});
export const nativeBuildersRoutes = Effect.fn("Admin.nativeBuildersRoutes")(
  function* (context: AdminContext) {
    const { request, url, deps, requireMutation, requireSession } = context;
    if (
      url.pathname !== "/admin/native-builders" &&
      !url.pathname.startsWith("/api/admin/native-builders")
    )
      return Option.none<Response>();
    // Browser session, allowed org, Origin and CSRF precede capability or item lookup.
    const session = yield* request.method === "POST"
      ? requireMutation(request)
      : requireSession(request);
    if (!deps.config.gatewayAdminOrganizationIds?.has(session.organizationId))
      return yield* Effect.fail(
        new AdminError({ status: 403, message: "Forbidden" }),
      );
    const actor = {
      kind: "human" as const,
      organizationId: session.organizationId,
      sessionHash: tokenHash(session.rawToken),
    };
    const fleet = deps.nativeBuilders;
    if (!fleet)
      return Option.some(
        new Response(JSON.stringify({ error: "fleet-disabled" }), {
          status: 503,
          headers: { ...SECURITY_HEADERS, "Content-Type": "application/json" },
        }),
      );
    if (url.pathname === "/admin/native-builders" && request.method === "GET")
      return Option.some(
        new Response(
          renderNativeBuildersPage(deriveCsrfToken(session.rawToken)),
          {
            headers: {
              ...HTML_SECURITY_HEADERS,
              "Content-Type": "text/html; charset=utf-8",
            },
          },
        ),
      );
    const tail = url.pathname.slice("/api/admin/native-builders".length);
    if (request.method === "GET" && tail === "")
      return Option.some(json(yield* fleet.fleet(actor)));
    const operation = /^\/refreshes\/([^/]+)$/u.exec(tail);
    if (request.method === "GET" && operation) {
      const id = yield* Schema.decodeUnknownEffect(FleetOpaqueId)(
        operation[1],
      ).pipe(
        Effect.mapError(() =>
          NativeFleetError.new("fleet-operation-not-found", 404),
        ),
      );
      return Option.some(json(yield* fleet.progress(actor, id)));
    }
    const action =
      /^\/([^/]+)\/(refresh|check-health|reconcile|decommission)$/u.exec(tail);
    if (request.method !== "POST" || (tail !== "/refresh" && !action))
      return Option.some(
        new Response("Not found", { status: 404, headers: SECURITY_HEADERS }),
      );
    const id = action
      ? yield* Schema.decodeUnknownEffect(FleetBuilderId)(action[1]).pipe(
          Effect.mapError(() =>
            NativeFleetError.new("fleet-builder-not-found", 404),
          ),
        )
      : undefined;
    const value: unknown = yield* body(request);
    if (action?.[2] === "reconcile" || action?.[2] === "decommission")
      return Option.some(
        json(yield* fleet.humanAction(actor, id ?? "", value, action[2]), 202),
      );
    yield* Schema.decodeUnknownEffect(
      Schema.Record(Schema.String, Schema.Never),
    )(value, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(() => NativeFleetError.new("fleet-invalid-request", 400)),
    );
    return Option.some(
      json(
        yield* action?.[2] === "check-health"
          ? fleet.checkHealth(actor, id ?? "")
          : fleet.refresh(
              actor,
              id === undefined
                ? { scope: "all" }
                : { scope: "builder", builder: id },
            ),
        202,
      ),
    );
  },
  (effect) =>
    effect.pipe(
      Effect.catchTag("@Gateway/NativeFleetError", (error) =>
        Effect.succeed(Option.some(json({ error: error.code }, error.status))),
      ),
    ),
);
