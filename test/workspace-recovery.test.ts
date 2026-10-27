import { createHash } from "node:crypto";
import * as filesystem from "node:fs/promises";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, Logger, Result } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, vi } from "vitest";
import { acquireCloneLock } from "../src/services/clone-lock.js";
import {
  makeWorkspace,
  runGitOutput,
  safeSessionKey,
} from "../src/services/workspace.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

import {
  fixtureIo,
  gitFixture,
  MARKER_FILE,
  repositoryRecord,
  runGit,
} from "./workspace-test-helpers.js";

describe("Workspace recovery regressions", () => {
  it.live(
    "hydrates private repository blobs before credential-free checkout",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        yield* runGit(
          ["config", "uploadpack.allowFilter", "true"],
          fixture.source,
        );
        yield* runGit(["checkout", "-b", "requested-ref"], fixture.source);
        yield* fixtureIo("write requested snapshot", () =>
          writeFile(join(fixture.source, "README.txt"), "requested snapshot\n"),
        );
        yield* runGit(["commit", "-am", "requested snapshot"], fixture.source);
        yield* runGit(["checkout", "main"], fixture.source);
        // file:// uses upload-pack and honors partial-clone filtering. Ordinary
        // local-path clones copy all objects and conceal missing checkout blobs.
        yield* fixtureIo("configure filtering transport", () =>
          writeFile(
            join(fixture.root, "gitconfig"),
            `[url "file://${fixture.source}"]\n\tinsteadOf = ${fixture.url}\n`,
          ),
        );
        const nativeSpawn = Bun.spawn;
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(Bun, "spawn").mockImplementation((command, options) => {
              if (Array.isArray(command) && command.includes("checkout")) {
                expect(options?.env?.GIT_CONFIG_VALUE_0).toBeUndefined();
                // Model the private origin refusing access once the gateway's
                // ephemeral authentication is gone. Checkout must be offline.
                return nativeSpawn(
                  [
                    "git",
                    "-c",
                    "protocol.file.allow=never",
                    ...command.slice(1),
                  ],
                  options,
                );
              }
              return nativeSpawn(command, options);
            }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const workspace = yield* makeWorkspace({
          workspaceRoot: fixture.workspaceRoot,
          repo: { listRepositories: () => Effect.succeed([]) },
          githubApp: {
            getBotIdentity: () =>
              Effect.succeed({
                name: "fixture[bot]",
                email: "fixture@example.com",
              }),
            getInstallationToken: () => Effect.succeed("ghs_private_fixture"),
          },
        });
        const target = yield* workspace.materialize(
          "private-blobs",
          repositoryRecord({
            id: "private-blobs",
            url: fixture.url,
            ref: "requested-ref",
          }),
        );
        expect(
          yield* fixtureIo("read checked-out blob", () =>
            readFile(join(target, "README.txt"), "utf8"),
          ),
        ).toBe("requested snapshot\n");
      }),
  );

  it.live("retries cleanly when fetch fails after cloning", () =>
    Effect.gen(function* () {
      const fixture = yield* gitFixture;
      const workspace = yield* makeWorkspace({
        workspaceRoot: fixture.workspaceRoot,
        repo: { listRepositories: () => Effect.succeed([]) },
        githubApp: undefined,
      });
      const repository = repositoryRecord({
        id: "atomic-clone",
        url: fixture.url,
        ref: "missing-ref",
      });
      const result = yield* workspace
        .materialize("atomic-session", repository)
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.reason).toBe("git_failed");
      expect(
        yield* fixtureIo("list workspace root", () =>
          readdir(fixture.workspaceRoot),
        ),
      ).toEqual([".clone-locks"]);
      const target = yield* workspace.materialize("atomic-session", {
        ...repository,
        ref: "HEAD",
      });
      expect(
        yield* fixtureIo("read clone", () =>
          readFile(join(target, "README.txt"), "utf8"),
        ),
      ).toBe("fixture\n");
      expect(
        yield* fixtureIo("read marker", () =>
          readFile(join(target, MARKER_FILE), "utf8"),
        ),
      ).toContain("atomic-clone");
    }),
  );

  it.live(
    "preserves a marker-less checkout while creating its replacement",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        const target = join(
          fixture.workspaceRoot,
          safeSessionKey("partial-session"),
        );
        yield* fixtureIo("create partial clone", async () => {
          await mkdir(target, { recursive: true });
          await writeFile(join(target, "partial.txt"), "incomplete");
        });
        const workspace = yield* makeWorkspace({
          workspaceRoot: fixture.workspaceRoot,
          repo: { listRepositories: () => Effect.succeed([]) },
          githubApp: undefined,
        });
        expect(
          yield* workspace.materialize(
            "partial-session",
            repositoryRecord({
              id: "partial",
              url: fixture.url,
              ref: "HEAD",
            }),
          ),
        ).toBe(target);
        expect(
          yield* fixtureIo("read recovered clone", () => readdir(target)),
        ).not.toContain("partial.txt");
        const siblings = yield* fixtureIo("find preserved checkout", () =>
          readdir(fixture.workspaceRoot),
        );
        const stale = siblings.find((name) =>
          name.startsWith(`.stale-${safeSessionKey("partial-session")}-`),
        );
        if (stale === undefined) throw new Error("preserved workspace missing");
        expect(
          yield* fixtureIo("read preserved work", () =>
            readFile(join(fixture.workspaceRoot, stale, "partial.txt"), "utf8"),
          ),
        ).toBe("incomplete");
      }),
  );

  it.live(
    "reclaims unlocked clone instances and preserves a live gateway lock",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        const activeOwner = "a".repeat(32);
        const deadOwner = "b".repeat(32);
        const lock = yield* Effect.acquireRelease(
          fixtureIo("lock live clone", async () => {
            await mkdir(fixture.workspaceRoot, { recursive: true });
            const lock = await acquireCloneLock(
              fixture.workspaceRoot,
              activeOwner,
            );
            if (lock === undefined) throw new Error("Initial lock missing");
            return lock;
          }),
          (lock) => Effect.promise(() => lock.release()),
        );
        const prefix = `.${safeSessionKey("instances")}-clone-v2-`;
        const active = `${prefix}${activeOwner}-active`;
        const dead = `${prefix}${deadOwner}-dead00`;
        yield* fixtureIo("seed clone instances", async () => {
          for (const name of [active, dead])
            await mkdir(join(fixture.workspaceRoot, name));
        });
        const make = () =>
          makeWorkspace({
            workspaceRoot: fixture.workspaceRoot,
            repo: { listRepositories: () => Effect.succeed([]) },
            githubApp: undefined,
          });
        const repository = repositoryRecord({
          id: "instances",
          url: fixture.url,
          ref: "HEAD",
        });
        const first = yield* make();
        yield* first.materialize("first-instance", repository);
        const names = yield* fixtureIo("read preserved clone", () =>
          readdir(fixture.workspaceRoot),
        );
        expect(names).toContain(active);
        expect(names).not.toContain(dead);
        yield* Effect.promise(() => lock.release());
        const restarted = yield* make();
        yield* restarted.materialize("restart-instance", repository);
        expect(
          yield* fixtureIo("read recovered instance", () =>
            readdir(fixture.workspaceRoot),
          ),
        ).not.toContain(active);
      }),
  );

  it.live(
    "reclaims dead local clone owners and preserves live, foreign and legacy staging",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        const dead = Bun.spawn(["bun", "-e", "process.exit(0)"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        yield* Effect.promise(() => dead.exited);
        const host = createHash("sha256")
          .update(hostname())
          .digest("hex")
          .slice(0, 16);
        const prefix = `.${safeSessionKey("abandoned")}-clone-`;
        const abandoned = `${prefix}${host}-${dead.pid}-dead00`;
        const live = `${prefix}${host}-${process.pid}-active`;
        const foreign = `${prefix}${host === "0000000000000000" ? "1111111111111111" : "0000000000000000"}-${dead.pid}-remote`;
        const legacy = `${prefix}legacy`;
        yield* fixtureIo("seed staging", async () => {
          for (const name of [abandoned, live, foreign, legacy])
            await mkdir(join(fixture.workspaceRoot, name), { recursive: true });
        });
        const workspace = yield* makeWorkspace({
          workspaceRoot: fixture.workspaceRoot,
          repo: { listRepositories: () => Effect.succeed([]) },
          githubApp: undefined,
        });
        yield* workspace.materialize(
          "recovered",
          repositoryRecord({
            id: "recovered",
            url: fixture.url,
            ref: "HEAD",
          }),
        );
        const names = yield* fixtureIo("read staging", () =>
          readdir(fixture.workspaceRoot),
        );
        expect(names).not.toContain(abandoned);
        expect(names).toEqual(expect.arrayContaining([live, foreign, legacy]));
      }),
  );

  it.effect(
    "backs off a failed staging scan and retries after its deadline",
    () =>
      Effect.gen(function* () {
        const fixture = yield* gitFixture;
        const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        yield* Effect.promise(() => dead.exited);
        const host = createHash("sha256")
          .update(hostname())
          .digest("hex")
          .slice(0, 16);
        const abandoned = `.${safeSessionKey("scan-retry")}-clone-${host}-${dead.pid}-dead00`;
        yield* fixtureIo("seed abandoned clone", () =>
          mkdir(join(fixture.workspaceRoot, abandoned), { recursive: true }),
        );
        const workspace = yield* makeWorkspace({
          workspaceRoot: fixture.workspaceRoot,
          repo: { listRepositories: () => Effect.succeed([]) },
          githubApp: undefined,
        });
        const abandonedPath = join(fixture.workspaceRoot, abandoned);
        const originalRemove = vi.mocked(filesystem.rm).getMockImplementation();
        if (originalRemove === undefined)
          throw new Error("filesystem implementation missing");
        let attempts = 0;
        const removeSpy = yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(filesystem, "rm").mockImplementation((path, options) => {
              if (path === abandonedPath && ++attempts === 1)
                return Promise.reject(new Error("controlled cleanup denial"));
              return originalRemove(path, options);
            }),
          ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const messages: string[] = [];
        const logger = Logger.make((options) =>
          messages.push(String(options.message)),
        );
        const repository = repositoryRecord({
          id: "scan-retry",
          url: fixture.url,
          ref: "HEAD",
        });
        yield* Effect.gen(function* () {
          const path = yield* workspace.materialize("first", repository);
          expect(
            yield* fixtureIo("read workspace", () =>
              readFile(join(path, "README.txt"), "utf8"),
            ),
          ).toBe("fixture\n");
          expect(messages).toContain("workspace.staging_recovery_failed");
          expect(
            yield* fixtureIo("read staging", () =>
              readdir(fixture.workspaceRoot),
            ),
          ).toContain(abandoned);
        }).pipe(Effect.provide(Logger.layer([logger])));
        expect(attempts).toBe(1);
        yield* workspace.materialize("second", repository);
        expect(attempts).toBe(1);
        expect(removeSpy).toHaveBeenCalled();
        yield* TestClock.adjust(30_000);
        yield* workspace.materialize("third", repository);
        expect(attempts).toBe(2);
        expect(
          yield* fixtureIo("read staging", () =>
            readdir(fixture.workspaceRoot),
          ),
        ).not.toContain(abandoned);
      }),
  );

  it.live("bounds a hanging git subprocess and kills its process group", () =>
    Effect.gen(function* () {
      const fixture = yield* gitFixture;
      const pidFile = join(fixture.root, "descendant.pid");
      const result = yield* runGitOutput(
        [
          "-c",
          `alias.hang=!sleep 60 & child=$!; echo $child > '${pidFile}'; wait $child`,
          "hang",
        ],
        fixture.root,
        "git-timeout",
        300,
      ).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure.message).toContain("timed out after 300ms");
      const pid = Number(
        yield* fixtureIo("read descendant pid", () =>
          readFile(pidFile, "utf8"),
        ),
      );
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
      const gone = yield* fixtureIo("await descendant exit", async () => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
              return true;
            throw error;
          }
          await Bun.sleep(20);
        }
        return false;
      });
      expect(gone).toBe(true);
    }),
  );
});
