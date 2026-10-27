/** The browser renders only the sanitized fleet projection. All mutations require
 * the existing session cookie, same-origin request and CSRF header. */
export function renderNativeBuildersPage(csrf: string): string {
  const token = JSON.stringify(csrf).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Partitura native builders</title>
<style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border:1px solid #aaa;padding:1rem;margin:1rem 0}button,input{font:inherit;margin:.3rem;padding:.4rem}label{display:block}output{display:block;white-space:pre-wrap}</style></head><body><a href="/admin">Partitura admin</a><h1>Native builders</h1><p>Fleet controls are restricted to gateway administrators. Refresh reads credentials explicitly. Check health uses cached credentials.</p><button id="reload">Reload fleet</button><button id="refresh-all">Refresh all</button><output id="message" aria-live="polite"></output><pre id="summary"></pre><main id="fleet"></main>
<script>
const csrf = ${token};
const base = "/api/admin/native-builders";
const message = document.getElementById("message");
const show = (value) => {
  message.textContent = JSON.stringify(value, null, 2);
};
async function get(path) {
  const r = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || "fleet-unavailable");
  return value;
}
async function post(path, body) {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error || "fleet-unavailable");
  show(value);
  if (value.operationId) await progress(value.operationId);
  await load();
}
async function progress(id) {
  for (let i = 0; i < 120; i++) {
    const value = await get(base + "/refreshes/" + encodeURIComponent(id));
    show(value);
    if (value.done) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  show({
    operationId: id,
    status: "pending",
    message: "Still pending. Reload progress explicitly.",
  });
}
function element(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}
function button(parent, label, call) {
  const b = element("button", label);
  b.type = "button";
  b.onclick = () => call().catch((error) => show({ error: error.message }));
  parent.append(b);
}
async function load() {
  const data = await get(base);
  document.getElementById("summary").textContent = JSON.stringify(
    {
      revision: data.revision,
      reloadError: data.reloadError,
      capacityError: data.capacityError,
      watchDegraded: data.watchDegraded,
      capacity: data.capacity,
      buckets: data.buckets,
      scratch: data.scratch,
      audit: data.audit,
    },
    null,
    2,
  );
  const list = document.getElementById("fleet");
  list.replaceChildren();
  for (const entry of data.entries) {
    const card = element("article", "");
    card.append(
      element("h2", entry.id),
      element("pre", JSON.stringify(entry, null, 2)),
    );
    button(card, "Refresh credentials", () =>
      post(base + "/" + encodeURIComponent(entry.id) + "/refresh", {}),
    );
    button(card, "Check cached health", () =>
      post(base + "/" + encodeURIComponent(entry.id) + "/check-health", {}),
    );
    const obligations = [
      ...(entry.recoveries || []),
      ...(entry.maintenance || []),
    ];
    if (obligations.length) {
      const selected = [];
      for (const obligation of obligations) {
        const label = element("label", "");
        const check = document.createElement("input");
        check.type = "checkbox";
        label.append(
          check,
          document.createTextNode(obligation.id + " host " + obligation.hostId),
        );
        selected.push({ check, obligation });
        card.append(label);
      }
      const reason = document.createElement("input");
      reason.placeholder = "Reason, required";
      reason.maxLength = 256;
      reason.setAttribute("aria-label", "Reason");
      const evidence = document.createElement("input");
      evidence.placeholder = "Decommission evidence reference";
      evidence.maxLength = 512;
      evidence.setAttribute("aria-label", "Decommission evidence reference");
      card.append(reason, evidence);
      for (const action of ["reconcile", "decommission"])
        button(
          card,
          action === "reconcile"
            ? "Reconcile selected"
            : "Decommission selected",
          async () => {
            const chosen = selected
              .filter((item) => item.check.checked)
              .map((item) => item.obligation);
            if (!reason.value || !chosen.length)
              throw new Error("Select obligations and enter a reason");
            const expectedHostId = chosen[0].hostId;
            if (chosen.some((item) => item.hostId !== expectedHostId))
              throw new Error("Select one physical host");
            const warning =
              action === "decommission"
                ? "Confirm the old installation is powered off, wiped or removed from service. Cleanup remains UNVERIFIED and this host will be permanently denied."
                : "Confirm fenced cleanup using current credentials for the selected host and obligations.";
            if (!window.confirm(warning)) return;
            await post(
              base + "/" + encodeURIComponent(entry.id) + "/" + action,
              {
                expectedHostId,
                recoveryIds: chosen.map((item) => item.id),
                reason: reason.value,
                ...(action === "decommission"
                  ? {
                      evidenceReference: evidence.value,
                      acknowledgeUnverifiedCleanup: true,
                    }
                  : {}),
              },
            );
          },
        );
    }
    list.append(card);
  }
}
document.getElementById("reload").onclick = () =>
  load().catch((error) => show({ error: error.message }));
document.getElementById("refresh-all").onclick = () =>
  post(base + "/refresh", {}).catch((error) => show({ error: error.message }));
load().catch((error) => show({ error: error.message }));
</script></body></html>`;
}
