import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect";
import { BuilderRegistry } from "../../src/services/builder-registry.js";
import { GatewayConfig } from "../../src/services/config.js";
import { BuilderRegistryConfig } from "../../src/services/config-native-build.js";
import { RegistryNativeBuildServices } from "../../src/services/native-build-assembly.js";
import {
  NativeBuildJobs,
  NativeJobPreparation,
} from "../../src/services/native-build-jobs.js";
import type { NativeEngineOptions } from "../../src/services/native-build-registry-client.js";
import { NativeBuildSecretCache } from "../../src/services/native-build-secret-cache.js";
import { NativeSecretJournal } from "../../src/services/native-build-secret-journal.js";
import {
  NativeBuildStateService,
  NativeStateConfig,
} from "../../src/services/native-build-state.js";
import { NativeTransportConfig } from "../../src/services/native-build-transport.js";
import { configProvider } from "../admin-control-plane-helpers.js";
import { bytes, document, entry, host } from "./builder-registry.js";
import { testAwait } from "./native-build-effects.js";
import { secretFixture } from "./native-build-secret.js";

export const cutoverFixture = Effect.fn("Test.cutoverFixture")(function* (
  root: string,
) {
  const scope = yield* Scope.fork(yield* Scope.Scope);
  const f = yield* secretFixture(root).pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  const settings = { ...f.settings };
  const primary = { ...f.record, hostname: "primary.example.test" };
  const backup = {
    ...primary,
    hostId: host(2),
    hostname: "backup.example.test",
  };
  yield* testAwait(
    Promise.all([
      writeFile(
        join(settings.fileSecretRoot ?? "", "primary.json"),
        bytes(primary),
        { mode: 0o400 },
      ),
      writeFile(
        join(settings.fileSecretRoot ?? "", "backup.json"),
        bytes(backup),
        { mode: 0o400 },
      ),
      writeFile(
        settings.registryFile ?? "",
        bytes(document([entry(), entry("backup")])),
        { mode: 0o600 },
      ),
    ]),
  );
  const plan = (overrides: Record<string, unknown> = {}) =>
    testAwait(
      f.native.plan({
        hosts: {
          [primary.hostname]: primary.hostId,
          [backup.hostname]: backup.hostId,
        },
        ...overrides,
      }),
    );
  yield* plan();
  yield* Scope.close(scope, Exit.void);
  const config = {
    ...(yield* GatewayConfig.make.pipe(
      Effect.provide(ConfigProvider.layer(configProvider)),
    )),
    nativeBuildRegistry: settings,
  };
  const bundle: NativeEngineOptions["prepareBundle"] = () =>
    Effect.succeed(
      (async function* () {
        yield Buffer.from("dummy bundle");
      })(),
    );
  const boot = Effect.fn("Test.bootRegistry")(function* (
    prepareBundle = bundle,
  ) {
    const lifetime = yield* Scope.fork(yield* Scope.Scope);
    const context = yield* Layer.build(
      RegistryNativeBuildServices.pipe(
        Layer.provide(Layer.succeed(GatewayConfig, config)),
        Layer.provide(Layer.succeed(BuilderRegistryConfig, settings)),
        Layer.provide(
          Layer.succeed(NativeStateConfig, {
            stateRoot: settings.stateRoot,
            cacheRoot: settings.cacheRoot,
            scratchRoot: settings.scratchRoot,
            bytesPerBuilder: settings.perBuilderBytes,
            bytesTotal: settings.totalBytes,
            otherRoots: [
              ...(settings.otherRoots ?? []),
              settings.fileSecretRoot ?? "",
            ],
            filesystem: async () => ({
              type: 0x01021994,
              bavail: 1e9,
              bsize: 4096,
            }),
          }),
        ),
        Layer.provide(
          Layer.succeed(NativeTransportConfig, {
            suffix: settings.suffix,
            executable: f.native.executable,
          }),
        ),
        Layer.provide(Layer.succeed(NativeJobPreparation, { prepareBundle })),
      ),
    ).pipe(Effect.provideService(Scope.Scope, lifetime));
    return {
      context,
      journal: Context.get(context, NativeSecretJournal),
      cache: Context.get(context, NativeBuildSecretCache),
      registry: Context.get(context, BuilderRegistry),
      state: Context.get(context, NativeBuildStateService),
      jobs: Context.get(context, NativeBuildJobs),
      close: Scope.close(lifetime, Exit.void),
    };
  });
  const write = (snapshot = document([entry(), entry("backup")])) =>
    testAwait(
      writeFile(settings.registryFile ?? "", bytes(snapshot), { mode: 0o600 }),
    );
  return { ...f, config, settings, primary, backup, boot, write, plan };
});
export const cutoverRequest = {
  organizationId: "org-a",
  sessionId: "session-a",
  commit: "e".repeat(40),
  pullRequest: 7,
  action: "archive",
};
