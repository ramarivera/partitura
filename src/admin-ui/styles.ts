/**
 * Inline CSS for the admin UI HTML documents.
 *
 * The full stylesheet is embedded into every page rendered by
 * `src/admin-ui.ts`. Tokens define a warm-paper / near-black ink / signal-orange
 * palette with crisp 1px rules, a subtle grid texture, and typography that
 * favors a system serif display stack against a local sans fallback. There
 * are no external font or asset dependencies.
 */

import { STYLES_ADMIN } from "./styles-admin";
import { STYLES_BASE } from "./styles-base";
import { STYLES_LANDING } from "./styles-landing";
import { STYLES_LINEAR } from "./styles-linear";

export const PAGE_STYLES =
  STYLES_BASE + STYLES_LANDING + STYLES_ADMIN + STYLES_LINEAR;
