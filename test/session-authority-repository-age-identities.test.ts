import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Redacted, Schema } from "effect";
import { vi } from "vitest";
import { SessionId, WorkspaceId } from "../src/domain/ids.js";
import * as NativeBuild from "../src/services/native-build-client.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunInputRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  testPath,
  workerSpawnInputs,
  withAuthority,
  testSessionId,
  testOrganizationId,
  install,
} = fixture;

describe("SessionAuthority repository age identities", () => {
  it.live(
    "selects native secrets from the exact run grant and ignores model secret inputs",
    () => {
      const requests: NativeBuild.NativeBuildRequest[] = [];
      const job = {
        job: "a".repeat(32),
        sessionId: testSessionId,
        commit: "b".repeat(40),
        action: "test",
        state: "starting" as const,
      };
      const client = vi
        .spyOn(NativeBuild, "createNativeBuildClient")
        .mockResolvedValue({
          start: async (request) => {
            requests.push(request);
            return job;
          },
          status: async () => job,
          cancel: async () => ({ ...job, cancellationRequested: true }),
          close: async () => {},
          artifact: async () => {
            throw new Error("No fixture artifact");
          },
        });
      return withAuthority(
        () =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            const runs = yield* RunRepo;
            const repositories = yield* WorkspaceRepo;
            yield* (yield* InstallationRepo).put(install(testOrganizationId));
            for (const [index, name] of [
              "bound-repo",
              "unbound-repo",
            ].entries()) {
              const repositoryId = Schema.decodeUnknownSync(WorkspaceId)(name);
              const sessionId = Schema.decodeUnknownSync(SessionId)(
                `native-age-session-${index}`,
              );
              const cwd = testPath(`native-age-workspace-${index}`);
              yield* repositories.createRepository({
                id: repositoryId,
                organizationId: testOrganizationId,
                url: "https://github.com/fixture/scoped.git",
                ref: "main",
              });
              yield* runs.create({
                sessionId,
                organizationId: testOrganizationId,
                issueId: Option.none(),
              });
              yield* runs.update(sessionId, {
                state: "orphaned",
                repositoryId: Option.some(repositoryId),
                workspacePath: Option.some(cwd),
                ompSessionFile: Option.some(join(cwd, "session.jsonl")),
              });
              yield* authority.processSession(sessionId);
              const listener = fixture.hostToolListener;
              if (listener === undefined)
                throw new Error("Missing host tool listener");
              const result = yield* listener({
                id: `native-age-${index}`,
                toolCallId: `native-age-${index}`,
                toolName: "native_build_start",
                arguments: {
                  commit: job.commit,
                  pullRequest: 31,
                  action: "test",
                  secretFiles: {
                    "repository-age-identity": "model-injected-key",
                  },
                  organizationId: "foreign-org",
                  repositoryId: "unbound-repo",
                },
              });
              expect(result.isError).not.toBe(true);
              expect(requests[index]?.secretFiles).toEqual(
                index === 0
                  ? { "repository-age-identity": "scoped-fixture-key" }
                  : undefined,
              );
            }
            expect(JSON.stringify(requests)).not.toContain("foreign-org-key");
            expect(JSON.stringify(requests)).not.toContain(
              "model-injected-key",
            );
          }),
        {
          configOverride: (config) => ({
            ...config,
            nativeBuild: {
              sshConfigFile: testPath("native-age/ssh_config"),
              scratchRoot: testPath("native-age/jobs"),
            },
            workerRepositoryAgeKeys: Redacted.make({
              [testOrganizationId]: { "bound-repo": "scoped-fixture-key" },
              "foreign-org": { "unbound-repo": "foreign-org-key" },
            }),
          }),
        },
      ).pipe(Effect.ensuring(Effect.sync(() => client.mockRestore())));
    },
  );

  it.live(
    "materializes only the run's org/repository key and passes a private file pointer",
    () =>
      withAuthority(
        () =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            const runs = yield* RunRepo;
            const repositories = yield* WorkspaceRepo;
            yield* (yield* InstallationRepo).put(install(testOrganizationId));
            for (const [index, repositoryName] of [
              "bound-repo",
              "unbound-repo",
            ].entries()) {
              const repositoryId =
                Schema.decodeUnknownSync(WorkspaceId)(repositoryName);
              const sessionId = Schema.decodeUnknownSync(SessionId)(
                `age-session-${index}`,
              );
              const cwd = testPath(`age-workspace-${index}`);
              yield* repositories.createRepository({
                id: repositoryId,
                organizationId: testOrganizationId,
                url: "https://github.com/fixture/scoped.git",
                ref: "main",
              });
              yield* runs.create({
                sessionId,
                organizationId: testOrganizationId,
                issueId: Option.none(),
              });
              yield* runs.update(sessionId, {
                state: "orphaned",
                repositoryId: Option.some(repositoryId),
                workspacePath: Option.some(cwd),
                ompSessionFile: Option.some(join(cwd, "session.jsonl")),
              });
              yield* authority.processSession(sessionId);
              const environment = workerSpawnInputs[index]?.env;
              expect(environment).toBeDefined();
              if (index === 0) {
                const path = join(
                  cwd,
                  ".omp-home",
                  ".config",
                  "sops",
                  "age",
                  "keys.txt",
                );
                expect(environment?.FNOX_AGE_KEY_FILE).toBe(path);
                expect(
                  yield* Effect.promise(() => readFile(path, "utf8")),
                ).toBe("scoped-fixture-key");
                const metadata = yield* Effect.promise(() => stat(path));
                expect(metadata.mode & 0o777).toBe(0o400);
                expect(metadata.uid).toBe(process.getuid?.());
                yield* (yield* RunInputRepo).applyStop(sessionId);
                yield* authority.processSession(sessionId);
                yield* Effect.promise(async () => {
                  await expect(readFile(path)).rejects.toMatchObject({
                    code: "ENOENT",
                  });
                });
              } else
                expect(environment).not.toHaveProperty("FNOX_AGE_KEY_FILE");
              expect(JSON.stringify(workerSpawnInputs[index])).not.toContain(
                "scoped-fixture-key",
              );
              expect(JSON.stringify(workerSpawnInputs[index])).not.toContain(
                "foreign-org-key",
              );
            }
          }),
        {
          config: [
            [
              "WORKER_REPOSITORY_AGE_KEYS_JSON",
              JSON.stringify({
                [testOrganizationId]: { "bound-repo": "scoped-fixture-key" },
                "foreign-org": { "unbound-repo": "foreign-org-key" },
              }),
            ],
          ],
        },
      ),
  );
});
