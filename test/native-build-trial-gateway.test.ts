import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { createNativeBuildClient } from "../src/services/native-build-client.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { waitUntil } from "./fixtures/native-build-wait.js";
import { observedStatusClient, setup } from "./native-build-client-helpers.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

for (const state of ["succeeded", "failed"] as const)
  it.live(
    `cancel preserves the real ${state} terminal state without sending a cancel`,
    () =>
      Effect.promise(async () => {
        const f = await setup();
        await mkdir(f.config.scratchRoot, { mode: 0o700 });
        const job = {
          job: "a".repeat(32),
          sessionId: "session-a",
          commit: f.commit,
          action: "archive",
          state,
          ...(state === "failed"
            ? {
                stage: "disk-preflight",
                failureCode: "host-disk-space-unavailable",
              }
            : {}),
        };
        await writeFile(
          join(f.config.scratchRoot, `${job.job}.json`),
          JSON.stringify(job),
          { mode: 0o600 },
        );
        const client = await createNativeBuildClient(f.config);
        try {
          expect(await client.cancel(job.sessionId, job.job)).toMatchObject({
            ...job,
            cancellationRequested: false,
          });
          expect(
            await readFile(f.trace, "utf8").catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return "";
                throw error;
              },
            ),
          ).toBe("");
        } finally {
          await client.close();
        }
      }),
  );

for (const invalid of [
  false,
  "foreign-job",
  "foreign-commit",
  "foreign-action",
  "inconsistent-diagnostic",
] as const)
  it.live(
    `status learns a reconciled crash failure on the original owned job: ${invalid}`,
    () =>
      Effect.promise(async () => {
        const f = await setup();
        await writeFile(
          f.configFile,
          JSON.stringify({ trace: f.trace, crashRun: true }),
        );
        const observed = await observedStatusClient(f.config);
        const { client } = observed;
        const barrier = join(f.workspace, "status-receipt");
        let jobId = "";
        try {
          const job = await client.start({
            sessionId: "session-a",
            workspacePath: f.workspace,
            commit: f.commit,
            pullRequest: 12,
            action: "archive",
          });
          jobId = job.job;
          await waitUntil(
            async () =>
              JSON.parse(
                await readFile(
                  join(f.config.scratchRoot, `${job.job}.json`),
                  "utf8",
                ),
              ).state === "failed",
          );
          await writeFile(
            f.configFile,
            JSON.stringify({
              trace: f.trace,
              statusBarrier: barrier,
              statusReceipt: {
                job: invalid === "foreign-job" ? "f".repeat(32) : job.job,
                commit:
                  invalid === "foreign-commit" ? "f".repeat(40) : job.commit,
                action: invalid === "foreign-action" ? "test" : job.action,
                state: "failed",
                stage:
                  invalid === "inconsistent-diagnostic" ? "boot" : "cleanup",
                failureCode: "execution-interrupted",
              },
            }),
          );
          const before = await readFile(
            join(f.config.scratchRoot, `${job.job}.json`),
            "utf8",
          );
          await client.status("session-a", job.job);
          await waitUntil(() => Bun.file(`${barrier}.entered`).exists());
          expect(observed.completed()).toBe(0);
          // Release the fake response only when we're joining its processing.
          await observed.settleStatus(job.job, () =>
            writeFile(barrier, "release"),
          );
          expect(observed.completed()).toBe(1);
          if (!invalid)
            await waitUntil(
              async () =>
                (await client.status("session-a", job.job)).failureCode !==
                undefined,
            );
          const status = await client.status("session-a", job.job);
          expect(status).toMatchObject({
            job: job.job,
            sessionId: "session-a",
            commit: job.commit,
            action: job.action,
            state: "failed",
          });
          if (invalid) {
            expect(status.failureCode).toBeUndefined();
            expect(
              await readFile(
                join(f.config.scratchRoot, `${job.job}.json`),
                "utf8",
              ),
            ).toBe(before);
          } else {
            expect(status).toMatchObject({
              stage: "cleanup",
              failureCode: "execution-interrupted",
            });
            expect(
              JSON.parse(
                await readFile(
                  join(f.config.scratchRoot, `${job.job}.json`),
                  "utf8",
                ),
              ),
            ).toMatchObject(status);
          }
        } finally {
          await writeFile(barrier, "release");
          await client.close();
        }
        if (!invalid) {
          const restarted = await createNativeBuildClient(f.config);
          try {
            expect(await restarted.status("session-a", jobId)).toMatchObject({
              failureCode: "execution-interrupted",
              stage: "cleanup",
            });
          } finally {
            await restarted.close();
          }
        }
      }),
  );

const authorityFixture = createAuthorityFixture();
for (const state of ["succeeded", "failed"] as const)
  it.live(`legacy cancel tool reports the existing ${state} receipt`, () => {
    const f = authorityFixture;
    const root = f.testPath("native-terminal");
    const scratchRoot = join(root, "jobs");
    const sshConfigFile = join(root, "ssh_config");
    const sshExecutable = join(root, "ssh");
    const job = "b".repeat(32);
    return f.withAuthority(
      () =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await chmod(root, 0o700);
            await mkdir(scratchRoot, { mode: 0o700 });
            await writeFile(sshConfigFile, "# dummy transport", {
              mode: 0o600,
            });
            // Success and pre-ownership refusal need no broker cleanup.
            await writeFile(sshExecutable, "#!/bin/sh\nexit 1\n", {
              mode: 0o700,
            });
            await writeFile(
              join(scratchRoot, `${job}.json`),
              JSON.stringify({
                job,
                sessionId: f.testSessionId,
                commit: "a".repeat(40),
                action: "test",
                state,
                ...(state === "failed"
                  ? {
                      stage: "disk-preflight",
                      failureCode: "host-disk-space-unavailable",
                    }
                  : {}),
              }),
              { mode: 0o600 },
            );
          });
          yield* (yield* InstallationRepo).put(f.install(f.testOrganizationId));
          const runs = yield* RunRepo;
          yield* runs.create({
            sessionId: f.testSessionId,
            organizationId: f.testOrganizationId,
            issueId: Option.some(f.testIssueId),
          });
          const workspace = f.testPath("native-workspace");
          yield* runs.update(f.testSessionId, {
            state: "orphaned",
            workspacePath: Option.some(workspace),
            ompSessionFile: Option.some(join(workspace, "session.jsonl")),
          });
          yield* (yield* SessionAuthority).processSession(f.testSessionId);
          const listener = f.hostToolListener;
          if (!listener) throw new Error("Missing host tool listener");
          const response = yield* listener({
            id: "cancel-terminal",
            toolCallId: "cancel-terminal",
            toolName: "native_build_cancel",
            arguments: { job },
          });
          expect(response.isError).not.toBe(true);
          expect(response.details).toMatchObject({
            job,
            builder: "primary",
            state,
            cancellationRequested: false,
            ...(state === "failed"
              ? { failureCode: "host-disk-space-unavailable" }
              : {}),
          });
        }),
      {
        configOverride: (config) => ({
          ...config,
          nativeBuild: { scratchRoot, sshConfigFile, sshExecutable },
        }),
      },
    );
  });
