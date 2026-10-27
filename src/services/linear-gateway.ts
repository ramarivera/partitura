import { Context, Effect, Layer } from "effect";
import { GatewayConfig } from "./config.js";
import { InstallationRepo, RunRepo } from "./store/repositories.js";

export type {
  LinearIssue,
  ListedSessionActivity,
} from "./linear-gateway-types.js";

import { makeLinearActivity } from "./linear-gateway-activity.js";
import { makeLinearCore } from "./linear-gateway-core.js";
import { makeLinearIssues } from "./linear-gateway-issues.js";
import { makeLinearMutations } from "./linear-gateway-mutations.js";
import { makeLinearWorkspace } from "./linear-gateway-workspace.js";

export class LinearGateway extends Context.Service<LinearGateway>()(
  "LinearGateway",
  {
    make: Effect.gen(function* () {
      const core = yield* makeLinearCore;
      const workspace = makeLinearWorkspace({ ...core });
      const activity = makeLinearActivity({ ...core, ...workspace });
      const issues = makeLinearIssues({ ...core, ...workspace, ...activity });
      const mutations = makeLinearMutations({
        ...core,
        ...workspace,
        ...activity,
        ...issues,
      });
      return {
        workspaceRead: workspace.workspaceRead,
        workspaceWrite: workspace.workspaceWrite,
        createActivity: activity.createActivity,
        listSessionActivities: activity.listSessionActivities,
        updateSession: activity.updateSession,
        teamStartedStates: issues.teamStartedStates,
        repositorySuggestions: issues.repositorySuggestions,
        getIssue: issues.getIssue,
        updateIssue: issues.updateIssue,
        addSessionExternalUrls: mutations.addSessionExternalUrls,
        createIssueComment: mutations.createIssueComment,
        refreshInstallation: mutations.refreshInstallation,
        createSessionOnIssue: mutations.createSessionOnIssue,
      };
    }),
  },
) {
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide([InstallationRepo.layer, RunRepo.layer, GatewayConfig.layer]),
  );
}
