export const STYLES_BASE = `
  :root {
    --paper: #f1e7d2;
    --paper-tint: #ece1c5;
    --ink: #1a1612;
    --ink-soft: #4a3e30;
    --ink-mute: #877355;
    --rule: #b8a886;
    --rule-soft: #d6c8a5;
    --signal: #c44a14;
    --signal-soft: #e88c5f;
    --warn: #8a6d00;
    --danger: #8a1f12;
    --good: #1f5a2e;
    --mono: ui-monospace, "SF Mono", "Menlo", "Consolas", monospace;
    --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI",
      system-ui, sans-serif;
    --display: "Iowan Old Style", "Charter", "Source Serif Pro",
      "Cambria", Georgia, serif;
    --rail-segment-gap: 0;
    --grid-line: rgba(26, 22, 18, 0.04);
  }

  :root[data-theme="editorial"][data-resolved-mode="dark"] {
    --paper: #181512;
    --paper-tint: #241f19;
    --ink: #f5eee1;
    --ink-soft: #d4c7b4;
    --ink-mute: #aa997f;
    --rule: #695d4b;
    --rule-soft: #433b31;
    --signal: #f07b42;
    --signal-soft: #f7b38f;
    --warn: #d8b742;
    --danger: #ee8477;
    --good: #79c28b;
    --grid-line: rgba(245, 238, 225, 0.05);
  }

  :root[data-theme="linear"] {
    --paper: #f8f9fb;
    --paper-tint: #eef0f4;
    --ink: #20232d;
    --ink-soft: #586171;
    --ink-mute: #7b8494;
    --rule: #d3d8e1;
    --rule-soft: #e5e8ee;
    --signal: #5e6ad2;
    --signal-soft: #8b95e6;
    --warn: #956e14;
    --danger: #b33d46;
    --good: #2f7a4d;
    --grid-line: transparent;
    --display: var(--sans);
    --rail-segment-gap: 6px;
  }

  :root[data-theme="linear"][data-resolved-mode="dark"] {
    --paper: #15171b;
    --paper-tint: #1d2026;
    --ink: #f0f1f5;
    --ink-soft: #b8becb;
    --ink-mute: #858d9d;
    --rule: #3a404c;
    --rule-soft: #2a2f38;
    --signal: #8b95f5;
    --signal-soft: #aeb5ff;
    --warn: #e0b84e;
    --danger: #f08a8f;
    --good: #80cf9b;
  }

  *, *::before, *::after { box-sizing: border-box; }

  html { font-size: 16px; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    background-image:
      linear-gradient(var(--grid-line) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
    background-size: 24px 24px;
    background-position: -1px -1px;
  }

  ::selection { background: var(--signal); color: var(--paper); }

  a {
    color: var(--ink);
    text-decoration: underline;
    text-decoration-color: var(--rule);
    text-underline-offset: 3px;
  }
  a:hover { text-decoration-color: var(--signal); }

  h1, h2, h3 {
    font-family: var(--display);
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0;
  }

  hr {
    border: 0;
    border-top: 1px solid var(--rule);
    margin: 32px 0;
  }

  button, .btn {
    font-family: var(--sans);
    font-size: 1rem;
    line-height: 1.2;
    border: 1px solid var(--ink);
    background: var(--paper);
    color: var(--ink);
    padding: 10px 18px;
    cursor: pointer;
    transition: background 120ms ease-out, color 120ms ease-out,
      border-color 120ms ease-out;
  }
  button:hover, .btn:hover {
    background: var(--ink);
    color: var(--paper);
  }
  button:focus-visible,
  a:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--signal);
    outline-offset: 2px;
  }
  button.btn-primary {
    background: var(--ink);
    color: var(--paper);
  }
  button.btn-primary:hover {
    background: var(--signal);
    border-color: var(--signal);
  }
  button.btn-danger {
    border-color: var(--danger);
    color: var(--danger);
  }
  button.btn-danger:hover {
    background: var(--danger);
    color: var(--paper);
  }
  button:disabled,
  .btn[aria-disabled="true"] {
    cursor: not-allowed;
    opacity: 0.55;
  }
  button:disabled:hover,
  .btn[aria-disabled="true"]:hover {
    background: var(--paper);
    color: var(--ink);
  }

  input[type="text"],
  input[type="url"],
  input[type="search"],
  textarea {
    font-family: var(--sans);
    font-size: 0.95rem;
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--rule);
    background: var(--paper-tint);
    color: var(--ink);
    border-radius: 0;
  }
  input[type="text"]:focus,
  input[type="url"]:focus,
  textarea:focus {
    border-color: var(--ink);
  }
  textarea { font-family: var(--mono); resize: vertical; }

  select {
    font: inherit;
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--rule);
    padding: 6px 26px 6px 8px;
    border-radius: 0;
    min-height: 32px;
  }

  .theme-switcher {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .theme-switcher label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--ink-mute);
    font-family: var(--mono);
    font-size: 0.68rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .theme-switcher select {
    min-height: 30px;
    font-size: 0.75rem;
    padding: 4px 22px 4px 7px;
    color: var(--ink);
    background: var(--paper);
  }
  .theme-switcher select:hover {
    border-color: var(--ink);
  }

  input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--signal);
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }
  th, td {
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid var(--rule-soft);
    vertical-align: top;
    font-size: 0.92rem;
  }
  th {
    border-bottom: 1px solid var(--rule);
    font-family: var(--mono);
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-soft);
    background: var(--paper-tint);
    font-weight: 500;
  }
  td code {
    font-family: var(--mono);
    font-size: 0.85em;
    color: var(--ink-soft);
  }
  td .pill {
    display: inline-block;
    padding: 2px 8px;
    border: 1px solid var(--rule);
    background: var(--paper);
    font-family: var(--mono);
    font-size: 0.72rem;
    letter-spacing: 0.02em;
    color: var(--ink-soft);
    margin: 2px 4px 2px 0;
  }
  td .pill.signal {
    border-color: var(--signal);
    color: var(--signal);
  }
  td .pill.warn {
    border-color: var(--warn);
    color: var(--warn);
  }
  td .pill.danger {
    border-color: var(--danger);
    color: var(--danger);
  }
  td .pill.good {
    border-color: var(--good);
    color: var(--good);
  }

  /* Reduced motion */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
      scroll-behavior: auto !important;
    }
  }

`;
