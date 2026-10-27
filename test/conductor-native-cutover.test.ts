import { writeFile } from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import { Clock, ConfigProvider, Effect, Layer, Option } from "effect";
import { GatewayCoreServicesLive, recoverGateway } from "../src/conductor.js";
import { GatewayConfig } from "../src/services/config.js";
import { RunRepo } from "../src/services/store/repositories.js";
import { WebhookPipeline } from "../src/services/webhook.js";
import { configProvider } from "./admin-control-plane-helpers.js";
import { cutoverFixture } from "./fixtures/native-build-cutover.js";
import { testAwait } from "./fixtures/native-build-effects.js";
import { testPaths } from "./fixtures/paths.js";
import {
  createdPayload,
  install,
  sessionId,
  sign,
  signedRequest,
} from "./webhook-fixtures.js";

const path = testPaths();
it.live(
  "the conductor's ordinary Linear ingress stays usable with offline builders and an invalid registry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* cutoverFixture(path("linear-ingress"));
        yield* f.plan({ unavailable: true });
        yield* testAwait(
          writeFile(f.settings.registryFile ?? "", "{invalid", { mode: 0o600 }),
        );
        const native = yield* f.boot();
        yield* Effect.gen(function* () {
          yield* recoverGateway;
          expect(native.registry.snapshot().error).toBeDefined();
          yield* install();
          const payload = createdPayload(yield* Clock.currentTimeMillis);
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
          Effect.provide(
            GatewayCoreServicesLive.pipe(
              Layer.provideMerge(Layer.succeedContext(native.context)),
              Layer.provideMerge(Layer.succeed(GatewayConfig, f.config)),
              Layer.provide(ConfigProvider.layer(configProvider)),
            ),
          ),
        );
      }),
    ),
);
