import { createContext, Script } from "node:vm";
import { expect, it } from "@effect/vitest";
import { renderAdminPage, renderNativeBuildersPage } from "../src/admin-ui.js";

it("fleet page escapes script context and renders dynamic fleet/evidence only as text", () => {
  const html = renderNativeBuildersPage(
    "</script><img src=x onerror=alert(1)>",
  );
  expect(html).not.toContain("</script><img");
  expect(html).toContain("\\u003c/script>");
  expect(html).not.toContain("innerHTML");
  expect(html).toContain("textContent");
  expect(html).toContain("document.createTextNode");
  const script = html.match(/<script>([\s\S]*)<\/script>/u)?.[1];
  if (!script) throw new Error("missing script");
  expect(() => new Script(script)).not.toThrow();
});
it("human controls use browser auth, explicit confirmation, closed bodies and no evidence URL fetch", () => {
  const html = renderNativeBuildersPage("csrf");
  for (const value of [
    "X-CSRF-Token",
    'credentials: "same-origin"',
    'cache: "no-store"',
    "window.confirm(warning)",
    "acknowledgeUnverifiedCleanup: true",
    "recoveryIds: chosen.map",
    "expectedHostId",
    "UNVERIFIED",
    "removed from service",
  ]) {
    expect(html).toContain(value);
  }
  expect(html).toContain("if (!window.confirm(warning)) return;");
  expect(html).not.toContain("fetch(evidence");
  expect(html).not.toContain("Authorization");
  expect(html).toContain("Refresh all");
  expect(html).toContain("Check cached health");
  expect(html).toContain("Still pending");
  expect(renderAdminPage(true)).toContain('href="/admin/native-builders"');
  expect(renderAdminPage(false)).not.toContain('href="/admin/native-builders"');
});

class FakeElement {
  textContent = "";
  hidden = false;
  href = "";
  onclick?: (event: { preventDefault: () => void }) => Promise<void>;
  siblings: FakeElement[] = [];
  after(element: FakeElement) {
    this.siblings.push(element);
  }
  replaceChildren() {}
}

function runFleetScript(
  fetch: (
    url: string,
  ) => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
) {
  const html = renderNativeBuildersPage("csrf");
  const source = html.match(/<script>([\s\S]*)<\/script>/u)?.[1];
  if (!source) throw new Error("missing script");
  const message = new FakeElement();
  const elements = new Map<string, FakeElement>([["message", message]]);
  const context = createContext({
    document: {
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, new FakeElement());
        return elements.get(id);
      },
      createElement: () => new FakeElement(),
    },
    fetch,
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
  });
  new Script(source).runInContext(context);
  const resume = message.siblings.find(
    (element) => element.textContent === "Resume progress",
  );
  const progress = (id: string) =>
    new Script(`progress("${id}")`).runInContext(context) as Promise<void>;
  return { message, resume, progress };
}

it("expired progress polling offers a working resume link for the same operation", async () => {
  let complete = false;
  const progressRequests: string[] = [];
  const { resume, progress } = runFleetScript(async (url) => {
    if (url.includes("/refreshes/")) progressRequests.push(url);
    return {
      ok: true,
      json: async () =>
        url.includes("/refreshes/") ? { done: complete } : { entries: [] },
    };
  });
  const id = "a".repeat(32);
  await progress(id);
  expect(resume).toBeDefined();
  expect(resume?.hidden).toBe(false);
  expect(resume?.href).toBe(`/api/admin/native-builders/refreshes/${id}`);
  expect(progressRequests).toHaveLength(120);
  complete = true;
  let prevented = false;
  expect(resume?.onclick).toBeTypeOf("function");
  await resume?.onclick?.({
    preventDefault: () => {
      prevented = true;
    },
  });
  expect(prevented).toBe(true);
  expect(progressRequests).toHaveLength(121);
  expect(resume?.hidden).toBe(true);
});

it("failed progress polling keeps the operation id and the resume link", async () => {
  let failing = true;
  const { message, resume, progress } = runFleetScript(async (url) => {
    if (!url.includes("/refreshes/"))
      return { ok: true, json: async () => ({ entries: [] }) };
    return {
      ok: !failing,
      json: async () =>
        failing ? { error: "gateway-unavailable" } : { done: true },
    };
  });
  const id = "b".repeat(32);
  await progress(id);
  const shown = JSON.parse(message.textContent);
  expect(shown.operationId).toBe(id);
  expect(shown.error).toBe("gateway-unavailable");
  expect(resume?.hidden).toBe(false);
  expect(resume?.href).toBe(`/api/admin/native-builders/refreshes/${id}`);
  failing = false;
  await resume?.onclick?.({ preventDefault: () => {} });
  expect(resume?.hidden).toBe(true);
});
