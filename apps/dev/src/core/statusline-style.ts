// core/statusline-style.ts — the ANSI styling slice for the /afk statusline.
//
// core/statusline.ts is deliberately PURE plain-text and SINGLE-LINE (the
// NO_COLOR / Codex-footer render). This sibling adds the theme AND the MULTI-LINE
// Claude Code layout (issue #1165): a repo-global HEADER line, always rendered,
// then ONE line per live AFK worker.
//
//   line 1 (header, ALWAYS): [wine » project (branch) v· model·effort] ctx=… 5h=… 7d=… prs=… iss=… loc=+A -R
//   line 2..N (one per live worker): the monitor's compact per-worker line
//
// Only the leading IDENTITY ZONE of line 1 (project + model·effort) carries a
// wine-red BACKGROUND; the rest of line 1 is background-transparent, each KPI a
// `key=value` pair (light-red KEY, default-fg VALUE). The header's new tokens:
// `5h=`/`7d=` are the Pro/Max rate-limit windows (rendered only when the payload
// exposes them); `prs=`/`iss=` are repo-global GitHub counts; `loc=+A -R` is the
// LOCAL branch diff vs origin/main.
//
// The per-worker lines REUSE the monitor's `renderWorkerCompactLine` verbatim
// (core/monitor.ts) — the single source of truth shared with `/afk monitor
// --once`, so the two surfaces never drift. Each line is tinted soft-red as a
// whole (a colour wrapper, never a structural rewrite) and ends with a reset so
// the background never bleeds. Zero live workers → only line 1 is emitted.
//
// CODEX keeps the single aggregate line: its `tui.status_line` footer is
// single-line only (per-runner split, ADR 0003), so the NO_COLOR path returns the
// plain single-line renderStatusline; the multi-line layout is Claude-Code-only.
//
// Everything here is PURE (inputs → string). The IO half
// (commands/statusline.ts) decides colour (NO_COLOR → the plain renderer),
// collects the live worker records, and passes `now`.

import {
  formatCacheAge,
  humanizeCount,
  humanizeTokens,
  renderStatusline,
  shortModel,
  type ClaudeInput,
  type ProjectInput,
  type RepoInput,
  type StatuslineInput,
} from "./statusline.js";
import { formatDiff, workerFields, type CompactWorker } from "./monitor.js";

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

/** `5h=<pct>% 7d=<pct>%` Pro/Max rate-limit windows, each only when the payload
 * exposed it (absent for non-Pro/Max and on the first render). */
function usageKvs(claude: ClaudeInput | undefined): string[] {
  if (!claude) return [];
  const parts: string[] = [];
  if (claude.usage5h !== undefined) parts.push(kv("5h", `${Math.round(claude.usage5h)}%`));
  if (claude.usage7d !== undefined) parts.push(kv("7d", `${Math.round(claude.usage7d)}%`));
  return parts;
}

/** `prs=<n> iss=<n>` repo-global counts, each only when > 0. When the cache
 * was served TTL-stale and refresh failed, the first rendered count carries a
 * soft age suffix so day-old counts are never silently shown as current. */
function repoCountsKv(repo: RepoInput | undefined): string[] {
  if (!repo) return [];
  const parts: string[] = [];
  const ageStr = repo.cacheAgeS !== undefined ? ` (${formatCacheAge(repo.cacheAgeS)})` : "";
  if (repo.openPrs && repo.openPrs > 0) {
    parts.push(kv("prs", String(repo.openPrs)) + ageStr);
  }
  if (repo.openIssues && repo.openIssues > 0) {
    // put age on iss= only when prs= didn't already carry it
    const issAge = ageStr && (!repo.openPrs || repo.openPrs === 0) ? ageStr : "";
    parts.push(kv("iss", String(repo.openIssues)) + issAge);
  }
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
  const tail = [ctxKv(claude), ...usageKvs(claude), ...repoCountsKv(repo), ...localDiffKv(repo)].filter(
    (x): x is string => x !== null,
  );
  if (tail.length) s += ` ${tail.join("  ")}`;
  return `${s}${RESET}`;
}

// ---------- line 2..N: one line per live worker ----------

