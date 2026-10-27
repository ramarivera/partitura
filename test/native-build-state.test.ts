import {
  link,
  readFile,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  importLegacyNativeSlot,
  importNativeKnownHosts,
} from "../deploy/mac-build/native-build-import.js";
import { nativeFile } from "../src/services/native-build-file-io.js";
import {
  nativeLimits,
  openNativeBuildState,
} from "../src/services/native-build-state.js";
import { testAwait, testRejects } from "./fixtures/native-build-effects.js";
import {
  fixturePrivateKey,
  privateFixtureDirectory,
  registryFixture,
  registryJob,
} from "./fixtures/native-build-registry.js";
import {
  classifyNativeSsh,
  createNativeBuildTransport,
  renderNativeSsh,
  validateNativeTransport,
} from "./fixtures/native-build-transport.js";
import { testPaths } from "./fixtures/paths.js";

const path = testPaths();
it.live(
  "retains leased artifacts and unresolved obligations past retention, then prunes safe metadata",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("retention")));
        const safe = registryJob(fixture.generation, {
          state: "succeeded",
          updatedAt: 1,
        });
        const unsafe = registryJob(fixture.generation, {
          state: "failed",
          updatedAt: 1,
        });
        unsafe.recovery.state = "operator-required";
        unsafe.recovery.lastReason = "cleanup-required";
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(safe, unsafe);
          }),
        );
        const reservation = yield* testAwait(
          fixture.state.reserve(safe, "artifact.partial", 4),
        );
        yield* testAwait(writeFile(reservation.path, "test", { mode: 0o600 }));
        const target = join(fixture.state.jobPath(safe), "artifact.tar");
        yield* testAwait(reservation.commit(target));
        const release = fixture.state.retainFile(target);
        try {
          yield* testAwait(fixture.state.prune(nativeLimits.retention + 1000));
          expect(yield* testAwait(readFile(target, "utf8"))).toBe("test");
          release();
          yield* testAwait(fixture.state.prune(nativeLimits.retention + 1000));
          expect(() =>
            fixture.state.owned("org-a", "session-a", safe.jobId),
          ).toThrow("not-found");
          expect(
            fixture.state.owned("org-a", "session-a", unsafe.jobId).recovery
              .state,
          ).toBe("operator-required");
          expect(fixture.state.quarantined(fixture.metadata.hostId)).toBe(true);
        } finally {
          release();
          yield* testAwait(fixture.state.close());
        }
        const state = yield* testAwait(openNativeBuildState(fixture.options));
        yield* testAwait(state.close());
      }),
    ),
);

