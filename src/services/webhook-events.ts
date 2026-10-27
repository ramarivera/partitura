import { Effect, Option, Schema } from "effect";
import {
  type DatabaseError,
  type RowDecodeError,
  type TokenCipherError,
  WebhookIdentityError,
  WebhookPayloadError,
} from "../domain/errors.js";
import {
  AppUserId,
  DeliveryId,
  InputId,
  IssueId,
  OrganizationId,
  TeamId,
} from "../domain/ids.js";
import type { AppUserNotification as AppUserNotificationType } from "../domain/models.js";
import {
  APP_USER_NOTIFICATION_DEFERRED_STOP_ACTION,
  AppUserNotification,
} from "../domain/models.js";
import { isString } from "./linear-helpers.js";
import type {
  InstallationRepo,
  RunInputRepo,
  RunRepo,
} from "./store/repositories.js";
import { clientIdMatches, isBoolean, isStringArray } from "./webhook-common.js";

export const validateOAuthAppPayload = (
  parsed: Record<string, unknown>,
  config: { readonly linearClientId: string },
): Effect.Effect<
  { action: string; organizationId: OrganizationId },
  WebhookPayloadError | WebhookIdentityError
> =>
  Effect.gen(function* () {
    const action = parsed.action;
    const oauthClientId = parsed.oauthClientId;
    const organizationId = parsed.organizationId;
    if (
      !isString(action) ||
      !isString(oauthClientId) ||
      !isString(organizationId)
    ) {
      return yield* Effect.fail(
        new WebhookPayloadError({
          message: "OAuthApp payload missing required fields",
          status: 400,
        }),
      );
    }
    if (!clientIdMatches(oauthClientId, config.linearClientId)) {
      return yield* Effect.fail(
        new WebhookIdentityError({
          message: `OAuth client identity mismatch (received ${oauthClientId})`,
        }),
      );
    }
    const decoded = yield* Schema.decodeUnknownEffect(OrganizationId)(
      organizationId,
    ).pipe(
      Effect.catchTag(
        "SchemaError",
        () =>
          new WebhookIdentityError({
            message: "Organization identity is not a valid identifier",
          }),
      ),
    );
    return { action, organizationId: decoded };
  });

export const handleOAuthAppRevoked = (
  action: string,
  organizationId: OrganizationId,
  installationRepo: InstallationRepo["Service"],
  timestamp: number,
): Effect.Effect<void, DatabaseError, never> =>
  Effect.gen(function* () {
    if (action !== "revoked" && action !== "revoke") return;
    yield* installationRepo.revoke(organizationId, timestamp);
  });

export const validatePermissionChangePayload = (
  parsed: Record<string, unknown>,
  config: { readonly linearClientId: string },
): Effect.Effect<
  {
    action: string;
    organizationId: OrganizationId;
    appUserId: AppUserId;
    addedTeamIds: ReadonlyArray<TeamId>;
    removedTeamIds: ReadonlyArray<TeamId>;
    canAccessAllPublicTeams: boolean;
  },
  WebhookPayloadError | WebhookIdentityError
