import type { RpcHostToolDefinition } from "./rpc-worker.js";
export const legacyNativeBuildTools = [
  {
    name: "native_build_start",
    label: "Native build: start",
    description:
      "Run the repository's .partitura/native-build.sh action in an isolated macOS VM for this commit and pull request. Select primary or the separately configured backup builder explicitly. No automatic failover. Use the same builder for later status, artifact and cancel calls.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["commit", "pullRequest", "action"],
      properties: {
        builder: { type: "string", enum: ["primary", "backup"] },
        commit: {
          type: "string",
          pattern: "^[a-f0-9]{40}$",
        },
        pullRequest: {
          type: "integer",
          minimum: 1,
          maximum: 99999999,
        },
        action: {
          type: "string",
          pattern: "^[a-z][a-z0-9-]{0,63}$",
        },
      },
    },
  },
  {
    name: "native_build_status",
    label: "Native build: status",
    description: "Read a native build job owned by this session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["job"],
      properties: {
        builder: { type: "string", enum: ["primary", "backup"] },
        job: { type: "string", pattern: "^[a-f0-9]{32}$" },
      },
    },
  },
  {
    name: "native_build_artifact",
    label: "Native build: deliver artifact",
    description:
      "Copy a verified native build archive into this session workspace. After a workflow-failed job, the archive holds the repository build log (build.log, last 1 MiB) and guest runner stderr (runner.log).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["job"],
      properties: {
        builder: { type: "string", enum: ["primary", "backup"] },
        job: { type: "string", pattern: "^[a-f0-9]{32}$" },
      },
    },
  },
  {
    name: "native_build_cancel",
    label: "Native build: cancel",
    description: "Cancel a native build job owned by this session.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["job"],
      properties: {
        builder: { type: "string", enum: ["primary", "backup"] },
        job: { type: "string", pattern: "^[a-f0-9]{32}$" },
      },
    },
  },
] satisfies ReadonlyArray<RpcHostToolDefinition>;

export const registryNativeBuildTools: ReadonlyArray<RpcHostToolDefinition> = [
  {
    name: "native_build_builders",
    label: "Native builders: availability",
    description:
      "List logical builder IDs and coarse availability. This list updates without restarting the worker.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  },
  ...legacyNativeBuildTools.map((tool) => ({
    ...tool,
    description:
      tool.name === "native_build_start"
        ? "Start one native job. An explicit builder never falls back. Omit it to use the declared ordered pre-admission selection. Once admitted, the job is never retried or moved. Follow-ups use the owned job ID; optional builder asserts its original binding."
        : tool.description,
    parameters: {
      ...tool.parameters,
      properties: {
        ...tool.parameters.properties,
        builder: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
      },
    },
  })),
];