it.live(
  "rejects a 257th referenced generation without dropping ownership",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("capacity")));
        try {
          yield* testAwait(
            fixture.state.transaction((draft) => {
              for (let index = 0; index < 256; index++) {
                const generation =
                  index === 0
                    ? fixture.generation
                    : {
                        ...fixture.generation,
                        id: index.toString(16).padStart(32, "0"),
                        equalityTag: index.toString(16).padStart(64, "0"),
                      };
                if (index) draft.generations.push(generation);
                draft.jobs.push(
                  registryJob(generation, { sessionId: `session-${index}` }),
                );
              }
            }),
          );
          yield* testAwait(
            expect(
              testRejects(
                fixture.state.addGeneration(
                  "primary",
                  { ...fixture.metadata, port: 22 },
                  fixture.key,
                ),
              ),
            ).rejects.toThrow("generation-capacity"),
          );
          expect(fixture.state.snapshot().generations).toHaveLength(256);
          expect(fixture.state.snapshot().jobs).toHaveLength(256);
        } finally {
          yield* testAwait(fixture.state.close());
        }
      }),
    ),
);
it.live(
  "restores exact generations using current or retiring keys and saved destination/pins",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("restore")));
        const old = fixture.generation;
        const currentKey = yield* testAwait(
          fixturePrivateKey(join(fixture.root, "current-key")),
        );
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(registryJob(old));
          }),
        );
        const changed = { ...fixture.metadata, hostname: "new.example.test" };
        const newer = yield* testAwait(
          fixture.state.addGeneration("primary", changed, currentKey),
        );
        const oldJob = fixture.state.snapshot().jobs[0];
        if (!oldJob) throw new Error("missing-fixture-job");
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(registryJob(newer, { sessionId: "another" }));
          }),
        );
        const release = fixture.state.retainGeneration(newer.id);
        release();
        expect(
          (yield* testAwait(
            fixture.state.addGeneration("primary", changed, currentKey),
          )).id,
        ).toBe(newer.id);
        const matching = yield* testAwait(
          readFile(join(fixture.options.stateRoot, "metadata.json"), "utf8"),
        );
        expect(matching).not.toContain(fixture.key);
        expect(matching).not.toContain("PRIVATE KEY");
        expect(
          (yield* testAwait(
            stat(join(fixture.options.stateRoot, "matching.key")),
          )).mode & 0o777,
        ).toBe(0o400);
        yield* testAwait(fixture.state.close());
        const state = yield* testAwait(openNativeBuildState(fixture.options));
        try {
          const transport = yield* testAwait(
            createNativeBuildTransport(state, {
              suffix: "example.test",
              executable: fixture.executable,
            }),
          );
          expect(transport.hasCredential(old.id)).toBe(false);
          yield* testAwait(
            transport.restore(fixture.metadata.source, [
              currentKey,
              fixture.key,
            ]),
          );
          expect(transport.hasCredential(old.id)).toBe(true);
          expect(transport.hasCredential(newer.id)).toBe(true);
          expect(
            yield* testAwait(
              readFile(join(state.generationPath(old.id), "config"), "utf8"),
            ),
          ).toContain("HostName builder.example.test");
          expect(
            yield* testAwait(
              readFile(join(state.generationPath(newer.id), "config"), "utf8"),
            ),
          ).toContain("HostName new.example.test");
          expect(
            (yield* testAwait(
              state.addGeneration("primary", fixture.metadata, fixture.key),
            )).id,
          ).toBe(old.id);
          yield* testAwait(
            expect(
              testRejects(
                transport.restore(fixture.metadata.source, [
                  fixture.key,
                  fixture.key,
                  fixture.key,
                ]),
              ),
            ).rejects.toThrow("too-many"),
          );
        } finally {
          yield* testAwait(state.close());
        }
      }),
    ),
);

it.live(
  "keeps historical generations unavailable when keys are missing or do not exactly match",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("missing")));
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(registryJob(fixture.generation));
          }),
        );
        yield* testAwait(fixture.state.close());
        const state = yield* testAwait(openNativeBuildState(fixture.options));
        try {
          const transport = yield* testAwait(
            createNativeBuildTransport(state, {
              suffix: "example.test",
            }),
          );
          yield* testAwait(transport.restore(fixture.metadata.source, []));
          expect(transport.hasCredential(fixture.generation.id)).toBe(false);
          yield* testAwait(
            expect(
              testRejects(
                transport.materialize(
                  {
                    ...fixture.generation,
                    transport: { ...fixture.metadata, port: 22 },
                  },
                  fixture.key,
                ),
              ),
            ).rejects.toThrow("generation-mismatch"),
          );
        } finally {
          yield* testAwait(state.close());
        }
        yield* testAwait(
          unlink(join(fixture.options.stateRoot, "matching.key")),
        );
        yield* testAwait(
          expect(
            testRejects(openNativeBuildState(fixture.options)),
          ).rejects.toThrow("matching-key-missing"),
        );
      }),
    ),
);

it.live(
  "serializes per-builder/total quota races across generations and rebuilds partial-byte usage",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cap = 2 * nativeLimits.overhead + 100;
        const fixture = yield* testAwait(
          registryFixture(path("quotas"), {
            bytesPerBuilder: cap,
            bytesTotal: cap,
          }),
        );
        const job = registryJob(fixture.generation);
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(job);
          }),
        );
        const rotated = yield* testAwait(
          fixture.state.addGeneration(
            "primary",
            { ...fixture.metadata, port: 22 },
            fixture.key,
          ),
        );
        const other = registryJob(rotated, { sessionId: "other" });
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(other);
          }),
        );
        const results = yield* Effect.all(
          [
            fixture.state.reserve(job, "artifact.partial", 100),
            fixture.state.reserve(other, "artifact.partial", 100),
          ].map((operation) => Effect.exit(operation)),
          { concurrency: "unbounded" },
        );
        expect(
          results.filter((result) => result._tag === "Success"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result._tag === "Failure"),
        ).toHaveLength(1);
        const reservation = results.find((result) => result._tag === "Success");
        if (reservation?._tag !== "Success") throw new Error("no-reservation");
        yield* testAwait(
          writeFile(reservation.value.path, Buffer.alloc(100), {
            mode: 0o600,
          }),
        );
        // A retained partial remains charged when usage is reconstructed.
        yield* reservation.value.commit();
        yield* testAwait(fixture.state.close());
        const state = yield* testAwait(
          openNativeBuildState({
            ...fixture.options,
            bytesTotal: 100 + nativeLimits.overhead,
          }),
        );
        try {
          yield* testAwait(
            expect(
              testRejects(state.reserve(other, "artifact.partial", 1)),
            ).rejects.toThrow("scratch-quota-exceeded"),
          );
        } finally {
          yield* testAwait(state.close());
        }
      }),
    ),
);

