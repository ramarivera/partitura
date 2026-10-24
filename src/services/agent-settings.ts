import { Schema } from "effect";
import type { RuntimeMode } from "../drivers/driver.js";
import { RUNTIME_MODES } from "../drivers/driver.js";

export type DriverKind = "omp" | "t3";
export type SettingName = "driver" | "model" | "effort" | "mode";
export type SettingSource =
  | "issue-label"
  | "project-label"
  | "admin-default"
  | "environment";

export interface ModelAlias {
  readonly omp?: string;
  readonly t3?: {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<{
      readonly id: string;
      readonly value: string | boolean;
    }>;
  };
}

export interface AgentSettings {
  readonly labelPrefixes: Readonly<Record<SettingName, string>>;
  readonly defaults: {
    readonly driver?: DriverKind;
    readonly model?: string;
    readonly ompModel?: string;
    readonly t3Model?: string;
    readonly effort?: string;
    readonly mode?: RuntimeMode;
  };
  readonly modelAliases: Readonly<Record<string, ModelAlias>>;
  readonly allowFullAccessViaLabel: boolean;
}

export interface EffectiveRunSettings {
  readonly driver: DriverKind;
  readonly modelAlias: string | null;
  readonly ompModel: string | null;
  readonly t3Model: NonNullable<ModelAlias["t3"]> | null;
  readonly effort: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly sources: Readonly<Record<SettingName, SettingSource>>;
  readonly warnings: ReadonlyArray<string>;
}

export const SettingSourceSchema = Schema.Literals([
  "issue-label",
  "project-label",
  "admin-default",
  "environment",
]);
export const RunSettingsSourcesSchema = Schema.Struct({
  driver: SettingSourceSchema,
  model: SettingSourceSchema,
  effort: SettingSourceSchema,
  mode: SettingSourceSchema,
});
export const EffectiveRunSettingsSchema = Schema.Struct({
  driver: Schema.Literals(["omp", "t3"]),
  modelAlias: Schema.NullOr(Schema.String),
  ompModel: Schema.NullOr(Schema.String),
  t3Model: Schema.NullOr(
    Schema.Struct({
      instanceId: Schema.NonEmptyString,
      model: Schema.NonEmptyString,
      options: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            id: Schema.NonEmptyString,
            value: Schema.Union([Schema.String, Schema.Boolean]),
          }),
        ),
      ),
    }),
  ),
  effort: Schema.NullOr(Schema.String),
  runtimeMode: Schema.Literals(RUNTIME_MODES),
  sources: RunSettingsSourcesSchema,
  warnings: Schema.Array(Schema.String),
});

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  labelPrefixes: {
    driver: "driver:",
    model: "model:",
    effort: "effort:",
    mode: "mode:",
  },
  defaults: {},
  modelAliases: {},
  allowFullAccessViaLabel: true,
};

export const applyEffortToT3Selection = (
  selection: Omit<NonNullable<ModelAlias["t3"]>, "options"> & {
    readonly options?: NonNullable<ModelAlias["t3"]>["options"] | undefined;
  },
  effort: string | null,
): NonNullable<ModelAlias["t3"]> => {
  if (effort === null)
    return {
      instanceId: selection.instanceId,
      model: selection.model,
      ...(selection.options === undefined
        ? {}
        : { options: selection.options }),
    };
  const optionId =
    selection.instanceId === "claude-cliproxy" ? "effort" : "reasoningEffort";
  const options = (selection.options ?? []).filter(
    (option) => option.id !== "effort" && option.id !== "reasoningEffort",
  );
  return {
    ...selection,
    options: [...options, { id: optionId, value: effort }],
  };
};

const runtimeModes: ReadonlyArray<string> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
const efforts: ReadonlyArray<string> = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
const aliasPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const modelPattern = /^[A-Za-z0-9._+-]+\/[A-Za-z0-9._:+-]+$/u;
const t3OptionPattern = /^[A-Za-z0-9_-]{1,80}$/u;

