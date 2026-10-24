import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_SETTINGS,
  resolveRunSettings,
  validateAgentSettings,
} from "../src/services/agent-settings.js";

const base = validateAgentSettings({
  labelPrefixes: {
    driver: "driver:",
    model: "model:",
    effort: "effort:",
    mode: "mode:",
  },
  defaults: {
    driver: "omp",
    model: "safe",
    effort: "medium",
    mode: "approval-required",
  },
  modelAliases: {
    safe: {
      omp: "cliproxyapi/gpt-6-sol",
      t3: {
        instanceId: "cliproxy",
        model: "gpt-6-sol",
        options: [{ id: "effort", value: "high" }],
      },
    },
    t3only: { t3: { instanceId: "cliproxy", model: "claude-sonnet" } },
  },
  allowFullAccessViaLabel: true,
});

describe("per-run settings resolution", () => {
  it("resolves each setting by issue, project, admin, then environment precedence", () => {
    const result = resolveRunSettings({
      settings: base,
      issueLabels: ["model:safe", "effort:high"],
      projectLabels: ["driver:t3", "mode:auto"],
      environment: {
        driver: "omp",
        ompModel: "cliproxyapi/gpt-6-sol",
        t3Model: null,
        effort: null,
        mode: "auto",
      },
    });
    expect(result).toMatchObject({
      driver: "t3",
      modelAlias: "safe",
      t3Model: {
        instanceId: "cliproxy",
        model: "gpt-6-sol",
        options: [{ id: "effort", value: "high" }],
      },
      effort: "high",
      runtimeMode: "auto",
      sources: {
        driver: "project-label",
        model: "issue-label",
        effort: "issue-label",
        mode: "project-label",
      },
      warnings: [],
    });
  });

  it("warns and falls through on unknown and conflicting labels without last-label wins", () => {
    const result = resolveRunSettings({
      settings: base,
      issueLabels: ["driver:omp", "driver:t3", "model:unconfigured"],
      projectLabels: ["effort:banana", "mode:full-access"],
      environment: {
        driver: "t3",
        ompModel: "cliproxyapi/gpt-6-sol",
        t3Model: null,
        effort: null,
        mode: "approval-required",
      },
    });
    expect(result.driver).toBe("omp");
    expect(result.modelAlias).toBe("safe");
    expect(result.effort).toBe("medium");
    expect(result.runtimeMode).toBe("full-access");
    expect(result.sources).toMatchObject({
      driver: "admin-default",
      model: "admin-default",
      effort: "admin-default",
      mode: "project-label",
    });
    expect(result.warnings).toHaveLength(3);
  });

  it("rejects unsafe aliases and does not enable full-access labels when disabled", () => {
    expect(() =>
      validateAgentSettings({
        modelAliases: { arbitrary: { omp: "../../provider/model" } },
      }),
    ).toThrow();
    const settings = validateAgentSettings({
      ...base,
      allowFullAccessViaLabel: false,
    });
    const result = resolveRunSettings({
      settings,
      issueLabels: ["mode:full-access"],
      projectLabels: [],
      environment: {
        driver: "omp",
        ompModel: null,
        t3Model: null,
        effort: null,
        mode: "auto",
      },
    });
    expect(result.runtimeMode).toBe("approval-required");
    expect(result.sources.mode).toBe("admin-default");
    expect(result.warnings).toHaveLength(1);
  });

  it("falls through to a compatible model alias for the selected driver", () => {
    const result = resolveRunSettings({
      settings: base,
      issueLabels: ["model:t3only", "driver:omp"],
      projectLabels: ["model:safe", "driver:t3"],
      environment: {
        driver: "omp",
        ompModel: "cliproxyapi/environment-model",
        t3Model: null,
        effort: null,
        mode: "auto",
      },
    });
    expect(result.driver).toBe("omp");
    expect(result.modelAlias).toBe("safe");
    expect(result.ompModel).toBe("cliproxyapi/gpt-6-sol");
    expect(result.sources.model).toBe("project-label");
  });

  it("selects an organization model default for the effective driver", () => {
    const settings = validateAgentSettings({
      defaults: { ompModel: "safe", t3Model: "t3only" },
      modelAliases: base.modelAliases,
    });
    const result = resolveRunSettings({
      settings,
      issueLabels: ["driver:t3"],
      projectLabels: [],
      environment: {
        driver: "omp",
        ompModel: "cliproxyapi/environment-model",
        t3Model: null,
        effort: null,
        mode: "auto",
      },
    });
    expect(result.modelAlias).toBe("t3only");
    expect(result.t3Model?.model).toBe("claude-sonnet");
    expect(result.sources.model).toBe("admin-default");
  });
});

it("defaults label prefixes and full-access label authorization on", () => {
  expect(DEFAULT_AGENT_SETTINGS.allowFullAccessViaLabel).toBe(true);
  expect(DEFAULT_AGENT_SETTINGS.labelPrefixes.model).toBe("model:");
});
