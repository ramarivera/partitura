import type { RpcHostToolDefinition } from "./rpc-worker.js";

export const LINEAR_WORKSPACE_READ_TOOL: RpcHostToolDefinition = {
  name: "linear_workspace_read",
  label: "Linear: workspace read",
  description:
    "Read issues, projects, documents, teams, and issue labels visible to this Linear installation. Choose a fixed operation and provide only its documented inputs.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["operation", "input"],
    properties: {
      operation: {
        type: "string",
        enum: [
          "get_issue",
          "search_issues",
          "list_issues",
          "get_project",
          "search_projects",
          "list_projects",
          "get_document",
          "search_documents",
          "list_documents",
          "list_teams",
          "list_issue_labels",
        ],
      },
      input: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 256 },
          term: { type: "string", minLength: 1, maxLength: 512 },
          teamId: { type: "string", minLength: 1, maxLength: 256 },
          first: { type: "integer", minimum: 1, maximum: 50 },
          after: { type: "string", minLength: 1, maxLength: 512 },
        },
      },
    },
  },
};

/** Query names, arguments, and selected entity fields follow @linear/sdk 89.0.0. */
export const LINEAR_WORKSPACE_READS = {
  get_issue: {
    document:
      "query($id: String!) { issue(id: $id) { id identifier title description url priority estimate dueDate createdAt updatedAt team { id } state { id } assignee { id } delegate { id } project { id } cycle { id } labelIds } }",
    allowed: ["id"],
    required: ["id"],
    variables: (input: Record<string, string | number>) => ({
      id: input.id as string,
    }),
  },
  search_issues: {
    document:
      "query($term: String!, $teamId: String, $first: Int, $after: String) { searchIssues(term: $term, teamId: $teamId, first: $first, after: $after) { totalCount nodes { id identifier title description url priority dueDate labelIds team { id name key } state { id name type } } pageInfo { endCursor hasNextPage } } }",
    allowed: ["term", "teamId", "first", "after"],
    required: ["term"],
    variables: (input: Record<string, string | number>) => input,
  },
  list_issues: {
    document:
      "query($first: Int, $after: String) { issues(first: $first, after: $after) { totalCount nodes { id identifier title description url priority dueDate labelIds team { id name key } state { id name type } } pageInfo { endCursor hasNextPage } } }",
    allowed: ["first", "after"],
    required: [],
    variables: (input: Record<string, string | number>) => input,
  },
  get_project: {
    document:
      "query($id: String!) { project(id: $id) { id name description content url color icon priority startDate targetDate createdAt updatedAt state } }",
    allowed: ["id"],
    required: ["id"],
    variables: (input: Record<string, string | number>) => ({
      id: input.id as string,
    }),
  },
  search_projects: {
    document:
      "query($term: String!, $teamId: String, $first: Int, $after: String) { searchProjects(term: $term, teamId: $teamId, first: $first, after: $after) { totalCount nodes { id name description content url color icon priority startDate targetDate state } pageInfo { endCursor hasNextPage } } }",
    allowed: ["term", "teamId", "first", "after"],
    required: ["term"],
    variables: (input: Record<string, string | number>) => input,
  },
  list_projects: {
    document:
      "query($first: Int, $after: String) { projects(first: $first, after: $after) { totalCount nodes { id name description content url color icon priority startDate targetDate state } pageInfo { endCursor hasNextPage } } }",
    allowed: ["first", "after"],
    required: [],
    variables: (input: Record<string, string | number>) => input,
  },
  get_document: {
    document:
      "query($id: String!) { document(id: $id) { id title content url color icon createdAt updatedAt archivedAt } }",
    allowed: ["id"],
    required: ["id"],
    variables: (input: Record<string, string | number>) => ({
      id: input.id as string,
    }),
  },
  search_documents: {
    document:
      "query($term: String!, $teamId: String, $first: Int, $after: String) { searchDocuments(term: $term, teamId: $teamId, first: $first, after: $after) { totalCount nodes { id title content url color icon createdAt updatedAt archivedAt } pageInfo { endCursor hasNextPage } } }",
    allowed: ["term", "teamId", "first", "after"],
    required: ["term"],
    variables: (input: Record<string, string | number>) => input,
  },
  list_documents: {
    document:
      "query($first: Int, $after: String) { documents(first: $first, after: $after) { totalCount nodes { id title content url color icon createdAt updatedAt archivedAt } pageInfo { endCursor hasNextPage } } }",
    allowed: ["first", "after"],
    required: [],
    variables: (input: Record<string, string | number>) => input,
  },
  list_teams: {
    document:
      "query($first: Int, $after: String) { teams(first: $first, after: $after) { totalCount nodes { id name key description color createdAt updatedAt } pageInfo { endCursor hasNextPage } } }",
    allowed: ["first", "after"],
    required: [],
    variables: (input: Record<string, string | number>) => input,
  },
  list_issue_labels: {
    document:
      "query($first: Int, $after: String) { issueLabels(first: $first, after: $after) { totalCount nodes { id name color description createdAt updatedAt } pageInfo { endCursor hasNextPage } } }",
    allowed: ["first", "after"],
    required: [],
    variables: (input: Record<string, string | number>) => input,
  },
} as const;