export const validateAgentSettings = (input: unknown): AgentSettings => {
  if (!isRecord(input)) throw new Error("Settings must be an object");
  const prefixes = isRecord(input.labelPrefixes) ? input.labelPrefixes : {};
  const defaults = isRecord(input.defaults) ? input.defaults : {};
  const aliases = isRecord(input.modelAliases) ? input.modelAliases : {};
  const labelPrefixes = {} as Record<SettingName, string>;
  for (const key of ["driver", "model", "effort", "mode"] as const) {
    const value = prefixes[key] ?? DEFAULT_AGENT_SETTINGS.labelPrefixes[key];
    if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,20}:$/u.test(value))
      throw new Error(`Invalid ${key} label prefix`);
    labelPrefixes[key] = value;
  }
  if (new Set(Object.values(labelPrefixes)).size !== 4)
    throw new Error("Label prefixes must be unique");
  if (
    input.allowFullAccessViaLabel !== undefined &&
    typeof input.allowFullAccessViaLabel !== "boolean"
  )
    throw new Error("allowFullAccessViaLabel must be a boolean");
  const normalizedDefaults: AgentSettings["defaults"] = {};
  const mutableDefaults: {
    driver?: DriverKind;
    model?: string;
    ompModel?: string;
    t3Model?: string;
    effort?: string;
    mode?: RuntimeMode;
  } = {};
  if (defaults.driver !== undefined) {
    if (defaults.driver !== "omp" && defaults.driver !== "t3")
      throw new Error("Invalid default driver");
    mutableDefaults.driver = defaults.driver;
  }
  if (defaults.model !== undefined) {
    if (
      typeof defaults.model !== "string" ||
      !aliasPattern.test(defaults.model)
    )
      throw new Error("Default model must name a configured alias");
    mutableDefaults.model = defaults.model;
  }
  for (const key of ["ompModel", "t3Model"] as const) {
    const value = defaults[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !aliasPattern.test(value))
      throw new Error(`Default ${key} must name a configured alias`);
    mutableDefaults[key] = value;
  }
  if (defaults.effort !== undefined) {
    if (
      typeof defaults.effort !== "string" ||
      !efforts.includes(defaults.effort)
    )
      throw new Error("Invalid default effort");
    mutableDefaults.effort = defaults.effort;
  }
  if (defaults.mode !== undefined) {
    if (
      typeof defaults.mode !== "string" ||
      !runtimeModes.includes(defaults.mode)
    )
      throw new Error("Invalid default runtime mode");
    mutableDefaults.mode = defaults.mode as RuntimeMode;
  }
  Object.assign(normalizedDefaults, mutableDefaults);
  const modelAliases: Record<string, ModelAlias> = {};
  for (const [name, value] of Object.entries(aliases)) {
    if (!aliasPattern.test(name) || !isRecord(value))
      throw new Error(`Invalid model alias ${name}`);
    const entry: { omp?: string; t3?: NonNullable<ModelAlias["t3"]> } = {};
    if (value.omp !== undefined) {
      if (typeof value.omp !== "string" || !modelPattern.test(value.omp))
        throw new Error(`Invalid OMP model for alias ${name}`);
      entry.omp = value.omp;
    }
    if (value.t3 !== undefined) {
      const t3 = value.t3;
      if (
        !isRecord(t3) ||
        typeof t3.instanceId !== "string" ||
        !/^[A-Za-z0-9_-]{1,80}$/u.test(t3.instanceId) ||
        typeof t3.model !== "string" ||
        !/^[A-Za-z0-9._:+-]{1,160}$/u.test(t3.model)
      )
        throw new Error(`Invalid T3 model for alias ${name}`);
      let options: NonNullable<ModelAlias["t3"]>["options"];
      if (t3.options !== undefined) {
        if (!Array.isArray(t3.options) || t3.options.length > 32)
          throw new Error(`Invalid T3 options for alias ${name}`);
        options = t3.options.map((option) => {
          if (
            !isRecord(option) ||
            typeof option.id !== "string" ||
            !t3OptionPattern.test(option.id) ||
            !(
              typeof option.value === "boolean" ||
              (typeof option.value === "string" && option.value.length > 0)
            )
          )
            throw new Error(`Invalid T3 option for alias ${name}`);
          return { id: option.id, value: option.value };
        });
      }
      entry.t3 = {
        instanceId: t3.instanceId,
        model: t3.model,
        ...(options === undefined ? {} : { options }),
      };
    }
    if (entry.omp === undefined && entry.t3 === undefined)
      throw new Error(`Model alias ${name} has no supported driver model`);
    modelAliases[name] = entry;
  }
  if (
    [
      normalizedDefaults.model,
      normalizedDefaults.ompModel,
      normalizedDefaults.t3Model,
    ].some((name) => name !== undefined && modelAliases[name] === undefined)
  )
    throw new Error("Default model alias is not configured");
  return {
    labelPrefixes,
    defaults: normalizedDefaults,
    modelAliases,
    allowFullAccessViaLabel: input.allowFullAccessViaLabel !== false,
  };
};

