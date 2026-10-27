export const SCRIPT_LIFECYCLE = `  // ---- bootstrap loader ----------------------------------------------------

  async function loadBootstrap(options) {
    options = options || {};
    var announce = options.announce !== false;
    var preserveExecutorToolkits = options.preserveExecutorToolkits === true;
    if (announce) {
      setStatus("loading", "loading…");
      announceStatus("repos-status", "Loading repositories…");
      announceStatus("installation-card", "");
      var loadingNode = document.createElement("p");
      loadingNode.className = "loading";
      loadingNode.textContent = "Loading installation…";
      var card = el("installation-card");
      if (card) {
        card.textContent = "";
        card.appendChild(loadingNode);
      }
    }
    setAriaBusy("repos-list", true);
    try {
      var result = await fetchJSON(BOOTSTRAP_URL, { method: "GET" });
      if (result && result.redirecting) return;
      var data = result.data || {};
      state.csrfToken = typeof data.csrfToken === "string" ? data.csrfToken : "";
      setPromptTemplatesSaveEnabled(state.promptTemplatesLoaded);
      state.installation = data.installation || null;
      state.repositories = Array.isArray(data.repositories) ? data.repositories : [];
      state.mcpServers = Array.isArray(data.mcpServers) ? data.mcpServers : [];
      var settingsField = el("agent-settings-json");
      if (settingsField && data.agentSettings) settingsField.value = JSON.stringify(data.agentSettings, null, 2);
      var fullAccessToggle = el("agent-settings-full-access");
      if (fullAccessToggle && data.agentSettings) fullAccessToggle.checked = data.agentSettings.allowFullAccessViaLabel !== false;
      state.executorInstance = data.executorInstance || null;
      if (!preserveExecutorToolkits) state.executorToolkits = [];
      renderInstallation(state.installation);
      renderRepositories(state.repositories);
      renderMcpServers(state.mcpServers);
      // Surface the OAuth callback outcome only after bootstrap rendered.
      var mcpStatus = el("mcp-status");
      if (mcpStatus && window.location && window.location.search) {
        var params = new URLSearchParams(window.location.search);
        var mcpResult = params.get("mcp");
        if (mcpResult === "connected") {
          mcpStatus.textContent = "MCP server connected.";
        } else if (mcpResult === "error") {
          mcpStatus.textContent =
            "MCP connection failed: " + (params.get("message") || "unknown error");
        }
        if (mcpResult !== null && window.history && window.history.replaceState) {
          window.history.replaceState(null, "", window.location.pathname);
        }
      }
      renderExecutor(state.executorInstance, state.executorToolkits);
      await loadNixCache();
      var badge = computeAccessibilityBadge(state.installation);
      setStatus(badge.state, badge.label);
      var logoutBtn = el("logout-btn");
      if (logoutBtn) logoutBtn.hidden = false;
      var installStatus = (state.installation && state.installation.revokedAt)
        ? "Installation revoked."
        : "Installation ready.";
      announceStatus("repos-status", installStatus);
    } catch (err) {
      var node = el("repos-status");
      if (node) {
        node.textContent = "";
        var errorCard = document.createElement("div");
        errorCard.className = "error-card";
        errorCard.textContent = (err && err.message)
          ? "Failed to load: " + err.message
          : "Failed to load bootstrap.";
        node.appendChild(errorCard);
      }
      setAriaBusy("repos-list", false);
      setStatus("warn", "load error");
    }
  }

  async function saveAgentSettings() {
    var status = el("agent-settings-status");
    var button = el("agent-settings-save");
    try {
      var payload = JSON.parse(el("agent-settings-json").value);
      payload.allowFullAccessViaLabel = !!el("agent-settings-full-access").checked;
      if (button) button.disabled = true;
      var result = await fetchJSON(AGENT_SETTINGS_URL, { method: "PUT", body: payload });
      if (result && result.redirecting) return;
      el("agent-settings-json").value = JSON.stringify(result.data.settings, null, 2);
      if (status) status.textContent = "Saved. New runs will use these settings.";
    } catch (err) {
      if (status) status.textContent = err && err.message ? err.message : "Could not save run settings.";
    } finally { if (button) button.disabled = false; }
  }


  // ---- logout --------------------------------------------------------------

  async function logout() {
    try {
      var result = await fetchJSON(LOGOUT_URL, { method: "POST", body: {} });
      if (result && result.redirecting) return;
    } catch (err) {
      // fall through to redirect even on failure
    }
    window.location.assign("/");
  }

  // ---- wire-up -------------------------------------------------------------

  function init() {
    var newBtn = el("new-repo-btn");
    if (newBtn) newBtn.addEventListener("click", function () { openForm(null); });
    var newMcpBtn = el("new-mcp-btn");
    if (newMcpBtn) newMcpBtn.addEventListener("click", function () { openMcpForm(null); });
    var mcpCancel = el("mcp-cancel");
    if (mcpCancel) mcpCancel.addEventListener("click", closeMcpForm);
    var addHeader = el("mcp-add-header");
    if (addHeader) addHeader.addEventListener("click", function () { addMcpHeaderRow("", ""); });
    var transport = el("mcp-transport");
    if (transport) transport.addEventListener("change", syncMcpHeaderVisibility);
    var executorForm = el("executor-form");
    if (executorForm) executorForm.addEventListener("submit", saveExecutor);
    var executorList = el("executor-list-btn");
    if (executorList) executorList.addEventListener("click", listExecutorToolkits);
    var executorDelete = el("executor-delete-btn");
    if (executorDelete) executorDelete.addEventListener("click", function () {
      openConfirm({
        title: "Remove Executor credentials?",
        body: "This removes the saved Executor endpoint and bearer token.",
        onConfirm: deleteExecutor,
      });
    });
    var executorToolkitList = el("executor-toolkit-list");
    if (executorToolkitList) executorToolkitList.addEventListener("click", handleExecutorClick);

    var cancelBtn = el("form-cancel-btn");
    if (cancelBtn) cancelBtn.addEventListener("click", closeForm);

    var inlineCancel = el("repo-form-cancel");
    if (inlineCancel) inlineCancel.addEventListener("click", closeForm);

    var form = el("repo-form");
    if (form) form.addEventListener("submit", submitRepoForm);
    var mcpForm = el("mcp-form");
    if (mcpForm) mcpForm.addEventListener("submit", submitMcpForm);

    var previewForm = el("preview-form");
    if (previewForm) previewForm.addEventListener("submit", submitPreview);
    ["created", "prompted", "contract"].forEach(function (kind) {
      var promptField = el("prompt-template-" + kind);
      if (promptField) promptField.addEventListener("input", function () {
        renderPromptPreview(kind);
      });
    });
    var promptSave = el("prompt-templates-save");
    if (promptSave) promptSave.addEventListener("click", savePromptTemplates);
    var agentSettingsSave = el("agent-settings-save");
    if (agentSettingsSave) agentSettingsSave.addEventListener("click", saveAgentSettings);

    var list = el("repos-list");
    if (list) list.addEventListener("click", handleRepoRowClick);
    var mcpList = el("mcp-list");
    if (mcpList) mcpList.addEventListener("click", handleMcpClick);
    var nixCacheList = el("nix-cache-list");
    if (nixCacheList) nixCacheList.addEventListener("click", handleRepoRowClick);
    var logoutBtn = el("logout-btn");

    var yesBtn = el("confirm-yes");
    var noBtn = el("confirm-no");
    if (yesBtn) yesBtn.addEventListener("click", function () { closeConfirm(true); });
    if (noBtn) noBtn.addEventListener("click", function () { closeConfirm(false); });

    setPromptTemplatesSaveEnabled(false);
    loadPromptTemplates().catch(function (err) {
      setPromptTemplatesSaveEnabled(false);
      var status = el("prompt-templates-status");
      if (status) status.textContent = err && err.message ? err.message : "Unable to load prompt templates.";
    });
    if (logoutBtn) logoutBtn.addEventListener("click", logout);

    setPreviewIdle();
    loadBootstrap();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
`;