export type LinearWorkspaceRead = keyof typeof LINEAR_WORKSPACE_READS;

export const prepareLinearWorkspaceRead = (
  operation: string,
  rawInput: unknown,
): {
  readonly operation: LinearWorkspaceRead;
  readonly document: string;
  readonly variables: Record<string, string | number>;
} => {
  if (!Object.hasOwn(LINEAR_WORKSPACE_READS, operation))
    throw new Error("operation is not an allowed Linear workspace read");
  if (
    typeof rawInput !== "object" ||
    rawInput === null ||
    Array.isArray(rawInput)
  )
    throw new Error("input must be an object");
  const definition = LINEAR_WORKSPACE_READS[operation as LinearWorkspaceRead];
  const input = rawInput as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!(definition.allowed as ReadonlyArray<string>).includes(key))
      throw new Error(`input field '${key}' is not allowed`);
  for (const key of definition.required)
    if (!Object.hasOwn(input, key))
      throw new Error(`input field '${key}' is required`);
  const variables: Record<string, string | number> = {};
  for (const key of definition.allowed) {
    const value = input[key];
    if (value === undefined) continue;
    if (key === "first") {
      if (
        !Number.isInteger(value) ||
        typeof value !== "number" ||
        value < 1 ||
        value > 50
      )
        throw new Error("first must be an integer from 1 to 50");
      variables[key] = value;
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0)
      throw new Error(`${key} must be a non-empty string`);
    const maxLength = key === "term" ? 512 : key === "after" ? 512 : 256;
    if (value.length > maxLength)
      throw new Error(`${key} exceeds ${maxLength} characters`);
    variables[key] = value.trim();
  }
  if (
    variables.first === undefined &&
    definition.allowed.includes("first" as never)
  )
    variables.first = 20;
  return {
    operation: operation as LinearWorkspaceRead,
    document: definition.document,
    variables: definition.variables(variables),
  };
};

export const LINEAR_WORKSPACE_MUTATIONS = {
  create_issue: {
    document:
      "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }",
    allowed: [
      "teamId",
      "title",
      "description",
      "assigneeId",
      "delegateId",
      "stateId",
      "projectId",
      "cycleId",
      "priority",
      "estimate",
      "dueDate",
      "parentId",
      "labelIds",
      "subscriberIds",
    ],
    required: ["teamId"],
  },
  update_issue: {
    document:
      "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title url } } }",
    allowed: [
      "title",
      "description",
      "assigneeId",
      "delegateId",
      "stateId",
      "projectId",
      "cycleId",
      "priority",
      "estimate",
      "dueDate",
      "parentId",
      "labelIds",
      "addedLabelIds",
      "subscriberIds",
    ],
    required: [],
  },
  create_comment: {
    document:
      "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body url } } }",
    allowed: ["issueId", "body", "parentId"],
    required: ["issueId", "body"],
  },
  create_project: {
    document:
      "mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name url } } }",
    allowed: [
      "name",
      "teamIds",
      "description",
      "content",
      "color",
      "icon",
      "leadId",
      "memberIds",
      "labelIds",
      "priority",
      "startDate",
      "targetDate",
      "statusId",
    ],
    required: ["name", "teamIds"],
  },
  update_project: {
    document:
      "mutation($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success project { id name url } } }",
    allowed: [
      "name",
      "teamIds",
      "description",
      "content",
      "color",
      "icon",
      "leadId",
      "memberIds",
      "labelIds",
      "priority",
      "startDate",
      "targetDate",
      "statusId",
    ],
    required: [],
  },
  create_project_update: {
    document:
      "mutation($input: ProjectUpdateCreateInput!) { projectUpdateCreate(input: $input) { success projectUpdate { id body health } } }",
    allowed: ["projectId", "body", "health", "url", "isUpdateForGroup"],
    required: ["projectId", "body"],
  },
  update_project_update: {
    document:
      "mutation($id: String!, $input: ProjectUpdateUpdateInput!) { projectUpdateUpdate(id: $id, input: $input) { success projectUpdate { id body health } } }",
    allowed: ["body", "health", "url"],
    required: [],
  },
  create_initiative: {
    document:
      "mutation($input: InitiativeCreateInput!) { initiativeCreate(input: $input) { success initiative { id name url } } }",
    allowed: [
      "name",
      "description",
      "content",
      "ownerId",
      "targetDate",
      "sortOrder",
    ],
    required: ["name"],
  },
  update_initiative: {
    document:
      "mutation($id: String!, $input: InitiativeUpdateInput!) { initiativeUpdate(id: $id, input: $input) { success initiative { id name url } } }",
    allowed: [
      "name",
      "description",
      "content",
      "ownerId",
      "targetDate",
      "sortOrder",
    ],
    required: [],
  },
  create_cycle: {
    document:
      "mutation($input: CycleCreateInput!) { cycleCreate(input: $input) { success cycle { id name startsAt endsAt } } }",
    allowed: ["teamId", "name", "startsAt", "endsAt", "description"],
    required: ["teamId", "name", "startsAt", "endsAt"],
  },
  update_cycle: {
    document:
      "mutation($id: String!, $input: CycleUpdateInput!) { cycleUpdate(id: $id, input: $input) { success cycle { id name startsAt endsAt } } }",
    allowed: ["name", "startsAt", "endsAt", "description"],
    required: [],
  },
  create_project_milestone: {
    document:
      "mutation($input: ProjectMilestoneCreateInput!) { projectMilestoneCreate(input: $input) { success projectMilestone { id name targetDate } } }",
    allowed: ["projectId", "name", "targetDate", "description", "sortOrder"],
    required: ["projectId", "name"],
  },
  update_project_milestone: {
    document:
      "mutation($id: String!, $input: ProjectMilestoneUpdateInput!) { projectMilestoneUpdate(id: $id, input: $input) { success projectMilestone { id name targetDate } } }",
    allowed: ["name", "targetDate", "description", "sortOrder"],
    required: [],
  },
  create_document: {
    document:
      "mutation($input: DocumentCreateInput!) { documentCreate(input: $input) { success document { id title url } } }",
    allowed: [
      "title",
      "content",
      "teamId",
      "issueId",
      "projectId",
      "initiativeId",
      "cycleId",
      "releaseId",
      "color",
      "icon",
      "subscriberIds",
    ],
    required: ["title"],
  },
  update_document: {
    document:
      "mutation($id: String!, $input: DocumentUpdateInput!) { documentUpdate(id: $id, input: $input) { success document { id title url } } }",
    allowed: [
      "title",
      "content",
      "teamId",
      "issueId",
      "projectId",
      "initiativeId",
      "cycleId",
      "releaseId",
      "color",
      "icon",
      "subscriberIds",
    ],
    required: [],
  },
  create_issue_label: {
    document:
      "mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name color } } }",
    allowed: ["name", "color", "description", "teamId"],
    required: ["name"],
  },
  update_issue_label: {
    document:
      "mutation($id: String!, $input: IssueLabelUpdateInput!) { issueLabelUpdate(id: $id, input: $input) { success issueLabel { id name color } } }",
    allowed: ["name", "color", "description"],
    required: [],
  },
} as const;

