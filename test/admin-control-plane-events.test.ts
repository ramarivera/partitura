import { it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { describe, expect } from "vitest";
import { RunEventRepo, RunRepo } from "../src/services/store/repositories.js";
import {
  adminRequest,
  createSession,
  fetchApp,
  organizationId,
  PUBLIC_URL,
  sessionId,
  sourceKey,
  withApp,
} from "./admin-control-plane-helpers.js";

describe("admin run-event pagination", () => {
  const seed = (count: number) =>
    Effect.gen(function* () {
      const id = sessionId("pagination/run");
      const runs = yield* RunRepo;
      const events = yield* RunEventRepo;
      yield* runs.create({
        sessionId: id,
        organizationId: organizationId("org-pagination"),
        issueId: Option.none(),
        now: 1000,
      });
      const keys = Array.from(
        { length: count },
        (_, index) => `event:${String(index).padStart(4, "0")}:雪`,
      );
      // Insert in reverse order and share timestamps to exercise the tie-breaker.
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index];
        if (key === undefined) throw new Error("Missing event fixture");
        yield* events.upsert({
          sessionId: id,
          sourceKey: sourceKey(key),
          kind: "action",
          level: "info",
          now: 1000 + Math.floor(index / 5),
        });
      }
      const { token } = yield* createSession("org-pagination", Date.now());
      return { path: `/runs/${encodeURIComponent(id)}`, token, keys };
    });

  const detailSchema = Schema.Struct({
    sessionId: Schema.String,
    run: Schema.Struct({ sessionId: Schema.String }),
    events: Schema.Array(Schema.Struct({ sourceKey: Schema.String })),
  });
  const readDetail = (response: Response) =>
    Effect.promise(() => response.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(detailSchema)),
    );
  const nextPath = (response: Response): string | null => {
    const link = response.headers.get("link");
    if (link === null) return null;
    const match = /^<([^>]+)>; rel="next"$/u.exec(link);
    if (match?.[1] === undefined) throw new Error("Invalid continuation link");
    return match[1];
  };

  it.live("defaults to 100 events and preserves the JSON body shape", () =>
    withApp(
      Effect.gen(function* () {
        const { path, token, keys } = yield* seed(105);
        const response = yield* fetchApp(
          adminRequest(`${path}.json`, { token }),
        );
        expect(response.status).toBe(200);
        const body: unknown = yield* Effect.promise(() => response.json());
        expect(Object.keys(body as object).sort()).toEqual([
          "attempt",
          "events",
          "issue",
          "lastActivityAt",
          "run",
          "sessionId",
          "settings",
          "state",
        ]);
        const detail = yield* Schema.decodeUnknownEffect(detailSchema)(body);
        expect(detail.events.map((event) => event.sourceKey)).toEqual(
          keys.slice(0, 100),
        );
        const next = nextPath(response);
        expect(next).not.toBeNull();
        if (next === null) throw new Error("Missing default continuation");
        expect(new URL(next, PUBLIC_URL).searchParams.get("limit")).toBe("100");
        const tail = yield* fetchApp(adminRequest(next, { token }));
        expect(
          (yield* readDetail(tail)).events.map((event) => event.sourceKey),
        ).toEqual(keys.slice(100));
        expect(nextPath(tail)).toBeNull();
      }),
    ),
  );

  it.live(
    "accepts 1000 and rejects malformed or out-of-range limits with 400",
    () =>
      withApp(
        Effect.gen(function* () {
          const { path, token, keys } = yield* seed(1001);
          const response = yield* fetchApp(
            adminRequest(`${path}.json?limit=1000`, { token }),
          );
          expect(response.status).toBe(200);
          expect(
            (yield* readDetail(response)).events.map(
              (event) => event.sourceKey,
            ),
          ).toEqual(keys.slice(0, 1000));
          const next = nextPath(response);
          if (next === null)
            throw new Error("Missing maximum-limit continuation");
          const tail = yield* fetchApp(adminRequest(next, { token }));
          expect(
            (yield* readDetail(tail)).events.map((event) => event.sourceKey),
          ).toEqual(keys.slice(1000));
          expect(nextPath(tail)).toBeNull();
          for (const limit of [
            "1001",
            "0",
            "-1",
            "1.5",
            "NaN",
            "Infinity",
            "abc",
            "",
          ]) {
            const invalid = yield* fetchApp(
              adminRequest(`${path}.json?limit=${limit}`, { token }),
            );
            expect(invalid.status).toBe(400);
          }
        }),
      ),
  );

  it.live(
    "continues through every event exactly once in repository order",
    () =>
      withApp(
        Effect.gen(function* () {
          const { path, token, keys } = yield* seed(21);
          let next: string | null = `${path}.json?limit=7`;
          const seen: string[] = [];
          let pages = 0;
          while (next !== null) {
            if (++pages > 3) throw new Error("Pagination did not terminate");
            const response = yield* fetchApp(adminRequest(next, { token }));
            expect(response.status).toBe(200);
            const detail = yield* readDetail(response);
            expect(detail.events).toHaveLength(7);
            seen.push(...detail.events.map((event) => event.sourceKey));
            next = nextPath(response);
          }
          expect(pages).toBe(3);
          expect(seen).toEqual(keys);
          expect(new Set(seen).size).toBe(keys.length);
        }),
      ),
  );

  it.live("renders a usable HTML continuation and supports Accept JSON", () =>
    withApp(
      Effect.gen(function* () {
        const { path, token, keys } = yield* seed(2);
        const response = yield* fetchApp(
          adminRequest(`${path}?limit=1`, { token }),
        );
        expect(response.status).toBe(200);
        const next = nextPath(response);
        if (next === null) throw new Error("Missing HTML continuation");
        const markup = yield* Effect.promise(() => response.text());
        expect(markup).toContain(
          `<a rel="next" href="${next.replaceAll("&", "&amp;")}">Next events</a>`,
        );
        expect(markup).toContain(
          'window.location.pathname + ".json" + window.location.search',
        );
        const request = adminRequest(next, { token });
        request.headers.set("Accept", "application/json");
        const tail = yield* fetchApp(request);
        expect(tail.headers.get("content-type")).toContain("application/json");
        expect(
          (yield* readDetail(tail)).events.map((event) => event.sourceKey),
        ).toEqual(keys.slice(1));
        expect(nextPath(tail)).toBeNull();
        const finalHtml = yield* fetchApp(adminRequest(next, { token }));
        expect(yield* Effect.promise(() => finalHtml.text())).not.toContain(
          'rel="next"',
        );
      }),
    ),
  );

  it.live("keeps linked issue metadata on continuation pages", () =>
    withApp(
      Effect.gen(function* () {
        const { path, token } = yield* seed(3);
        const events = yield* RunEventRepo;
        yield* events.upsert({
          sessionId: sessionId("pagination/run"),
          sourceKey: sourceKey("event:0000:created"),
          kind: "created",
          level: "info",
          now: 999,
          payload: {
            agentSession: {
              issue: {
                identifier: "SYM-23",
                title: "Paginate run events",
                url: "https://linear.app/acme/issue/SYM-23",
              },
            },
          },
        });
        const issueSchema = Schema.Struct({
          issue: Schema.Struct({
            identifier: Schema.NullOr(Schema.String),
            title: Schema.NullOr(Schema.String),
            url: Schema.NullOr(Schema.String),
          }),
        });
        const expected = {
          identifier: "SYM-23",
          title: "Paginate run events",
          url: "https://linear.app/acme/issue/SYM-23",
        };
        let next: string | null = `${path}.json?limit=1`;
        let pages = 0;
        while (next !== null) {
          if (++pages > 4) throw new Error("Pagination did not terminate");
          const response = yield* fetchApp(adminRequest(next, { token }));
          const body: unknown = yield* Effect.promise(() => response.json());
          const detail = yield* Schema.decodeUnknownEffect(issueSchema)(body);
          expect(detail.issue).toEqual(expected);
          next = nextPath(response);
        }
        expect(pages).toBe(4);
      }),
    ),
  );

  it.live(
    "rejects malformed cursors with 400 and keeps authentication first",
    () =>
      withApp(
        Effect.gen(function* () {
          const { path, token } = yield* seed(0);
          const encode = (text: string) =>
            Buffer.from(text).toString("base64url");
          const cursors = [
            "",
            "%%%",
            "a",
            encode("not json"),
            encode("null"),
            encode("[]"),
            encode("{}"),
            encode('{"createdAt":"1000","sourceKey":"event"}'),
            encode('{"createdAt":1e400,"sourceKey":"event"}'),
            encode('{"createdAt":1000,"sourceKey":7}'),
          ];
          for (const cursor of cursors) {
            for (const suffix of ["", ".json"]) {
              const response = yield* fetchApp(
                adminRequest(
                  `${path}${suffix}?cursor=${encodeURIComponent(cursor)}`,
                  { token },
                ),
              );
              expect(response.status).toBe(400);
            }
          }
          expect(
            (yield* fetchApp(adminRequest(`${path}.json?cursor=%%%`))).status,
          ).toBe(401);
          expect(
            (yield* fetchApp(adminRequest(`${path}?limit=0`))).status,
          ).toBe(302);
          const empty = yield* fetchApp(
            adminRequest(`${path}.json`, { token }),
          );
          expect(empty.status).toBe(200);
          expect((yield* readDetail(empty)).events).toEqual([]);
          expect(nextPath(empty)).toBeNull();
        }),
      ),
  );
});
