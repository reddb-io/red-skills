// core/statusline-style.ts — the ANSI styling slice for the /afk statusline.
//
// core/statusline.ts is deliberately PURE plain-text and SINGLE-LINE (the
// NO_COLOR / Codex-footer render). This sibling adds the theme AND the MULTI-LINE
// Claude Code layout (issue #1165): a repo-global HEADER line, always rendered,
// then ONE line per live AFK worker.
//
//   line 1 (header, ALWAYS): [brand » project (branch) v· model·effort] ctx=… 5h=… 7d=… prs=… iss=… loc=+A -R
//   line 2..N (one per live worker): the terse per-worker statusline line
//
// Only the leading IDENTITY ZONE of line 1 (project + model·effort) carries a
// brand BACKGROUND; the rest of line 1 is background-transparent, each KPI a
// `key=value` pair (paper KEY, default-fg VALUE). The header's new tokens:
// `5h=`/`7d=` are the Pro/Max rate-limit windows (rendered only when the payload
// exposes them); `prs=`/`iss=` are repo-global GitHub counts; `loc=+A -R` is the
// LOCAL branch diff vs origin/main.
//
// The per-worker lines share the monitor's `workerFields` data extraction
// (core/monitor.ts) and keep the same vitals vocabulary (`tls`/`rsn`/`txt`),
// while rendering the compact Claude Code-specific layout. Each line follows
// the neutral hierarchy and ends with a reset so the background never bleeds. Zero live
// workers → only line 1 is emitted.
//
// CODEX keeps the single aggregate line: its `tui.status_line` footer is
// single-line only (per-runner split, ADR 0003), so the NO_COLOR path returns the
// plain single-line renderStatusline; the multi-line layout is Claude-Code-only.
//
// Everything here is PURE (inputs → string). The IO half
// (commands/statusline.ts) decides colour (NO_COLOR → the plain renderer),
// collects the live worker records, and passes `now`.

import {
  humanizeCount,
  humanizeTokens,
  renderFleetBlock,
  renderValidationGateBlock,
  renderProjectVersionLabel,
  renderRspBlock,
  renderUnlandedDocsBlock,
  renderStatuslineWithPreset,
  shortModel,
  type ClaudeInput,
  type FleetInput,
  type DocsInput,
  type ProjectInput,
  type RepoInput,
  type RspStatusInput,
  type ValidationGateInput,
  type StatuslinePreset,
  type StatuslineInput,
} from "./statusline.js";
import {
  tokenToAnsiBackground,
  tokenToAnsiForeground,
} from "@reddb-io/brand-tokens";
import { AFK_PHASE_ORDER, isLandingPhase, macroPhase } from "./mirror.js";
import { formatDiff, workerFields, type CompactWorker } from "./monitor.js";

/** Brand-token-derived SGR paint. */
const BRAND_BACKGROUND = tokenToAnsiBackground("brand.primary");
const BRAND_INK = tokenToAnsiForeground("brand.on-primary");
const MODEL_BACKGROUND = tokenToAnsiBackground("neutral.900");
const PAPER = tokenToAnsiForeground("paper");
const NOBG = "\x1b[49m"; // drop background → terminal default (the transparent zone)
const KEY = PAPER;
const VAL = "\x1b[39m"; // transparent-zone VALUE: terminal default foreground
const SOFT = tokenToAnsiForeground("neutral.400");
const DIM = tokenToAnsiForeground("neutral.500");
const SPOTLIGHT = tokenToAnsiForeground("red.500");
const BOLD = "\x1b[1m";
const NOBOLD = "\x1b[22m";
const RESET = "\x1b[0m";

const BRANCH_MAX = 28;
const WORKER_GUTTER = "  ";

type WorkerColumn =
  | "workerId"
  | "run"
  | "org"
  | "iss"
  | "lifecycle"
  | "phase"
  | "elapsed"
  | "heartbeat"
  | "loc"
  | "tks"
  | "tls"
  | "rsn"
  | "txt";