/** The TERSE per-worker line for the Claude Code statusline (issue #1175, #1176):
 *
 *   <wID>  run=<runner> <model> <effort>  org=<afk|go>  iss=<issue-number>  <stage>  <elapsed>  loc=+A -R  tks=<h>  tls=<t> rsn=<r> txt=<x>
 *
 * A visual sibling of line 1: the `wID` is BOLD + red, and every k=v token
 * (`run=`/`iss=`/`loc=`/`tks=` and each vital `tls=`/`rsn=`/`txt=`) reuses the
 * same {@link kv} colour convention line 1 uses — light-red KEY, default-fg
 * VALUE — so no token is a distinct blob. EVERY key on this line is EXACTLY 3
 * letters (house rule, issue #1176), so the vitals renamed tools/reason/text →
 * tls/rsn/txt HERE ONLY (the monitor dashboard line keeps tools:/reason:/text:).
 * `iss=` carries the bare ISSUE NUMBER read from the worker's `current.number`
 * (populated on claim for BOTH `/afk` and `/go` lanes), NOT the old done/total
 * queue counter (meaningless for a single-issue /go run) — and the standalone
 * `#<n>` token is dropped, the `<stage>` stays bare. The truncated issue TITLE,
 * the live/quiet badge, `wait`, and `log` are DROPPED here; the fuller monitor
 * line (`renderWorkerCompactLine`) keeps them. The two share only the field data
 * ({@link workerFields}), never a renderer, so the terse form cannot bleed into
 * the monitor. `now` is an epoch in seconds. */
export function renderWorkerLine(worker: CompactWorker, now: number): string {
  const f = workerFields(worker, now);
  const runVal = [f.runner, f.model ? shortModel(f.model) : undefined, f.effort]
    .filter((x): x is string => Boolean(x))
    .join(" ");
  const parts: string[] = [];
  // wID — bold red, reusing BOLD + the SOFT red tone (no new ANSI).
  parts.push(`${BOLD}${f.workerId}${NOBOLD}`);
  parts.push(kv("run", runVal));
  // org=<afk|go> — spawn-time provenance (issue #1219). 3-letter key (house
  // rule), same kv colour convention. An unstamped worker is an afk-fleet
  // worker, so default the display to afk.
  parts.push(kv("org", f.origin || "afk"));
  // iss=<issue-number> from current.number (both /afk and /go lanes); the
  // <stage> follows bare and the legacy standalone #<n> token is dropped.
  if (f.issue !== null) {
    parts.push(kv("iss", String(f.issue)));
    if (f.stage) parts.push(f.stage);
  }
  parts.push(f.elapsed);
  parts.push(kv("loc", formatDiff(f.added, f.removed)));
  parts.push(kv("tks", humanizeCount(f.tokens)));
  // The vitals as INDIVIDUAL 3-letter k=v pairs (single-spaced group), same
  // convention. Renamed from tools/reason/text on the STATUSLINE line only.
  parts.push(`${kv("tls", String(f.tools))} ${kv("rsn", String(f.reasoning))} ${kv("txt", String(f.text))}`);
  return `${NOBG}${SOFT}${parts.join("  ")}${RESET}`;
}

// ---------- assembly ----------

/** Options for the themed multi-line render: the terminal width budget (reserved
 * for future per-line trimming), the live worker records, and `now` (epoch
 * seconds) for their elapsed clocks. */
export interface StyleOptions {
  columns?: number;
  workers?: ReadonlyArray<CompactWorker>;
  now?: number;
}

/** The full themed statusline: the header line, plus one line per live worker
 * (Claude Code renders each `\n`-separated segment as its own row). Zero workers
 * → only the header line. */
export function styleStatusline(input: StatuslineInput, opts: StyleOptions = {}): string {
  const lines = [renderHeaderLine(input.project, input.claude, input.repo)];
  const now = opts.now ?? 0;
  for (const worker of opts.workers ?? []) lines.push(renderWorkerLine(worker, now));
  return lines.join("\n");
}

/** Render the statusline, themed or plain. `color` is the switch: true → the
 * themed multi-line {@link styleStatusline} (Claude Code); false → the plain,
 * single-line {@link renderStatusline} (NO_COLOR / the Codex footer). */
export function renderStatuslineThemed(
  input: StatuslineInput,
  color: boolean,
  opts: StyleOptions = {},
): string {
  return color ? styleStatusline(input, opts) : renderStatusline(input);
}
