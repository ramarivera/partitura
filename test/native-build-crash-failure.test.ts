import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { waitUntil } from "./fixtures/native-build-wait.js";
import { setup } from "./native-build-client-helpers.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const f = createAuthorityFixture();
it.live(
  "killed running broker exposes a fixed MCP status and artifact failure, then learns its final receipt",
  () =>
    Effect.gen(function* () {
      const native = yield* Effect.promise(() => setup());
      // Kill the fake SSH process after it consumed the bundle, like a session
      // disappearing mid-run. Nothing here contacts an SSH server or native host.
      yield* Effect.promise(async () => {
        const script = await readFile(native.config.sshExecutable, "utf8");
        await writeFile(
          native.config.sshExecutable,
          script.replace(
            "if(config.crashRun) process.exit(255);",
            'if(config.crashRun) process.kill(process.pid,"SIGKILL");',
          ),
        );
        await writeFile(
          native.configFile,
          JSON.stringify({ trace: native.trace, crashRun: true }),
        );
      });
      yield* f.withAuthority(
        () =>
          Effect.gen(function* () {
            yield* (yield* InstallationRepo).put(
              f.install(f.testOrganizationId),
            );
            const runs = yield* RunRepo;
            yield* runs.create({
              sessionId: f.testSessionId,
              organizationId: f.testOrganizationId,
              issueId: Option.some(f.testIssueId),
            });
            yield* runs.update(f.testSessionId, {
              state: "orphaned",
              workspacePath: Option.some(native.workspace),
              ompSessionFile: Option.some(
                join(native.workspace, "session.jsonl"),
              ),
            });
            yield* (yield* SessionAuthority).processSession(f.testSessionId);
            const listener = f.hostToolListener;
            if (!listener) throw new Error("Missing host tool listener");
            const call = (toolName: string, args: Record<string, unknown>) =>
              listener({
                id: toolName,
                toolCallId: toolName,
                toolName,
                arguments: args,
              });
            const start = yield* call("native_build_start", {
              commit: native.commit,
              pullRequest: 12,
              action: "archive",
            });
            const started = start.details as { job: string };
            expect(start.isError).not.toBe(true);
            yield* Effect.promise(() =>
              waitUntil(async () => {
                const record = JSON.parse(
                  await readFile(
                    join(native.config.scratchRoot, `${started.job}.json`),
                    "utf8",
                  ),
                );
                return record.state === "failed";
              }),
            );
            const barrier = join(native.workspace, "status-release");
            yield* Effect.promise(() =>
              writeFile(
                native.configFile,
                JSON.stringify({
                  trace: native.trace,
                  statusBarrier: barrier,
                  statusReceipt: {
                    commit: native.commit,
                    action: "archive",
                    state: "failed",
                    stage: "cleanup",
                    failureCode: "execution-interrupted",
                  },
                }),
              ),
            );
            const diagnostic = {
              failureCode: "execution-interrupted",
              message:
                "Native build execution was interrupted. The final broker outcome may still be pending.",
            };
            const status = yield* call("native_build_status", {
              job: started.job,
            });
            expect(status.details).toMatchObject({
              state: "failed",
              ...diagnostic,
            });
            const text = status.content[0]?.text;
            if (typeof text !== "string")
              throw new Error("Missing status text");
            expect(JSON.parse(text)).toMatchObject(diagnostic);
            const artifact = yield* call("native_build_artifact", {
              job: started.job,
            });
            expect(artifact.isError).toBe(true);
            expect(artifact.details).toEqual(diagnostic);
            expect(artifact.content[0]?.text).toBe(
              `Native build has no deliverable artifact: execution-interrupted. ${diagnostic.message}`,
            );
            // Synthetic presentation must not poison durable receipt lookup or cancel.
            const record = JSON.parse(
              yield* Effect.promise(() =>
                readFile(
                  join(native.config.scratchRoot, `${started.job}.json`),
                  "utf8",
                ),
              ),
            );
            expect(record.failureCode).toBeUndefined();
            yield* Effect.promise(() => writeFile(barrier, "release"));
            yield* Effect.promise(() =>
              waitUntil(
                async () =>
                  JSON.parse(
                    await readFile(
                      join(native.config.scratchRoot, `${started.job}.json`),
                      "utf8",
                    ),
                  ).failureCode === "execution-interrupted",
              ),
            );
            const confirmed = yield* call("native_build_status", {
              job: started.job,
            });
            expect(confirmed.details).toMatchObject({
              stage: "cleanup",
              ...diagnostic,
            });
            const canceled = yield* call("native_build_cancel", {
              job: started.job,
            });
            expect(canceled.details).toMatchObject({
              cancellationRequested: true,
            });
            expect(
              yield* Effect.promise(() => readFile(native.trace, "utf8")),
            ).toContain(`cancel ${started.job}`);
          }),
        {
          configOverride: (config) => ({
            ...config,
            nativeBuild: native.config,
          }),
        },
      );
    }),
);