const WORKER_COLUMNS: readonly WorkerColumn[] = [
  "workerId",
  "run",
  "org",
  "iss",
  "lifecycle",
  "phase",
  "elapsed",
  "heartbeat",
  "loc",
  "tks",
  "tls",
  "rsn",
  "txt",
];
const SHORT_WORKER_COLUMNS: readonly WorkerColumn[] = ["workerId", "iss", "lifecycle", "phase", "elapsed", "heartbeat"];
type WorkerCells = Record<WorkerColumn, string>;
type WorkerWidths = Record<WorkerColumn, number>;
const NO_AGENT_ORIGINS = new Set(["requeue"]);

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

function padVisible(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

/** A transparent-zone `key=value`: paper KEY, default-fg VALUE, back to SOFT. */
const kv = (key: string, value: string): string => `${KEY}${key}=${VAL}${value}${SOFT}`;

/** The `+A -R` signed-pair value (a zero side is omitted), or null when both are
 * zero. Rendered as the VALUE of a `loc=` pair, so the `+`/`-` are default-fg. */
function signedDiff(added: number | undefined, removed: number | undefined): string | null {
  const parts: string[] = [];
  if (added && added > 0) parts.push(`+${added}`);
  if (removed && removed > 0) parts.push(`-${removed}`);
  return parts.length ? parts.join(" ") : null;
}

function tokenDisplay(f: ReturnType<typeof workerFields>): string {
  return f.runner === "claude" && f.tokens === 0 ? "—" : humanizeCount(f.tokens);
}

function heartbeatAge(ms: number | undefined): string {
  if (ms === undefined) return "?";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/** Compact proof-of-life sourced from the same evaluator verdict as
 * `worker_vitals`: fresh `3s`, quiet `~11m`, live descendant `+`, wedged `!`. */
function heartbeatDisplay(worker: CompactWorker): string {
  const verdict = worker.livenessVerdict;
  if (!verdict) return "?";
  const age = heartbeatAge(verdict.laneAgeMs);
  if (verdict.status === "stalled") return `!${age}`;
  if (verdict.laneFresh) return age;
  return `~${age}${verdict.liveDescendants === true ? "+" : ""}`;
}

/** A declared child wait owns the liveness cell while it is active. Showing the
 * stale agent heartbeat beside a healthy gate child is the false alarm this
 * cell exists to prevent; unexplained silence still keeps the alarming `hb=`. */
function proofOfLifeCell(worker: CompactWorker, fields: ReturnType<typeof workerFields>): string {
  return fields.wait ?? `hb=${heartbeatDisplay(worker)}`;
}

// ---------- identity zone (brand field) ----------

/** `» bold-project dim-(branch) dim-vX`. Branch truncated like the plain renderer. */
function projectContent(project: ProjectInput, includeVersion = true): string {
  let ref = "";
  if (project.branch) {
    const b = project.branch.length > BRANCH_MAX ? `${project.branch.slice(0, 27)}…` : project.branch;
    ref = ` (${b})`;
  } else if (project.detachedSha) {
    ref = ` (detached ${project.detachedSha})`;
  }
  const version = includeVersion ? renderProjectVersionLabel(project, "always") : null;
  const ver = version ? ` ${version}` : "";
  return `» ${BOLD}${project.basename}${NOBOLD}${ref}${ver}`;
}

/** `model·effort`, or null when there is no model. */
function modelContent(claude: ClaudeInput | undefined): string | null {
  if (!claude || !claude.model) return null;
  return claude.effort ? `${claude.model}·${claude.effort}` : claude.model;
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

/** `prs=<n> cpr=<n> iss=<n>` repo-global counts, each only when > 0. They carry
 * no age here: the remote counters are the daemon's, dated one by one on its
 * payload (ADR 0141 decision 2), and this render draws what a caller states. */
function repoCountsKv(repo: RepoInput | undefined): string[] {
  if (!repo) return [];
  const parts: string[] = [];
  if (repo.openPrs && repo.openPrs > 0) parts.push(kv("prs", String(repo.openPrs)));
  if (repo.todayPrs && repo.todayPrs > 0) parts.push(kv("cpr", String(repo.todayPrs)));
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

function fleetKv(fleet: FleetInput | undefined): string[] {
  const block = renderFleetBlock(fleet);
  return block ? [block] : [];
}

function docsKv(docs: DocsInput | undefined): string[] {
  const block = renderUnlandedDocsBlock(docs);
  return block ? [block] : [];
}

function validationGateKv(gate: ValidationGateInput | undefined): string[] {
  const block = renderValidationGateBlock(gate);
  return block ? [block] : [];
}

function rspKv(rsp: RspStatusInput | undefined): string[] {
  const block = renderRspBlock(rsp);
  if (!rsp || !block) return [];
  if (rsp.state === "ready") return [`${SOFT}${block}${SOFT}`];
  if (rsp.state === "error") return [`${SPOTLIGHT}${block}${SOFT}`];
  return [`${DIM}${block}${SOFT}`];
}

/** Line 1 — brand identity plus a receded model block, then a transparent KPI tail. */
export function renderHeaderLine(
  project: ProjectInput,
  claude: ClaudeInput | undefined,
  repo: RepoInput | undefined,
  fleet?: FleetInput,
  preset: StatuslinePreset = "full",
  rsp?: RspStatusInput,
  docs?: DocsInput,
  validationGate?: ValidationGateInput,
): string {
  let s = `${BRAND_BACKGROUND}${BRAND_INK} ${projectContent(project, preset === "full")} `;
  const model = modelContent(claude);
  if (preset === "full" && model !== null) s += `${MODEL_BACKGROUND}${PAPER} ${model} `;
  // Drop the background: from here on the line is transparent.
  s += `${NOBG}${SOFT}`;
  const tail = preset === "short"
    ? [
        ctxKv(claude),
        repo && repo.openIssues && repo.openIssues > 0 ? kv("iss", String(repo.openIssues)) : null,
        ...rspKv(rsp),
      ].filter((x): x is string => x !== null)
    : [
        ctxKv(claude),
        ...usageKvs(claude),
        ...repoCountsKv(repo),
        ...localDiffKv(repo),
        ...docsKv(docs),
        ...fleetKv(fleet),
        ...validationGateKv(validationGate),
        ...rspKv(rsp),
      ].filter((x): x is string => x !== null);
  if (tail.length) s += ` ${tail.join("  ")}`;
  return `${s}${RESET}`;
}

// ---------- line 2..N: one line per live worker ----------

/**
 * The worker's progress cell: pipeline `phase` joined to the momentary
 * `activity` as `phase·activity` (`coding·impl`, `validating·typecheck`).
 *
 * Both halves are load-bearing and neither subsumes the other. `phase` answers
 * "where in the pipeline is this worker?" and moves only at hard boundaries;
 * `activity` answers "what is it doing right now?" and is derived per stream
 * event. A no-agent gate row carries no phase but a very informative activity
 * (`typecheck`, `lint`); a worker between stream events carries a phase but no
 * activity. Either half alone therefore renders bare, without a dangling `·`.
 */
function progressCell(phase: string, activity: string): string {
  return [phase, activity].filter(Boolean).join("·");
}

// Lifecycle-bar ramp: completed, current, and future are neutral intensity.
// A failed/parked cursor changes glyph as well as taking the sole spotlight.
const BAR_DONE = tokenToAnsiForeground("neutral.300");
const BAR_CURRENT = tokenToAnsiForeground("neutral.0");
const BAR_AHEAD = tokenToAnsiForeground("neutral.700");

function lifecycleBar(phase: string, failed: boolean): string {
  const current = Math.max(0, (AFK_PHASE_ORDER as readonly string[]).indexOf(macroPhase(phase)));
  if (current === AFK_PHASE_ORDER.length - 1) {
    return `${BAR_DONE}${"█".repeat(AFK_PHASE_ORDER.length)}${SOFT}`;
  }
  const cursor = failed ? `${SPOTLIGHT}!` : `${BAR_CURRENT}▶`;
  return `${BAR_DONE}${"█".repeat(current)}${cursor}${BAR_AHEAD}${"░".repeat(AFK_PHASE_ORDER.length - current - 1)}${SOFT}`;
}

function workerCells(worker: CompactWorker, now: number): WorkerCells {
  const f = workerFields(worker, now);
  const runVal = [f.runner, f.model ? shortModel(f.model) : undefined, f.effort]
    .filter((x): x is string => Boolean(x))
    .join(" ");
  const landing = isLandingPhase(f.phase);
  const noAgent = landing || (f.origin !== undefined && NO_AGENT_ORIGINS.has(f.origin));
  const failed = worker.state.blocked > 0 || worker.state.failed > 0;
  return {
    workerId: f.workerId,
    run: `run=${runVal}`,
    org: `org=${landing ? "landing" : f.origin || "afk"}`,
    iss: f.issue === null ? "" : `iss=${String(f.issue)}`,
    lifecycle: f.issue === null ? "" : lifecycleBar(f.phase, failed),
    phase: f.issue === null ? "" : progressCell(f.phase, f.activity),
    elapsed: f.elapsed,
    heartbeat: proofOfLifeCell(worker, f),
    loc: noAgent ? "" : `loc=${formatDiff(f.added, f.removed)}`,
    tks: noAgent ? "" : `tks=${tokenDisplay(f)}`,
    tls: noAgent ? "" : `tls=${String(f.tools)}`,
    rsn: noAgent ? "" : `rsn=${String(f.reasoning)}`,
    txt: noAgent ? "" : `txt=${String(f.text)}`,
  };
}

function workerWidths(rows: readonly WorkerCells[], columns: readonly WorkerColumn[] = WORKER_COLUMNS): WorkerWidths {
  const widths = Object.fromEntries(WORKER_COLUMNS.map((column) => [column, 0])) as WorkerWidths;
  for (const row of rows) {
    for (const column of columns) widths[column] = Math.max(widths[column], visibleWidth(row[column]));
  }
  return widths;
}

function colorWorkerCell(column: WorkerColumn, raw: string): string {
  if (column === "workerId") return `${BOLD}${raw}${NOBOLD}`;
  const eq = raw.indexOf("=");
  if (eq > 0) return `${KEY}${raw.slice(0, eq + 1)}${VAL}${raw.slice(eq + 1)}${SOFT}`;
  return raw;
}

function formatWorkerCells(
  row: WorkerCells,
  widths: WorkerWidths,
  columns: readonly WorkerColumn[] = WORKER_COLUMNS,
): string {
  const parts = columns.map((column) => colorWorkerCell(column, padVisible(row[column], widths[column])));
  return `${NOBG}${SOFT}${parts.join(WORKER_GUTTER)}${RESET}`;
}

function renderWorkerLines(
  workers: ReadonlyArray<CompactWorker>,
  now: number,
  preset: StatuslinePreset = "full",
): string[] {
  const rows = workers.map((worker) => workerCells(worker, now));
  const columns = preset === "short" ? SHORT_WORKER_COLUMNS : WORKER_COLUMNS;
  const widths = workerWidths(rows, columns);
  return rows.map((row) => formatWorkerCells(row, widths, columns));
}

/** The TERSE per-worker line for the Claude Code statusline (issue #1175, #1176):
 *
 *   <wID>  run=<runner> <model> <effort>  org=<afk|go>  iss=<issue-number>  <phase>  <elapsed>  loc=+A -R  tks=<h>  tls=<t> rsn=<r> txt=<x>
 *
 * A visual sibling of line 1: the `wID` is BOLD + red, and every k=v token
 * (`run=`/`iss=`/`loc=`/`tks=` and each vital `tls=`/`rsn=`/`txt=`) reuses the
 * same {@link kv} colour convention line 1 uses — paper KEY, default-fg
 * VALUE — so no token is a distinct blob. Existing keys stay exactly 3 letters
 * (house rule, issue #1176); the proof-of-life token keeps the canonical `hb=`
 * spelling from #2480. The vitals use the shared monitor/statusline
 * vocabulary `tls`/`rsn`/`txt` for tools, reasoning, and text activity.
 * `iss=` carries the bare ISSUE NUMBER read from the worker's `current.number`
 * (populated on claim for BOTH `/afk` and `/go` lanes), NOT the old done/total
 * queue counter (meaningless for a single-issue /go run) — and the standalone
 * `#<n>` token is dropped, the `<phase>` stays bare. The truncated issue TITLE,
 * the live/quiet badge, `wait`, and `log` are DROPPED here; the fuller monitor
 * line (`renderWorkerCompactLine`) keeps them. The two share only the field data
 * ({@link workerFields}), never a renderer, so the terse form cannot bleed into
 * the monitor. `now` is an epoch in seconds. */
export function renderWorkerLine(worker: CompactWorker, now: number, preset: StatuslinePreset = "full"): string {
  const f = workerFields(worker, now);
  const failed = worker.state.blocked > 0 || worker.state.failed > 0;
  if (preset === "short") {
    const parts: string[] = [`${BOLD}${f.workerId}${NOBOLD}`];
    if (f.issue !== null) {
      parts.push(kv("iss", String(f.issue)));
      parts.push(lifecycleBar(f.phase, failed));
      const progress = progressCell(f.phase, f.activity);
      if (progress) parts.push(progress);
    }
    parts.push(f.elapsed);
    const pulse = proofOfLifeCell(worker, f);
    const eq = pulse.indexOf("=");
    parts.push(eq > 0 ? kv(pulse.slice(0, eq), pulse.slice(eq + 1)) : pulse);
    return `${NOBG}${SOFT}${parts.join("  ")}${RESET}`;
  }
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
  const landing = isLandingPhase(f.phase);
  parts.push(kv("org", landing ? "landing" : f.origin || "afk"));
  // Per-worker fleet attribution is deliberately NOT rendered (#2568): which
  // fleet owns a worker stays available in fleet_status/worker_status; on the
  // statusline it was noise.
  // iss=<issue-number> from current.number (both /afk and /go lanes); the
  // <phase·activity> cell follows bare and the legacy standalone #<n> token is
  // dropped.
  if (f.issue !== null) {
    parts.push(kv("iss", String(f.issue)));
    parts.push(lifecycleBar(f.phase, failed));
    const progress = progressCell(f.phase, f.activity);
    if (progress) parts.push(progress);
  }
  parts.push(f.elapsed);
  const pulse = proofOfLifeCell(worker, f);
  const eq = pulse.indexOf("=");
  parts.push(eq > 0 ? kv(pulse.slice(0, eq), pulse.slice(eq + 1)) : pulse);
  if (landing || (f.origin !== undefined && NO_AGENT_ORIGINS.has(f.origin))) {
    return `${NOBG}${SOFT}${parts.join("  ")}${RESET}`;
  }
  parts.push(kv("loc", formatDiff(f.added, f.removed)));
  parts.push(kv("tks", tokenDisplay(f)));
  // The vitals as INDIVIDUAL 3-letter k=v pairs (single-spaced group), same
  // convention and vocabulary as the monitor dashboard.
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
  preset?: StatuslinePreset;
}

/** The full themed statusline: the header line, plus one line per live worker
 * (Claude Code renders each `\n`-separated segment as its own row). Zero workers
 * → only the header line. */
export function styleStatusline(input: StatuslineInput, opts: StyleOptions = {}): string {
  const preset = opts.preset ?? "full";
  const lines = [renderHeaderLine(
    input.project,
    input.claude,
    input.repo,
    input.fleet,
    preset,
    input.rsp,
    input.docs,
    input.validationGate,
  )];
  const now = opts.now ?? 0;
  lines.push(...renderWorkerLines(opts.workers ?? [], now, preset));
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
  const preset = opts.preset ?? "full";
  return color ? styleStatusline(input, opts) : renderStatuslineWithPreset(input, preset);
}
