import { writeFile } from "node:fs/promises";
import { expect } from "@effect/vitest";
import { Effect, Option, Schedule, Schema } from "effect";
import { InputId, WorkspaceId } from "../src/domain/ids.js";
import type { GatewayConfig } from "../src/services/config.js";
import {
  InstallationRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { FakeT3Server } from "./fixtures/fake-t3.js";

import type { createAuthorityFixture } from "./session-authority-fixture.js";

export const createDriverFixture = (
  fixture: ReturnType<typeof createAuthorityFixture>,
) => {
  const {
    testPath,
    install,
    testOrganizationId,
    testSessionId,
    testIssueId,
    withAuthority,
  } = fixture;
  const seedDriverRun = (
    defaultDriver: "omp" | "t3",
    labels: ReadonlyArray<string> = [],
  ) =>
    Effect.gen(function* () {
      const installations = yield* InstallationRepo;
      const repositories = yield* WorkspaceRepo;
      const runs = yield* RunRepo;
      const inputs = yield* RunInputRepo;
      yield* installations.put(install(testOrganizationId));
      const id = Schema.decodeUnknownSync(WorkspaceId)("driver-repo");
      yield* repositories.createRepository({
        organizationId: testOrganizationId,
        id,
        url: "https://github.com/org/repo.git",
        ref: "main",
        defaultDriver,
      });
      const cwd = testPath("driver-workspace");
      const configPath = testPath("driver-workspace/.git/config");
      yield* Effect.promise(() =>
        writeFile(
          configPath,
          '[core]\nrepositoryformatversion = 0\n[http "https://github.com/"]\nextraheader = AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0\n',
        ),
      );
      const initialized = yield* Effect.sync(() =>
        Bun.spawnSync({
          cmd: ["/usr/bin/git", "init", "--quiet", cwd],
          env: {
            PATH: "/usr/bin:/bin",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
          },
        }),
      );
      expect(initialized.exitCode).toBe(0);
      yield* runs.create({
        sessionId: testSessionId,
        organizationId: testOrganizationId,
        issueId: Option.some(testIssueId),
      });
      yield* runs.update(testSessionId, {
        repositoryId: Option.some(id),
        workspacePath: Option.some(cwd),
      });
      yield* inputs.enqueue({
        id: Schema.decodeUnknownSync(InputId)("driver-input"),
        sessionId: testSessionId,
        kind: "created",
        body: "Fix the test and open a PR",
        payload: { agentSession: { issue: { labels } } },
      });
      return { cwd, configPath };
    });

  const awaitState = (state: string) =>
    Effect.gen(function* () {
      const runs = yield* RunRepo;
      yield* runs.get(testSessionId).pipe(
        Effect.repeat({
          while: (run) => Option.isNone(run) || run.value.state !== state,
          schedule: Schedule.spaced(5),
        }),
        Effect.timeoutOrElse({
          duration: 3_000,
          orElse: () => Effect.die(new Error(`Run did not reach ${state}`)),
        }),
      );
    });

  const withT3Authority = <A, E>(
    task: Parameters<typeof withAuthority<A, E>>[0],
    server: FakeT3Server,
    workerUid?: string,
    sandboxMode: false | "firecracker" | "sysbox" = false,
  ) =>
    withAuthority(task, {
      withLinearGateway: true,
      ...(workerUid === undefined ? {} : { workerUid }),
      ...(sandboxMode
        ? {
            configOverride: (config: GatewayConfig["Service"]) => ({
              ...config,
              workerSandboxMode: sandboxMode,
              sessionSandboxBrokerSocketPath:
                "/nonexistent-sandbox-broker.sock",
            }),
          }
        : {}),
      config: [
        ["T3_BASE_URL", server.baseUrl.toString()],
        ["T3_ALLOW_PRIVATE_NETWORK_HTTP", "true"],
        ["T3_TOKEN", server.token],
        ["T3_PROVIDER_INSTANCE", "codex-cliproxy"],
        ["T3_MODEL", "gpt-6-sol"],
      ],
    });

  const t3Server = Effect.acquireRelease(
    Effect.sync(() => new FakeT3Server()),
    (server) => Effect.sync(() => server.stop()),
  );
  return { seedDriverRun, awaitState, withT3Authority, t3Server };
};
