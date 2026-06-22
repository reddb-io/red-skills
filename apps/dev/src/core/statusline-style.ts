// core/statusline-style.ts — the ANSI styling slice for the /afk statusline.
//
// core/statusline.ts is deliberately PURE plain-text. This sibling adds the
// "high-tech" theme: a TWO-LINE powerline layout where each semantic group sits
// on its own wine-red background block (the block-to-block background SHIFT is
// the separator — no `/` or `|` glyphs, so it needs no powerline/Nerd font), and
// every KPI *number* is drawn as a black chip (black bg, white text) for
// contrast.
//
//   line 1 (header, always): » <project> | <model·effort> | ctx<n>
//   line 2 (AFK, when workers>0): <rq rh bk backlog> | <wk ad rm #issues active>
//
// Width-aware: Claude Code exports $COLUMNS to the statusline command (v2.1.153+),
// so line 2 fits its issue list to the budget and collapses the rest into `+N`.
// Without COLUMNS it falls back to a fixed 3-issue cap. Per the Claude Code docs,
// each line ends with a reset so the block background never bleeds.
//
// Everything here is PURE (inputs → string). The IO half
// (commands/statusline.ts) decides colour (NO_COLOR → the plain renderer) and
// passes the COLUMNS budget.

import {
  humanizeTokens,
  renderStatusline,
  type AfkInput,
  type ClaudeInput,
  type ProjectInput,
  type StatuslineInput,
} from "./statusline.js";

/** Truecolor SGR helpers. WINE/WINE2 are the two block shades; chips are black. */
const WINE = "\x1b[48;2;114;47;55m";
const WINE2 = "\x1b[48;2;88;36;42m";
const BLACK = "\x1b[48;2;0;0;0m";
const WHITE = "\x1b[38;2;255;255;255m";
const DIM = "\x1b[38;2;201;150;158m";
const GOLD = "\x1b[38;2;240;200;120m";
const BOLD = "\x1b[1m";
const NOBOLD = "\x1b[22m";
const RESET = "\x1b[0m";

const BRANCH_MAX = 28;
/** Issue cap when no COLUMNS budget is available. */
const ISSUE_CAP_NO_WIDTH = 3;
/** Reserve columns for Claude Code's right-side notifications when budgeting. */
const WIDTH_MARGIN = 6;
/** Per-issue `·stage` suffixes only render at or below this worker count, so a
 * crowded fleet shows bare `#N` and stays narrow. */
const STAGE_MAX_WORKERS = 2;

/** Visible width of an ANSI string (escapes stripped). */
// eslint-disable-next-line no-control-regex
const vlen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** A KPI number as a black chip; `blockBg` restores the block background after. */
const chip = (value: string, blockBg: string): string => `${BLACK}${WHITE}${value}${blockBg}`;
/** A dim two-letter label sitting on the block field. */
const label = (text: string): string => `${DIM}${text}${WHITE}`;

/** Block 1 content: `» bold-project dim-(branch)`. Branch truncated like the
 * plain renderer (27 chars + ellipsis). */
function projectContent(project: ProjectInput): string {
  let ref = "";
  if (project.branch) {
    const b = project.branch.length > BRANCH_MAX ? `${project.branch.slice(0, 27)}…` : project.branch;
    ref = ` ${DIM}(${b})${WHITE}`;
  } else if (project.detachedSha) {
    ref = ` ${DIM}(detached ${project.detachedSha})${WHITE}`;
  }
  return `${GOLD}»${WHITE} ${BOLD}${project.basename}${NOBOLD}${ref}`;
}

/** Block 2 content: `model·effort`, or null when there is no model. */
function modelContent(claude: ClaudeInput | undefined): string | null {
  if (!claude || !claude.model) return null;
  return claude.effort ? `${claude.model}${DIM}·${WHITE}${claude.effort}` : claude.model;
}

/** Block 3 content: `ctx<chip(tokens pct)>`, or null when context is absent. */
function ctxContent(claude: ClaudeInput | undefined): string | null {
  if (!claude || !claude.contextTokens) return null;
  const human = humanizeTokens(claude.contextTokens);
  const value =
    claude.contextPercent === undefined ? human : `${human} ${Math.round(claude.contextPercent)}%`;
  return `${label("ctx")}${chip(value, WINE2)}`;
}

/** A powerline block: ` content ` painted on `bg`. */
const block = (bg: string, content: string): string => `${bg} ${content} `;

