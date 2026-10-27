export const STYLES_LINEAR = `  /* ----- Linear-inspired alternate system ----- */
  :root[data-theme="linear"] body {
    background-image: none;
  }
  :root[data-theme="linear"] h1,
  :root[data-theme="linear"] h2,
  :root[data-theme="linear"] h3 {
    font-family: var(--sans);
    font-weight: 650;
    letter-spacing: -0.025em;
  }
  :root[data-theme="linear"] button,
  :root[data-theme="linear"] .btn,
  :root[data-theme="linear"] input[type="text"],
  :root[data-theme="linear"] input[type="url"],
  :root[data-theme="linear"] input[type="search"],
  :root[data-theme="linear"] textarea,
  :root[data-theme="linear"] select {
    border-radius: 6px;
  }
  :root[data-theme="linear"] button,
  :root[data-theme="linear"] .btn {
    font-size: 0.88rem;
    padding: 9px 14px;
  }
  :root[data-theme="linear"] button.btn-primary {
    background: var(--signal);
    border-color: var(--signal);
    color: #fff;
  }
  :root[data-theme="linear"] button.btn-primary:hover {
    background: var(--signal-soft);
    border-color: var(--signal-soft);
    color: #fff;
  }
  :root[data-theme="linear"] .theme-switcher select {
    border-radius: 6px;
  }
  :root[data-theme="linear"] .landing {
    max-width: 880px;
  }
  :root[data-theme="linear"] .hero h1 {
    max-width: 18ch;
    line-height: 1.08;
  }
  :root[data-theme="linear"] .hero h1 em {
    font-style: normal;
    color: var(--signal);
  }
  :root[data-theme="linear"] .cta-row a.cta {
    border-radius: 6px;
    background: var(--signal);
    border-color: var(--signal);
    font-family: var(--sans);
    font-size: 0.95rem;
    font-weight: 600;
  }
  :root[data-theme="linear"] .cta-row a.cta:hover {
    background: var(--signal-soft);
    border-color: var(--signal-soft);
    transform: translateY(-1px);
    box-shadow: none;
  }
  :root[data-theme="linear"] .trust {
    border-radius: 8px;
  }
  :root[data-theme="linear"] ol.steps li {
    grid-template-columns: 32px 1fr;
    gap: 12px;
  }
  :root[data-theme="linear"] ol.steps li::before {
    content: "•";
    color: var(--signal);
    font-size: 1.2rem;
    line-height: 1;
  }
  :root[data-theme="linear"] .admin-header {
    background: var(--paper-tint);
  }
  :root[data-theme="linear"] section.rail-block,
  :root[data-theme="linear"] section.panel {
    border-radius: 10px;
    box-shadow: 0 1px 2px rgba(31, 35, 45, 0.08);
  }
  :root[data-theme="linear"] .rail-track {
    gap: var(--rail-segment-gap);
  }
  :root[data-theme="linear"] .rail-segment {
    border-right: 1px solid var(--rule);
    border-radius: 8px;
  }
  :root[data-theme="linear"] .rail-segment::after {
    display: none;
  }
  :root[data-theme="linear"] .status-pill,
  :root[data-theme="linear"] td .pill {
    border-radius: 999px;
  }
  :root[data-theme="linear"] section.panel,
  :root[data-theme="linear"] section.rail-block {
    margin-bottom: 20px;
  }

  /* Responsive */
  @media (max-width: 1024px) {
    .admin-body {
      grid-template-columns: 1fr;
    }
    aside.installation {
      border-right: 0;
      border-bottom: 1px solid var(--rule);
    }
  }
  @media (max-width: 720px) {
    .landing-header {
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 16px;
    }
    .landing-header-tools {
      flex: 1 1 280px;
    }
    .header-actions {
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    main.console { padding: 16px; }
    .rail-track {
      grid-template-columns: 1fr;
      gap: 16px;
    }
    .rail-segment { border-right: 1px solid var(--rule) !important; }
    .rail-segment::after { display: none; }
    form.repo-form, form.preview-form {
      grid-template-columns: 1fr;
    }
    .panel-body { overflow-x: auto; }
  }
  @media (max-width: 360px) {
    .landing { padding: 24px 16px 48px; }
    .admin-header { flex-wrap: wrap; }
  }
`;
