// core/statusline-style.ts — the ANSI styling slice for the /afk statusline.
//
// core/statusline.ts is deliberately PURE plain-text. This sibling adds the
// "high-tech" theme: a TWO-LINE powerline layout where each semantic group sits
// on its own wine-red background block (the block-to-block background SHIFT is
// the separator — no `/` or `|` glyphs, so it needs no powerline/Nerd font), and
// every KPI *number* is drawn as a black chip (black bg, white text).
//
//   line 1 (header, always): » project | model·effort | ctx | pr/is | +local/-local
//   line 2 (AFK, workers>0): runner | wk/res | ad/rm | rq/rh/bk/wt/tk/$ | #issues
//
// Block shades alternate WINE2/WINE in EMITTED order, so dropping an absent block
// never collapses the shift. Width-aware: Claude Code exports $COLUMNS to the
// statusline command (v2.1.153+), so line 2 fits its issue list to the budget and
// collapses the rest into `+N` (fixed 3-issue cap without COLUMNS). Each line ends
// with a reset so the block background never bleeds (per the Claude Code docs).
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
  type RepoInput,
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
/** A dim label sitting on the block field. */
const label = (text: string): string => `${DIM}${text}${WHITE}`;

/** A block content builder: given its background shade, return the painted
 * content, or null/"" to drop the block entirely. */
type Block = (bg: string) => string | null;

/**
 * Assemble present blocks into a powerline run: each block ` content ` on a
 * shade that alternates WINE2 / WINE in EMITTED order (absent blocks never
 * consume a shade slot, so the shift stays visible). `startIdx` seeds the
 * alternation; the returned `nextIdx` lets a caller continue it (the AFK line's
 * width-budgeted issue block picks up where the fixed blocks left off).
 */
function assemble(blocks: Block[], startIdx = 0): { text: string; nextIdx: number } {
  let text = "";
  let idx = startIdx;
  for (const b of blocks) {
    const bg = idx % 2 === 0 ? WINE2 : WINE;
    const content = b(bg);
    if (content === null || content === "") continue;
    text += `${bg} ${content} `;
    idx += 1;
  }
  return { text, nextIdx: idx };
}

// ---------- line 1: header ----------

/** `» bold-project dim-(branch)`. Branch truncated like the plain renderer. */
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

/** `model·effort`, or null when there is no model. */
function modelContent(claude: ClaudeInput | undefined): string | null {
  if (!claude || !claude.model) return null;
  return claude.effort ? `${claude.model}${DIM}·${WHITE}${claude.effort}` : claude.model;
}

/** `ctx<chip(tokens pct)>`, or null when context is absent. */
function ctxContent(claude: ClaudeInput | undefined, bg: string): string | null {
  if (!claude || !claude.contextTokens) return null;
  const human = humanizeTokens(claude.contextTokens);
  const value =
    claude.contextPercent === undefined ? human : `${human} ${Math.round(claude.contextPercent)}%`;
  return `${label("ctx")}${chip(value, bg)}`;
}

/** `pr<chip> is<chip>` repo-global counts, or null when both are absent/zero
 * (a both-zero read is also how a gh failure surfaces, so it stays hidden). */
function repoCountsContent(repo: RepoInput | undefined, bg: string): string | null {
  if (!repo) return null;
  const parts: string[] = [];
  if (repo.openPrs && repo.openPrs > 0) parts.push(`${label("pr")}${chip(String(repo.openPrs), bg)}`);
  if (repo.openIssues && repo.openIssues > 0)
    parts.push(`${label("is")}${chip(String(repo.openIssues), bg)}`);
  return parts.length ? parts.join(" ") : null;
}

/** `+<chip> -<chip>` LOCAL branch diff, or null when the branch is clean. */
function localDiffContent(repo: RepoInput | undefined, bg: string): string | null {
  if (!repo) return null;
  const parts: string[] = [];
  if (repo.localAdded && repo.localAdded > 0) parts.push(`${label("+")}${chip(String(repo.localAdded), bg)}`);
  if (repo.localRemoved && repo.localRemoved > 0)
    parts.push(`${label("-")}${chip(String(repo.localRemoved), bg)}`);
  return parts.length ? parts.join(" ") : null;
}

