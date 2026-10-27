export interface ListedSessionActivity {
  readonly id: string;
  readonly type:
    | "thought"
    | "action"
    | "elicitation"
    | "response"
    | "error"
    | "prompt"
    | "unknown";
  readonly body: string | null;
  readonly title: string | null;
  readonly signal: "auth" | "continue" | "select" | "stop" | null;
  readonly createdAt: string;
}

export interface LinearIssue {
  readonly id: string;
  readonly identifier: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly stateId: string | null;
  readonly stateName: string | null;
  readonly stateType: string | null;
  readonly delegateId: string | null;
  readonly url: string | null;
  readonly teamId: string | null;
  readonly labels: ReadonlyArray<string>;
  readonly projectId: string | null;
  readonly projectLabels: ReadonlyArray<string>;
}
