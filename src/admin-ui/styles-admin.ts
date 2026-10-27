export const STYLES_ADMIN = `  /* ----- Admin ----- */
  .admin-shell {
    --aside-width: 280px;
    display: grid;
    grid-template-columns: 1fr;
    min-height: 100vh;
  }
  .admin-header {
    grid-column: 1 / -1;
    border-bottom: 1px solid var(--rule);
    padding: 14px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    background: var(--paper);
  }
  .admin-header .title {
    font-family: var(--mono);
    font-size: 0.78rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ink-soft);
  }
  .admin-header .title strong {
    color: var(--ink);
    font-weight: 600;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .header-actions .theme-switcher {
    justify-content: flex-end;
  }
  .status-pill {
    font-family: var(--mono);
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    padding: 4px 10px;
    border: 1px solid var(--rule);
    background: var(--paper-tint);
    color: var(--ink-soft);
  }
  .status-pill[data-state="ok"] {
    border-color: var(--good);
    color: var(--good);
  }
  .status-pill[data-state="warn"] {
    border-color: var(--warn);
    color: var(--warn);
  }
  .status-pill[data-state="danger"] {
    border-color: var(--danger);
    color: var(--danger);
  }

  .admin-body {
    display: grid;
    grid-template-columns: var(--aside-width) 1fr;
    gap: 0;
  }

  aside.installation {
    border-right: 1px solid var(--rule);
    padding: 20px;
    background: var(--paper-tint);
  }
  aside.installation h2 {
    font-family: var(--mono);
    font-size: 0.72rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink-mute);
    margin-bottom: 14px;
    border-bottom: 1px solid var(--rule-soft);
    padding-bottom: 6px;
  }
  .install-row {
    margin-bottom: 16px;
  }
  .install-row .label {
    font-family: var(--mono);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-mute);
    margin-bottom: 4px;
  }
  .install-row .value {
    font-family: var(--mono);
    font-size: 0.88rem;
    color: var(--ink);
    word-break: break-word;
  }

  main.console {
    padding: 24px;
    overflow-x: hidden;
  }

  section.rail-block {
    border: 1px solid var(--rule);
    margin-bottom: 32px;
    background: var(--paper);
  }
  .rail-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--rule-soft);
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
  }
  .rail-header h2 {
    font-family: var(--display);
    font-size: 1.1rem;
    font-weight: 600;
  }
  .rail-header .hint {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--ink-mute);
  }
  .rail {
    padding: 18px 16px;
    overflow-x: auto;
  }
  .rail-track {
    display: grid;
    grid-template-columns: repeat(6, minmax(120px, 1fr));
    gap: 0;
    align-items: stretch;
    min-width: 720px;
  }
  .rail-segment {
    position: relative;
    border: 1px solid var(--rule);
    border-right: 0;
    padding: 12px 14px;
    background: var(--paper-tint);
    transition: background 120ms ease-out, border-color 120ms ease-out;
  }
  .rail-segment:last-child {
    border-right: 1px solid var(--rule);
  }
  .rail-segment::after {
    content: "";
    position: absolute;
    right: -8px;
    top: 50%;
    transform: translateY(-50%);
    width: 16px;
    height: 16px;
    border-top: 1px solid var(--rule);
    border-right: 1px solid var(--rule);
    background: var(--paper-tint);
    z-index: 1;
    pointer-events: none;
  }
  .rail-segment[data-state="matched"] {
    background: var(--signal);
    color: var(--paper);
    border-color: var(--signal);
  }
  .rail-segment[data-state="matched"]::after {
    background: var(--signal);
    border-color: var(--signal);
  }
  .rail-segment[data-state="active"] {
    background: var(--paper);
    border-color: var(--ink);
  }
  .rail-segment[data-state="skipped"] {
    background: var(--paper);
    color: var(--ink-mute);
    border-color: var(--rule-soft);
  }
  .rail-segment .seg-title {
    font-family: var(--mono);
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .rail-segment .seg-detail {
    font-family: var(--display);
    font-size: 1rem;
    margin-top: 4px;
    word-break: break-word;
  }
  .rail-segment .seg-id {
    font-family: var(--mono);
    font-size: 0.72rem;
    margin-top: 4px;
    opacity: 0.85;
  }

  section.panel {
    border: 1px solid var(--rule);
    margin-bottom: 32px;
    background: var(--paper);
  }
  .panel-header {
    padding: 12px 16px;
    border-bottom: 1px solid var(--rule-soft);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
  }
  .panel-header h2 {
    font-family: var(--display);
    font-size: 1.1rem;
    font-weight: 600;
  }
  .panel-body { padding: 16px; }

  table.repos {
    width: 100%;
  }
  table.repos td.actions {
    white-space: nowrap;
    text-align: right;
  }
  table.repos td.actions button {
    margin-left: 6px;
    padding: 4px 10px;
    font-size: 0.8rem;
  }
  .default-cell {
    font-family: var(--mono);
    font-size: 0.78rem;
    letter-spacing: 0.04em;
  }

  form.repo-form {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
  form.repo-form .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  form.repo-form .field.full { grid-column: 1 / -1; }
  form.repo-form label {
    font-family: var(--mono);
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-mute);
  }
  form.repo-form .field-row {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  form.repo-form .field-row label.checkbox {
    font-family: var(--sans);
    font-size: 0.92rem;
    color: var(--ink);
    text-transform: none;
    letter-spacing: 0;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  form.repo-form .form-actions {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    border-top: 1px solid var(--rule-soft);
    padding-top: 16px;
  }
  form.repo-form .key-value-editor {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  form.repo-form .key-value-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) auto;
    gap: 8px;
    align-items: center;
  }
  form.repo-form .key-value-row .btn { white-space: nowrap; }
  form .error {
    color: var(--danger);
    font-family: var(--mono);
    font-size: 0.78rem;
    margin-top: 4px;
  }

  form.preview-form {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
  }
  form.preview-form .field-full { grid-column: 1 / -1; }
  .preview-result {
    border-top: 1px solid var(--rule-soft);
    margin-top: 16px;
    padding: 12px 16px;
    font-family: var(--mono);
    font-size: 0.85rem;
    display: grid;
    gap: 4px;
  }
  .preview-result[data-state="matched"] { color: var(--good); }
  .preview-result[data-state="none"] { color: var(--ink-mute); }
  .preview-result[data-state="ambiguous"] { color: var(--warn); }
  .preview-result[data-state="error"] { color: var(--danger); }
  .preview-result .matched-row {
    font-family: var(--display);
    font-size: 1rem;
    color: var(--ink);
  }

  .empty {
    border: 1px dashed var(--rule);
    padding: 28px 16px;
    text-align: center;
    color: var(--ink-mute);
    font-family: var(--mono);
    font-size: 0.88rem;
  }
  .loading {
    padding: 16px;
    color: var(--ink-mute);
    font-family: var(--mono);
    font-size: 0.85rem;
  }
  .error-card {
    border: 1px solid var(--danger);
    padding: 14px 16px;
    color: var(--danger);
    font-family: var(--mono);
    font-size: 0.85rem;
    background: var(--paper-tint);
  }

  .toast {
    position: fixed;
    bottom: 16px;
    right: 16px;
    padding: 12px 16px;
    border: 1px solid var(--ink);
    background: var(--ink);
    color: var(--paper);
    font-family: var(--mono);
    font-size: 0.82rem;
    max-width: 360px;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 160ms ease-out, transform 160ms ease-out;
    pointer-events: none;
  }
  .toast[data-show="true"] {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }
  .toast[data-tone="error"] {
    background: var(--danger);
    border-color: var(--danger);
  }
  .toast[data-tone="warn"] {
    background: var(--warn);
    border-color: var(--warn);
  }

`;
