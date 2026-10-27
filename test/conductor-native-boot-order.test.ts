import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option } from "effect";
import { vi } from "vitest";
import { GatewayServicesLive, recoverGateway } from "../src/conductor.js";
import { BuilderRegistry } from "../src/services/builder-registry.js";
import { NativeBuildRuntimeAdapters } from "../src/services/native-build-assembly.js";
import { NativeBuildFleet } from "../src/services/native-build-fleet.js";
import { NativeBuildJobs } from "../src/services/native-build-jobs.js";
import { NativeBuildStateService } from "../src/services/native-build-state.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import { RunRepo } from "../src/services/store/repositories.js";
import { WebhookPipeline } from "../src/services/webhook.js";
import { configProvider } from "./admin-control-plane-helpers.js";
import { document, entry } from "./fixtures/builder-registry.js";
import { cutoverFixture } from "./fixtures/native-build-cutover.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { registryJob } from "./fixtures/native-build-registry.js";
import { testPaths } from "./fixtures/paths.js";
import {
  createdPayload,
  install,
  sessionId,
  sign,
  signedRequest,
} from "./webhook-fixtures.js";

const observations = vi.hoisted(() => ({
  constructed: false,
  inspect: undefined as undefined | (() => void),
}));
// Observe the real SessionAuthority constructor, not a consumer run after all layers finish.
vi.mock("../src/services/session-authority.js", async (original) => {
  const actual =
    await original<typeof import("../src/services/session-authority.js")>();
  const { Effect, Layer, Option } = await import("effect");
  const { NativeBuildStateService } = await import(
    "../src/services/native-build-state.js"
  );
  const { WorkerIdentityRepo } = await import(
    "../src/services/store/worker-identity-repo.js"
  );
  const { ActivityProjector } = await import("../src/services/projector.js");
  const {
    InstallationRepo,
    McpServerRepo,
    PromptTemplateRepo,
    RunEventRepo,
    RunInputRepo,
    RunRepo,
    WorkspaceRepo,
    AgentSettingsRepo,
  } = await import("../src/services/store/repositories.js");
  const { McpOAuth } = await import("../src/services/mcp-oauth.js");
  const { LinearGateway } = await import("../src/services/linear-gateway.js");
  const { GatewayConfig } = await import("../src/services/config.js");
  const { GitHubApp } = await import("../src/services/github-app.js");
  const { RpcWorker } = await import("../src/services/rpc-worker.js");
  const { NixEnvironment } = await import("../src/services/nix-environment.js");
  class ProbedSessionAuthority extends actual.SessionAuthority {
    static override readonly layer = Layer.effect(
      actual.SessionAuthority,
      Effect.gen(function* () {
        const state = yield* Effect.serviceOption(NativeBuildStateService);
        expect(Option.isSome(state)).toBe(true);
        observations.inspect?.();
        observations.constructed = true;
        return yield* actual.SessionAuthority.make;
      }),
    ).pipe(
      Layer.provide([
        ActivityProjector.layer,
        InstallationRepo.layer,
        McpServerRepo.layer,
        McpOAuth.layer,
        PromptTemplateRepo.layer,
        RunEventRepo.layer,
        RunInputRepo.layer,
        RunRepo.layer,
        LinearGateway.layer,
        WorkspaceRepo.layer,
        AgentSettingsRepo.layer,
        GatewayConfig.layer,
        GitHubApp.layer,
        RpcWorker.layer,
        WorkerIdentityRepo.layer,
        NixEnvironment.layer,
      ]),
    );
  }
  return { ...actual, SessionAuthority: ProbedSessionAuthority };
});
const path = testPaths();
it.live(
  "production assembly recovers crash metadata before constructing SessionAuthority or serving ingress",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("production-boot"));
        yield* f.write(document([entry()]));
        const first = yield* f.boot();
        yield* first.registry.awaitIdle();
        const generation = first.state.snapshot().generations[0];
        if (!generation) return yield* Effect.die("missing generation");
        const starting = registryJob(generation);
        const submitting = registryJob(generation, { state: "submitting" });
        const terminal = registryJob(generation, { state: "failed" });
        const saved = first.state.snapshot();
        const partial = join(first.state.jobPath(starting), "artifact.partial");
        const bundle = join(first.state.jobPath(terminal), "source.bundle");
        yield* first.close;
        // Crash-shaped disk state is seeded only AFTER shutdown, so no graceful engine cleanup can repair it.
        yield* testAwait(
          Promise.all([
            mkdir(join(partial, ".."), { recursive: true, mode: 0o700 }),
            mkdir(join(bundle, ".."), { recursive: true, mode: 0o700 }),
          ]),
        );
        yield* testAwait(
          Promise.all([
            writeFile(
              join(f.settings.stateRoot, "metadata.json"),
              JSON.stringify({
                ...saved,
                jobs: [starting, submitting, terminal],
              }),
              { mode: 0o600 },
            ),
            writeFile(partial, "crash partial", { mode: 0o600 }),
            writeFile(bundle, "resolved input", { mode: 0o600 }),
          ]),
        );
        yield* f.plan({ unavailable: true });
        observations.constructed = false;
        observations.inspect = () => {
          const metadata = JSON.parse(
            readFileSync(join(f.settings.stateRoot, "metadata.json"), "utf8"),
          );
          expect(
            metadata.jobs.find(
              (job: { jobId: string }) => job.jobId === starting.jobId,
            ).state,
          ).toBe("interrupted");
          expect(
            metadata.jobs.find(
              (job: { jobId: string }) => job.jobId === submitting.jobId,
            ).recovery.deadline,
          ).toBeGreaterThan(0);
          expect(existsSync(partial)).toBe(false);
          expect(existsSync(bundle)).toBe(false);
        };
        const workerRoot = join(f.root, "ordinary-workers");
        yield* testAwait(mkdir(workerRoot, { mode: 0o700 }));
        const provider = ConfigProvider.fromUnknown({
          WORKSPACE_ROOT: workerRoot,
          NATIVE_BUILD_REGISTRY_FILE: f.settings.registryFile,
          NATIVE_BUILD_STATE_ROOT: f.settings.stateRoot,
          NATIVE_BUILD_REGISTRY_SCRATCH_ROOT: f.settings.scratchRoot,
          NATIVE_BUILD_CACHE_ROOT: f.settings.cacheRoot,
          NATIVE_BUILD_FILE_SECRET_ROOT: f.settings.fileSecretRoot,
          NATIVE_BUILD_ALLOWED_HOST_SUFFIX: f.settings.suffix,
        }).pipe(ConfigProvider.orElse(configProvider));
        yield* Effect.gen(function* () {
          expect(observations.constructed).toBe(true);
          yield* SessionAuthority;
          expect(
            Option.isSome(yield* Effect.serviceOption(NativeBuildJobs)),
          ).toBe(true);
          expect(
            Option.isSome(yield* Effect.serviceOption(NativeBuildFleet)),
          ).toBe(true);
          expect(
            Option.isSome(yield* Effect.serviceOption(BuilderRegistry)),
          ).toBe(true);
          const state = Option.getOrThrow(
            yield* Effect.serviceOption(NativeBuildStateService),
          );
          expect(state.options).toMatchObject({
            stateRoot: f.settings.stateRoot,
            scratchRoot: f.settings.scratchRoot,
            cacheRoot: f.settings.cacheRoot,
          });
          expect(state.options.otherRoots).toContain(f.settings.fileSecretRoot);
          observations.inspect?.();
          yield* recoverGateway;
          yield* install();
          const payload = createdPayload(Date.now());
          const response = yield* WebhookPipeline.use((service) =>
            service.handle(
              signedRequest(payload, {
                signature: sign(JSON.stringify(payload), "webhook"),
              }),
            ),
          );
          expect(response.status).toBe(200);
          expect(
            Option.isSome(
              yield* RunRepo.use((repo) => repo.get(sessionId("session-1"))),
            ),
          ).toBe(true);
        }).pipe(
          Effect.provide(GatewayServicesLive),
          Effect.provideService(NativeBuildRuntimeAdapters, {
            filesystem: async () => ({
              type: 0x01021994,
              bavail: 1e9,
              bsize: 4096,
            }),
            executable: f.native.executable,
          }),
          Effect.provide(ConfigProvider.layer(provider)),
          Effect.ensuring(
            Effect.sync(() => {
              observations.inspect = undefined;
            }),
          ),
        );
      }),
    ).pipe(Effect.timeout(10000)),
);