/** Line 1 — the header. Blocks alternate WINE2 / WINE / WINE2 so the background
 * shift marks each boundary. Always present (project is always there). */
export function renderHeaderLine(project: ProjectInput, claude: ClaudeInput | undefined): string {
  let line = block(WINE2, projectContent(project));
  const model = modelContent(claude);
  if (model !== null) line += block(WINE, model);
  const ctx = ctxContent(claude);
  if (ctx !== null) line += block(WINE2, ctx);
  return `${line}${RESET}`;
}

/** Line 2 — the AFK KPIs, or null when there are no live workers. Backlog block
 * (rq/rh/bk) on WINE2, active block (wk/ad/rm/wt/tk/$ + issues) on WINE. The
 * issue list fits the COLUMNS budget (or a 3-issue cap), overflow as `+N`. */
export function renderAfkLine(afk: AfkInput | undefined, columns: number | undefined): string | null {
  if (!afk || afk.workers <= 0) return null;

  const backParts: string[] = [];
  if (afk.queue > 0) backParts.push(`${label("rq")}${chip(String(afk.queue), WINE2)}`);
  if (afk.human > 0) backParts.push(`${label("rh")}${chip(String(afk.human), WINE2)}`);
  if (afk.blocked > 0) backParts.push(`${label("bk")}${chip(String(afk.blocked), WINE2)}`);
  const backBlock = backParts.length ? block(WINE2, backParts.join(" ")) : "";

  const actParts: string[] = [`${label("wk")}${chip(String(afk.workers), WINE)}`];
  if (afk.added > 0) actParts.push(`${label("ad")}${chip(String(afk.added), WINE)}`);
  if (afk.removed > 0) actParts.push(`${label("rm")}${chip(String(afk.removed), WINE)}`);
  if (afk.waiting !== undefined && afk.waiting > 0)
    actParts.push(`${label("wt")}${chip(String(afk.waiting), WINE)}`);
  if (afk.tokens !== undefined && afk.tokens > 0)
    actParts.push(`${label("tk")}${chip(humanizeTokens(afk.tokens), WINE)}`);
  if (afk.costUsd !== undefined && afk.costUsd > 0)
    actParts.push(`${label("$")}${chip(afk.costUsd.toFixed(2), WINE)}`);
  const actHead = actParts.join(" ");

  const showStage = afk.workers <= STAGE_MAX_WORKERS;
  const issueTok = (issue: number | string, i: number): string => {
    const stage = showStage ? afk.stages?.[i] : undefined;
    const suffix = stage ? `${DIM}·${stage}${WHITE}` : "";
    return ` ${label("#")}${chip(String(issue), WINE)}${suffix}`;
  };

  const budget = columns && columns > 0 ? columns - WIDTH_MARGIN : null;
  const assemble = (issuesStr: string, overflow: number): string => {
    const over = overflow > 0 ? ` ${DIM}+${overflow}${WHITE}` : "";
    return `${backBlock}${WINE} ${actHead}${issuesStr}${over} ${RESET}`;
  };

  let issuesStr = "";
  let shown = 0;
  for (let i = 0; i < afk.issues.length; i++) {
    if (budget === null && shown >= ISSUE_CAP_NO_WIDTH) break;
    const tok = issueTok(afk.issues[i], i);
    if (budget !== null && vlen(assemble(issuesStr + tok, afk.issues.length - shown - 1)) > budget) break;
    issuesStr += tok;
    shown += 1;
  }
  return assemble(issuesStr, afk.issues.length - shown);
}

/** The full themed statusline: header line, plus the AFK line when workers are
 * live, joined by a newline (Claude Code renders each as a row). */
export function styleStatusline(input: StatuslineInput, columns?: number): string {
  const lines = [renderHeaderLine(input.project, input.claude)];
  const afk = renderAfkLine(input.afk, columns);
  if (afk !== null) lines.push(afk);
  return lines.join("\n");
}

/** Render the statusline, themed or plain. `color` is the switch: true → the
 * powerline {@link styleStatusline}; false → the plain {@link renderStatusline}
 * (single line, no escapes) for NO_COLOR / non-terminal consumers. */
export function renderStatuslineThemed(
  input: StatuslineInput,
  color: boolean,
  columns?: number,
): string {
  return color ? styleStatusline(input, columns) : renderStatusline(input);
}
