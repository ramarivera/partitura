import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import {
  InputId,
  McpServerId,
  SessionId,
  SourceKey,
  WorkspaceId,
} from "../src/domain/ids.js";
import { SessionAuthority } from "../src/services/session-authority.js";
import {
  InstallationRepo,
  McpServerRepo,
  ProjectionRepo,
  PromptTemplateRepo,
  RunEventRepo,
  RunInputRepo,
  RunRepo,
} from "../src/services/store/repositories.js";
import { TokenCrypto } from "../src/services/token-crypto.js";
import { tokenContext } from "../src/services/token-migration.js";
import { createAuthorityFixture } from "./session-authority-fixture.js";

const fixture = createAuthorityFixture();
const {
  testPath,
  projectorThoughts,
  workerPrompts,
  workerSpawnInputs,
  withAuthority,
  testSessionId,
  testOrganizationId,
  install,
} = fixture;

describe("SessionAuthority behavior invariants", () => {
  it.live(
    "persists independent retry notices for concurrent interrupted sessions",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const runs = yield* RunRepo;
          const inputs = yield* RunInputRepo;
          const projections = yield* ProjectionRepo;
          yield* InstallationRepo.use((repo) =>
            repo.put(install(testOrganizationId)),
          );
          for (const name of ["retry-session-a", "retry-session-b"]) {
            const sessionId = Schema.decodeUnknownSync(SessionId)(name);
            const inputId = Schema.decodeUnknownSync(InputId)(`${name}-prompt`);
            yield* runs.create({
              sessionId,
              organizationId: testOrganizationId,
              issueId: Option.none(),
            });
            yield* inputs.enqueue({
              id: inputId,
              sessionId,
              kind: "prompted",
              body: `Continue ${name}`,
              payload: {},
            });
            yield* inputs.markProcessed(inputId);
            const cwd = testPath(name);
            yield* Effect.promise(() => mkdir(cwd, { recursive: true }));
            yield* runs.update(sessionId, {
              state: "orphaned",
              workspacePath: Option.some(cwd),
            });
            yield* authority.processSession(sessionId);
            const thought = projectorThoughts.find(
              (item) =>
                item.sessionId === sessionId &&
                item.text.startsWith("Retrying"),
            );
            expect(thought).toBeDefined();
            if (thought === undefined) throw new Error("missing retry notice");
            // Persist the actual authority-produced key and payload through the
            // real outbox. Its global primary key must accept both sessions.
            yield* projections.enqueue({
              sourceKey: Schema.decodeUnknownSync(SourceKey)(thought.sourceKey),
              sessionId,
              activityType: "thought",
              payloadHash: name,
              payload: { sessionId, text: thought.text },
            });
          }
          expect(workerPrompts).toEqual([
            "Continue retry-session-a",
            "Continue retry-session-b",
          ]);
        }),
      ),
  );

  it.live("renders a prompted template when retrying an orphaned run", () =>
    withAuthority(() =>
      Effect.gen(function* () {
        const authority = yield* SessionAuthority;
        const installationRepo = yield* InstallationRepo;
        const runRepo = yield* RunRepo;
        const runInputRepo = yield* RunInputRepo;
        const templateRepo = yield* PromptTemplateRepo;
        yield* installationRepo.put(install(testOrganizationId));
        yield* templateRepo.upsert({
          organizationId: testOrganizationId,
          kind: "prompted",
          body: "Retry:\n{{userRequest}}",
          updatedAt: 0,
        });
        yield* runRepo.create({
          sessionId: testSessionId,
          organizationId: testOrganizationId,
          issueId: Option.none(),
        });
        const inputId = Schema.decodeUnknownSync(InputId)("orphan-retry-input");
        yield* runInputRepo.enqueue({
          id: inputId,
          sessionId: testSessionId,
          kind: "prompted",
          body: "continue after interruption",
          payload: {},
        });
        yield* runInputRepo.markProcessed(inputId);
        yield* Effect.promise(() =>
          mkdir(testPath("orphan-retry-template"), { recursive: true }),
        );
        yield* runRepo.update(testSessionId, {
          state: "orphaned",
          workspacePath: Option.some(testPath("orphan-retry-template")),
        });

        yield* authority.processSession(testSessionId);

        expect(workerSpawnInputs).toHaveLength(1);
        expect(workerPrompts).toEqual(["Retry:\ncontinue after interruption"]);
      }),
    ),
  );
  it.effect(
    "materializes configured MCP servers through the real authority layer",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const runRepo = yield* RunRepo;
          const installationRepo = yield* InstallationRepo;
          const mcpServerRepo = yield* McpServerRepo;
          const repositoryId = Schema.decodeUnknownSync(WorkspaceId)(
            "authority-mcp-repository",
          );
          const workspace = yield* Effect.promise(() =>
            mkdtemp(join(testPath("temporary"), "authority-mcp-config-")),
          );
          yield* installationRepo.put(install(testOrganizationId));
          yield* mcpServerRepo.createMcpServer({
            organizationId: testOrganizationId,
            id: Schema.decodeUnknownSync(McpServerId)("authority-mcp-server"),
            name: "configured",
            transport: "stdio",
            command: "node",
            args: ["server.js"],
            env: { TOKEN: "secret" },
            repositoryId: Option.some(repositoryId),
            now: 1,
          });
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            repositoryId: Option.some(repositoryId),
            workspacePath: Option.some(workspace),
            ompSessionFile: Option.some(join(workspace, "session.jsonl")),
          });
          yield* authority.processSession(testSessionId);
          const config = JSON.parse(
            yield* Effect.promise(() =>
              readFile(join(workspace, "mcp.json"), "utf8"),
            ),
          ) as { mcpServers: Record<string, { command: string }> };
          expect(config.mcpServers.configured?.command).toBe("node");
        }),
      ),
    { timeout: 15_000 },
  );
  it.effect(
    "deduplicates proxy renewal failures per session and server and revokes its bearer on shutdown",
    () =>
      withAuthority((db) =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const repo = yield* McpServerRepo;
          const cipher = yield* TokenCrypto;
          const sid = testSessionId;
          const org = testOrganizationId;
          const serverId =
            Schema.decodeUnknownSync(McpServerId)("proxy-events");
          const url = "https://mcp.example/server";
          const workspace = testPath("proxy-workspace");
          yield* InstallationRepo.use((service) => service.put(install(org)));
          yield* repo.createMcpServer({
            organizationId: org,
            id: serverId,
            name: "renewal-test",
            transport: "http",
            url,
            now: 1,
          });
          const encrypt = (field: string, value: string) =>
            cipher.encrypt(
              value,
              tokenContext("mcp_oauth_credential", org, serverId, field),
            );
          const client = yield* encrypt(
            "client_json",
            JSON.stringify({
              clientId: "client",
              clientSecret: "gateway-client-secret",
              authorizationEndpoint: "https://mcp.example/authorize",
              tokenEndpoint: "https://mcp.example/token",
            }),
          );
          const access = yield* encrypt(
            "access_token",
            "gateway-access-secret",
          );
          // Missing refresh material fails locally without an external request.
          db.query(
            "INSERT INTO mcp_oauth_credential (organization_id, server_id, server_url, client_json, access_token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            org,
            serverId,
            url,
            `mcpenc:v1:${client}`,
            `mcpenc:v1:${access}`,
            0,
            1,
            1,
          );
          yield* RunRepo.use((service) =>
            service.create({
              sessionId: sid,
              organizationId: org,
              issueId: Option.none(),
            }),
          );
          yield* RunRepo.use((service) =>
            service.update(sid, {
              state: "orphaned",
              workspacePath: Option.some(workspace),
              ompSessionFile: Option.some(join(workspace, "session.jsonl")),
            }),
          );
          yield* authority.processSession(sid);
          const contents = yield* Effect.promise(() =>
            readFile(join(workspace, "mcp.json"), "utf8"),
          );
          const config = JSON.parse(contents) as {
            mcpServers: Record<
              string,
              { url: string; headers: Record<string, string> }
            >;
          };
          const server = config.mcpServers["renewal-test"];
          if (server === undefined)
            throw new Error("Expected gateway MCP proxy configuration");
          expect(contents).not.toContain("gateway-access-secret");
          expect(contents).not.toContain("gateway-client-secret");
          expect(JSON.stringify(workerSpawnInputs)).not.toContain(
            "gateway-access-secret",
          );
          const response = yield* Effect.promise(() =>
            fetch(server.url, {
              method: "POST",
              headers: server.headers,
              body: "{}",
            }),
          );
          expect(response.status).toBe(502);
          const retries = yield* Effect.promise(() =>
            Promise.all(
              Array.from({ length: 12 }, () =>
                fetch(server.url, {
                  method: "POST",
                  headers: server.headers,
                  body: "{}",
                }),
              ),
            ),
          );
          expect(retries.map((retry) => retry.status)).toEqual(
            Array(12).fill(502),
          );
          const events = yield* RunEventRepo.use((service) =>
            service.list(sid),
          );
          expect(
            events.filter((event) => event.kind === "mcp_refresh_failed"),
          ).toHaveLength(1);
          expect(
            events.find((event) => event.kind === "mcp_refresh_failed"),
          ).toMatchObject({
            sourceKey: `mcp-refresh:${sid}:${serverId}`,
            level: "error",
            text: Option.some(
              "MCP credential renewal failed for renewal-test. Reconnect this server in the gateway and retry the tool call.",
            ),
            payload: { serverId },
          });
          expect(JSON.stringify(events)).not.toContain("gateway-client-secret");
          yield* authority.shutdown();
          yield* Effect.promise(() =>
            expect(
              fetch(server.url, { headers: server.headers }),
            ).rejects.toThrow(),
          );
        }),
      ),
  );
  it.effect(
    "routes MCP decrypt failures through retry handling",
    () =>
      withAuthority((db) =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const runRepo = yield* RunRepo;
          const installationRepo = yield* InstallationRepo;
          const mcpServerRepo = yield* McpServerRepo;
          const workspace = yield* Effect.promise(() =>
            mkdtemp(join(testPath("temporary"), "authority-mcp-corrupt-")),
          );
          yield* installationRepo.put(install(testOrganizationId));
          yield* mcpServerRepo.createMcpServer({
            organizationId: testOrganizationId,
            id: Schema.decodeUnknownSync(McpServerId)("corrupt-mcp-server"),
            name: "corrupt",
            transport: "stdio",
            command: "node",
            args: [],
            env: { TOKEN: "secret" },
            repositoryId: Option.none(),
            now: 1,
          });
          db.query(
            "UPDATE mcp_server SET env_json=? WHERE organization_id=? AND id=?",
          ).run(
            JSON.stringify({ TOKEN: "mcpenc:v1:not-valid-ciphertext" }),
            testOrganizationId,
            "corrupt-mcp-server",
          );
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            workspacePath: Option.some(workspace),
            ompSessionFile: Option.some(join(workspace, "session.jsonl")),
          });
          yield* Effect.result(authority.processSession(testSessionId));
          const updated = yield* runRepo.get(testSessionId);
          expect(Option.isSome(updated)).toBe(true);
          if (Option.isSome(updated)) {
            expect(updated.value.state).toBe("orphaned");
            expect(updated.value.desiredState).toBe("running");
            expect(Option.isSome(updated.value.nextAttemptAt)).toBe(true);
            expect(updated.value.terminalReason).not.toEqual(Option.none());
          }
          expect(workerSpawnInputs).toHaveLength(0);
        }),
      ),
    { timeout: 15_000 },
  );

  it.effect(
    "materializes an empty MCP config when no servers exist",
    () =>
      withAuthority(() =>
        Effect.gen(function* () {
          const authority = yield* SessionAuthority;
          const runRepo = yield* RunRepo;
          const installationRepo = yield* InstallationRepo;
          const workspace = yield* Effect.promise(() =>
            mkdtemp(join(testPath("temporary"), "authority-mcp-empty-")),
          );
          yield* installationRepo.put(install(testOrganizationId));
          yield* runRepo.create({
            sessionId: testSessionId,
            organizationId: testOrganizationId,
            issueId: Option.none(),
          });
          yield* runRepo.update(testSessionId, {
            state: "orphaned",
            workspacePath: Option.some(workspace),
            ompSessionFile: Option.some(join(workspace, "session.jsonl")),
          });
          yield* authority.processSession(testSessionId);
          expect(
            JSON.parse(
              yield* Effect.promise(() =>
                readFile(join(workspace, "mcp.json"), "utf8"),
              ),
            ),
          ).toEqual({ mcpServers: {} });
        }),
      ),
    { timeout: 15_000 },
  );
});
