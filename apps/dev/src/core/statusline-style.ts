// core/statusline-style.ts — the ANSI styling slice for the /afk statusline.
//
// core/statusline.ts is deliberately PURE plain-text. This sibling adds the
// theme: a TWO-LINE layout where only the leading IDENTITY ZONE (project +
// model·effort) carries a wine-red BACKGROUND. Everything after it — the rest of
// line 1 and ALL of line 2 — is background-transparent, so no red block ever
// appears past the model. In the transparent zone each KPI is a `key=value`
// pair: the KEY is a very-light, high-contrast red (≈ white), the VALUE is the
// terminal's default foreground; every other glyph (runner, the `#` sigil, the
// `·stage` suffix) uses a softer, lighter red. Abbreviations are always THREE
// letters (wrk/rdy/hmn/blk/loc/wai/tok/usd; ctx/prs/iss); a diff is one
// `loc=+A -R` pair, so the signed `+A -R` is the default-fg VALUE.
//
//   line 1 (header, always): [wine » project (branch) v· model·effort] ctx=… prs=… iss=… loc=+A -R
//   line 2 (AFK, workers>0):  runner wrk=… res=… loc=+A -R rdy=… hmn=… blk=… wai=… tok=… usd=… #issues
//
// The identity zone keeps the two wine shades (WINE2 project, WINE model) so a
// faint block separator survives between them; the shift to transparent IS the
// separator from the model onward. Width-aware: Claude Code exports $COLUMNS, so
// line 2 fits its issue list to the budget and collapses the rest into `+N`.
// Each line ends with a reset so the background never bleeds.
//
// Everything here is PURE (inputs → string). The IO half
// (commands/statusline.ts) decides colour (NO_COLOR → the plain renderer) and
// passes the COLUMNS budget.

import {
  humanizeAlive,
  humanizeTokens,
  renderStatusline,
  type AfkInput,
  type ClaudeInput,
  type ProjectInput,
  type RepoInput,
  type StatuslineInput,
} from "./statusline.js";

/** Truecolor SGR helpers. */
const WINE = "\x1b[48;2;114;47;55m"; // identity-zone bg (model block)
const WINE2 = "\x1b[48;2;88;36;42m"; // identity-zone bg (project block)
const NOBG = "\x1b[49m"; // drop background → terminal default (the transparent zone)
const WHITE = "\x1b[38;2;255;255;255m"; // identity-zone text
const KEY = "\x1b[38;2;255;214;214m"; // transparent-zone KEY: very light red ≈ white, high contrast
const VAL = "\x1b[39m"; // transparent-zone VALUE: terminal default foreground
const SOFT = "\x1b[38;2;224;138;148m"; // transparent-zone general font: a lighter red (runner, +/-/# sigils, ·stage)
const DIM = "\x1b[38;2;201;150;158m"; // identity-zone branch/version
const GOLD = "\x1b[38;2;240;200;120m"; // » accent
const BOLD = "\x1b[1m";
const NOBOLD = "\x1b[22m";
const RESET = "\x1b[0m";

const BRANCH_MAX = 28;
/** Issue cap when no COLUMNS budget is available. */
const ISSUE_CAP_NO_WIDTH = 3;
/** Reserve columns for Claude Code's right-side notifications when budgeting. */
const WIDTH_MARGIN = 6;
/** Per-issue `·stage` suffixes only render at or below this worker count. */
const STAGE_MAX_WORKERS = 2;

/** Visible width of an ANSI string (escapes stripped). */
// eslint-disable-next-line no-control-regex
const vlen = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** A transparent-zone `key=value`: light-red KEY, default-fg VALUE, back to SOFT. */
const kv = (key: string, value: string): string => `${KEY}${key}=${VAL}${value}${SOFT}`;

/** The `+A -R` signed-pair value (a zero side is omitted), or null when both are
 * zero. Rendered as the VALUE of a `loc=` pair, so the `+`/`-` are default-fg. */
function signedDiff(added: number | undefined, removed: number | undefined): string | null {
  const parts: string[] = [];
  if (added && added > 0) parts.push(`+${added}`);
  if (removed && removed > 0) parts.push(`-${removed}`);
  return parts.length ? parts.join(" ") : null;
}

// ---------- identity zone (wine background) ----------

/** `» bold-project dim-(branch) dim-vX`. Branch truncated like the plain renderer. */
function projectContent(project: ProjectInput): string {
  let ref = "";
  if (project.branch) {
    const b = project.branch.length > BRANCH_MAX ? `${project.branch.slice(0, 27)}…` : project.branch;
    ref = ` ${DIM}(${b})${WHITE}`;
  } else if (project.detachedSha) {
    ref = ` ${DIM}(detached ${project.detachedSha})${WHITE}`;
  }
  const ver = project.version ? ` ${DIM}v${project.version}${WHITE}` : "";
  return `${GOLD}»${WHITE} ${BOLD}${project.basename}${NOBOLD}${ref}${ver}`;
}

/** `model·effort`, or null when there is no model. */
function modelContent(claude: ClaudeInput | undefined): string | null {
  if (!claude || !claude.model) return null;
  return claude.effort ? `${claude.model}${DIM}·${WHITE}${claude.effort}` : claude.model;
}

// ---------- line 1: header ----------