export const resolveRunSettings = (input: {
  readonly settings: AgentSettings;
  readonly issueLabels: ReadonlyArray<string>;
  readonly projectLabels: ReadonlyArray<string>;
  readonly environment: {
    readonly driver: DriverKind;
    readonly ompModel: string | null;
    readonly t3Model: NonNullable<ModelAlias["t3"]> | null;
    readonly effort: string | null;
    readonly mode: RuntimeMode;
  };
}): EffectiveRunSettings => {
  const warnings: string[] = [];
  const values: Record<
    SettingName,
    { value: string | null; source: SettingSource }
  > = {
    driver: {
      value: input.settings.defaults.driver ?? input.environment.driver,
      source:
        input.settings.defaults.driver === undefined
          ? "environment"
          : "admin-default",
    },
    model: {
      value: input.settings.defaults.model ?? null,
      source:
        input.settings.defaults.model === undefined
          ? "environment"
          : "admin-default",
    },
    effort: {
      value: input.settings.defaults.effort ?? input.environment.effort,
      source:
        input.settings.defaults.effort === undefined
          ? "environment"
          : "admin-default",
    },
    mode: {
      value: input.settings.defaults.mode ?? input.environment.mode,
      source:
        input.settings.defaults.mode === undefined
          ? "environment"
          : "admin-default",
    },
  };
  for (const [labels, source] of [
    [input.projectLabels, "project-label"],
    [input.issueLabels, "issue-label"],
  ] as const) {
    for (const key of ["driver", "model", "effort", "mode"] as const) {
      const prefix = input.settings.labelPrefixes[key];
      const matches = [
        ...new Set(
          labels
            .filter((label) => label.startsWith(prefix))
            .map((label) => label.slice(prefix.length)),
        ),
      ];
      if (matches.length === 0) continue;
      if (matches.length > 1) {
        warnings.push(
          `Conflicting ${key} labels at ${source}; using the next settings tier.`,
        );
        continue;
      }
      const value = matches[0] ?? "";
      const valid =
        key === "driver"
          ? value === "omp" || value === "t3"
          : key === "model"
            ? input.settings.modelAliases[value] !== undefined
            : key === "effort"
              ? efforts.includes(value)
              : runtimeModes.includes(value) &&
                (value !== "full-access" ||
                  input.settings.allowFullAccessViaLabel);
      if (!valid) {
        warnings.push(
          `Unknown or disallowed ${key} label at ${source}; using the next settings tier.`,
        );
        continue;
      }
      values[key] = { value, source };
    }
  }
  const driver = values.driver.value === "t3" ? "t3" : "omp";
  const supportsDriver = (name: string | null): boolean => {
    if (name === null) return false;
    const candidate = input.settings.modelAliases[name];
    return (
      candidate !== undefined &&
      (driver === "omp"
        ? candidate.omp !== undefined
        : candidate.t3 !== undefined)
    );
  };
  const driverModelDefault =
    driver === "omp"
      ? input.settings.defaults.ompModel
      : input.settings.defaults.t3Model;
  let modelAlias =
    values.model.source === "issue-label" ||
    values.model.source === "project-label"
      ? values.model.value
      : (driverModelDefault ?? input.settings.defaults.model ?? null);
  let modelSource: SettingSource =
    values.model.source === "issue-label" ||
    values.model.source === "project-label"
      ? values.model.source
      : modelAlias === null
        ? "environment"
        : "admin-default";
  if (modelAlias !== null && !supportsDriver(modelAlias)) {
    warnings.push(
      `Model alias ${modelAlias} has no ${driver} configuration; using the next settings tier.`,
    );
    if (modelSource === "issue-label") {
      const projectModels = [
        ...new Set(
          input.projectLabels
            .filter((label) =>
              label.startsWith(input.settings.labelPrefixes.model),
            )
            .map((label) =>
              label.slice(input.settings.labelPrefixes.model.length),
            ),
        ),
      ];
      if (
        projectModels.length === 1 &&
        supportsDriver(projectModels[0] ?? null)
      ) {
        modelAlias = projectModels[0] ?? null;
        modelSource = "project-label";
      } else if (
        projectModels.length === 1 &&
        input.settings.modelAliases[projectModels[0] ?? ""] !== undefined
      ) {
        warnings.push(
          `Project model alias ${projectModels[0]} has no ${driver} configuration; using the next settings tier.`,
        );
      }
    }
    const adminModel = driverModelDefault ?? input.settings.defaults.model;
    if (
      !supportsDriver(modelAlias) &&
      adminModel !== undefined &&
      supportsDriver(adminModel)
    ) {
      modelAlias = adminModel;
      modelSource = "admin-default";
    } else if (!supportsDriver(modelAlias)) {
      modelAlias = null;
      modelSource = "environment";
    }
  }
  const alias =
    modelAlias === null ? undefined : input.settings.modelAliases[modelAlias];
  return {
    driver,
    modelAlias,
    ompModel:
      driver === "omp" ? (alias?.omp ?? input.environment.ompModel) : null,
    t3Model: driver === "t3" ? (alias?.t3 ?? input.environment.t3Model) : null,
    effort: values.effort.value,
    runtimeMode: values.mode.value as RuntimeMode,
    sources: {
      driver: values.driver.source,
      model: modelSource,
      effort: values.effort.source,
      mode: values.mode.source,
    },
    warnings,
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