it.live(
  "enforces the total quota across different builders and the free-space margin",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(
          registryFixture(path("total"), {
            bytesPerBuilder: 1e9,
            bytesTotal: 100 + nativeLimits.overhead,
          }),
        );
        const first = registryJob(fixture.generation);
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(first);
          }),
        );
        const gen = yield* testAwait(
          fixture.state.addGeneration(
            "backup",
            { ...fixture.metadata, source: "file:backup.json" },
            fixture.key,
          ),
        );
        const second = registryJob(gen);
        yield* testAwait(
          fixture.state.transaction((draft) => {
            draft.jobs.push(second);
          }),
        );
        const held = yield* testAwait(
          fixture.state.reserve(first, "artifact.partial", 100),
        );
        try {
          yield* testAwait(
            expect(
              testRejects(fixture.state.reserve(second, "artifact.partial", 1)),
            ).rejects.toThrow("quota"),
          );
        } finally {
          yield* testAwait(held.release());
          yield* testAwait(fixture.state.close());
        }
        const state = yield* testAwait(
          openNativeBuildState({
            ...fixture.options,
            filesystem: async () => ({ type: 0x01021994, bavail: 1, bsize: 1 }),
          }),
        );
        try {
          yield* testAwait(
            expect(
              testRejects(state.reserve(first, "artifact.partial", 1)),
            ).rejects.toThrow("quota"),
          );
        } finally {
          yield* testAwait(state.close());
        }
      }),
    ),
);

it.live(
  "rejects overlapping roots, unsafe links/modes, non-tmpfs cache and competing state owners",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("protected")));
        try {
          yield* testAwait(
            expect(
              testRejects(openNativeBuildState(fixture.options)),
            ).rejects.toThrow("locked"),
          );
          const file = join(fixture.root, "unsafe");
          yield* testAwait(writeFile(file, "safe", { mode: 0o600 }));
          yield* testAwait(link(file, `${file}-hardlink`));
          yield* testAwait(
            expect(testRejects(nativeFile(file, 0o600, 100))).rejects.toThrow(
              "unsafe",
            ),
          );
          yield* testAwait(symlink(file, `${file}-symlink`));
          yield* testAwait(
            expect(
              testRejects(nativeFile(`${file}-symlink`, 0o600, 100)),
            ).rejects.toThrow(),
          );
          yield* testAwait(
            expect(
              testRejects(
                openNativeBuildState({
                  ...fixture.options,
                  scratchRoot: fixture.options.stateRoot,
                }),
              ),
            ).rejects.toThrow("overlapping"),
          );
        } finally {
          yield* testAwait(fixture.state.close());
        }
        yield* testAwait(
          expect(
            testRejects(
              openNativeBuildState({
                ...fixture.options,
                filesystem: async () => ({ type: 1, bavail: 1e12, bsize: 1 }),
              }),
            ),
          ).rejects.toThrow("tmpfs"),
        );
      }),
    ),
);

it.live(
  "renders only pinned scalar SSH settings and classifies narrowly qualified denial",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("ssh")));
        try {
          const config = renderNativeSsh(
            fixture.metadata,
            fixture.state.generationPath(fixture.generation.id),
          );
          expect(config.knownHosts).toContain(
            "[builder.example.test]:2222 ssh-ed25519 ",
          );
          expect(config.config).not.toMatch(
            /^\s*(?:HostKeyAlias|Include|Match|ProxyCommand|LocalCommand) /mu,
          );
          expect(config.config).toContain("ServerAliveInterval 15");
          expect(config.config).toContain("IdentityAgent none");
          expect(
            renderNativeSsh({ ...fixture.metadata, port: 22 }, fixture.root)
              .knownHosts,
          ).toMatch(/^builder.example.test /u);
          expect(() =>
            validateNativeTransport(
              { ...fixture.metadata, hostname: "-oProxyCommand=x" },
              fixture.key,
              "example.test",
            ),
          ).toThrow();
          expect(() =>
            validateNativeTransport(
              { ...fixture.metadata, hostname: "badexample.test" },
              fixture.key,
              "example.test",
            ),
          ).toThrow();
          const denial =
            "OpenSSH_9.2p1 Debian-2\ndebug1: Host 'builder.example.test' is known and matches the ED25519 host key.\ndebug1: Authentications that can continue: publickey\ndebug1: No more authentication methods to try.\nbuilder@builder.example.test: Permission denied (publickey).\n";
          expect(classifyNativeSsh(denial, false)).toBe("needs-refresh");
          expect(classifyNativeSsh(denial, true)).toBe("unavailable");
          expect(
            classifyNativeSsh(denial.replace("9.2p1", "10.0p1"), false),
          ).toBe("unavailable");
          expect(
            classifyNativeSsh("Permission denied (publickey).\n", false),
          ).toBe("unavailable");
        } finally {
          yield* testAwait(fixture.state.close());
        }
      }),
    ),
);

