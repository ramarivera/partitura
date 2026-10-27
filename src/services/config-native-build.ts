import { isIP } from "node:net";
import { isAbsolute, resolve, sep } from "node:path";
import { Config, Context, Effect, Option } from "effect";
import { invalid, positiveInteger } from "./config-values.js";

export interface BuilderRegistrySettings {
  readonly registryFile?: string | undefined;
  readonly stateRoot: string;
  readonly scratchRoot: string;
  readonly cacheRoot: string;
  readonly tokenFile?: string | undefined;
  readonly vaultId?: string | undefined;
  readonly suffix: string;
  readonly fileSecretRoot?: string | undefined;
  readonly dailyBudget: number;
  readonly hourlyBudget: number;
  readonly perBuilderBytes: number;
  readonly totalBytes: number;
  readonly otherRoots?: readonly string[];
}
export class BuilderRegistryConfig extends Context.Service<
  BuilderRegistryConfig,
  BuilderRegistrySettings
>()("BuilderRegistryConfig") {}

export const nativePathsOverlap = (left: string, right: string) =>
  left === right ||
  left.startsWith(`${right}${right === sep ? "" : sep}`) ||
  right.startsWith(`${left}${left === sep ? "" : sep}`);

const pathSetting = (name: string, fallback?: string) =>
  Config.option(Config.String(name)).pipe(
    Config.mapEffect((value) => {
      const path = Option.getOrUndefined(value) ?? fallback;
      return path === undefined ||
        (path.length > 0 && isAbsolute(path) && resolve(path) === path)
        ? Effect.succeed(path)
        : Effect.fail(invalid(`${name} must be an absolute canonical path`));
    }),
  );

export const loadBuilderRegistrySettings = Effect.fn(
  "GatewayConfig.nativeRegistry",
)(function* (otherRoots: readonly string[]) {
  const settings = yield* Config.all({
    registryFile: pathSetting("NATIVE_BUILD_REGISTRY_FILE"),
    stateRoot: pathSetting(
      "NATIVE_BUILD_STATE_ROOT",
      "/app/data/native-build-registry",
    ),
    scratchRoot: pathSetting(
      "NATIVE_BUILD_REGISTRY_SCRATCH_ROOT",
      "/app/native-build-registry-scratch",
    ),
    cacheRoot: pathSetting("NATIVE_BUILD_CACHE_ROOT", "/run/partitura-native"),
    tokenFile: pathSetting("NATIVE_BUILD_OP_TOKEN_FILE"),
    vaultId: Config.option(Config.String("NATIVE_BUILD_OP_VAULT_ID")).pipe(
      Config.map(Option.getOrUndefined),
    ),
    suffix: Config.String("NATIVE_BUILD_ALLOWED_HOST_SUFFIX").pipe(
      Config.withDefault("xalda-procyon.ts.net"),
    ),
    fileSecretRoot: pathSetting("NATIVE_BUILD_FILE_SECRET_ROOT"),
    dailyBudget: positiveInteger("NATIVE_BUILD_OP_DAILY_BUDGET", 400),
    hourlyBudget: positiveInteger("NATIVE_BUILD_OP_HOURLY_BUDGET", 200),
    perBuilderBytes: positiveInteger(
      "NATIVE_BUILD_REGISTRY_SCRATCH_BYTES_PER_BUILDER",
      8 * 1024 ** 3,
    ),
    totalBytes: positiveInteger(
      "NATIVE_BUILD_REGISTRY_SCRATCH_BYTES_TOTAL",
      32 * 1024 ** 3,
    ),
  });
  const { stateRoot, scratchRoot, cacheRoot } = settings;
  if (!stateRoot || !scratchRoot || !cacheRoot)
    return yield* Effect.fail(invalid("Native registry roots are required"));
  if (
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(
      settings.suffix,
    ) ||
    isIP(settings.suffix) !== 0 ||
    settings.suffix.length > 253 ||
    settings.suffix.split(".").some((label) => label.length > 63) ||
    (settings.vaultId !== undefined &&
      !/^[a-z0-9]{26}$/u.test(settings.vaultId)) ||
    settings.hourlyBudget > settings.dailyBudget ||
    settings.perBuilderBytes > settings.totalBytes
  )
    return yield* Effect.fail(invalid("Invalid native registry policy"));
  for (const root of [
    stateRoot,
    cacheRoot,
    settings.fileSecretRoot,
    ...otherRoots,
  ])
    if (
      settings.registryFile !== undefined &&
      root !== undefined &&
      nativePathsOverlap(scratchRoot, resolve(root))
    )
      return yield* Effect.fail(
        invalid("Native registry scratch root overlaps another root"),
      );
  if (settings.registryFile !== undefined)
    for (const root of [stateRoot, cacheRoot])
      if (otherRoots.some((other) => nativePathsOverlap(root, resolve(other))))
        return yield* Effect.fail(
          invalid(
            "Native registry state/cache root overlaps a legacy or worker root",
          ),
        );
  return {
    ...settings,
    stateRoot,
    scratchRoot,
    cacheRoot,
    otherRoots,
  } satisfies BuilderRegistrySettings;
});
