import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";
import { NixEnvironmentError } from "../src/domain/errors.js";
import { WorkspaceId } from "../src/domain/ids.js";
import { NixPackageName } from "../src/domain/models.js";
import {
  resolveDeviationExtensionPath,
  SessionAuthority,
} from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunRepo,
  WorkspaceRepo,
} from "../src/services/store/repositories.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  testPath,
  workerSpawnInputs,
  nixPreparedRepositories,
  withAuthority,
  testSessionId,
  testOrganizationId,
  install,
} = fixture;

describe("SessionAuthority Nix environment preparation", () => {
  it.live(
    "prepares repository dependencies before the first worker and its orphan retry",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          const workspaceRepo = yield* WorkspaceRepo;
          const repositoryId = Schema.decodeUnknownSync(WorkspaceId)(
            "nix-authority-repository",
          );
          yield* installationRepo.put(install(testOrganizationId));
          yield* workspaceRepo.createRepository({
            organizationId: testOrganizationId,
            id: repositoryId,
            url: "https://example.com/repository.git",
            ref: "main",
            nixPackages: [Schema.decodeUnknownSync(NixPackageName)("nodejs")],
          });
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            repositoryId: Option.some(repositoryId),
            workspacePath: Option.some(testPath("nix-authority")),
            ompSessionFile: Option.some(
              testPath("nix-authority/session.jsonl"),
            ),
          });
          fixture.nixPathEntries = ["/nix/store/test-node/bin"];

          yield* authority.processSession(testSessionId);
          expect(nixPreparedRepositories).toEqual([repositoryId]);
          expect(workerSpawnInputs).toHaveLength(1);
          expect(workerSpawnInputs[0]?.env?.PATH).toBe(
            `/nix/store/test-node/bin${process.env.PATH ? `:${process.env.PATH}` : ""}`,
          );
          expect(workerSpawnInputs[0]?.env?.HOME).toBe(process.env.HOME);
          expect(workerSpawnInputs[0]?.env).not.toHaveProperty("NIX_REMOTE");
          expect(workerSpawnInputs[0]?.env).not.toHaveProperty("NIX_CONFIG");
          expect(workerSpawnInputs[0]?.env).not.toHaveProperty("NIX_PATH");
          expect(workerSpawnInputs[0]?.env).not.toHaveProperty("NIX_PROFILES");
          expect(workerSpawnInputs[0]?.command).toContain("--extension");
          expect(workerSpawnInputs[0]?.command).toContain(
            resolveDeviationExtensionPath(),
          );

          yield* authority.shutdown();
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            ompSessionFile: Option.some(
              testPath("nix-authority/session.jsonl"),
            ),
          });
          yield* authority.processSession(testSessionId);
          expect(nixPreparedRepositories).toEqual([repositoryId, repositoryId]);
          expect(workerSpawnInputs).toHaveLength(2);
        }),
      ),
  );

  it.live(
    "seeds the worker profile and routes resumed workers through CLIProxyAPI",
    () => {
      const profile = testPath("worker-profile");
      const extension = testPath("extensions/pi-claude-cli.ts");
      return withAuthority(
        () =>
          Effect.gen(function* () {
            const authority = yield* SessionAuthority;
            const installationRepo = yield* InstallationRepo;
            const runRepo = yield* RunRepo;
            const workspaceRepo = yield* WorkspaceRepo;
            yield* Effect.promise(async () => {
              await chmod(profile, 0o755);
              await mkdir(join(profile, "skills", "effect"), {
                recursive: true,
                mode: 0o755,
              });
              await writeFile(
                join(profile, "skills", "effect", "SKILL.md"),
                "# Effect\n",
                { mode: 0o644 },
              );
              await writeFile(
                join(profile, "models.yml"),
                "providers:\n  cliproxyapi:\n    api: openai-responses\n    baseUrl: http://cliproxyapi:8317/v1\n    apiKey: CLIPROXYAPI_API_KEY\n    models:\n      - id: gpt-6-sol\n",
                { mode: 0o644 },
              );
              await writeFile(extension, "export default () => {};\n");
            });
            yield* installationRepo.put(install(testOrganizationId));
            yield* runRepo.create({
              sessionId: testSessionId,
              organizationId: testOrganizationId,
              issueId: Option.none(),
            });
            const workspace = testPath("profile-workspace");
            const repositoryId =
              Schema.decodeUnknownSync(WorkspaceId)("profile-repository");
            yield* workspaceRepo.createRepository({
              organizationId: testOrganizationId,
              id: repositoryId,
              url: "https://example.com/repository.git",
              ref: "main",
              nixPackages: [],
            });
            yield* runRepo.update(testSessionId, {
              state: "orphaned",
              repositoryId: Option.some(repositoryId),
              workspacePath: Option.some(workspace),
              ompSessionFile: Option.some(join(workspace, "session.jsonl")),
            });

            yield* authority.processSession(testSessionId);
            expect(workerSpawnInputs).toHaveLength(1);
            const input = workerSpawnInputs[0];
            expect(input?.command).toEqual(
              expect.arrayContaining(["--extension", extension]),
            );
            // A resumed omp session keeps its own model.
            expect(input?.command).not.toContain("--model");
            expect(input?.injectedEnv).toEqual({
              CLIPROXYAPI_BASE_URL: "http://cliproxyapi:8317",
              CLIPROXYAPI_API_KEY: "symphony-client-key",
              PI_CLAUDE_DRIVER: "cli",
              PI_CLAUDE_AUTH: "claude-login",
              PI_CLAUDE_EXECUTABLE: "claude-cliproxy",
            });
            expect(input?.env).not.toHaveProperty("CLIPROXYAPI_API_KEY");
            expect(input?.env?.PI_CODING_AGENT_DIR).toBe(
              join(workspace, ".omp-gateway"),
            );
            expect(
              yield* Effect.promise(() =>
                readFile(
                  join(
                    workspace,
                    ".omp-gateway",
                    "skills",
                    "effect",
                    "SKILL.md",
                  ),
                  "utf8",
                ),
              ),
            ).toBe("# Effect\n");
          }),
        {
          config: [
            ["CLIPROXYAPI_BASE_URL", "http://cliproxyapi:8317"],
            ["CLIPROXYAPI_API_KEY", "symphony-client-key"],
            ["WORKER_PROFILE_DIR", profile],
            ["WORKER_EXTENSION_PATHS", extension],
          ],
        },
      );
    },
    { timeout: 15_000 },
  );

  it.live(
    "keeps the inherited environment unchanged for an empty dependency result",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          const workspaceRepo = yield* WorkspaceRepo;
          const repositoryId = Schema.decodeUnknownSync(WorkspaceId)(
            "nix-empty-dependencies",
          );
          yield* installationRepo.put(install(testOrganizationId));
          yield* workspaceRepo.createRepository({
            organizationId: testOrganizationId,
            id: repositoryId,
            url: "https://example.com/empty.git",
            ref: "main",
            nixPackages: [],
          });
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            repositoryId: Option.some(repositoryId),
            workspacePath: Option.some(testPath("nix-empty")),
            ompSessionFile: Option.some(testPath("nix-empty/session.jsonl")),
          });

          yield* authority.processSession(testSessionId);
          expect(nixPreparedRepositories).toEqual([repositoryId]);
          expect(workerSpawnInputs).toHaveLength(1);
          expect(workerSpawnInputs[0]?.env?.PATH).toBe(process.env.PATH);
          expect(workerSpawnInputs[0]?.env?.HOME).toBe(process.env.HOME);
        }),
      ),
  );

  it.live(
    "records a typed preparation failure without spawning an RPC worker",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const installationRepo = yield* InstallationRepo;
          const runRepo = yield* RunRepo;
          const workspaceRepo = yield* WorkspaceRepo;
          const repositoryId = Schema.decodeUnknownSync(WorkspaceId)(
            "nix-failing-dependencies",
          );
          yield* installationRepo.put(install(testOrganizationId));
          yield* workspaceRepo.createRepository({
            organizationId: testOrganizationId,
            id: repositoryId,
            url: "https://example.com/failing.git",
            ref: "main",
            nixPackages: [Schema.decodeUnknownSync(NixPackageName)("nodejs")],
          });
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            repositoryId: Option.some(repositoryId),
            workspacePath: Option.some(testPath("nix-failing")),
            ompSessionFile: Option.some(testPath("nix-failing/session.jsonl")),
          });
          yield* Effect.promise(() =>
            mkdir(testPath("nix-failing"), { recursive: true }),
          );
          fixture.nixPrepareError = new NixEnvironmentError({
            message: "Nix preparation failed",
            reason: "process_failed",
          });

          const result = yield* Effect.result(
            authority.processSession(testSessionId),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("@Gateway/NixEnvironmentError");
          }
          expect(workerSpawnInputs).toHaveLength(0);
          const run = yield* runRepo.get(testSessionId);
          expect(Option.isSome(run)).toBe(true);
          if (Option.isSome(run)) {
            expect(run.value.state).toBe("orphaned");
            expect(run.value.terminalReason).toEqual(
              Option.some("Nix preparation failed"),
            );
          }
        }),
      ),
  );
});