> =>
  Effect.gen(function* () {
    const action = parsed.action;
    const oauthClientId = parsed.oauthClientId;
    const organizationId = parsed.organizationId;
    const appUserId = parsed.appUserId;
    const added = parsed.addedTeamIds;
    const removed = parsed.removedTeamIds;
    const canAccess = parsed.canAccessAllPublicTeams;

    if (
      !isString(action) ||
      !isString(oauthClientId) ||
      !isString(organizationId) ||
      !isString(appUserId) ||
      !isStringArray(added) ||
      !isStringArray(removed) ||
      !isBoolean(canAccess)
    ) {
      return yield* Effect.fail(
        new WebhookPayloadError({
          message: "PermissionChange missing or invalid fields",
          status: 400,
        }),
      );
    }

    // Live evidence (2026-08-11): PermissionChange payloads report the OAuth
    // client's internal UUID, NOT the console client_id carried by
    // AgentSessionEvent/AppUserNotification payloads — the two identifiers
    // share no hex, so a direct comparison can never match. The HMAC
    // signature is the auth boundary; the organization + appUserId checks
    // below pin the tenant and app. Log the observed form for visibility.
    if (!clientIdMatches(oauthClientId, config.linearClientId)) {
      yield* Effect.logInfo("webhook.permissionChange.client_id_form").pipe(
        Effect.annotateLogs({
          event: "webhook.permissionChange.client_id_form",
          oauthClientId,
          organizationId,
        }),
      );
    }

    const decodedOrganizationId = yield* Schema.decodeUnknownEffect(
      OrganizationId,
    )(organizationId).pipe(
      Effect.catchTag(
        "SchemaError",
        () =>
          new WebhookIdentityError({
            message: "Organization identity is not a valid identifier",
          }),
      ),
    );

    const decodedAppUserId = yield* Schema.decodeUnknownEffect(AppUserId)(
      appUserId,
    ).pipe(
      Effect.catchTag(
        "SchemaError",
        () =>
          new WebhookPayloadError({
            message: `Invalid app user id ${appUserId}`,
            status: 400,
          }),
      ),
    );

    const addedTeamIds = yield* Effect.forEach(added, (teamId) =>
      Schema.decodeUnknownEffect(TeamId)(teamId).pipe(
        Effect.catchTag(
          "SchemaError",
          () =>
            new WebhookPayloadError({
              message: `Invalid team id ${teamId}`,
              status: 400,
            }),
        ),
      ),
    );

    const removedTeamIds = yield* Effect.forEach(removed, (teamId) =>
      Schema.decodeUnknownEffect(TeamId)(teamId).pipe(
        Effect.catchTag(
          "SchemaError",
          () =>
            new WebhookPayloadError({
              message: `Invalid team id ${teamId}`,
              status: 400,
            }),
        ),
      ),
    );

    return {
      action,
      organizationId: decodedOrganizationId,
      appUserId: decodedAppUserId,
      addedTeamIds,
      removedTeamIds,
      canAccessAllPublicTeams: canAccess,
    };
  });

export const handlePermissionChange = (
  action: string,
  organizationId: OrganizationId,
  appUserId: AppUserId,
  addedTeamIds: ReadonlyArray<TeamId>,
  removedTeamIds: ReadonlyArray<TeamId>,
  canAccessAllPublicTeams: boolean,
  installationRepo: InstallationRepo["Service"],
  timestamp: number,
): Effect.Effect<void, DatabaseError | RowDecodeError, never> =>
  Effect.gen(function* () {
    if (action !== "teamAccessChanged") return;
    yield* installationRepo.applyPermissionChange(
      organizationId,
      appUserId,
      addedTeamIds,
      removedTeamIds,
      canAccessAllPublicTeams,
      timestamp,
    );
  });

export const APP_USER_NOTIFICATION_STOP_ACTIONS: Record<string, true> = {
  issueUnassignedFromYou: true,
  [APP_USER_NOTIFICATION_DEFERRED_STOP_ACTION]: true,
};

export const validateAppUserNotification = (
  parsed: Record<string, unknown>,
  config: { readonly linearClientId: string },
  installationRepo: InstallationRepo["Service"],
): Effect.Effect<
  {
    readonly payload: AppUserNotificationType;
    readonly organizationId: OrganizationId;
    readonly appUserId: AppUserId;
    readonly issueId: Option.Option<IssueId>;
  },
  | WebhookPayloadError
  | WebhookIdentityError
  | DatabaseError
  | RowDecodeError
  | TokenCipherError
