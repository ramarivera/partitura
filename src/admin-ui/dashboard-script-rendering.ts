export const SCRIPT_RENDERING = `  // ---- rendering -----------------------------------------------------------

  function renderInstallation(installation) {
    var card = el("installation-card");
    if (!card) return;
    card.textContent = "";

    var rows = [
      ["Organization", installation && installation.organizationId ? installation.organizationId : "—"],
      ["App user", installation && installation.appUserId ? installation.appUserId : "—"],
      ["Scopes", installation && Array.isArray(installation.scopes) && installation.scopes.length
        ? installation.scopes.join(", ")
        : "—"],
      ["Accessible teams", installation && installation.canAccessAllPublicTeams
        ? "All public teams"
        : (Array.isArray(installation.accessibleTeamIds)
            ? installation.accessibleTeamIds.length + " teams"
            : "Restricted — see Linear")],
      ["Status", installation && installation.revokedAt
        ? "Revoked"
        : "Active"],
    ];

    rows.forEach(function (row) {
      var wrap = document.createElement("div");
      wrap.className = "install-row";
      var label = document.createElement("div");
      label.className = "label";
      label.textContent = row[0];
      var value = document.createElement("div");
      value.className = "value";
      value.textContent = row[1];
      if (row[0] === "Status") {
        value.setAttribute("data-state", row[1] === "Revoked" ? "danger" : "good");
      }
      wrap.appendChild(label);
      wrap.appendChild(value);
      card.appendChild(wrap);
    });
  }

  function computeAccessibilityBadge(installation) {
    if (!installation) return { state: "warn", label: "no installation" };
    if (installation.revokedAt) return { state: "danger", label: "revoked" };
    if (installation.canAccessAllPublicTeams) return { state: "ok", label: "all public teams" };
    if (Array.isArray(installation.accessibleTeamIds) && installation.accessibleTeamIds.length > 0) {
      return { state: "ok", label: installation.accessibleTeamIds.length + " teams" };
    }
    return { state: "warn", label: "restricted" };
  }

  function renderRepositories(repositories) {
    var list = el("repos-list");
    var status = el("repos-status");
    list.textContent = "";
    status.textContent = "";
    if (!Array.isArray(repositories) || repositories.length === 0) {
      list.removeAttribute("aria-busy");
      setAriaBusy("repos-list", false);
      status.textContent = "No repositories yet.";
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent =
        "Add the first repository the gateway is allowed to route issues into.";
      list.appendChild(empty);
      return;
    }
    var table = document.createElement("table");
    table.className = "repos";
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["URL", "Default ref", "Teams", "Projects", "Labels", "Nix packages", "Default", ""].forEach(function (text) {
      var th = document.createElement("th");
      th.scope = "col";
      th.textContent = text;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    repositories.forEach(function (repo) {
      var tr = document.createElement("tr");
      tr.dataset.repoId = typeof repo.id === "string" ? repo.id : "";

      var urlCell = document.createElement("td");
      urlCell.appendChild(buildCopyCell(repo.url || "—"));
      tr.appendChild(urlCell);

      var refCell = document.createElement("td");
      var refCode = document.createElement("code");
      refCode.textContent = repo.ref || "—";
      refCell.appendChild(refCode);
      tr.appendChild(refCell);

      var teamsCell = document.createElement("td");
      teamsCell.appendChild(buildPillList(repo.teamIds, "no team scoping"));
      tr.appendChild(teamsCell);

      var projectsCell = document.createElement("td");
      projectsCell.appendChild(buildPillList(repo.projectIds, "no project scoping"));
      tr.appendChild(projectsCell);

      var labelsCell = document.createElement("td");
      labelsCell.appendChild(buildPillList(repo.labels, "no label matching"));
      tr.appendChild(labelsCell);

      var nixPackagesCell = document.createElement("td");
      nixPackagesCell.appendChild(buildPillList(repo.nixPackages, "no extra packages"));
      tr.appendChild(nixPackagesCell);

      var defaultCell = document.createElement("td");
      defaultCell.className = "default-cell";
      var badge = document.createElement("span");
      if (repo.isDefault) {
        badge.textContent = "✓ default";
        badge.setAttribute("data-pill", "good");
        badge.className = "pill good";
      } else {
        badge.textContent = "scoped";
        badge.className = "pill";
      }
      defaultCell.appendChild(badge);
      tr.appendChild(defaultCell);

      var actionsCell = document.createElement("td");
      actionsCell.className = "actions";
      var editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.dataset.action = "edit";
      editBtn.dataset.repoId = typeof repo.id === "string" ? repo.id : "";
      editBtn.textContent = "Edit";
      actionsCell.appendChild(editBtn);

      var deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn-danger";
      deleteBtn.dataset.action = "delete";
      deleteBtn.dataset.repoId = typeof repo.id === "string" ? repo.id : "";
      deleteBtn.textContent = "Delete";
      actionsCell.appendChild(deleteBtn);

      tr.appendChild(actionsCell);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    list.appendChild(table);
    setAriaBusy("repos-list", false);
    status.textContent = repositories.length + " repositories configured.";
  }

  function renderMcpServers(servers) {
    var list = el("mcp-list");
    var status = el("mcp-status");
    if (!list || !status) return;
    list.textContent = "";
    if (!Array.isArray(servers) || servers.length === 0) {
      status.textContent = "No MCP servers configured.";
      list.textContent = "Add an installation-wide or repository-scoped server.";
      setAriaBusy("mcp-list", false);
      return;
    }
    status.textContent = servers.length + " MCP servers configured.";
    var table = document.createElement("table");
    table.className = "repos";
    var head = document.createElement("thead");
    var row = document.createElement("tr");
    ["Name", "Transport", "Scope", "Environment", "OAuth", "Status", ""].forEach(function (label) {
      var th = document.createElement("th"); th.scope = "col"; th.textContent = label; row.appendChild(th);
    });
    head.appendChild(row); table.appendChild(head);
    var body = document.createElement("tbody");
    servers.forEach(function (server) {
      var tr = document.createElement("tr");
      var name = document.createElement("td"); name.textContent = server.name || server.id || "—"; tr.appendChild(name);
      var transport = document.createElement("td"); transport.textContent = server.transport || "—"; tr.appendChild(transport);
      var scope = document.createElement("td"); scope.textContent = server.repositoryId || "installation-wide"; tr.appendChild(scope);
      var env = document.createElement("td"); env.textContent = server.env && Object.keys(server.env).length ? Object.keys(server.env).map(function (key) { return key + "=•••"; }).join(", ") : "—"; tr.appendChild(env);
      var oauth = document.createElement("td"); var oauthState = server.oauth || { connected: false, expired: false }; oauth.textContent = oauthState.connected ? (oauthState.expired ? "expired" : "connected") : "not connected"; tr.appendChild(oauth);
      var enabled = document.createElement("td"); enabled.textContent = server.enabled ? "enabled" : "disabled"; tr.appendChild(enabled);
      var actions = document.createElement("td"); actions.className = "actions";
      var edit = document.createElement("button"); edit.type = "button"; edit.dataset.action = "edit-mcp"; edit.dataset.mcpId = server.id || ""; edit.textContent = "Edit"; actions.appendChild(edit);
      var toggle = document.createElement("button"); toggle.type = "button"; toggle.dataset.action = "toggle-mcp"; toggle.dataset.mcpId = server.id || ""; toggle.textContent = server.enabled ? "Disable" : "Enable"; actions.appendChild(toggle);
      if ((server.transport === "http" || server.transport === "sse") && server.enabled) {
        var auth = document.createElement("button"); auth.type = "button"; auth.dataset.action = oauthState.connected ? "disconnect-mcp" : "connect-mcp"; auth.dataset.mcpId = server.id || ""; auth.textContent = oauthState.connected ? "Disconnect" : "Connect"; actions.appendChild(auth);
      }
      var remove = document.createElement("button"); remove.type = "button"; remove.className = "btn-danger"; remove.dataset.action = "delete-mcp"; remove.dataset.mcpId = server.id || ""; remove.textContent = "Delete"; actions.appendChild(remove);
      tr.appendChild(actions); body.appendChild(tr);
    });
    table.appendChild(body); list.appendChild(table); setAriaBusy("mcp-list", false);
  }
  function renderExecutor(instance, toolkits) {
    var endpoint = el("executor-endpoint"); var token = el("executor-token");
    if (endpoint) endpoint.value = instance && instance.endpoint ? instance.endpoint : "";
    if (token) token.value = "";
    var list = el("executor-toolkit-list"); var status = el("executor-status");
    if (!list || !status) return;
    list.textContent = ""; status.textContent = instance ? "Executor configured." : "Configure an Executor endpoint and token.";
    (Array.isArray(toolkits) ? toolkits : []).forEach(function (toolkit) {
      var row = document.createElement("div"); row.className = "install-row";
      var label = document.createElement("div"); label.className = "label"; label.textContent = toolkit.name || toolkit.slug || "Toolkit";
      var value = document.createElement("div"); value.className = "value"; value.textContent = toolkit.slug || "—";
      var button = document.createElement("button"); button.type = "button"; button.className = "btn"; button.textContent = "Attach as MCP"; button.dataset.executorSlug = toolkit.slug || "";
      row.appendChild(label); row.appendChild(value); row.appendChild(button); list.appendChild(row);
    });
  }
  async function listExecutorToolkits() {
    var status = el("executor-status"); if (status) status.textContent = "Loading toolkits…";
    try {
      var result = await fetchJSON(EXECUTOR_TOOLKITS, { method: "GET" });
      if (result && result.redirecting) return;
      state.executorToolkits = result.data && Array.isArray(result.data.toolkits) ? result.data.toolkits : [];
      renderExecutor(state.executorInstance, state.executorToolkits);
    }
    catch (err) { if (status) status.textContent = err && err.message ? err.message : "Could not list Executor toolkits."; }
  }
  async function saveExecutor(event) {
    event.preventDefault(); var form = el("executor-form"); var error = el("executor-form-error");
    if (!form) return;
    if (error) { error.textContent = ""; error.hidden = true; }
    try {
      var result = await fetchJSON(EXECUTOR_BASE, { method: "PUT", body: { endpoint: form.elements.namedItem("endpoint").value.trim(), token: form.elements.namedItem("token").value } });
      if (result && result.redirecting) return;
      if (error) { error.textContent = ""; error.hidden = true; }
      showToast("Executor saved.", "ok"); await loadBootstrap({ announce: false });
    }
    catch (err) { if (error) { error.textContent = err && err.message ? err.message : "Could not save Executor."; error.hidden = false; } }
  }
  async function deleteExecutor() {
    try {
      var result = await fetchJSON(EXECUTOR_BASE, { method: "DELETE", body: {} });
      if (result && result.redirecting) return;
      showToast("Executor removed.", "ok"); await loadBootstrap({ announce: false });
    }
    catch (err) { showToast(err && err.message ? err.message : "Could not remove Executor.", "error"); }
  }
  async function attachExecutorToolkit(slug) {
    try {
      var result = await fetchJSON(EXECUTOR_ATTACH, { method: "POST", body: { slug: slug } });
      if (result && result.redirecting) return;
      showToast("Toolkit attached as MCP.", "ok"); await loadBootstrap({ announce: false, preserveExecutorToolkits: true });
    }
    catch (err) { showToast(err && err.message ? err.message : "Could not attach toolkit.", "error"); }
  }
  function handleExecutorClick(event) {
    var target = event.target; if (!(target instanceof HTMLElement)) return;
    var button = target.closest("button[data-executor-slug]"); if (button) attachExecutorToolkit(button.dataset.executorSlug || "");
  }
  function addMcpHeaderRow(key, value) {
    var editor = el("mcp-headers-editor"); if (!editor) return;
    var row = document.createElement("div"); row.className = "key-value-row"; row.setAttribute("data-header-row", "true");
    var keyInput = document.createElement("input"); keyInput.type = "text"; keyInput.placeholder = "Header name"; keyInput.autocomplete = "off"; keyInput.value = key || "";
    var valueInput = document.createElement("input"); valueInput.type = "text"; valueInput.placeholder = "Value"; valueInput.autocomplete = "off"; valueInput.value = value || "";
    var remove = document.createElement("button"); remove.type = "button"; remove.className = "btn btn-danger"; remove.textContent = "Remove"; remove.addEventListener("click", function () { row.remove(); });
    row.appendChild(keyInput); row.appendChild(valueInput); row.appendChild(remove); editor.appendChild(row);
  }
  function setMcpHeaderRows(headers) {
    var editor = el("mcp-headers-editor"); if (!editor) return;
    editor.textContent = "";
    Object.keys(headers || {}).forEach(function (key) { addMcpHeaderRow(key, headers[key]); });
  }
  function readMcpHeaderRows() {
    var headers = {};
    var editor = el("mcp-headers-editor"); if (!editor) return headers;
    editor.querySelectorAll("[data-header-row]").forEach(function (row) {
      var inputs = row.querySelectorAll("input"); if (inputs.length < 2) return;
      var key = inputs[0].value.trim(); if (!key) return;
      headers[key] = inputs[1].value;
    });
    return headers;
  }
  function syncMcpHeaderVisibility() {
    var transport = el("mcp-transport"); var field = el("mcp-headers-field");
    if (field) field.hidden = !transport || (transport.value !== "http" && transport.value !== "sse");
  }
  function openMcpForm(server) {
    state.editingMcp = server || null;
    var form = el("mcp-form"); if (!form) return;
    var fields = { id: server && server.id || "", name: server && server.name || "", transport: server && server.transport || "stdio", command: server && server.command || "", url: server && server.url || "", args: server && Array.isArray(server.args) ? JSON.stringify(server.args) : "", oauthClientId: server && server.oauthClient ? server.oauthClient.clientId || "" : "", oauthClientSecret: "", oauthScope: server && server.oauthClient ? server.oauthClient.scope || "" : "", oauthTokenEndpointAuthMethod: server && server.oauthClient ? server.oauthClient.tokenEndpointAuthMethod || "" : "", env: server && server.env ? Object.keys(server.env).map(function (key) { return key + "=" + server.env[key]; }).join("\\n") : "", repositoryId: server && server.repositoryId || "", enabled: !server || server.enabled !== false };
    Object.keys(fields).forEach(function (key) { var field = form.elements.namedItem(key); if (!field) return; if (field.type === "checkbox") field.checked = fields[key]; else field.value = fields[key]; });
    setMcpHeaderRows(server && server.headers ? server.headers : {});
    syncMcpHeaderVisibility();
    var idField = el("mcp-id"); if (idField) idField.readOnly = !!(server && server.id);
    var error = el("mcp-form-error"); if (error) { error.textContent = ""; error.hidden = true; }
    form.hidden = false; var focus = server ? el("mcp-name") : idField; if (focus) focus.focus();
  }
  function closeMcpForm() { var form = el("mcp-form"); if (form) form.hidden = true; state.editingMcp = null; }
  function serializeMcpForm() {
    var form = el("mcp-form"), fields = form.elements, env = {};
    (fields.namedItem("env").value || "").split("\\n").forEach(function (line) { var index = line.indexOf("="); if (index <= 0) return; env[line.slice(0, index).trim()] = line.slice(index + 1); });
    return { id: fields.namedItem("id").value.trim(), name: fields.namedItem("name").value.trim(), transport: fields.namedItem("transport").value, command: fields.namedItem("command").value.trim() || null, url: fields.namedItem("url").value.trim() || null, args: parseMcpArgs(fields.namedItem("args").value), oauthClientId: fields.namedItem("oauthClientId").value.trim() || null, oauthClientSecret: fields.namedItem("oauthClientSecret").value.trim() || null, oauthScope: fields.namedItem("oauthScope").value.trim() || null, oauthTokenEndpointAuthMethod: fields.namedItem("oauthTokenEndpointAuthMethod").value || null, env: env, headers: readMcpHeaderRows(), repositoryId: fields.namedItem("repositoryId").value.trim() || null, enabled: !!fields.namedItem("enabled").checked };
  }
  async function submitMcpForm(event) {
    event.preventDefault(); var payload = serializeMcpForm();
    if (!payload.id || !payload.name) { var invalid = el("mcp-form-error"); invalid.textContent = "Server ID and name are required."; invalid.hidden = false; return; }
    var button = el("mcp-submit"); if (button) button.disabled = true;
    try { var update = !!(state.editingMcp && state.editingMcp.id); var result = await fetchJSON(update ? MCP_DETAIL(state.editingMcp.id) : MCP_BASE, { method: update ? "PUT" : "POST", body: payload }); if (result && result.redirecting) return; closeMcpForm(); showToast(update ? "MCP server updated." : "MCP server added.", "ok"); await loadBootstrap({ announce: false }); }
    catch (err) { var box = el("mcp-form-error"); box.textContent = err && err.message ? err.message : "Could not save MCP server."; box.hidden = false; }
    finally { if (button) button.disabled = false; }
  }
  async function connectMcpServer(id) {
    try {
      var result = await fetchJSON(MCP_BASE + "/" + encodeURIComponent(id) + "/oauth/connect", { method: "POST", body: {} });
      var payload = result && result.data;
      if (payload && payload.authorizationUrl) { window.location.assign(payload.authorizationUrl); return; }
      announceStatus("mcp-status", "MCP OAuth connection did not return an authorization URL.");
    } catch (err) { announceStatus("mcp-status", err && err.message ? err.message : "Could not connect MCP OAuth."); showToast("MCP OAuth connection failed.", "danger"); }
  }
  async function disconnectMcpServer(id) {
    try {
      await fetchJSON(MCP_BASE + "/" + encodeURIComponent(id) + "/oauth/disconnect", { method: "POST", body: {} });
      showToast("MCP OAuth disconnected.", "ok");
      await loadBootstrap({ announce: false });
    } catch (err) { announceStatus("mcp-status", err && err.message ? err.message : "Could not disconnect MCP OAuth."); showToast("MCP OAuth disconnection failed.", "danger"); }
  }
  async function deleteMcpServer(id) { var result = await fetchJSON(MCP_DETAIL(id), { method: "DELETE", body: {} }); if (result && result.redirecting) return; showToast("MCP server removed.", "ok"); await loadBootstrap({ announce: false }); }
  async function toggleMcpServer(server) { var result = await fetchJSON(MCP_DETAIL(server.id), { method: "PUT", body: Object.assign({}, server, { enabled: !server.enabled }) }); if (result && result.redirecting) return; await loadBootstrap({ announce: false }); }
  function handleMcpClick(event) {
    var target = event.target; if (!(target instanceof HTMLElement)) return;
    var button = target.closest("button[data-action]"); if (!button) return;
    var id = button.getAttribute("data-mcp-id") || ""; var server = state.mcpServers.find(function (item) { return item && item.id === id; }); if (!server) return;
    var action = button.getAttribute("data-action");
    if (action === "edit-mcp") openMcpForm(server);
    if (action === "toggle-mcp") toggleMcpServer(server);
    if (action === "connect-mcp") connectMcpServer(id);
    if (action === "disconnect-mcp") disconnectMcpServer(id);
    if (action === "delete-mcp") openConfirm({ title: "Delete MCP server?", body: "Remove " + (server.name || id) + "?", onConfirm: function () { deleteMcpServer(id); } });
  }

  function buildCopyCell(text) {
    var span = document.createElement("span");
    span.textContent = text;
    return span;
  }

  function buildPillList(values, emptyLabel) {
    var frag = document.createDocumentFragment();
    if (!Array.isArray(values) || values.length === 0) {
      var empty = document.createElement("span");
      empty.className = "pill";
      empty.textContent = emptyLabel;
      frag.appendChild(empty);
      return frag;
    }
    values.forEach(function (value) {
      var pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = String(value);
      frag.appendChild(pill);
    });
    return frag;
  }

  function renderNixCache(entries) {
    var list = el("nix-cache-list");
    var status = el("nix-cache-status");
    if (!list || !status) return;
    list.textContent = "";
    status.textContent = "";
    if (!Array.isArray(entries) || entries.length === 0) {
      list.textContent = "No cached Nix environments.";
      setAriaBusy("nix-cache-list", false);
      return;
    }
    var table = document.createElement("table");
    table.className = "repos";
    var head = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["Cache key", "Status", "Size (bytes)", "Last used", ""].forEach(function (label) {
      var th = document.createElement("th");
      th.scope = "col";
      th.textContent = label;
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    var body = document.createElement("tbody");
    entries.forEach(function (entry) {
      var row = document.createElement("tr");
      [
        entry && entry.cacheKey,
        entry && entry.status,
        entry && entry.sizeBytes,
        entry && entry.lastUsedAt,
      ].forEach(function (value) {
        var cell = document.createElement("td");
        cell.textContent = value === undefined || value === null ? "—" : String(value);
        row.appendChild(cell);
      });
      var actions = document.createElement("td");
      var prune = document.createElement("button");
      prune.type = "button";
      prune.className = "btn-danger";
      prune.dataset.action = "prune-nix-cache";
      prune.dataset.cacheKey = entry && typeof entry.cacheKey === "string" ? entry.cacheKey : "";
      prune.textContent = "Prune";
      prune.disabled = !prune.dataset.cacheKey;
      actions.appendChild(prune);
      row.appendChild(actions);
      body.appendChild(row);
    });
    table.appendChild(body);
    list.appendChild(table);
    status.textContent = entries.length + " cached Nix environment" + (entries.length === 1 ? "." : "s.");
    setAriaBusy("nix-cache-list", false);
  }

  async function loadNixCache() {
    if (!document.documentElement.hasAttribute("data-gateway-admin")) return;
    el("nix-cache-panel").hidden = false;
    setAriaBusy("nix-cache-list", true);
    var result = await fetchJSON(NIX_CACHE_URL, { method: "GET" });
    if (result && result.redirecting) return;
    state.nixCache = result && result.data && Array.isArray(result.data.entries) ? result.data.entries : [];
    renderNixCache(state.nixCache);
  }

  async function pruneNixCache(cacheKey) {
    var result = await fetchJSON(NIX_CACHE_URL + "/" + encodeURIComponent(cacheKey) + "/prune", {
      method: "POST",
      body: {},
    });
    if (result && result.redirecting) return;
    showToast("Nix cache entry pruned.", "ok");
    await loadNixCache();
  }


`;
