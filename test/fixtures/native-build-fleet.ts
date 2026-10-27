import { writeFile } from "node:fs/promises";
import { ConfigProvider, Effect } from "effect";
import { BuilderRegistry } from "../../src/services/builder-registry.js";
import {
  BuilderRegistryFiles,
  registryIO,
} from "../../src/services/builder-registry-files.js";
import { BuilderRegistryIdentity } from "../../src/services/builder-registry-identity.js";
import {
  BuilderSecretProvider,
  normalizeBuilderFileRecord,
} from "../../src/services/builder-secret-provider.js";
import { GatewayConfig } from "../../src/services/config.js";
import { BuilderRegistryConfig } from "../../src/services/config-native-build.js";
import { NativeBuildFleet } from "../../src/services/native-build-fleet.js";
import { NativeBuildFleetRecovery } from "../../src/services/native-build-fleet-recovery.js";
import { NativeBuildSecretCache } from "../../src/services/native-build-secret-cache.js";
import { NativeSecretJournal } from "../../src/services/native-build-secret-journal.js";
import { NativeBuildStateService } from "../../src/services/native-build-state.js";
import { NativeBuildTransport } from "../../src/services/native-build-transport.js";
import { configProvider } from "../admin-control-plane-helpers.js";
import { bytes, document, entry } from "./builder-registry.js";
import { secretFixture } from "./native-build-secret.js";

export const fleetActor = {
  kind: "human" as const,
  organizationId: "org-admin",
  sessionHash: "hashed-session",
};
export const fleetFixture = Effect.fn("Test.fleetFixture")(function* (
  root: string,
  overrideTransport?: (
    transport: NativeBuildTransport["Service"],
  ) => NativeBuildTransport["Service"],
) {
  const f = yield* secretFixture(root);
  const transport =
    overrideTransport?.(f.native.transport) ?? f.native.transport;
  const grants = new Set([fleetActor.organizationId]);
  const config = {
    ...(yield* GatewayConfig.make.pipe(
      Effect.provide(ConfigProvider.layer(configProvider)),
    )),
    nativeBuildRegistry: f.settings,
    gatewayAdminOrganizationIds: grants,
  };
  const reads: string[] = [];
  const cache = yield* f.openCache({
    read: (source, reserve) =>
      (source.startsWith("file:") ? Effect.void : reserve(4)).pipe(
        Effect.tap(() => Effect.sync(() => reads.push(source))),
        Effect.as(f.record),
      ),
  });
  const identity = yield* BuilderRegistryIdentity.make.pipe(
    Effect.provideService(NativeBuildStateService, f.native.state),
    Effect.provideService(NativeBuildTransport, transport),
  );
  const registry = yield* BuilderRegistry.make.pipe(
    Effect.provideService(BuilderRegistryConfig, f.settings),
    Effect.provideService(BuilderRegistryIdentity, identity),
    Effect.provideService(BuilderSecretProvider, {
      resolve: (item) =>
        normalizeBuilderFileRecord(
          bytes(f.record),
          item.secretSource.type === "file"
            ? `file:${item.secretSource.name}`
            : `onepassword:${item.secretSource.vaultId}:${item.secretSource.itemId}`,
          f.settings.suffix,
        ),
    }),
    Effect.provideService(NativeBuildSecretCache, cache),
    Effect.provideService(NativeBuildStateService, f.native.state),
    Effect.provide(BuilderRegistryFiles.layer),
  );
  const write = (builders = [entry()]) =>
    registryIO(() =>
      writeFile(f.settings.registryFile ?? "", bytes(document(builders)), {
        mode: 0o600,
      }),
    ).pipe(
      Effect.andThen(registry.reload()),
      Effect.andThen(registry.awaitIdle()),
    );
  yield* write();
  const recovery = yield* NativeBuildFleetRecovery.make.pipe(
    Effect.provideService(BuilderRegistry, registry),
    Effect.provideService(NativeBuildStateService, f.native.state),
    Effect.provideService(NativeBuildTransport, transport),
  );
  const fleet = yield* NativeBuildFleet.make.pipe(
    Effect.provideService(GatewayConfig, config),
    Effect.provideService(BuilderRegistry, registry),
    Effect.provideService(NativeBuildStateService, f.native.state),
    Effect.provideService(NativeBuildTransport, transport),
    Effect.provideService(NativeBuildSecretCache, cache),
    Effect.provideService(NativeSecretJournal, f.journal),
    Effect.provideService(NativeBuildFleetRecovery, recovery),
  );
  return {
    ...f,
    config,
    grants,
    fleet,
    registry,
    recovery,
    cache,
    reads,
    write,
  };
});
