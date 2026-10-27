export const SCRIPT_SETUP = `
(function () {
  "use strict";

  var BOOTSTRAP_URL = "/api/admin/bootstrap";
  var REPOSITORIES_BASE = "/api/admin/repositories";
  var REPOSITORY_DETAIL = function (id) { return REPOSITORIES_BASE + "/" + encodeURIComponent(id); };
  var PREVIEW_URL = "/api/admin/preview";
  var NIX_CACHE_URL = "/api/admin/nix-cache";
  var MCP_BASE = "/api/admin/mcp-servers";
  var MCP_DETAIL = function (id) { return MCP_BASE + "/" + encodeURIComponent(id); };
  var LOGOUT_URL = "/api/admin/logout";
  var PROMPT_TEMPLATES_URL = "/api/admin/prompt-templates";
  var AGENT_SETTINGS_URL = "/api/admin/agent-settings";
  var EXECUTOR_BASE = "/api/admin/executor-instance";
  var EXECUTOR_TOOLKITS = "/api/admin/executor/toolkits";
  var EXECUTOR_ATTACH = "/api/admin/executor/attach";

  var state = {
    csrfToken: "",
    installation: null,
    repositories: [],
    executorInstance: null,
    executorToolkits: [],
    mcpServers: [],
    editingMcp: null,
    nixCache: [],
    editing: null,
    promptTemplates: {},
    promptTemplatesLoaded: false,
    pendingDelete: null,
    pendingConfirm: null,
  };

  function el(id) { return document.getElementById(id); }

  function setStatus(stateText, label) {
    var pill = el("header-status");
    if (!pill) return;
    pill.setAttribute("data-state", stateText);
    pill.textContent = label;
  }

  function setAriaBusy(rootId, busy) {
    var root = el(rootId);
    if (!root) return;
    root.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function showToast(message, tone) {
    var toast = el("toast");
    if (!toast) return;
    toast.textContent = message;
    if (tone) toast.setAttribute("data-tone", tone); else toast.removeAttribute("data-tone");
    toast.setAttribute("data-show", "true");
    window.setTimeout(function () {
      toast.setAttribute("data-show", "false");
    }, TOAST_DURATION_MS);
  }

  function announceStatus(regionId, message) {
    var node = el(regionId);
    if (!node) return;
    node.textContent = message;
  }

  function csrfHeaders() {
    return {
      "content-type": "application/json",
      "X-CSRF-Token": state.csrfToken,
    };
  }

  function parseErrorBody(bodyText, fallback) {
    if (!bodyText) return fallback;
    try {
      var data = JSON.parse(bodyText);
      if (data && typeof data === "object") {
        if (typeof data.error === "string") return data.error;
        if (typeof data.message === "string") return data.message;
      }
    } catch (err) { /* swallow */ }
    return bodyText || fallback;
  }

  async function handleUnauthorized(response) {
    if (response && response.status === 401) {
      window.location.assign("/");
      return true;
    }
    return false;
  }

  async function fetchJSON(url, init) {
    init = init || {};
    init.credentials = "same-origin";
    if (init.body && typeof init.body !== "string") {
      init.body = JSON.stringify(init.body);
    }
    if (init.body && !init.headers) init.headers = {};
    if (init.body) {
      init.headers = Object.assign(
        { "content-type": "application/json" },
        csrfHeaders(),
        init.headers || {}
      );
    } else if (!init.method || init.method === "GET") {
      init.headers = Object.assign({ accept: "application/json" }, init.headers || {});
    }
    var response = await fetch(url, init);
    if (await handleUnauthorized(response)) {
      return { redirecting: true, response: response };
    }
    var text = await response.text();
    var data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (err) { data = null; }
    }
    if (!response.ok) {
      var message = parseErrorBody(text, "Request failed (" + response.status + ")");
      var error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return { ok: true, status: response.status, data: data, raw: text };
  }

`;
