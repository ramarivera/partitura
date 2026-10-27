import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
} from "effect";
import { RUNTIME_MODES, type RuntimeMode } from "../drivers/driver.js";
import type {
  GatewayConfigShape,
  T3Connection,
  T3DriverConfig,
} from "./config-types.js";
import {
  absolutePath,
  GatewayConfigValues,
  invalid,
  positiveInteger,
  timeoutMilliseconds,
} from "./config-values.js";
import { parseT3DeviceBackupConfig } from "./t3-device-backup.js";

export * from "./config-types.js";

import { modelProvider } from "./worker-profile.js";

const requiredValue = Effect.fn("GatewayConfig.requiredValue")(function* (
  name: string,
): Effect.fn.Return<string, Config.ConfigError> {
  const direct = yield* Config.option(Config.String(name));
  if (Option.isSome(direct)) {
    const value = direct.value.trim();
    if (value.length > 0) return value;
  }

  const filePath = yield* Config.option(Config.String(`${name}_FILE`));
  if (Option.isSome(filePath) && filePath.value.trim().length > 0) {
    const path = filePath.value.trim();
    const value = yield* Effect.tryPromise({
      try: () => Bun.file(path).text(),
      catch: (error) =>
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `Could not read ${name} from ${path}: ${String(error)}`,
          }),
        ),
    });
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return yield* Effect.fail(
    new Config.ConfigError(
      new ConfigProvider.SourceError({
        message: `Missing required environment variable ${name} or ${name}_FILE`,
      }),
    ),
  );
});

const optionalValue = Effect.fn("GatewayConfig.optionalValue")(function* (
  name: string,
): Effect.fn.Return<string | undefined, Config.ConfigError> {
  const direct = yield* Config.option(Config.String(name));
  if (Option.isSome(direct)) {
    const value = direct.value.trim();
    if (value.length > 0) return value;
  }

  const filePath = yield* Config.option(Config.String(`${name}_FILE`));
  if (Option.isNone(filePath) || filePath.value.trim().length === 0) {
    return undefined;
  }

  const path = filePath.value.trim();
  const value = yield* Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (error) =>
      new Config.ConfigError(
        new ConfigProvider.SourceError({
          message: `Could not read ${name} from ${path}: ${String(error)}`,
        }),
      ),
  });
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
});

/** Codex through CLIProxyAPI's OpenAI-compatible endpoint, declared by the profile. */
export const DEFAULT_CLIPROXYAPI_WORKER_MODEL = "cliproxyapi/gpt-6-sol";

