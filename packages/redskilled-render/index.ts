/**
 * @reddb-io/redskilled-render — one render implementation, drawn at parameterized
 * densities.
 *
 * **The no-drift guarantee is one implementation, not one string** (ADR 0132
 * decision 1). ADR 0130 rule 10 had moved rendering into the daemon so that "the
 * string is a pure function of the payload" would keep surfaces from drifting;
 * what that bought was a statusline poorer than the one it replaced, because a
 * single rendered string cannot serve a one-line statusline and a full TUI at
 * once. This module amends the letter of that rule to serve its intent: the
 * layout lives in exactly one place, and each surface asks it for the density it
 * has room for.
 *
 * **Stateless, and it opens no transport.** A pure function from one decoded
 * payload to one drawn surface, so the same module serves a socket read, a piped
 * file and a checked-in fixture — and a fixture payload renders byte-identically
 * to a live one. Nothing here reads a clock, a directory, an environment variable
 * or a file descriptor.
 *
 * **Three densities, composed rather than duplicated.** `line` is the statusline;
 * `panel` is the middle height, whose first row IS the line; `dashboard` is the
 * table. The degradation ladder, the selection and the marks are shared by all
 * three, which is what makes "they cannot drift" rest on code instead of on a
 * shared string.
 */
export {
  decodeRedskilledPayload,
  RedskilledRenderDecodeError,
  type RedskilledRenderDecoded,
  type RedskilledRenderEncoding,
} from "./decode.js";

export {
  clamp,
  flattenPublishedLine,
  formatAgeSeconds,
  formatBytes,
  formatCount,
  formatDuration,
  formatRate,
  pad,
  shortModel,
  stripAnsi,
  width,
} from "./format.js";

export {
  BAR_AHEAD,
  BAR_CURRENT,
  BAR_DONE,
  BOLD,
  DIM,
  KEY,
  NOBG,
  NOBOLD,
  RED,
  RESET,
  SOFT,
  VAL,
  WHITE,
  WINE,
  WINE2,
} from "./palette.js";

export {
  BUDGET_BAND_MARK,
  BUDGET_SPENT_MARK,
  DEATH_MARK,
  ENGINE_BEHIND_MARK,
  LAPSED_MARK,
  LOG_LINE_MARK,
  REDSKILLED_RENDER_ABSENCE,
  UNREGISTERED_MARK,
} from "./marks.js";

export * from "./payload.js";

export {
  detailLadder,
  resolveStatuslineProjectMatch,
  selectRenderProjects,
  selectRenderWorkers,
  type RedskilledStatuslineDetail,
  type RedskilledStatuslineProjectMatch,
} from "./select.js";

export {
  redskilledStatuslineBound,
  redskilledStatuslineCharacters,
  REDSKILLED_STATUSLINE_DEFAULTS,
  renderRedskilledStatusline,
  renderRedskilledStatuslineAbsence,
  workerName,
  type RedskilledStatuslineBound,
  type RedskilledStatuslineOptions,
  type RedskilledStatuslineRender,
} from "./line.js";

export {
  REDSKILLED_PANEL_DEFAULTS,
  renderRedskilledPanel,
  type RedskilledPanel,
  type RedskilledPanelOptions,
} from "./panel.js";

export {
  compactRates,
  isRedskilledDashboard,
  progressBar,
  REDSKILLED_DASHBOARD_COLUMNS,
  REDSKILLED_DASHBOARD_DEFAULTS,
  renderRedskilledDashboard,
  type RedskilledDashboard,
  type RedskilledDashboardCells,
  type RedskilledDashboardColumn,
  type RedskilledDashboardCounts,
  type RedskilledDashboardHeader,
  type RedskilledDashboardOptions,
  type RedskilledDashboardRow,
  type RedskilledDashboardWindows,
} from "./dashboard.js";

import { decodeRedskilledPayload } from "./decode.js";
import {
  REDSKILLED_DASHBOARD_DEFAULTS,
  renderRedskilledDashboard,
  type RedskilledDashboard,
  type RedskilledDashboardOptions,
} from "./dashboard.js";
import {
  REDSKILLED_STATUSLINE_DEFAULTS,
  renderRedskilledStatusline,
  type RedskilledStatuslineOptions,
  type RedskilledStatuslineRender,
} from "./line.js";
import {
  REDSKILLED_PANEL_DEFAULTS,
  renderRedskilledPanel,
  type RedskilledPanel,
  type RedskilledPanelOptions,
} from "./panel.js";

/** How much of the machine a surface has room to draw. */
export type RedskilledRenderDensity = "line" | "panel" | "dashboard";

/**
 * One request to draw, at one density.
 *
 * A discriminated union rather than one options record with every field on it:
 * `maxWorkers` is meaningless to a table and `maxRows` is meaningless to a line,
 * and an options bag carrying both would let a caller set the one its density
 * ignores and believe it took effect.
 */
export type RedskilledRenderRequest =
  | { readonly density: "line"; readonly options?: Partial<RedskilledStatuslineOptions> }
  | { readonly density: "panel"; readonly options?: Partial<RedskilledPanelOptions> }
  | { readonly density: "dashboard"; readonly options?: Partial<RedskilledDashboardOptions> };

/** What one density drew, tagged so a caller need not re-derive which it asked for. */
export type RedskilledRendered =
  | { readonly density: "line"; readonly render: RedskilledStatuslineRender; readonly lines: readonly string[] }
  | { readonly density: "panel"; readonly render: RedskilledPanel; readonly lines: readonly string[] }
  | { readonly density: "dashboard"; readonly render: RedskilledDashboard; readonly lines: readonly string[] };

/**
 * Draw one payload at one density. PURE.
 *
 * **The one entry point, so a surface names a density rather than a module.** A
 * caller that imported `renderRedskilledDashboard` directly is doing nothing
 * wrong — the densities are public — but a surface whose height is configuration
 * (a pane an operator resizes, a tooltip that expands) needs to choose at run
 * time, and choosing between three imports is how a fourth layout gets written.
 *
 * `input` is text or an already-decoded value: the socket path holds a parsed
 * frame and a fixture path holds bytes, and both reach the same render.
 */
export function renderRedskilled(
  input: string | unknown,
  request: RedskilledRenderRequest = { density: "line" },
): RedskilledRendered {
  const { payload } = decodeRedskilledPayload(input);
  if (request.density === "dashboard") {
    const render = renderRedskilledDashboard(payload, { ...REDSKILLED_DASHBOARD_DEFAULTS, ...request.options });
    return { density: "dashboard", render, lines: render.lines };
  }
  if (request.density === "panel") {
    const render = renderRedskilledPanel(payload, { ...REDSKILLED_PANEL_DEFAULTS, ...request.options });
    return { density: "panel", render, lines: render.lines };
  }
  const render = renderRedskilledStatusline(payload, { ...REDSKILLED_STATUSLINE_DEFAULTS, ...request.options });
  return { density: "line", render, lines: render.lines };
}
