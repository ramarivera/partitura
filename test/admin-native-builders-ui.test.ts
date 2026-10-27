import { Script } from "node:vm";
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