/** Line 1 — the header powerline. Always present (project is always there). */
export function renderHeaderLine(
  project: ProjectInput,
  claude: ClaudeInput | undefined,
  repo: RepoInput | undefined,
): string {
  const { text } = assemble([
    () => projectContent(project),
    () => modelContent(claude),
    (bg) => ctxContent(claude, bg),
    (bg) => repoCountsContent(repo, bg),
    (bg) => localDiffContent(repo, bg),
  ]);
  return `${text}${RESET}`;
}

// ---------- line 2: AFK ----------

/** `wk<chip>` plus `res<chip>` when the supervisor has closed any issue. */
function workersContent(afk: AfkInput, bg: string): string {
  let s = `${label("wk")}${chip(String(afk.workers), bg)}`;
  if (afk.resolved !== undefined && afk.resolved > 0)
    s += ` ${label("res")}${chip(String(afk.resolved), bg)}`;
  return s;
}

/** `ad<chip> rm<chip>` in-transit worker diff, or null when nothing moved. */
function transitContent(afk: AfkInput, bg: string): string | null {
  const parts: string[] = [];
  if (afk.added > 0) parts.push(`${label("ad")}${chip(String(afk.added), bg)}`);
  if (afk.removed > 0) parts.push(`${label("rm")}${chip(String(afk.removed), bg)}`);
  return parts.length ? parts.join(" ") : null;
}

/** `rq rh bk wt tk $` pipeline + cost, each only when > 0; null when all zero. */
function pipelineContent(afk: AfkInput, bg: string): string | null {
  const parts: string[] = [];
  if (afk.queue > 0) parts.push(`${label("rq")}${chip(String(afk.queue), bg)}`);
  if (afk.human > 0) parts.push(`${label("rh")}${chip(String(afk.human), bg)}`);
  if (afk.blocked > 0) parts.push(`${label("bk")}${chip(String(afk.blocked), bg)}`);
  if (afk.waiting !== undefined && afk.waiting > 0)
    parts.push(`${label("wt")}${chip(String(afk.waiting), bg)}`);
  if (afk.tokens !== undefined && afk.tokens > 0)
    parts.push(`${label("tk")}${chip(humanizeTokens(afk.tokens), bg)}`);
  if (afk.costUsd !== undefined && afk.costUsd > 0)
    parts.push(`${label("$")}${chip(afk.costUsd.toFixed(2), bg)}`);
  return parts.length ? parts.join(" ") : null;
}

/** Line 2 — the AFK KPIs, or null when there are no live workers. */
export function renderAfkLine(afk: AfkInput | undefined, columns: number | undefined): string | null {
  if (!afk || afk.workers <= 0) return null;

  const fixed = assemble([
    () => (afk.runner ? `${GOLD}${afk.runner}${WHITE}` : null),
    (bg) => workersContent(afk, bg),
    (bg) => transitContent(afk, bg),
    (bg) => pipelineContent(afk, bg),
  ]);

  if (afk.issues.length === 0) return `${fixed.text}${RESET}`;

  const issuesBg = fixed.nextIdx % 2 === 0 ? WINE2 : WINE;
  const showStage = afk.workers <= STAGE_MAX_WORKERS;
  const issueTok = (issue: number | string, i: number): string => {
    const stage = showStage ? afk.stages?.[i] : undefined;
    const suffix = stage ? `${DIM}·${stage}${WHITE}` : "";
    return `${label("#")}${chip(String(issue), issuesBg)}${suffix}`;
  };

  const budget = columns && columns > 0 ? columns - WIDTH_MARGIN : null;
  const wrap = (inner: string, overflow: number): string => {
    const over = overflow > 0 ? ` ${DIM}+${overflow}${WHITE}` : "";
    return `${fixed.text}${issuesBg} ${inner}${over} ${RESET}`;
  };

  const toks: string[] = [];
  let shown = 0;
  for (let i = 0; i < afk.issues.length; i++) {
    if (budget === null && shown >= ISSUE_CAP_NO_WIDTH) break;
    const next = [...toks, issueTok(afk.issues[i], i)].join(" ");
    if (budget !== null && vlen(wrap(next, afk.issues.length - shown - 1)) > budget) break;
    toks.push(issueTok(afk.issues[i], i));
    shown += 1;
  }
  return wrap(toks.join(" "), afk.issues.length - shown);
}

// ---------- assembly ----------

/** The full themed statusline: header line, plus the AFK line when workers are
 * live, joined by a newline (Claude Code renders each as a row). */
export function styleStatusline(input: StatuslineInput, columns?: number): string {
  const lines = [renderHeaderLine(input.project, input.claude, input.repo)];
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
