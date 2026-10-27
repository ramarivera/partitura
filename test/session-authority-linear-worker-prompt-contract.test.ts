import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import {
  deviationFromRpcEvent,
  linearWorkerPrompt,
  resolveDeviationExtensionPath,
} from "../src/services/session-authority.js";

describe("Linear worker prompt contract", () => {
  it("adds the Linear activity contract to a created session", () => {
    const prompt = linearWorkerPrompt("created", "Fix the webhook race");

    expect(prompt).toContain("Use OMP todos");
    expect(prompt).toContain("Linear agent plan");
    expect(prompt).toContain("Linear elicitations");
    expect(prompt).toContain("thought and action activities");
    expect(prompt).toContain("include relevant artifact URLs");
    expect(prompt).toContain("rromp_report_deviation");
    expect(prompt).toContain("cease work immediately");
    expect(prompt.endsWith("Linear task:\nFix the webhook race")).toBe(true);
  });

  it.each(["prompted", "stop"] as const)(
    "leaves %s input unchanged",
    (kind) => {
      expect(linearWorkerPrompt(kind, "Continue from here")).toBe(
        "Continue from here",
      );
    },
  );

  it("extracts only valid deviation tool calls", () => {
    expect(
      deviationFromRpcEvent({
        type: "tool_execution_start",
        toolName: "rromp_report_deviation",
        args: { deviation: "  Used a narrower migration scope.  " },
      }),
    ).toBe("Used a narrower migration scope.");
    expect(
      deviationFromRpcEvent({
        type: "tool_execution_start",
        toolName: "read",
        args: { deviation: "not a report" },
      }),
    ).toBeNull();
  });

  it("resolves the bundled deviation extension entrypoint", () => {
    expect(resolveDeviationExtensionPath()).not.toBeNull();
  });

  it("loads the image's bundled deviation extension for isolated workers", () => {
    for (const mode of ["firecracker", "sysbox"] as const) {
      expect(resolveDeviationExtensionPath(mode)).toBe(
        "/app/dist/extensions/report-deviation.js",
      );
    }
    expect(resolveDeviationExtensionPath("native")).toBe(
      fileURLToPath(
        new URL("../src/extensions/report-deviation.ts", import.meta.url),
      ),
    );
  });
});