export type LinearWorkspaceMutation = keyof typeof LINEAR_WORKSPACE_MUTATIONS;

const describeMutationFields = () =>
  Object.entries(LINEAR_WORKSPACE_MUTATIONS)
    .map(([operation, definition]) => {
      const required = new Set<string>(definition.required);
      const fields = definition.allowed
        .map((field) => `${field}${required.has(field) ? " (required)" : ""}`)
        .join(", ");
      return `${operation}: ${fields}`;
    })
    .join("; ");

export const LINEAR_WORKSPACE_WRITE_TOOL: RpcHostToolDefinition = {
  name: "linear_workspace_write",
  label: "Linear: workspace write",
  description: `Create or update workspace issues, comments, projects, project updates, initiatives, cycles, milestones, documents, and issue labels. This tool has no delete, archive, or trash operations. Allowed and required input fields by operation: ${describeMutationFields()}.`,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["operation", "input"],
    properties: {
      operation: {
        type: "string",
        enum: Object.keys(LINEAR_WORKSPACE_MUTATIONS),
      },
      id: { type: "string", minLength: 1 },
      input: { type: "object", additionalProperties: true },
    },
  },
};

export const LINEAR_WORKSPACE_TOOLS = [
  LINEAR_WORKSPACE_READ_TOOL,
  LINEAR_WORKSPACE_WRITE_TOOL,
] as const;

export const validateLinearWorkspaceMutationInput = (
  operation: LinearWorkspaceMutation,
  id: unknown,
  input: unknown,
): { readonly id?: string; readonly input: Record<string, unknown> } => {
  const definition = LINEAR_WORKSPACE_MUTATIONS[operation];
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("input must be an object");
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!(definition.allowed as ReadonlyArray<string>).includes(key))
      throw new Error(`input field '${key}' is not allowed`);
  for (const key of definition.required)
    if (!Object.hasOwn(record, key) || record[key] === "")
      throw new Error(`input field '${key}' is required`);
  const needsId = operation.startsWith("update_");
  if (needsId && (typeof id !== "string" || id.trim().length === 0))
    throw new Error("id is required for update operations");
  if (!needsId && id !== undefined)
    throw new Error("id is only accepted for update operations");
  return {
    ...(needsId ? { id: (id as string).trim() } : {}),
    input: record,
  };
};