it.live(
  "imports explicit legacy records offline, ignores SSH config and preserves originals",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* testAwait(registryFixture(path("import")));
        const legacy = yield* testAwait(
          privateFixtureDirectory(fixture.root, "legacy"),
        );
        const id = "f".repeat(32);
        const record = {
          job: id,
          sessionId: "legacy-session",
          commit: "e".repeat(40),
          action: "archive",
          state: "starting",
        };
        const original = JSON.stringify(record);
        yield* testAwait(
          writeFile(join(legacy, `${id}.json`), original, { mode: 0o600 }),
        );
        yield* testAwait(
          writeFile(
            join(legacy, "ssh_config"),
            "Include /secrets\nProxyCommand rm -rf /\n",
          ),
        );
        const input = {
          scratchRoot: legacy,
          privateKeyPath: fixture.keyPath,
          pins: fixture.metadata.hostKeys,
          builderId: "primary",
          source: fixture.metadata.source,
          hostId: fixture.metadata.hostId,
          hostname: fixture.metadata.hostname,
          sshUser: fixture.metadata.sshUser,
          port: fixture.metadata.port,
          suffix: "example.test",
          acknowledgeQuiesced: true as const,
          originalOwners: {
            [id]: {
              sessionId: "legacy-session",
              organizationId: "owner-org",
              pullRequest: 9,
            },
          },
          resolveOwner: async () => ({
            organizationId: "owner-org",
            pullRequest: 9,
          }),
        };
        try {
          const imported = yield* testAwait(
            importLegacyNativeSlot(fixture.state, fixture.transport, input),
          );
          expect(imported.importedJobs).toEqual([id]);
          expect(
            yield* testAwait(readFile(join(legacy, `${id}.json`), "utf8")),
          ).toBe(original);
          const job = fixture.state.owned("owner-org", "legacy-session", id);
          expect(job.state).toBe("submitting");
          expect(job.recovery.state).toBe("pending");
          expect(fixture.state.quarantined(fixture.metadata.hostId)).toBe(true);
          yield* testAwait(
            expect(
              testRejects(
                importLegacyNativeSlot(fixture.state, fixture.transport, {
                  ...input,
                  resolveOwner: async () => undefined,
                }),
              ),
            ).rejects.toThrow("owner-quarantined"),
          );
          yield* testAwait(
            expect(
              testRejects(
                importLegacyNativeSlot(fixture.state, fixture.transport, {
                  ...input,
                  scratchRoot: fixture.options.stateRoot,
                }),
              ),
            ).rejects.toThrow("overlapping"),
          );
          yield* testAwait(
            symlink(
              join(legacy, `${id}.json`),
              join(legacy, `${"a".repeat(32)}.json`),
            ),
          );
          const rejectedLink = yield* importLegacyNativeSlot(
            fixture.state,
            fixture.transport,
            input,
          ).pipe(Effect.flip);
          expect(rejectedLink).toMatchObject({
            _tag: "@Gateway/NativeOperationError",
            cause: { code: "ELOOP" },
          });
          expect(() =>
            importNativeKnownHosts(
              `@cert-authority * ssh-ed25519 abc\n`,
              fixture.metadata.hostname,
              22,
            ),
          ).toThrow();
          expect(() =>
            importNativeKnownHosts(
              `|1|hash ssh-ed25519 abc\n`,
              fixture.metadata.hostname,
              22,
            ),
          ).toThrow();
        } finally {
          yield* testAwait(fixture.state.close());
        }
      }),
    ),
);
