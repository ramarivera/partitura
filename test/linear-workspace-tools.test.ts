import { describe, expect, it } from "vitest";
import {
  LINEAR_WORKSPACE_MUTATIONS,
  LINEAR_WORKSPACE_READS,
  prepareLinearWorkspaceRead,
  validateLinearWorkspaceMutationInput,
} from "../src/services/linear-workspace-tools.js";

describe("Linear workspace tools", () => {
  it("exposes only fixed read operations with bounded documented inputs", () => {
    expect(Object.keys(LINEAR_WORKSPACE_READS)).toEqual([
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
    ]);
    expect(
      prepareLinearWorkspaceRead("get_issue", { id: " issue-1 " }),
    ).toEqual({
      operation: "get_issue",
      document: LINEAR_WORKSPACE_READS.get_issue.document,
      variables: { id: "issue-1" },
    });
    expect(
      prepareLinearWorkspaceRead("list_issues", { first: 5 }).variables,
    ).toEqual({ first: 5 });
    expect(() =>
      prepareLinearWorkspaceRead("arbitrary", { query: "mutation { ... }" }),
    ).toThrow("operation is not an allowed Linear workspace read");
    expect(() =>
      prepareLinearWorkspaceRead("get_issue", { id: "issue-1", query: "..." }),
    ).toThrow("input field 'query' is not allowed");
    expect(() => prepareLinearWorkspaceRead("get_issue", {})).toThrow("id");
    expect(() =>
      prepareLinearWorkspaceRead("list_issues", { first: 51 }),
    ).toThrow("first must be an integer from 1 to 50");
    expect(() =>
      prepareLinearWorkspaceRead("search_issues", { term: "x".repeat(513) }),
    ).toThrow("term exceeds 512 characters");
  });

  it("validates only allowlisted create and update fields", () => {
    expect(
      validateLinearWorkspaceMutationInput("create_issue", undefined, {
        teamId: "team-1",
        title: "A task",
      }),
    ).toEqual({ input: { teamId: "team-1", title: "A task" } });
    expect(() =>
      validateLinearWorkspaceMutationInput("create_issue", undefined, {
        title: "missing team",
      }),
    ).toThrow("teamId");
    expect(() =>
      validateLinearWorkspaceMutationInput("update_issue", " ", {
        title: "invalid id",
      }),
    ).toThrow("id is required");
    expect(() =>
      validateLinearWorkspaceMutationInput("update_issue", "issue-1", {
        title: "A task",
        delete: true,
      }),
    ).toThrow("not allowed");
    expect(
      Object.keys(LINEAR_WORKSPACE_MUTATIONS).some((name) =>
        name.includes("delete"),
      ),
    ).toBe(false);
  });
});