const workerModelRouting = Effect.fn("GatewayConfig.workerModelRouting")(
  function* (): Effect.fn.Return<
    Pick<
      GatewayConfigShape,
      | "workerProfileDir"
      | "cliproxyApiBaseUrl"
      | "cliproxyApiKey"
      | "workerDefaultModel"
    >,
    Config.ConfigError
  > {
    const profile = yield* Config.option(Config.String("WORKER_PROFILE_DIR"));
    const profileDir = Option.isSome(profile)
      ? profile.value.trim() || undefined
      : undefined;
    const workerProfileDir =
      profileDir === undefined
        ? undefined
        : yield* absolutePath("WORKER_PROFILE_DIR", profileDir);
    const rawBase = yield* Config.option(Config.String("CLIPROXYAPI_BASE_URL"));
    const base = Option.isSome(rawBase)
      ? rawBase.value.trim() || undefined
      : undefined;
    const key = yield* optionalValue("CLIPROXYAPI_API_KEY");
    if ((base === undefined) !== (key === undefined))
      return yield* Effect.fail(
        invalid(
          "CLIPROXYAPI_BASE_URL and CLIPROXYAPI_API_KEY (or _FILE) must be set together",
        ),
      );
    let cliproxyApiBaseUrl: string | undefined;
    if (base !== undefined) {
      const url = URL.canParse(base) ? new URL(base) : undefined;
      if (
        url === undefined ||
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== ""
      )
        return yield* Effect.fail(
          invalid(
            "CLIPROXYAPI_BASE_URL must be an http(s) URL without credentials, query, or fragment",
          ),
        );
      cliproxyApiBaseUrl = `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    }
    const rawModel = yield* Config.option(
      Config.String("WORKER_DEFAULT_MODEL"),
    );
    const configuredModel = Option.isSome(rawModel)
      ? rawModel.value.trim() || undefined
      : undefined;
    const workerDefaultModel =
      configuredModel ??
      (workerProfileDir === undefined || cliproxyApiBaseUrl === undefined
        ? undefined
        : DEFAULT_CLIPROXYAPI_WORKER_MODEL);
    if (
      workerDefaultModel !== undefined &&
      modelProvider(workerDefaultModel) === undefined
    )
      return yield* Effect.fail(
        invalid(
          "WORKER_DEFAULT_MODEL must be provider/model with an optional :thinking suffix",
        ),
      );
    return {
      workerProfileDir,
      cliproxyApiBaseUrl,
      cliproxyApiKey: key === undefined ? undefined : Redacted.make(key),
      workerDefaultModel,
    };
  },
);

const isRuntimeMode = (value: string): value is RuntimeMode =>
  RUNTIME_MODES.some((mode) => mode === value);

const t3ModelOptions = (
  raw: string | undefined,
): Result.Result<T3DriverConfig["modelOptions"], Config.ConfigError> => {
  if (raw === undefined) return Result.succeed([]);
  const invalid = Result.fail(
    new Config.ConfigError(
      new ConfigProvider.SourceError({
        message:
          'T3_MODEL_OPTIONS must be a JSON object of string or boolean values, e.g. {"effort":"high"}',
      }),
    ),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid;
  }
  const options: Array<{ id: string; value: string | boolean }> = [];
  for (const [id, value] of Object.entries(parsed)) {
    if (id.trim().length === 0) return invalid;
    if (typeof value === "boolean") {
      options.push({ id: id.trim(), value });
    } else if (typeof value === "string" && value.trim().length > 0) {
      options.push({ id: id.trim(), value: value.trim() });
    } else {
      return invalid;
    }
  }
  return Result.succeed(options);
};

const configFailure = (message: string) =>
  Effect.fail(
    new Config.ConfigError(new ConfigProvider.SourceError({ message })),
  );

const t3RemoteConnection = Effect.fn("GatewayConfig.t3RemoteConnection")(
  function* (
    baseUrlValue: string | undefined,
  ): Effect.fn.Return<T3Connection, Config.ConfigError> {
    if (baseUrlValue === undefined)
      return yield* configFailure("T3_MODE=remote requires T3_BASE_URL");
    const baseUrl = yield* Effect.try({
      try: () => new URL(baseUrlValue),
      catch: () =>
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: "T3_BASE_URL must be a valid URL",
          }),
        ),
    });
    if (
      (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") ||
      baseUrl.username !== "" ||
      baseUrl.password !== "" ||
      baseUrl.search !== "" ||
      baseUrl.hash !== ""
    )
      return yield* configFailure(
        "T3_BASE_URL must use http(s) without credentials, query, or fragment",
      );
    const allowPrivateNetworkHttp = yield* Config.Boolean(
      "T3_ALLOW_PRIVATE_NETWORK_HTTP",
    ).pipe(Config.withDefault(false));
    if (baseUrl.protocol === "http:" && !allowPrivateNetworkHttp)
      return yield* configFailure(
        "T3_BASE_URL requires HTTPS unless T3_ALLOW_PRIVATE_NETWORK_HTTP=true on a trusted private network",
      );
    const tokenFile = yield* Config.option(Config.String("T3_TOKEN_FILE"));
    const directToken = yield* Config.option(Config.String("T3_TOKEN"));
    const hasDirectToken =
      Option.isSome(directToken) && directToken.value.trim().length > 0;
    // requiredValue validates that the file (or variable) yields a token now.
    const token = yield* requiredValue("T3_TOKEN");
    return {
      _tag: "Remote",
      baseUrl,
      token:
        !hasDirectToken &&
        Option.isSome(tokenFile) &&
        tokenFile.value.trim().length > 0
          ? { _tag: "File", path: tokenFile.value.trim() }
          : { _tag: "Inline", token: Redacted.make(token) },
    };
  },
);

const T3_SIMPLE_VALUE = /^[A-Za-z0-9._/-]{1,200}$/u;

/** The only provider instances a launched daemon defines; both use CLIProxyAPI. */
export const T3_LAUNCH_INSTANCES: ReadonlySet<string> = new Set([
  "codex-cliproxy",
  "claude-cliproxy",
]);

const t3LaunchConnection = Effect.fn("GatewayConfig.t3LaunchConnection")(
  function* (
    baseUrlValue: string | undefined,
  ): Effect.fn.Return<T3Connection, Config.ConfigError> {
    // A shared daemon endpoint or bearer would bypass per-session isolation.
    if (
      baseUrlValue !== undefined ||
      (yield* optionalValue("T3_TOKEN")) !== undefined
    )
      return yield* configFailure(
        "T3_MODE=launch starts a daemon per session; unset T3_BASE_URL, T3_TOKEN and T3_TOKEN_FILE",
      );
    const portBase = yield* positiveInteger("T3_PORT_BASE", 47100);
    const portCount = yield* positiveInteger(
      "T3_PORT_COUNT",
      yield* positiveInteger("WORKER_UID_COUNT", 64),
    );
    if (
      !Number.isSafeInteger(portBase) ||
      !Number.isSafeInteger(portCount) ||
      portBase < 1024 ||
      portCount < 1 ||
      portBase + portCount - 1 > 65535
    )
      return yield* configFailure(
        "T3_PORT_BASE and T3_PORT_COUNT must describe unprivileged TCP ports",
      );
    const launchTimeoutMs = yield* timeoutMilliseconds(
      "T3_LAUNCH_TIMEOUT_MS",
      60_000,
    );
    const value = (name: string, fallback: string) =>
      optionalValue(name).pipe(
        Effect.map((raw) => raw ?? fallback),
        Effect.filterOrElse(
          (raw) => T3_SIMPLE_VALUE.test(raw),
          () => configFailure(`${name} must be a plain path or identifier`),
        ),
      );
    return {
      _tag: "Launch",
      cliPath: yield* value("T3_CLI_PATH", "t3"),
      portBase,
      portCount,
      launchTimeoutMs,
      codexExecutable: yield* value("T3_CODEX_EXECUTABLE", "codex"),
      claudeExecutable: yield* value(
        "T3_CLAUDE_EXECUTABLE",
        (yield* optionalValue("WORKER_CLAUDE_EXECUTABLE")) ?? "claude-cliproxy",
      ),
      codexModel: yield* value("T3_CODEX_MODEL", "gpt-6-sol"),
      codexReasoningEffort: yield* value("T3_CODEX_REASONING_EFFORT", "high"),
      textGenerationModel: yield* value(
        "T3_TEXT_GENERATION_MODEL",
        "gpt-6-luna",
      ),
    };
  },
);

const t3DriverConfig = Effect.fn("GatewayConfig.t3Driver")(
  function* (): Effect.fn.Return<
    T3DriverConfig | undefined,
    Config.ConfigError
  > {
    const modeValue = yield* optionalValue("T3_MODE");
    const baseUrlValue = yield* optionalValue("T3_BASE_URL");
    if (modeValue === undefined && baseUrlValue === undefined) return undefined;
    const mode = modeValue ?? "remote";
    if (mode !== "launch" && mode !== "remote") {
      return yield* configFailure("T3_MODE must be launch or remote");
    }
    const connection: T3Connection =
      mode === "launch"
        ? yield* t3LaunchConnection(baseUrlValue)
        : yield* t3RemoteConnection(baseUrlValue);
    const runtimeModeValue =
      (yield* optionalValue("T3_RUNTIME_MODE")) ?? "auto";
    if (!isRuntimeMode(runtimeModeValue)) {
      return yield* Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: `T3_RUNTIME_MODE must be one of ${RUNTIME_MODES.join(", ")}`,
          }),
        ),
      );
    }
    const interactionMode =
      (yield* optionalValue("T3_INTERACTION_MODE")) ?? "default";
    if (interactionMode !== "default" && interactionMode !== "plan") {
      return yield* Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: "T3_INTERACTION_MODE must be default or plan",
          }),
        ),
      );
    }
    const idNamespace = (yield* optionalValue("T3_ID_NAMESPACE")) ?? "symphony";
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(idNamespace)) {
      return yield* Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: "T3_ID_NAMESPACE must be 1-32 letters, digits, '_' or '-'",
          }),
        ),
      );
    }
    const modelOptions = t3ModelOptions(
      yield* optionalValue("T3_MODEL_OPTIONS"),
    );
    if (Result.isFailure(modelOptions))
      return yield* Effect.fail(modelOptions.failure);
    const projectId = yield* optionalValue("T3_PROJECT_ID");
    return {
      connection,
      ...(projectId === undefined ? {} : { projectId }),
      providerInstanceId: yield* requiredValue("T3_PROVIDER_INSTANCE"),
      model: yield* requiredValue("T3_MODEL"),
      modelOptions: modelOptions.success,
      runtimeMode: runtimeModeValue,
      interactionMode,
      idNamespace,
    };
  },
);

export class GatewayConfig extends Context.Service<GatewayConfig>()(
  "GatewayConfig",
  {
    make: Effect.gen(function* (): Effect.fn.Return<
      GatewayConfigShape,
      Config.ConfigError
    > {
      const values = yield* Config.unwrap(GatewayConfigValues);
      const allowedIds = yield* optionalValue(
        "LINEAR_ALLOWED_ORGANIZATION_IDS",
      );
      const production = yield* Config.String("NODE_ENV").pipe(
        Config.withDefault("development"),
      );
      if (production === "production" && allowedIds === undefined) {
        return yield* Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Production requires an explicit organization allowlist",
            }),
          ),
        );
      }
      const parseIds = (raw: string | undefined) =>
        raw === undefined
          ? undefined
          : new Set(
              raw
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean),
            );
      const allowedOrganizationIds = parseIds(allowedIds);
      const gatewayAdminOrganizationIds = parseIds(
        yield* optionalValue("GATEWAY_ADMIN_ORGANIZATION_IDS"),
      );
      const ownersJson = yield* optionalValue("GITHUB_APP_ALLOWED_OWNERS_JSON");
      const githubAppAllowedOwners = yield* Effect.try({
        try: () => {
          if (ownersJson === undefined) return undefined;
          const value: unknown = JSON.parse(ownersJson);
          if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value)
          )
            throw new Error("Expected org to GitHub owner array map");
          const result: Record<string, ReadonlyArray<string>> = {};
          for (const [org, owners] of Object.entries(value)) {
            if (
              !Array.isArray(owners) ||
              !owners.every(
                (owner): owner is string =>
                  typeof owner === "string" &&
                  /^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(owner),
              )
            )
              throw new Error("Invalid GitHub owner binding");
            result[org] = owners.map((owner) => owner.toLowerCase());
          }
          return result;
        },
        catch: () =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Invalid organization to GitHub owners map",
            }),
          ),
      });
      if (values.tokenEncryptionKeyId > 255)
        return yield* Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Key id must fit one byte",
            }),
          ),
        );
      const previousKeys = yield* optionalValue(
        "TOKEN_ENCRYPTION_PREVIOUS_KEYS_JSON",
      );
      const linearClientId = yield* requiredValue("LINEAR_CLIENT_ID");
      const linearClientSecret = yield* requiredValue("LINEAR_CLIENT_SECRET");
      const linearWebhookSecret = yield* requiredValue("LINEAR_WEBHOOK_SECRET");
      const tokenEncryptionKey = yield* requiredValue("TOKEN_ENCRYPTION_KEY");
      const rawRepositoryAgeKeys = yield* optionalValue(
        "WORKER_REPOSITORY_AGE_KEYS_JSON",
      );
      const workerRepositoryAgeKeys = yield* Effect.try({
        try: () => {
          const value: unknown = JSON.parse(rawRepositoryAgeKeys ?? "{}");
          if (
            typeof value !== "object" ||
            value === null ||
            Array.isArray(value) ||
            Buffer.byteLength(rawRepositoryAgeKeys ?? "{}") > 2 * 1024 * 1024
          )
            throw new Error("invalid map");
          const result: Record<string, Record<string, string>> = Object.create(
            null,
          );
          for (const [organizationId, repositories] of Object.entries(value)) {
            if (
              !/^[A-Za-z0-9_-]{1,128}$/u.test(organizationId) ||
              typeof repositories !== "object" ||
              repositories === null ||
              Array.isArray(repositories)
            )
              throw new Error("invalid binding");
            const bindings: Record<string, string> = Object.create(null);
            for (const [repositoryId, identity] of Object.entries(
              repositories,
            )) {
              if (
                !/^[A-Za-z0-9_-]{1,128}$/u.test(repositoryId) ||
                typeof identity !== "string" ||
                identity.trim().length === 0 ||
                Buffer.byteLength(identity) > 256 * 1024 ||
                identity.includes("\0")
              )
                throw new Error("invalid identity");
              bindings[repositoryId] = identity;
            }
            result[organizationId] = bindings;
          }
          return Redacted.make(result);
        },
        catch: () =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message:
                "WORKER_REPOSITORY_AGE_KEYS_JSON must bind organization and repository IDs to bounded scoped age identities",
            }),
          ),
      });
      const githubAppId = yield* optionalValue("GITHUB_APP_ID");
      const githubAppPrivateKey = yield* optionalValue(
        "GITHUB_APP_PRIVATE_KEY",
      );
      if ((githubAppId === undefined) !== (githubAppPrivateKey === undefined)) {
        const missing =
          githubAppId === undefined
            ? "GITHUB_APP_ID"
            : "GITHUB_APP_PRIVATE_KEY";
        yield* Effect.logWarning(
          `GitHub App configuration is partial; missing ${missing}`,
        ).pipe(
          Effect.annotateLogs({
            event: "config.github_app.partial",
            missing,
          }),
        );
      }
      const publicUrlValue = yield* requiredValue("PUBLIC_URL");
      const publicUrl = yield* Effect.try({
        try: () => new URL(publicUrlValue),
        catch: () =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "PUBLIC_URL must be a valid URL",
            }),
          ),
      });
      if (
        publicUrl.protocol !== "https:" &&
        publicUrl.hostname !== "localhost"
      ) {
        return yield* Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "PUBLIC_URL must use HTTPS except on localhost",
            }),
          ),
        );
      }
      const routing = yield* workerModelRouting();
      const t3Driver = yield* t3DriverConfig();
      const deviceBackupInput = yield* optionalValue(
        "T3_DEVICE_BACKUP_CONFIG_JSON",
      );
      const t3DeviceBackup =
        deviceBackupInput === undefined
          ? undefined
          : yield* Effect.try({
              try: () => parseT3DeviceBackupConfig(deviceBackupInput),
              catch: () =>
                new Config.ConfigError(
                  new ConfigProvider.SourceError({
                    message: "Invalid T3_DEVICE_BACKUP_CONFIG_JSON",
                  }),
                ),
            });
      if (
        values.workerSandboxMode !== "native" &&
        values.sessionSandboxBrokerSocketPath === undefined
      )
        return yield* configFailure(
          `WORKER_SANDBOX_MODE=${values.workerSandboxMode} requires SESSION_SANDBOX_BROKER_SOCKET`,
        );
      if (
        (values.nativeBuildSshConfigFile === undefined) !==
        (values.nativeBuildScratchRoot === undefined)
      )
        return yield* configFailure(
          "NATIVE_BUILD_SSH_CONFIG_FILE and NATIVE_BUILD_SCRATCH_ROOT must be configured together",
        );
      if (
        (values.nativeBuildBackupSshConfigFile === undefined) !==
        (values.nativeBuildBackupScratchRoot === undefined)
      )
        return yield* configFailure(
          "NATIVE_BUILD_BACKUP_SSH_CONFIG_FILE and NATIVE_BUILD_BACKUP_SCRATCH_ROOT must be configured together",
        );
      if (
        values.nativeBuildBackupSshConfigFile !== undefined &&
        (values.nativeBuildSshConfigFile === undefined ||
          values.nativeBuildBackupSshConfigFile ===
            values.nativeBuildSshConfigFile ||
          values.nativeBuildBackupScratchRoot === values.nativeBuildScratchRoot)
      )
        return yield* configFailure(
          "The backup native builder requires a primary configuration and separate transport and scratch paths",
        );
      if (t3Driver?.connection._tag === "Launch") {
        // Launched daemons only get the proxy client key, like OMP workers.
        if (routing.cliproxyApiBaseUrl === undefined)
          return yield* configFailure(
            "T3_MODE=launch requires CLIPROXYAPI_BASE_URL and CLIPROXYAPI_API_KEY",
          );
        if (!T3_LAUNCH_INSTANCES.has(t3Driver.providerInstanceId))
          return yield* configFailure(
            `T3_MODE=launch supports T3_PROVIDER_INSTANCE ${[...T3_LAUNCH_INSTANCES].join(" or ")}`,
          );
      }
      return {
        ...values,
        ...(values.nativeBuildSshConfigFile === undefined ||
        values.nativeBuildScratchRoot === undefined
          ? {}
          : {
              nativeBuild: {
                sshConfigFile: values.nativeBuildSshConfigFile,
                scratchRoot: values.nativeBuildScratchRoot,
              },
            }),
        ...routing,
        ...(values.nativeBuildBackupSshConfigFile === undefined ||
        values.nativeBuildBackupScratchRoot === undefined
          ? {}
          : {
              nativeBuildBackup: {
                sshConfigFile: values.nativeBuildBackupSshConfigFile,
                scratchRoot: values.nativeBuildBackupScratchRoot,
              },
            }),
        ...(t3DeviceBackup === undefined ? {} : { t3DeviceBackup }),
        workerRepositoryAgeKeys,
        allowedOrganizationIds,
        gatewayAdminOrganizationIds,
        githubAppAllowedOwners,
        tokenEncryptionPreviousKeys:
          previousKeys === undefined ? undefined : Redacted.make(previousKeys),
        // Spread so the service type keeps t3Driver optional.
        ...(t3Driver === undefined ? {} : { t3Driver }),
        linearClientId,
        githubAppId,
        githubAppPrivateKey:
          githubAppPrivateKey === undefined
            ? undefined
            : Redacted.make(githubAppPrivateKey),
        linearClientSecret: Redacted.make(linearClientSecret),
        linearWebhookSecret: Redacted.make(linearWebhookSecret),
        tokenEncryptionKey: Redacted.make(tokenEncryptionKey),
        publicUrl,
      };
    }).pipe(Effect.map((value): GatewayConfigShape => value)),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies;
}

export const organizationAllowed = (
  config: GatewayConfigShape,
  organizationId: string,
): boolean =>
  config.allowedOrganizationIds === undefined ||
  config.allowedOrganizationIds.has(organizationId);