> =>
  Effect.gen(function* () {
    const payload = yield* Schema.decodeUnknownEffect(AppUserNotification)(
      parsed,
    ).pipe(
      Effect.catchTag(
        "SchemaError",
        (error) =>
          new WebhookPayloadError({
            message: "AppUserNotification payload is invalid",
            status: 400,
            cause: String(error),
          }),
      ),
    );
    if (!clientIdMatches(payload.oauthClientId, config.linearClientId)) {
      return yield* Effect.fail(
        new WebhookIdentityError({
          message: `OAuth client identity mismatch (received ${payload.oauthClientId})`,
        }),
      );
    }

    const organizationId = yield* Schema.decodeUnknownEffect(OrganizationId)(
      payload.organizationId,
    ).pipe(
      Effect.catchTag(
        "SchemaError",
        () =>
          new WebhookIdentityError({
            message: "Organization identity is not a valid identifier",
          }),
      ),
    );
    const appUserId = yield* Schema.decodeUnknownEffect(AppUserId)(
      payload.appUserId,
    ).pipe(
      Effect.catchTag(
        "SchemaError",
        () =>
          new WebhookPayloadError({
            message: `Invalid app user id ${payload.appUserId}`,
            status: 400,
          }),
      ),
    );
    const installation = yield* installationRepo.get(organizationId);
    if (Option.isNone(installation)) {
      return yield* Effect.fail(
        new WebhookIdentityError({
          message: "No installation for organization",
        }),
      );
    }
    if (Option.isSome(installation.value.revokedAt)) {
      return yield* Effect.fail(
        new WebhookIdentityError({ message: "Installation is revoked" }),
      );
    }
    if (installation.value.appUserId !== appUserId) {
      return yield* Effect.fail(
        new WebhookIdentityError({ message: "Installation app user mismatch" }),
      );
    }

    const rawIssueId = Option.getOrElse(
      payload.notification.issueId,
      () => null,
    );
    let issueId = Option.none<IssueId>();
    if (rawIssueId !== null) {
      issueId = Option.some(
        yield* Schema.decodeUnknownEffect(IssueId)(rawIssueId).pipe(
          Effect.catchTag(
            "SchemaError",
            () =>
              new WebhookPayloadError({
                message: `Invalid issue id ${rawIssueId}`,
                status: 400,
              }),
          ),
        ),
      );
    }
    if (APP_USER_NOTIFICATION_STOP_ACTIONS[payload.action] === true) {
      if (Option.isNone(issueId) || Option.isNone(payload.notification.issue)) {
        return yield* Effect.fail(
          new WebhookPayloadError({
            message: "AppUserNotification action is missing issue details",
            status: 400,
          }),
        );
      }
      if (payload.notification.issue.value.id !== rawIssueId) {
        return yield* Effect.fail(
          new WebhookIdentityError({
            message: "Notification issue identity mismatch",
          }),
        );
      }
    }
    return { payload, organizationId, appUserId, issueId };
  });

export const handleAppUserNotification = (
  payload: AppUserNotificationType,
  organizationId: OrganizationId,
  issueId: Option.Option<IssueId>,
  runRepo: RunRepo["Service"],
  runInputRepo: RunInputRepo["Service"],
  timestamp: number,
): Effect.Effect<
  void,
  WebhookPayloadError | DatabaseError | RowDecodeError,
  never
> =>
  Effect.gen(function* () {
    if (APP_USER_NOTIFICATION_STOP_ACTIONS[payload.action] !== true) {
      yield* Effect.logDebug("webhook.appUserNotification.ignored").pipe(
        Effect.annotateLogs({
          event: "webhook.appUserNotification.ignored",
          action: payload.action,
        }),
      );
      return;
    }
    if (Option.isNone(issueId)) return;
    const persistedPayload =
      Schema.encodeUnknownSync(AppUserNotification)(payload);
    const runs = yield* runRepo.listNonTerminalByIssue({
      organizationId,
      issueId: issueId.value,
    });
    const stopId = payload.notification.id || payload.webhookId;
    // The signed event time bounds both delayed ingress and startup replay.
    yield* Effect.forEach(
      runs.filter((run) => run.createdAt <= timestamp),
      (run) =>
        Schema.decodeUnknownEffect(InputId)(
          `${run.sessionId}:stop:${stopId}`,
        ).pipe(
          Effect.catchTag(
            "SchemaError",
            () =>
              new WebhookPayloadError({
                message: "Invalid AppUserNotification stop input id",
                status: 400,
              }),
          ),
          Effect.flatMap((id) =>
            runInputRepo.enqueue({
              id,
              sessionId: run.sessionId,
              kind: "stop",
              body: `Stopped by Linear notification ${payload.action}.`,
              payload: persistedPayload,
              createdAt: timestamp,
            }),
          ),
          Effect.asVoid,
        ),
    );
  });

export const decodeDeliveryId = (
  raw: string,
): Effect.Effect<DeliveryId, WebhookPayloadError> =>
  Schema.decodeUnknownEffect(DeliveryId)(raw).pipe(
    Effect.catchTag(
      "SchemaError",
      () =>
        new WebhookPayloadError({
          message: "Invalid delivery id",
          status: 400,
        }),
    ),
  );
