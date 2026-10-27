export const SCRIPT_FORMS = `  // ---- form ----------------------------------------------------------------

  function openForm(repository) {
    state.editing = repository || null;
    var panel = el("repo-form-panel");
    var form = el("repo-form");
    var heading = el("form-heading");
    var errorBox = el("repo-form-error");
    if (!panel || !form || !heading) return;

    heading.textContent = repository && repository.id ? "Edit repository" : "Add repository";
    var fields = {
      id: repository && repository.id ? repository.id : "",
      url: repository && repository.url ? repository.url : "",
      ref: repository && repository.ref ? repository.ref : "",
      teamIds: Array.isArray(repository && repository.teamIds)
        ? repository.teamIds.join(", ")
        : "",
      projectIds: Array.isArray(repository && repository.projectIds)
        ? repository.projectIds.join(", ")
        : "",
      labels: Array.isArray(repository && repository.labels)
        ? repository.labels.join(", ")
        : "",
      nixPackages: Array.isArray(repository && repository.nixPackages)
        ? repository.nixPackages.join(", ")
        : "",
      isDefault: !!(repository && repository.isDefault),
    };
    Object.keys(fields).forEach(function (name) {
      var field = form.elements.namedItem(name);
      if (!field) return;
      if (field.type === "checkbox") {
        field.checked = fields[name];
      } else {
        field.value = fields[name];
      }
    });
    var idField = el("repo-id");
    if (idField) idField.readOnly = !!(repository && repository.id);
    errorBox.textContent = "";
    errorBox.hidden = true;
    panel.hidden = false;
    var focusField = repository && repository.id ? el("repo-url") : idField;
    if (focusField) focusField.focus();
  }

  function closeForm() {
    var panel = el("repo-form-panel");
    if (panel) panel.hidden = true;
    state.editing = null;
  }

  function parseList(value) {
    if (typeof value !== "string") return [];
    return value
      .split(",")
      .map(function (entry) { return entry.trim(); })
      .filter(function (entry) { return entry.length > 0; });
  }
  function parseMcpArgs(value) {
    if (typeof value !== "string") return [];
    var trimmed = value.trim();
    if (trimmed.charAt(0) === "[") {
      try {
        var parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.every(function (entry) { return typeof entry === "string"; })) return parsed;
      } catch {}
    }
    return parseList(value);
  }

  function serializeForm(form) {
    var data = {};
    var elements = form.elements;
    data.url = (elements.namedItem("url").value || "").trim();
    data.ref = (elements.namedItem("ref").value || "").trim();
    data.teamIds = parseList(elements.namedItem("teamIds").value);
    data.projectIds = parseList(elements.namedItem("projectIds").value);
    data.labels = parseList(elements.namedItem("labels").value);
    data.nixPackages = parseList(elements.namedItem("nixPackages").value);
    data.isDefault = !!(elements.namedItem("isDefault") && elements.namedItem("isDefault").checked);
    var idField = elements.namedItem("id");
    if (idField && idField.value) data.id = idField.value;
    return data;
  }

  function showFormError(message) {
    var box = el("repo-form-error");
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }

  function validateRepoPayload(payload) {
    if (!payload.id) return "Repository ID is required.";
    if (!payload.url) return "Repository URL is required.";
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:[\\/]+/.test(payload.url) && !/^https?:\\/\\//i.test(payload.url)) {
      // accept ssh-style git@... and https://
      if (!/^git@/.test(payload.url)) {
        return "Repository URL must be an ssh: or https:// URL.";
      }
    }
    if (!payload.ref) return "Default ref is required.";
    return null;
  }

  async function submitRepoForm(event) {
    event.preventDefault();
    var form = el("repo-form");
    if (!form) return;
    var payload = serializeForm(form);
    var validation = validateRepoPayload(payload);
    if (validation) {
      showFormError(validation);
      return;
    }
    var submitBtn = el("repo-form-submit");
    if (submitBtn) submitBtn.disabled = true;
    try {
      var isUpdate = !!(state.editing && state.editing.id);
      var url = isUpdate ? REPOSITORY_DETAIL(state.editing.id) : REPOSITORIES_BASE;
      var result = await fetchJSON(url, {
        method: isUpdate ? "PUT" : "POST",
        body: payload,
      });
      if (result && result.redirecting) return;
      showToast(isUpdate ? "Repository updated." : "Repository added.", "ok");
      closeForm();
      await loadBootstrap({ announce: false });
    } catch (err) {
      showFormError(err && err.message ? err.message : "Could not save repository.");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  function openConfirm(options) {
    var modal = el("confirm-modal");
    var title = el("confirm-title");
    var body = el("confirm-body");
    var yesBtn = el("confirm-yes");
    var noBtn = el("confirm-no");
    if (!modal || !title || !body || !yesBtn || !noBtn) return;
    title.textContent = options.title;
    body.textContent = options.body;
    modal.hidden = false;
    state.pendingConfirm = options.onConfirm || null;
    yesBtn.focus();
  }

  function closeConfirm(runCallback) {
    var modal = el("confirm-modal");
    var yesBtn = el("confirm-yes");
    var noBtn = el("confirm-no");
    if (!modal) return;
    var callback = state.pendingConfirm;
    state.pendingConfirm = null;
    if (modal) modal.hidden = true;
    if (yesBtn) yesBtn.onclick = null;
    if (noBtn) noBtn.onclick = null;
    if (runCallback && typeof callback === "function") callback();
  }

  async function deleteRepository(id) {
    var result = await fetchJSON(REPOSITORY_DETAIL(id), { method: "DELETE" });
    if (result && result.redirecting) return;
    showToast("Repository removed.", "ok");
    await loadBootstrap({ announce: false });
  }

  function handleRepoRowClick(event) {
    var target = event.target;
    if (!(target instanceof HTMLElement)) return;
    var button = target.closest("button[data-action]");
    if (!button) return;
    var id = button.getAttribute("data-repo-id") || "";
    var action = button.getAttribute("data-action");
    if (action === "prune-nix-cache") {
      var cacheKey = button.getAttribute("data-cache-key") || "";
      if (!cacheKey) return;
      openConfirm({
        title: "Prune Nix cache?",
        body: "Remove cached Nix environment " + cacheKey + "? Future sessions will rebuild it.",
        onConfirm: function () { pruneNixCache(cacheKey); },
      });
      return;
    }
    if (!id) return;
    if (action === "edit") {
      var found = state.repositories.find(function (r) { return r && r.id === id; });
      if (!found) return;
      openForm(found);
    } else if (action === "delete") {
      openConfirm({
        title: "Delete repository?",
        body: "Remove this repository from the gateway? Live sessions targeting this ref will be cancelled.",
        onConfirm: function () { deleteRepository(id); },
      });
    }
  }

  // ---- preview -------------------------------------------------------------

  function setPreviewIdle() {
    var node = el("preview-result");
    if (!node) return;
    node.setAttribute("data-state", "idle");
    node.textContent = "Run a preview to see which repository would be chosen.";
  }

  function renderPreview(result) {
    var node = el("preview-result");
    if (!node) return;
    node.textContent = "";
    if (!result) {
      setPreviewIdle();
      return;
    }

    var stateValue = result.state
      || (result.kind === "match" ? "matched" : result.kind)
      || (result.matched || result.match ? "matched" : "none");
    var match = result.repository || result.matched || result.match || null;
    var reason = result.reason || result.message || "";

    node.setAttribute("data-state", stateValue);

    if (stateValue === "matched" && match) {
      var row = document.createElement("div");
      row.className = "matched-row";
      row.textContent = "→ " + (match.url || match.id || "(repository)");
      node.appendChild(row);
      if (match.ref) {
        var refRow = document.createElement("div");
        refRow.textContent = "ref: " + match.ref;
        node.appendChild(refRow);
      }
    } else if (stateValue === "ambiguous") {
      var ambRow = document.createElement("div");
      ambRow.className = "matched-row";
      ambRow.textContent = "Ambiguous — multiple repositories match.";
      node.appendChild(ambRow);
    } else {
      var noneRow = document.createElement("div");
      noneRow.className = "matched-row";
      noneRow.textContent = "No repository matched.";
      node.appendChild(noneRow);
    }

    if (reason) {
      var reasonRow = document.createElement("div");
      reasonRow.textContent = reason;
      node.appendChild(reasonRow);
    }

    if (Array.isArray(result.trace)) {
      applyRailTrace(result.trace, match);
    }
  }

  function applyRailTrace(trace, matched) {
    var levels = {
      "explicit": "explicit",
      "issue-label": "issue-label",
      "issueLabel": "issue-label",
      "issue_label": "issue-label",
      "project-label": "project-label",
      "projectLabel": "project-label",
      "project_label": "project-label",
      "project": "project",
      "team": "team",
      "default": "default",
    };
    var stopAt = -1;
    var labels = [];
    trace.forEach(function (step) {
      var levelKey = step && step.level;
      var segmentKey = levels[levelKey] || levelKey;
      if (!levels[segmentKey]) return;
      labels.push(segmentKey);
      if (step && (step.matchedRepository || step.repositoryId)) {
        stopAt = labels.length - 1;
      }
    });

    var segments = document.querySelectorAll('[data-rail-segment]');
    segments.forEach(function (segment) {
      var key = segment.getAttribute("data-rail-segment");
      var index = labels.indexOf(key);
      var detail = segment.querySelector("[data-rail-detail]");
      var idNode = segment.querySelector("[data-rail-id]");
      if (!detail || !idNode) return;
      if (index === -1) {
        detail.textContent = "—";
        idNode.textContent = "";
        segment.setAttribute("data-state", "active");
      } else if (index < stopAt) {
        detail.textContent = "skipped";
        idNode.textContent = "";
        segment.setAttribute("data-state", "skipped");
      } else if (index === stopAt) {
        var matchedRepo = matched || {};
        detail.textContent = matchedRepo.url || matchedRepo.id || "matched";
        idNode.textContent = matchedRepo.id ? "id: " + matchedRepo.id : "";
        segment.setAttribute("data-state", "matched");
      } else {
        detail.textContent = "—";
        idNode.textContent = "";
        segment.setAttribute("data-state", "active");
      }
    });
  }

  function resetRail() {
    var segments = document.querySelectorAll('[data-rail-segment]');
    segments.forEach(function (segment) {
      var detail = segment.querySelector("[data-rail-detail]");
      var idNode = segment.querySelector("[data-rail-id]");
      if (detail) detail.textContent = "—";
      if (idNode) idNode.textContent = "";
      segment.setAttribute("data-state", "active");
    });
  }

  async function submitPreview(event) {
    event.preventDefault();
    var form = el("preview-form");
    if (!form) return;
    var elements = form.elements;
    var payload = {
      repositoryId: (elements.namedItem("repositoryId").value || "").trim() || null,
      teamId: (elements.namedItem("teamId").value || "").trim() || null,
      projectId: (elements.namedItem("projectId").value || "").trim() || null,
      issueLabels: parseList(elements.namedItem("issueLabels").value),
      projectLabels: parseList(elements.namedItem("projectLabels").value),
    };
    var node = el("preview-result");
    node.setAttribute("data-state", "idle");
    node.textContent = "Resolving…";
    try {
      var result = await fetchJSON(PREVIEW_URL, { method: "POST", body: payload });
      if (result && result.redirecting) return;
      renderPreview(result.data);
    } catch (err) {
      resetRail();
      var node = el("preview-result");
      node.setAttribute("data-state", "error");
      node.textContent = err && err.message ? err.message : "Preview failed.";
    }
  }

  var PROMPT_SAMPLES = {
    created: {
      userRequest: "User request:\nSample task from Linear",
      issueContext: "Issue context:\nIssue: Sample issue (SYM-1)",
      threadComment: "Thread comment:\nPlease investigate this.",
      previousComments: "Previous comments:\n1. Earlier discussion",
      guidance: "Guidance:\n1. Keep the change focused.",
    },
    prompted: {
      userRequest: "Sample follow-up from Linear",
    },
    contract: {},
  };

  // Must mirror substitutePromptTemplate in src/services/prompt-templates.ts:
  // unknown tokens pass through and empty token-only sections are dropped.
  function substitutePromptPreview(template, kind) {
    var values = PROMPT_SAMPLES[kind] || {};
    var emptyTokens = {};
    Object.keys(values).forEach(function (name) {
      if (!values[name]) emptyTokens["{{" + name + "}}"] = true;
    });
    var filtered = String(template || "").split("\n").filter(function (line) {
      return !emptyTokens[line.trim()];
    }).join("\n");
    return filtered.replace(/[{][{]([A-Za-z][A-Za-z0-9_]*)[}][}]/gu, function (token, name) {
      return Object.prototype.hasOwnProperty.call(values, name) ? (values[name] || "") : token;
    });
  }

  function renderPromptPreview(kind) {
    var kinds = kind ? [kind] : ["created", "prompted", "contract"];
    kinds.forEach(function (templateKind) {
      var source = el("prompt-template-" + templateKind);
      var preview = templateKind === "created"
        ? el("prompt-template-preview")
        : el("prompt-template-preview-" + templateKind);
      if (source && preview) preview.textContent = substitutePromptPreview(source.value, templateKind);
    });
  }

  function renderPromptTemplates(templates) {
    state.promptTemplates = {};
    ["created", "prompted", "contract"].forEach(function (kind) {
      var field = el("prompt-template-" + kind);
      if (field) field.value = "";
    });
    (Array.isArray(templates) ? templates : []).forEach(function (template) {
      state.promptTemplates[template.kind] = template.body;
      var field = el("prompt-template-" + template.kind);
      if (field) field.value = template.body;
    });
    renderPromptPreview();
  }
  function setPromptTemplatesSaveEnabled(enabled) {
    var saveButton = el("prompt-templates-save");
    if (saveButton) saveButton.disabled = !enabled || !state.csrfToken;
  }

  async function loadPromptTemplates() {
    setPromptTemplatesSaveEnabled(false);
    var result = await fetchJSON(PROMPT_TEMPLATES_URL, { method: "GET" });
    if (result && result.redirecting) return;
    renderPromptTemplates(result.data && result.data.templates);
    state.promptTemplatesLoaded = true;
    setPromptTemplatesSaveEnabled(true);
  }

  async function savePromptTemplates() {
    var status = el("prompt-templates-status");
    if (!state.csrfToken) {
      if (status) status.textContent = "Prompt templates are not ready yet.";
      return;
    }
    if (!state.promptTemplatesLoaded) {
      if (status) status.textContent = "Prompt templates are not loaded yet.";
      return;
    }
    var kinds = ["created", "prompted", "contract"];
    var failures = [];
    var warnings = [];
    for (var i = 0; i < kinds.length; i += 1) {
      var kind = kinds[i];
      var field = el("prompt-template-" + kind);
      try {
        var result = await fetchJSON(PROMPT_TEMPLATES_URL, {
          method: "PUT",
          body: { kind: kind, body: field ? field.value : "" },
        });
        var returnedWarnings = result && result.data && result.data.warnings;
        if (Array.isArray(returnedWarnings)) {
          returnedWarnings.forEach(function (warning) {
            warnings.push(kind + ": " + warning);
          });
        }
      } catch (err) {
        failures.push(kind + ": " + (err && err.message ? err.message : "save failed"));
      }
    }
    if (status) {
      var messages = failures.concat(warnings);
      status.textContent = messages.length > 0
        ? messages.join(" | ")
        : "Prompt templates saved.";
    }
    if (failures.length === 0) {
      await loadPromptTemplates();
    }
  }

`;
