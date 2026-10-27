import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { vi } from "vitest";
import { WorkspaceId } from "../src/domain/ids.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import * as T3DeviceBackup from "../src/services/t3-device-backup.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  testPath,
  toolExternalUrlCalls,
  workerSpawnInputs,
  toolCommentCalls,
  workspaceWriteCalls,
  withAuthority,
  testSessionId,
  testIssueId,
  testOrganizationId,
  install,
} = fixture;

describe("SessionAuthority host-tool mutation gate", () => {
  it.live(
    "routes T3 device backup through the current run and refuses operations after stop",
    () => {
      const calls: Array<unknown> = [];
      const releases: Array<unknown> = [];
      const backup = vi
        .spyOn(T3DeviceBackup, "makeT3DeviceBackup")
        .mockReturnValue({
          call: (organizationId, sessionId, arguments_) =>
            Effect.sync(() => {
              calls.push({ organizationId, sessionId, arguments_ });
              return { devices: [] };
            }),
          release: (organizationId, sessionId) =>
            Effect.sync(() => {
              releases.push({ organizationId, sessionId });
            }),
        });
      return withAuthority(
        () =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            const runs = yield* RunRepo;
            const inputs = yield* RunInputRepo;
            yield* (yield* InstallationRepo).put(install(testOrganizationId));
            yield* runs.create({
              sessionId: testSessionId,
              organizationId: testOrganizationId,
              issueId: Option.none(),
            });
            const cwd = testPath("device-backup-authority");
            yield* runs.update(testSessionId, {
              state: "orphaned",
              workspacePath: Option.some(cwd),
              ompSessionFile: Option.some(join(cwd, "session.jsonl")),
            });
            yield* authority.processSession(testSessionId);
            expect(
              fixture.registeredHostTools.map((tool) => tool.name),
            ).toContain("t3_device_backup");
            const listener = fixture.hostToolListener;
            if (listener === undefined)
              throw new Error("Missing host tool listener");
            const call = {
              id: "device-call",
              toolCallId: "device-tool",
              toolName: "t3_device_backup",
              arguments: {
                operation: "list",
                organizationId: "foreign",
                sessionId: "foreign",
              },
            };
            const result = yield* listener(call);
            expect(result.isError).not.toBe(true);
            expect(calls).toEqual([
              {
                organizationId: testOrganizationId,
                sessionId: testSessionId,
                arguments_: call.arguments,
              },
            ]);
            yield* inputs.applyStop(testSessionId);
            const refused = yield* listener(call);
            expect(refused.isError).toBe(true);
            expect(calls).toHaveLength(1);
            yield* authority.processSession(testSessionId);
            expect(releases).toContainEqual({
              organizationId: testOrganizationId,
              sessionId: testSessionId,
            });
          }),
        {
          configOverride: (config) => ({
            ...config,
            t3DeviceBackup: {
              baseUrl: "https://t3.example.test",
              tokenFile: "/run/secrets/t3-backup",
              workspaceRoot: "/srv/device-backup",
              organizationHosts: { [testOrganizationId]: ["mac"] },
              instanceId: "configured-provider",
              model: "configured-model",
            },
          }),
        },
      ).pipe(Effect.ensuring(Effect.sync(() => backup.mockRestore())));
    },
  );

  it.live(
    "creates a repo-bound PR without Linear and refuses creation after stop",
    () => {
      const requests: Array<{ url: string; authorization: string | null }> = [];
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (url, init) => {
          requests.push({
            url: String(url),
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return new Response(
            JSON.stringify([
              {
                number: 42,
                html_url: "https://github.com/acme/widgets/pull/42",
                head: { ref: "fix/issue", repo: { full_name: "acme/widgets" } },
                base: { ref: "main", repo: { full_name: "acme/widgets" } },
              },
            ]),
            { status: 200 },
          );
        });
      return withAuthority(
        () =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            const runs = yield* RunRepo;
            const inputs = yield* RunInputRepo;
            const repositories = yield* WorkspaceRepo;
            yield* (yield* InstallationRepo).put(install(testOrganizationId));
            const repositoryId =
              Schema.decodeUnknownSync(WorkspaceId)("pr-repository");
            yield* repositories.createRepository({
              id: repositoryId,
              organizationId: testOrganizationId,
              url: "https://github.com/acme/widgets.git",
              ref: "main",
            });
            yield* runs.create({
              sessionId: testSessionId,
              organizationId: testOrganizationId,
              issueId: Option.none(),
            });
            yield* runs.update(testSessionId, {
              state: "orphaned",
              repositoryId: Option.some(repositoryId),
              workspacePath: Option.some(testPath("pr-authority")),
              ompSessionFile: Option.some(
                testPath("pr-authority/session.jsonl"),
              ),
            });
            yield* authority.processSession(testSessionId);
            const listener = fixture.hostToolListener;
            expect(listener).toBeDefined();
            if (listener === undefined) return;
            const call = {
              id: "pr-call",
              toolCallId: "pr-tool",
              toolName: "github_create_pull_request",
              arguments: {
                head: "fix/issue",
                base: "main",
                title: "Fix issue",
              },
            };
            const result = yield* listener(call);
            expect(result.isError).not.toBe(true);
            expect(result.details).toMatchObject({
              url: "https://github.com/acme/widgets/pull/42",
            });
            expect(JSON.stringify(result)).not.toContain("ghs_pr_private");
            expect(requests).toEqual([
              {
                url: "https://api.github.com/repos/acme/widgets/pulls?state=open&head=acme%3Afix%2Fissue&base=main",
                authorization: "Bearer ghs_pr_private",
              },
            ]);
            yield* inputs.applyStop(testSessionId);
            const refused = yield* listener(call);
            expect(refused.isError).toBe(true);
            expect(requests).toHaveLength(1);
          }),
        {
          githubApp: {
            getBotIdentity: () =>
              Effect.succeed({
                name: "partitura[bot]",
                email: "partitura@example.test",
              }),
            getInstallationToken: (owner, name, org) => {
              expect([owner, name, org]).toEqual([
                "acme",
                "widgets",
                testOrganizationId,
              ]);
              return Effect.succeed("ghs_pr_private");
            },
          },
        },
      ).pipe(Effect.ensuring(Effect.sync(() => fetchMock.mockRestore())));
    },
  );
  for (const builder of ["primary", "backup"] as const) {
    it.live(
      `retries ${builder} native recovery without using the other builder`,
      () => {
        const root = testPath(`native-recovery-${builder}`);
        const scratch = join(root, "jobs");
        const ssh = join(root, "ssh");
        const configFile = join(root, "ssh_config");
        const job = "b".repeat(32);
        return withAuthority(
          () =>
            Effect.gen(function* () {
              yield* Effect.promise(async () => {
                await chmod(root, 0o700);
                await mkdir(scratch, { mode: 0o700 });
                await writeFile(configFile, "# private transport fixture\n", {
                  mode: 0o600,
                });
                await writeFile(
                  ssh,
                  '#!/bin/sh\n[ -f "$(dirname "$0")/online" ] || exit 1\nexit 0\n',
                  { mode: 0o700 },
                );
                await writeFile(
                  join(scratch, `${job}.json`),
                  JSON.stringify({
                    job,
                    sessionId: testSessionId,
                    commit: "a".repeat(40),
                    action: "test",
                    state: "running",
                  }),
                  { mode: 0o600 },
                );
              });
              const authority = yield* SessionAuthority;
              const installations = yield* InstallationRepo;
              const runs = yield* RunRepo;
              yield* installations.put(install(testOrganizationId));
              yield* runs.create({
                sessionId: testSessionId,
                organizationId: testOrganizationId,
                issueId: Option.some(testIssueId),
              });
              yield* runs.update(testSessionId, {
                state: "orphaned",
                workspacePath: Option.some(
                  testPath("native-recovery-workspace"),
                ),
                ompSessionFile: Option.some(
                  testPath("native-recovery-workspace/session.jsonl"),
                ),
              });
              yield* authority.processSession(testSessionId);
              const listener = fixture.hostToolListener;
              if (listener === undefined)
                throw new Error("host tool listener missing");
              const request = {
                id: "native-status",
                toolCallId: "native-status",
                toolName: "native_build_status",
                arguments: { job, builder },
              };
              expect((yield* listener(request)).isError).toBe(true);
              yield* Effect.promise(() => writeFile(join(root, "online"), ""));
              const recovered = yield* listener(request);
              expect(recovered.isError).not.toBe(true);
              expect(recovered.content).toMatchObject([
                {
                  type: "text",
                  text: expect.stringContaining('"state":"interrupted"'),
                },
              ]);
              const persisted = yield* Effect.promise(() =>
                readFile(join(scratch, `${job}.json`), "utf8"),
              );
              expect(JSON.parse(persisted)).toMatchObject({
                sessionId: testSessionId,
                state: "interrupted",
              });
            }),
          {
            configOverride: (config) => ({
              ...config,
              nativeBuild:
                builder === "primary"
                  ? {
                      sshConfigFile: configFile,
                      scratchRoot: scratch,
                      sshExecutable: ssh,
                    }
                  : {
                      sshConfigFile: join(root, "unavailable-primary"),
                      scratchRoot: join(root, "primary-jobs"),
                    },
              ...(builder === "backup"
                ? {
                    nativeBuildBackup: {
                      sshConfigFile: configFile,
                      scratchRoot: scratch,
                      sshExecutable: ssh,
                    },
                  }
                : {}),
            }),
          },
        );
      },
    );
  }

  it.live("refuses native build mutations after stop", () =>
    withAuthority(
      () =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          const runInputRepo = yield* RunInputRepo;
          yield* installationRepo.put(install(testOrganizationId));
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.some(testIssueId),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            workspacePath: Option.some(testPath("native-build-mutation-gate")),
            ompSessionFile: Option.some(
              testPath("native-build-mutation-gate/session.jsonl"),
            ),
          });
          yield* authority.processSession(testSessionId);

          expect(fixture.registeredHostTools.map((tool) => tool.name)).toEqual(
            expect.arrayContaining([
              "native_build_start",
              "native_build_status",
              "native_build_artifact",
              "native_build_cancel",
            ]),
          );
          const listener = fixture.hostToolListener;
          expect(listener).toBeDefined();
          if (listener === undefined) return;

          yield* runInputRepo.applyStop(testSessionId);
          for (const toolName of [
            "native_build_start",
            "native_build_artifact",
            "native_build_cancel",
          ] as const) {
            const result = yield* listener({
              id: `call-${toolName}`,
              toolCallId: `tool-${toolName}`,
              toolName,
              arguments:
                toolName === "native_build_start"
                  ? {
                      commit: "a".repeat(40),
                      pullRequest: 7,
                      action: "archive",
                    }
                  : { job: "b".repeat(32) },
            });
            expect(result.isError).toBe(true);
            expect(result.content).toMatchObject([
              { type: "text", text: "Run has stopped" },
            ]);
          }
        }),
      {
        config: [
          ["NATIVE_BUILD_SSH_CONFIG_FILE", testPath("native/ssh_config")],
          ["NATIVE_BUILD_SCRATCH_ROOT", testPath("native/scratch")],
        ],
      },
    ),
  );

  it.live("refuses mutating host tools once the run is canceled", () =>
    withAuthority(
      () =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          const runInputRepo = yield* RunInputRepo;
          yield* installationRepo.put(install(testOrganizationId));
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.some(testIssueId),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            workspacePath: Option.some(testPath("mutation-gate")),
            ompSessionFile: Option.some(
              testPath("mutation-gate/session.jsonl"),
            ),
          });

          yield* authority.processSession(testSessionId);
          expect(fixture.registeredHostTools.map((tool) => tool.name)).toEqual([
            "linear_workspace_read",
            "linear_workspace_write",
            "linear_get_issue",
            "linear_create_comment",
            "linear_update_issue",
            "linear_add_external_url",
            "github_create_pull_request",
          ]);
          expect(workerSpawnInputs).toHaveLength(1);
          const listener = fixture.hostToolListener;
          expect(listener).toBeDefined();
          if (listener === undefined) return;

          const readTool = fixture.registeredHostTools.find(
            (tool) => tool.name === "linear_workspace_read",
          );
          expect(readTool?.parameters).toMatchObject({
            required: ["operation", "input"],
            properties: { input: { type: "object" } },
          });
          const workspaceRead = yield* listener({
            id: "call-workspace-read",
            toolCallId: "tool-workspace-read",
            toolName: "linear_workspace_read",
            arguments: { operation: "get_issue", input: { id: "issue-1" } },
          });
          expect(workspaceRead.isError).not.toBe(true);
          expect(workspaceRead.content).toEqual([
            {
              type: "text",
              text: JSON.stringify({
                operation: "get_issue",
                input: { id: "issue-1" },
              }),
            },
          ]);

          const allowed = yield* listener({
            id: "call-allowed",
            toolCallId: "tool-1",
            toolName: "linear_create_comment",
            arguments: { body: "first" },
          });
          expect(allowed.isError).not.toBe(true);
          expect(toolCommentCalls).toHaveLength(1);

          const allowedWorkspaceWrite = yield* listener({
            id: "call-allowed-write",
            toolCallId: "tool-workspace-denied",
            toolName: "linear_workspace_write",
            arguments: {
              operation: "create_issue",
              input: { teamId: "team-1", title: "should not be created" },
            },
          });
          expect(allowedWorkspaceWrite.isError).not.toBe(true);
          expect(workspaceWriteCalls).toHaveLength(1);

          // Stop dominance: desired_state flips to canceled, then the
          // in-gate re-read must refuse further mutations.
          yield* runInputRepo.applyStop(testSessionId);
          const refused = yield* listener({
            id: "call-refused",
            toolCallId: "tool-2",
            toolName: "linear_create_comment",
            arguments: { body: "second" },
          });
          expect(refused.isError).toBe(true);
          expect(toolCommentCalls).toHaveLength(1);
          const deniedWorkspaceWrite = yield* listener({
            id: "call-denied-write",
            toolCallId: "tool-workspace-denied",
            toolName: "linear_workspace_write",
            arguments: {
              operation: "create_issue",
              input: { teamId: "team-1", title: "should not be created" },
            },
          });
          expect(deniedWorkspaceWrite.isError).toBe(true);
          expect(workspaceWriteCalls).toHaveLength(1);

          // Read tools still work after cancellation.
          const read = yield* listener({
            id: "call-read",
            toolCallId: "tool-3",
            toolName: "linear_get_issue",
            arguments: { issueId: "issue-1" },
          });
          expect(read.isError).not.toBe(true);
        }),
      { withLinearGateway: true },
    ),
  );
  it.live("normalizes external URLs before sending", () =>
    withAuthority(
      () =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          yield* installationRepo.put(install(testOrganizationId));
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.some(testIssueId),
          });
          yield* Effect.promise(() =>
            mkdir(testPath("external-url"), { recursive: true }),
          );
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            workspacePath: Option.some(testPath("external-url")),
            ompSessionFile: Option.some(testPath("external-url/session.jsonl")),
          });
          yield* authority.processSession(testSessionId);
          const listener = fixture.hostToolListener;
          expect(listener).toBeDefined();
          if (listener === undefined) return;

          const result = yield* listener({
            id: "call-url",
            toolCallId: "tool-url",
            toolName: "linear_add_external_url",
            arguments: {
              label: "Pull request",
              url: "  https://github.com/acme/project/pull/42  ",
            },
          });
          expect(result.isError).not.toBe(true);
          expect(toolExternalUrlCalls).toEqual([
            {
              sessionId: testSessionId,
              urls: [
                {
                  label: "Pull request",
                  url: "https://github.com/acme/project/pull/42",
                },
              ],
            },
          ]);
        }),
      { withLinearGateway: true },
    ),
  );
});