/** `ctx=<tokens pct>` in the transparent zone, or null when context is absent. */
function ctxKv(claude: ClaudeInput | undefined): string | null {
  if (!claude || !claude.contextTokens) return null;
  const human = humanizeTokens(claude.contextTokens);
  const value =
    claude.contextPercent === undefined ? human : `${human} ${Math.round(claude.contextPercent)}%`;
  return kv("ctx", value);
}

/** `prs=<n> iss=<n>` repo-global counts, each only when > 0. */
function repoCountsKv(repo: RepoInput | undefined): string[] {
  if (!repo) return [];
  const parts: string[] = [];
  if (repo.openPrs && repo.openPrs > 0) parts.push(kv("prs", String(repo.openPrs)));
  if (repo.openIssues && repo.openIssues > 0) parts.push(kv("iss", String(repo.openIssues)));
  return parts;
}

/** `loc=+A -R` LOCAL branch diff (committed + uncommitted vs origin/main), or
 * empty when the branch is clean. */
function localDiffKv(repo: RepoInput | undefined): string[] {
  if (!repo) return [];
  const value = signedDiff(repo.localAdded, repo.localRemoved);
  return value ? [kv("loc", value)] : [];
}

/** Line 1 — wine identity zone (project + model) then a transparent KPI tail. */
export function renderHeaderLine(
  project: ProjectInput,
  claude: ClaudeInput | undefined,
  repo: RepoInput | undefined,
): string {
  let s = `${WINE2}${WHITE} ${projectContent(project)} `;
  const model = modelContent(claude);
  if (model !== null) s += `${WINE}${WHITE} ${model} `;
  // Drop the background: from here on the line is transparent.
  s += `${NOBG}${SOFT}`;
  const tail = [ctxKv(claude), ...repoCountsKv(repo), ...localDiffKv(repo)].filter(
    (x): x is string => x !== null,
  );
  if (tail.length) s += ` ${tail.join("  ")}`;
  return `${s}${RESET}`;
}

// ---------- line 2: AFK (fully transparent) ----------

/** Compact model family name: `claude-opus-4-8` → `opus`, `claude-sonnet-5` → `sonnet`. */
function compactModelName(model: string): string {
  const m = model.match(/^claude-([a-z]+)-/);
  return m ? m[1] : model;
}

/** Runner label with optional compact model+effort: `claude opus-max`, `codex`. */
function formatRunnerLabel(
  runner: string | undefined,
  model: string | undefined,
  effort: string | undefined,
): string {
  if (!runner) return "";
  if (!model) return runner;
  const compact = compactModelName(model);
  return effort ? `${runner} ${compact}-${effort}` : `${runner} ${compact}`;
}

/** Line 2 — the AFK KPIs, transparent background, or null when no live workers. */
export function renderAfkLine(afk: AfkInput | undefined, columns: number | undefined): string | null {
  if (!afk || afk.workers <= 0) return null;

  const groups: string[] = [];
  const runnerLabel = formatRunnerLabel(afk.runner, afk.model, afk.effort);
  if (runnerLabel) groups.push(`${SOFT}${runnerLabel}${VAL}`);

  let workers = kv("wrk", String(afk.workers));
  if (afk.resolved !== undefined && afk.resolved > 0) workers += ` ${kv("res", String(afk.resolved))}`;
  groups.push(workers);

  const diff = signedDiff(afk.added, afk.removed);
  if (diff) groups.push(kv("loc", diff));

  const pipe: string[] = [];
  if (afk.queue > 0) pipe.push(kv("rdy", String(afk.queue)));
  if (afk.human > 0) pipe.push(kv("hmn", String(afk.human)));
  if (afk.blocked > 0) pipe.push(kv("blk", String(afk.blocked)));
  if (afk.waiting !== undefined && afk.waiting > 0) pipe.push(kv("wai", String(afk.waiting)));
  if (afk.tokens !== undefined && afk.tokens > 0) pipe.push(kv("tok", humanizeTokens(afk.tokens)));
  if (afk.costUsd !== undefined && afk.costUsd > 0) pipe.push(kv("usd", afk.costUsd.toFixed(2)));
  if (pipe.length) groups.push(pipe.join(" "));

  const fixed = `${NOBG}${SOFT} ${groups.join("  ")}`;
  if (afk.issues.length === 0) return `${fixed} ${RESET}`;

  const showStage = afk.workers <= STAGE_MAX_WORKERS;
  const issueTok = (issue: number | string, i: number): string => {
    const stage = showStage ? afk.stages?.[i] : undefined;
    const alive = afk.aliveMs?.[i];
    let suffix = stage ? `${SOFT}·${stage}` : "";
    if (alive !== undefined && alive > 0) suffix += `${SOFT}·${humanizeAlive(alive)}`;
    return `${SOFT}#${VAL}${issue}${suffix}`;
  };

  const budget = columns && columns > 0 ? columns - WIDTH_MARGIN : null;
  const wrap = (inner: string, overflow: number): string => {
    const over = overflow > 0 ? ` ${SOFT}+${overflow}` : "";
    return `${fixed}  ${inner}${over} ${RESET}`;
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
 * themed {@link styleStatusline}; false → the plain {@link renderStatusline}
 * (single line, no escapes) for NO_COLOR / non-terminal consumers. */
export function renderStatuslineThemed(
  input: StatuslineInput,
  color: boolean,
  columns?: number,
): string {
  return color ? styleStatusline(input, columns) : renderStatusline(input);
}
