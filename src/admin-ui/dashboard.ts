import { SCRIPT_FORMS } from "./dashboard-script-forms";
import { SCRIPT_LIFECYCLE } from "./dashboard-script-lifecycle";
import { SCRIPT_RENDERING } from "./dashboard-script-rendering";
import { SCRIPT_SETUP } from "./dashboard-script-setup";
/**
 * Static HTML body and inline client script for the authenticated admin SPA
 * served from GET /admin.
 *
 * The body markup exposes the documented landmarks and form structures the
 * client script hooks into (installation aside, routing rail, repositories
 * table, repository form, preview form, confirm dialog, toast). The client
 * script performs the bootstrap fetch, renders dynamic state into the DOM
 * via `textContent` / `setAttribute` and never interpolates API payloads
 * into innerHTML. All mutations use X-CSRF-Token, same-origin credentials,
 * and an application/json body. A 401 on any response bounces back to "/".
 */

import { THEME_CONTROLS } from "./theme";
export const ADMIN_BODY = `
<header class="admin-header" role="banner">
  <div class="title"><strong>Partitura</strong> &nbsp;↔&nbsp; Linear Control Plane</div>
  <div class="header-actions">
    ${THEME_CONTROLS}
    <span class="status-pill" id="header-status" data-state="loading" aria-live="polite">loading…</span>
    <button id="logout-btn" type="button" class="btn" hidden>Log out</button>
  </div>
</header>

<div class="admin-body">

  <aside class="installation" role="complementary" aria-labelledby="inst-heading">
    <h2 id="inst-heading">Installation</h2>
    <div id="installation-card">
      <p class="loading">Loading installation…</p>
    </div>
  </aside>

  <main class="console" role="main">

    <section class="rail-block" aria-labelledby="rail-heading">
      <div class="rail-header">
        <h2 id="rail-heading">Routing rail</h2>
        <span class="hint">explicit → issue-label → project-label → project → team → default</span>
      </div>
      <div class="rail">
        <div class="rail-track" id="rail-track">
          <div class="rail-segment" data-state="active" data-rail-segment="explicit">
            <div class="seg-title">01 · Explicit</div>
            <div class="seg-detail" data-rail-detail>—</div>
            <div class="seg-id" data-rail-id></div>
          </div>
          <div class="rail-segment" data-state="active" data-rail-segment="issue-label">
            <div class="seg-title">02 · Issue label</div>
            <div class="seg-detail" data-rail-detail>—</div>
            <div class="seg-id" data-rail-id></div>
          </div>
          <div class="rail-segment" data-state="active" data-rail-segment="project-label">
            <div class="seg-title">03 · Project label</div>
            <div class="seg-detail" data-rail-detail>—</div>
            <div class="seg-id" data-rail-id></div>
          </div>
          <div class="rail-segment" data-state="active" data-rail-segment="project">
            <div class="seg-title">04 · Project</div>
            <div class="seg-detail" data-rail-detail>—</div>
            <div class="seg-id" data-rail-id></div>
          </div>
          <div class="rail-segment" data-state="active" data-rail-segment="team">
            <div class="seg-title">05 · Team</div>
            <div class="seg-detail" data-rail-detail>—</div>
            <div class="seg-id" data-rail-id></div>
          </div>
          <div class="rail-segment" data-state="active" data-rail-segment="default">
            <div class="seg-title">06 · Default</div>
            <div class="seg-detail" data-rail-detail>—</div>
            <div class="seg-id" data-rail-id></div>
          </div>
        </div>
      </div>
    </section>

    <section class="panel" aria-labelledby="repos-heading">
      <div class="panel-header">
        <h2 id="repos-heading">Repositories</h2>
        <button id="new-repo-btn" type="button" class="btn">+ Add repository</button>
      </div>
      <div class="panel-body">
        <div id="repos-status" role="status" aria-live="polite"></div>
        <div id="repos-list" aria-busy="true"></div>
      </div>
    </section>

    <section class="panel" aria-labelledby="form-heading" id="repo-form-panel" hidden>
      <div class="panel-header">
        <h2 id="form-heading">Repository</h2>
        <button type="button" class="btn" id="form-cancel-btn" aria-label="Cancel">Cancel</button>
      </div>
      <div class="panel-body">
        <form id="repo-form" class="repo-form" novalidate>
          <div class="field">
            <label for="repo-id">Repository ID</label>
            <input id="repo-id" name="id" type="text" required autocomplete="off"
              placeholder="backend-api">
          </div>
          <div class="field">
            <label for="repo-url">Repository URL</label>
            <input id="repo-url" name="url" type="url" required autocomplete="off"
              placeholder="git@github.com:org/repo.git">
          </div>
          <div class="field">
            <label for="repo-ref">Default ref</label>
            <input id="repo-ref" name="ref" type="text" required autocomplete="off"
              placeholder="main">
          </div>
          <div class="field">
            <label for="repo-teams">Team IDs (comma-separated)</label>
            <input id="repo-teams" name="teamIds" type="text" autocomplete="off"
              placeholder="team-1, team-2">
          </div>
          <div class="field">
            <label for="repo-projects">Project IDs (comma-separated)</label>
            <input id="repo-projects" name="projectIds" type="text" autocomplete="off"
              placeholder="proj-a">
          </div>
          <div class="field full">
            <label for="repo-labels">Labels (comma-separated)</label>
            <input id="repo-labels" name="labels" type="text" autocomplete="off"
              placeholder="backend, urgent">
          </div>
          <div class="field full">
            <label for="repo-nix-packages">Nix packages (comma-separated)</label>
            <input id="repo-nix-packages" name="nixPackages" type="text" autocomplete="off"
              placeholder="git, nodejs_22">
            <span class="hint">Nixpkgs attribute paths only; packages are installed for this repository's agent sessions.</span>
          </div>
          <div class="field full">
            <div class="field-row">
              <label class="checkbox" for="repo-default">
                <input id="repo-default" name="isDefault" type="checkbox">
                Default repository (catch-all when nothing else matches)
              </label>
            </div>
          </div>
          <div id="repo-form-error" class="error" role="alert" hidden></div>
          <div class="form-actions">
            <button type="button" class="btn" id="repo-form-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary" id="repo-form-submit">Save repository</button>
          </div>
        </form>
      </div>
    </section>

    <section class="panel" aria-labelledby="mcp-heading">
      <div class="panel-header">
        <h2 id="mcp-heading">MCP servers</h2>
        <button id="new-mcp-btn" type="button" class="btn">+ Add MCP server</button>
      </div>
      <div class="panel-body">
        <div id="mcp-status" role="status" aria-live="polite"></div>
        <div id="mcp-list" aria-busy="true"></div>
        <form id="mcp-form" class="repo-form" novalidate hidden>
          <div class="field"><label for="mcp-id">Server ID</label><input id="mcp-id" name="id" required autocomplete="off" placeholder="github"></div>
          <div class="field"><label for="mcp-name">MCP name</label><input id="mcp-name" name="name" required autocomplete="off" placeholder="github"></div>
          <div class="field"><label for="mcp-transport">Transport</label><select id="mcp-transport" name="transport"><option value="stdio">stdio</option><option value="http">http</option><option value="sse">sse</option></select></div>
          <div class="field"><label for="mcp-command">Command</label><input id="mcp-command" name="command" autocomplete="off" placeholder="npx"></div>
          <div class="field"><label for="mcp-url">URL</label><input id="mcp-url" name="url" type="url" autocomplete="off" placeholder="https://mcp.example.com"></div>
          <div class="field"><label for="mcp-args">Arguments (JSON array or comma-separated)</label><input id="mcp-args" name="args" autocomplete="off"></div>
          <div class="field"><label for="mcp-oauth-client-id">OAuth client ID</label><input id="mcp-oauth-client-id" name="oauthClientId" autocomplete="off"></div>
          <div class="field"><label for="mcp-oauth-client-secret">OAuth client secret</label><input id="mcp-oauth-client-secret" name="oauthClientSecret" type="password" autocomplete="new-password" placeholder="•••"></div>
          <div class="field"><label for="mcp-oauth-scope">OAuth scope</label><input id="mcp-oauth-scope" name="oauthScope" autocomplete="off"></div>
          <div class="field"><label for="mcp-oauth-auth-method">OAuth token auth method</label><select id="mcp-oauth-auth-method" name="oauthTokenEndpointAuthMethod"><option value="">Default</option><option value="none">none</option><option value="client_secret_basic">client_secret_basic</option><option value="client_secret_post">client_secret_post</option></select></div>
          <div class="field"><label for="mcp-env">Environment (KEY=value per line)</label><textarea id="mcp-env" name="env" rows="3" autocomplete="off"></textarea><span class="hint">Secret values are write-only; existing values show as •••.</span></div>
          <div class="field full" id="mcp-headers-field" hidden>
            <label>Headers</label>
            <div id="mcp-headers-editor" class="key-value-editor"></div>
            <button type="button" class="btn" id="mcp-add-header">+ Add header</button>
            <span class="hint">Secret values are write-only; existing values show as •••.</span>
          </div>
          <div class="field"><label for="mcp-repository">Repository ID (blank = installation-wide)</label><input id="mcp-repository" name="repositoryId" autocomplete="off"></div>
          <div class="field"><label class="checkbox"><input id="mcp-enabled" name="enabled" type="checkbox" checked> Enabled</label></div>
          <div id="mcp-form-error" class="error" role="alert" hidden></div>
          <div class="form-actions"><button type="button" class="btn" id="mcp-cancel">Cancel</button><button type="submit" class="btn btn-primary" id="mcp-submit">Save MCP server</button></div>
        </form>
      </div>
    </section>
    <section class="panel" aria-labelledby="executor-heading">
      <div class="panel-header">
        <h2 id="executor-heading">Executor source</h2>
        <button id="executor-list-btn" type="button" class="btn">List Executor toolkits</button>
      </div>
      <div class="panel-body">
        <form id="executor-form" class="repo-form" novalidate>
          <div class="field"><label for="executor-endpoint">Executor endpoint</label><input id="executor-endpoint" name="endpoint" type="url" required placeholder="https://executor.example.com"></div>
          <div class="field"><label for="executor-token">Bearer token</label><input id="executor-token" name="token" type="password" autocomplete="new-password" placeholder="•••"></div>
          <div id="executor-form-error" class="error" role="alert" hidden></div>
          <div class="form-actions"><button type="submit" class="btn btn-primary">Save Executor</button><button id="executor-delete-btn" type="button" class="btn btn-danger">Remove</button></div>
        </form>
        <div id="executor-status" role="status" aria-live="polite"></div>
        <div id="executor-toolkit-list"></div>
      </div>
    </section>

    <section id="nix-cache-panel" class="panel" aria-labelledby="nix-cache-heading" hidden>
      <div class="panel-header">
        <h2 id="nix-cache-heading">Nix package cache</h2>
      </div>
      <div class="panel-body">
        <div id="nix-cache-status" role="status" aria-live="polite"></div>
        <div id="nix-cache-list" aria-busy="true"></div>
      </div>
    </section>

    <section class="panel" aria-labelledby="prompt-templates-heading">
      <div class="panel-header">
        <h2 id="prompt-templates-heading">Worker prompt templates</h2>
        <span class="hint">Changes apply to new inputs, including follow-ups in running sessions.</span>
      </div>
      <div class="panel-body">
        <div id="prompt-templates-status" role="status" aria-live="polite"></div>
        <div id="prompt-template-editors">
          <div class="field full"><label for="prompt-template-created">Created input</label><textarea id="prompt-template-created" rows="8" data-prompt-kind="created"></textarea></div>
          <div class="field full"><label for="prompt-template-prompted">Prompted input</label><textarea id="prompt-template-prompted" rows="4" data-prompt-kind="prompted"></textarea></div>
          <div class="field full"><label for="prompt-template-contract">Worker contract</label><textarea id="prompt-template-contract" rows="10" data-prompt-kind="contract"></textarea></div>
        </div>
        <div class="hint">Changes apply to new inputs, including follow-ups in running sessions. Created placeholders: <code>{{userRequest}}</code> <code>{{issueContext}}</code> <code>{{threadComment}}</code> <code>{{previousComments}}</code> <code>{{guidance}}</code>. Prompted placeholder: <code>{{userRequest}}</code>. Unknown placeholders remain literal.</div>
        <div class="field full"><label for="prompt-template-preview">Created preview (sample payload)</label><pre id="prompt-template-preview" aria-live="polite"></pre></div>
        <div class="field full"><label for="prompt-template-preview-prompted">Prompted preview (sample payload)</label><pre id="prompt-template-preview-prompted" aria-live="polite"></pre></div>
        <div class="field full"><label for="prompt-template-preview-contract">Contract preview</label><pre id="prompt-template-preview-contract" aria-live="polite"></pre></div>
        <div class="form-actions"><button type="button" class="btn btn-primary" id="prompt-templates-save" disabled>Save prompt templates</button></div>
      </div>
    </section>

    <section class="panel" aria-labelledby="agent-settings-heading">
      <div class="panel-header">
        <h2 id="agent-settings-heading">Run settings</h2>
        <span class="hint">Organization defaults apply to new runs. Each run keeps its settings snapshot across retries.</span>
      </div>
      <div class="panel-body">
        <div id="agent-settings-status" role="status" aria-live="polite"></div>
        <label class="checkbox" for="agent-settings-full-access"><input id="agent-settings-full-access" type="checkbox" checked> Allow full-access runtime mode from issue or project labels</label>
        <div class="field full"><label for="agent-settings-json">Defaults, label prefixes, and model aliases (JSON)</label><textarea id="agent-settings-json" rows="16" spellcheck="false" aria-describedby="agent-settings-help"></textarea>
          <span class="hint" id="agent-settings-help">Set <code>defaults.ompModel</code> and <code>defaults.t3Model</code> for driver-specific defaults, or <code>defaults.model</code> for a shared fallback. Aliases map to <code>omp</code> model IDs and/or a T3 <code>instanceId</code>, <code>model</code>, and typed options. Labels use driver:, model:, effort:, and mode: prefixes by default. Full-access labels are allowed by default.</span></div>
        <div class="form-actions"><button type="button" class="btn btn-primary" id="agent-settings-save">Save run settings</button></div>
      </div>
    </section>

    <section class="panel" aria-labelledby="preview-heading">
      <div class="panel-header">
        <h2 id="preview-heading">Route preview</h2>
        <span class="hint" style="font-family: var(--mono); font-size: 0.72rem; color: var(--ink-mute);">
          Simulate which repository a Linear event would resolve to.
        </span>
      </div>
      <div class="panel-body">
        <form id="preview-form" class="preview-form" novalidate>
          <div class="field">
            <label for="preview-repo">Explicit repository ID</label>
            <input id="preview-repo" name="repositoryId" type="text" autocomplete="off">
          </div>
          <div class="field">
            <label for="preview-team">Team ID</label>
            <input id="preview-team" name="teamId" type="text" autocomplete="off">
          </div>
          <div class="field">
            <label for="preview-project">Project ID</label>
            <input id="preview-project" name="projectId" type="text" autocomplete="off">
          </div>
          <div class="field">
            <label for="preview-issue-labels">Issue labels (comma-separated)</label>
            <input id="preview-issue-labels" name="issueLabels" type="text" autocomplete="off">
          </div>
          <div class="field">
            <label for="preview-project-labels">Project labels (comma-separated)</label>
            <input id="preview-project-labels" name="projectLabels" type="text" autocomplete="off">
          </div>
          <div class="field field-full">
            <button type="submit" class="btn">Resolve preview</button>
          </div>
        </form>
        <div id="preview-result" class="preview-result" role="status" aria-live="polite" data-state="idle"></div>
      </div>
    </section>

  </main>
</div>

<div id="toast" class="toast" role="status" aria-live="polite"></div>

<div id="confirm-modal" hidden role="dialog" aria-modal="true"
  aria-labelledby="confirm-title" aria-describedby="confirm-body">
  <div class="confirm-card">
    <h3 id="confirm-title">Confirm</h3>
    <p id="confirm-body">Are you sure?</p>
    <div class="confirm-actions">
      <button type="button" class="btn" id="confirm-no">Cancel</button>
      <button type="button" class="btn btn-danger" id="confirm-yes">Confirm</button>
    </div>
  </div>
</div>
`;

export const ADMIN_SCRIPT =
  SCRIPT_SETUP + SCRIPT_RENDERING + SCRIPT_FORMS + SCRIPT_LIFECYCLE;
