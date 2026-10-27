export const STYLES_LANDING = `  /* ----- Landing ----- */
  .landing {
    max-width: 720px;
    margin: 0 auto;
    padding: 32px 24px 64px;
  }
  .landing-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 1px solid var(--rule);
    padding-bottom: 16px;
    margin-bottom: 48px;
  }
  .brand {
    font-family: var(--mono);
    font-size: 0.78rem;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ink-soft);
  }
  .brand strong { color: var(--ink); font-weight: 600; }
  .version {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--ink-mute);
  }

  .landing-header-tools {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 16px;
    flex-wrap: wrap;
  }

  .landing-header .theme-switcher {
    justify-content: flex-end;
  }

  .hero h1 {
    font-size: clamp(2.2rem, 5vw, 3.4rem);
    line-height: 1.05;
    margin-bottom: 24px;
  }
  .hero h1 em {
    font-style: italic;
    color: var(--signal);
    font-weight: 600;
  }
  .hero p.lead {
    font-size: 1.1rem;
    color: var(--ink-soft);
    max-width: 56ch;
    margin: 0 0 32px;
  }

  .cta-row {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }
  .cta-row a.cta {
    font-family: var(--display);
    font-size: 1.2rem;
    padding: 14px 26px;
    border: 1px solid var(--ink);
    background: var(--ink);
    color: var(--paper);
    text-decoration: none;
    letter-spacing: 0.01em;
    transition: background 120ms ease-out, border-color 120ms ease-out,
      transform 120ms ease-out;
  }
  .cta-row a.cta:hover {
    background: var(--signal);
    border-color: var(--signal);
    transform: translate(-2px, -2px);
    box-shadow: 4px 4px 0 0 var(--ink);
    color: var(--paper);
  }
  .cta-row .cta-hint {
    font-family: var(--mono);
    font-size: 0.78rem;
    color: var(--ink-mute);
  }

  .trust {
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 12px 16px;
    border: 1px solid var(--rule-soft);
    background: var(--paper-tint);
    font-family: var(--mono);
    font-size: 0.82rem;
    color: var(--ink-soft);
    margin: 32px 0 48px;
  }
  .trust .lock {
    width: 14px;
    height: 14px;
    background:
      linear-gradient(var(--ink), var(--ink)) center 60% / 60% 2px no-repeat,
      var(--paper);
    border: 1px solid var(--ink);
    flex: 0 0 14px;
    position: relative;
  }
  .trust .lock::before {
    content: "";
    position: absolute;
    left: 2px; right: 2px; top: -6px;
    height: 8px;
    border: 1px solid var(--ink);
    border-bottom: 0;
  }

  ol.steps {
    list-style: none;
    counter-reset: step;
    padding: 0;
    margin: 0;
    border-top: 1px solid var(--rule);
  }
  ol.steps li {
    counter-increment: step;
    display: grid;
    grid-template-columns: 64px 1fr;
    gap: 16px;
    padding: 18px 0;
    border-bottom: 1px solid var(--rule-soft);
  }
  ol.steps li::before {
    content: counter(step, decimal-leading-zero);
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--ink-mute);
    align-self: start;
    padding-top: 4px;
  }
  ol.steps li h3 {
    font-size: 1.2rem;
    margin-bottom: 4px;
  }
  ol.steps li p {
    margin: 0;
    color: var(--ink-soft);
  }

  .landing-footer {
    border-top: 1px solid var(--rule);
    padding-top: 16px;
    margin-top: 48px;
    display: flex;
    justify-content: space-between;
    color: var(--ink-mute);
    font-size: 0.82rem;
  }

`;
