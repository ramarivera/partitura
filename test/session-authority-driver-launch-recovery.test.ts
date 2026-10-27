import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schedule, Schema } from "effect";
import { WorkspaceId } from "../src/domain/ids.js";
import { NixPackageName } from "../src/domain/models.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  PromptTemplateRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { createDriverFixture } from "./session-authority-driver-fixture.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const { seedDriverRun, awaitState, withT3Authority, t3Server } =
  createDriverFixture(fixture);
const {
  testPath,
  toolExternalUrlCalls,
  workerSpawnInputs,
  nixPreparedRepositories,
  withAuthority,
  testSessionId,
  testOrganizationId,
} = fixture;

describe("AgentDriver authority integration", () => {
  it.live(
    "launches a private T3 daemon per session with the OMP Git credential path",
    () =>
      Effect.gen(function* () {
        const server = yield* t3Server;
        const cli = testPath("bin/t3-proxy.sh");
        const fakeCli = fileURLToPath(
          new URL("./fixtures/fake-t3-cli.ts", import.meta.url),
        );
        yield* Effect.promise(() =>
          writeFile(
            cli,
            `#!/bin/sh\nexec ${process.execPath} ${fakeCli} proxy ${server.baseUrl.port} ${server.token} "$@"\n`,
            { mode: 0o755 },
          ),
        );
        const portBase = 20_000 + ((process.pid * 11) % 20_000);
        yield* withAuthority(
          () =>
            Effect.gen(function* () {
              const { cwd, configPath } = yield* seedDriverRun("t3");
              yield* (yield* PromptTemplateRepo).upsert({
                organizationId: testOrganizationId,
                kind: "contract",
                body: "Org OMP contract: use linear_get_issue, linear_create_comment, linear_add_external_url and rromp_report_deviation, then push.",
                updatedAt: 0,
              });
              fixture.nixPathEntries = ["/nix/store/repository-toolchain/bin"];
              yield* (yield* WorkspaceRepo).updateRepository(
                testOrganizationId,
                Schema.decodeUnknownSync(WorkspaceId)("driver-repo"),
                {
                  nixPackages: [
                    Schema.decodeUnknownSync(NixPackageName)("nodejs"),
                  ],
                },
              );
              yield* (yield* SessionAuthority).processSession(testSessionId);
              expect(nixPreparedRepositories).toContain("driver-repo");
              const launchEnv = JSON.parse(
                yield* Effect.promise(() =>
                  readFile(`${cwd}/.omp-home/t3/serve-env.json`, "utf8"),
                ),
              ) as { path: string };
              expect(launchEnv.path.split(":")[0]).toBe(
                "/nix/store/repository-toolchain/bin",
              );
              const ref = Option.getOrThrow(
                yield* (yield* WorkspaceRepo).getDriverSession(testSessionId),
              );
              expect(ref.driver).toBe("t3");
              expect(ref.locator.origin).toBe(`http://127.0.0.1:${portBase}`);
              expect(workerSpawnInputs).toHaveLength(0);
              expect([...server.projects.values()][0]?.workspaceRoot).toBe(cwd);
              // GitHub credentials stay in the gateway during checkout and
              // never persist in the worker's repository config or cross T3.
              const minted = Buffer.from("x-access-token:ghs_launch").toString(
                "base64",
              );
              const workspaceGitConfig = yield* Effect.promise(() =>
                readFile(configPath, "utf8"),
              );
              expect(workspaceGitConfig).not.toContain("AUTHORIZATION");
              expect(workspaceGitConfig).not.toContain("ghs_launch");
              expect(workspaceGitConfig).toMatch(
                /\[url "http:\/\/127\.0\.0\.1:\d+\/git\/[A-Za-z0-9_-]+\/org\/repo"\]/u,
              );
              expect(workspaceGitConfig).toContain(
                "insteadOf = https://github.com/org/repo",
              );
              expect(JSON.stringify(server.requests)).not.toContain(minted);
              expect(JSON.stringify(server.requests)).not.toContain(
                "ghs_launch",
              );
              const prompt = JSON.stringify(
                server.commandsOf("message.dispatch")[0],
              );
              expect(prompt).toContain("github_create_pull_request");
              expect(prompt).not.toContain("git config --get");
              expect(prompt).not.toContain("Org OMP contract");
              expect(prompt).not.toContain("linear_get_issue");
              expect(prompt).not.toContain("rromp_report_deviation");
              const t3Home = join(cwd, ".omp-home", "t3");
              const serveEnv = JSON.parse(
                yield* Effect.promise(() =>
                  readFile(join(t3Home, "serve-env.json"), "utf8"),
                ),
              );
              expect(serveEnv.home).toBe(join(cwd, ".omp-home"));
              expect(serveEnv.keys).toContain("CLIPROXYAPI_API_KEY");
              expect(serveEnv.keys).not.toContain("LINEAR_CLIENT_SECRET");
              const settings = yield* Effect.promise(() =>
                readFile(join(t3Home, "userdata", "settings.json"), "utf8"),
              );
              expect(settings).toContain("codex-cliproxy");
              expect(settings).not.toContain("proxy-client-key");
              const provider = Number(
                yield* Effect.promise(() =>
                  readFile(join(t3Home, "provider.pid"), "utf8"),
                ),
              );
              server.updateRun(ref.nativeId, "run-1", { status: "running" });
              server.upsertItem(ref.nativeId, {
                id: "message-1",
                type: "assistant_message",
                runId: "run-1",
                status: "completed",
                ordinal: 1,
                messageId: "assistant-1",
                text: "Opened https://github.com/org/repo/pull/7",
                streaming: false,
              });
              server.updateRun(ref.nativeId, "run-1", { status: "completed" });
              yield* awaitState("succeeded");
              expect(toolExternalUrlCalls).toContainEqual({
                sessionId: testSessionId,
                urls: [
                  {
                    label: "Pull request",
                    url: "https://github.com/org/repo/pull/7",
                  },
                ],
              });
              // Run end stops the daemon and its provider children.
              const stopped = yield* Effect.sync(() => {
                try {
                  process.kill(provider, 0);
                  return false;
                } catch {
                  return true;
                }
              }).pipe(
                Effect.repeat({
                  until: (done) => done,
                  schedule: Schedule.spaced(25),
                }),
                Effect.timeoutOrElse({
                  duration: 5_000,
                  orElse: () => Effect.succeed(false),
                }),
              );
              expect(stopped).toBe(true);
            }),
          {
            withLinearGateway: true,
            githubApp: {
              getBotIdentity: () =>
                Effect.succeed({
                  name: "test-app[bot]",
                  email: "98765+test-app[bot]@users.noreply.github.com",
                }),
              getInstallationToken: () => Effect.succeed("ghs_launch"),
            },
            config: [
              ["T3_MODE", "launch"],
              ["T3_CLI_PATH", cli],
              ["T3_PORT_BASE", String(portBase)],
              ["T3_PORT_COUNT", "4"],
              ["T3_PROVIDER_INSTANCE", "codex-cliproxy"],
              ["T3_MODEL", "gpt-6-sol"],
              ["CLIPROXYAPI_BASE_URL", "https://cliproxyapi.example.test"],
              ["CLIPROXYAPI_API_KEY", "proxy-client-key"],
            ],
          },
        );
      }),
    20_000,
  );
  it.live(
    "reuses the T3 thread after restart while a new attempt ignores old terminal events",
    () =>
      Effect.gen(function* () {
        const server = yield* t3Server;
        yield* withT3Authority(
          () =>
            Effect.gen(function* () {
              yield* seedDriverRun("t3");
              const authority = yield* SessionAuthority;
              const runs = yield* RunRepo;
              yield* authority.processSession(testSessionId);
              const ref = Option.getOrThrow(
                yield* (yield* WorkspaceRepo).getDriverSession(testSessionId),
              );
              yield* authority.shutdown();
              yield* runs.update(testSessionId, {
                state: "orphaned",
                nextAttemptAt: Option.none(),
              });
              yield* authority.processSession(testSessionId);
              expect(
                server.requestsFor("orchestration.launchThread"),
              ).toHaveLength(1);
              expect(server.projects.size).toBe(1);
              expect(server.commandsOf("message.dispatch")).toHaveLength(2);
              expect(server.commandsOf("message.dispatch")[1]?.threadId).toBe(
                ref.nativeId,
              );
              expect(
                Option.getOrThrow(yield* runs.get(testSessionId)).state,
              ).toBe("running");
            }),
          server,
        );
      }),
  );
});
