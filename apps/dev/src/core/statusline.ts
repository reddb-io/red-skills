// Port of the RENDER path of statusline.sh — the /afk statusline aggregator for
// Claude Code. statusline.sh reads the Claude Code stdin JSON payload (cwd,
// model, effort, context window, rate limits) and combines it with live /afk
// worker state from <root>/.red/tmp/workers/*/* to emit ONE compact line like:
//
//   red-skills · Opus·high · 47k 24% · 5h=23% 7d=41% · prs=3 iss=24 loc=+142 -36 · wrk=4 rdy=1 hmn=11 blk=10 loc=+12 -3 #17
//
// This module is the SINGLE-LINE plain form — the NO_COLOR / Codex-footer render.
// The themed Claude Code render is MULTI-LINE (issue #1165): a repo-global header
// line plus one line per live AFK worker. That layout lives in the sibling style
// module (core/statusline-style.ts); this file stays one aggregate line.
//
// The AFK KPIs use three-letter `key=value` mnemonics
// (wrk/rdy/hmn/blk/loc/wai/tok/usd) instead of emojis; the optional ANSI
// theming (a short wine identity zone, then a transparent key=value tail) lives
// in the sibling style module, not here.
//
// The render here is PURE — no stdin parse, no filesystem, no git/gh, no cache,
// no ANSI. The caller injects the already-resolved inputs (project basename +
// branch, model + effort, context tokens + percent, and the aggregated worker
// counts), and this module assembles the exact plain-text line byte-for-byte
// with statusline.sh's section assembly and optional-drop behaviour. The stdin
// parse, the worker-state read, the git/gh reads, the 240 s GitHub-count cache,
// and the OSC-8/ANSI colouring all belong to the orchestration slice and are
// out of scope — the test asserts the plain/structural content exactly as
// statusline.test.sh does after stripping escapes.

import { compareSemver } from "./bundle-version.js";

/**
 * `claude-opus-4-8` → `opus`, for the themed per-worker `run=` label (#1175).
 *
 * The shortening is pure string work over a display string, so it lives with the
 * other layout primitives in `@reddb-io/redskilled-render` (#3150) and is
 * re-exported here for the siblings that already ask this module for their
 * formatting. Two spellings of one shortening is the drift the move ends.
 */
export { shortModel } from "@reddb-io/redskilled-render/format.js";

/** The block-1 project inputs: basename plus optional git ref. */
export interface ProjectInput {
  /** `basename "$cwd"` — always present. */
  basename: string;
  /** `git symbolic-ref --short HEAD` when on a branch; "" / undefined otherwise. */
  branch?: string;
  /** `git rev-parse --short HEAD` when detached (used only when branch is absent). */
  detachedSha?: string;
  /** Running `dev` plugin/bundle version (e.g. `1.233.0`), from build-info.
   * Rendered as a dim `v<version>` tag on the themed header line so the user can
   * see which RedSkills version is producing the statusline. Themed line only. */
  version?: string;
  /** Newest locally cached `dev` bundle version. The render path uses this
   * cache-only fact to mark a stale session without doing network discovery. */
  latestCachedVersion?: string;
  /** Stable pointer version from the local bundle cache, when present. */
  pointerVersion?: string;
}

/** The block-2/3 Claude Code payload inputs. */
export interface ClaudeInput {
  /** `.model.display_name`; "" / undefined outside Claude Code → no model block. */
  model?: string;
  /** `.effort.level`; appended as `model·effort` when both present. */
  effort?: string;
  /** `.context_window.total_input_tokens`; 0 / undefined → no context block. */
  contextTokens?: number;
  /** `.context_window.used_percentage`; rounded to an int and suffixed with `%`. */
  contextPercent?: number;
  /** `.rate_limits.five_hour.used_percentage` — the rolling 5-hour usage window
   * Claude Code exposes for Pro/Max accounts AFTER the first API response of the
   * session (absent for non-Pro/Max and on the very first render). Rendered as a
   * `5h=<pct>%` token, only when present, so its absence is graceful. */
  usage5h?: number;
  /** `.rate_limits.seven_day.used_percentage` — the rolling weekly usage window,
   * same Pro/Max-only availability as {@link usage5h}. Rendered as `7d=<pct>%`,
   * only when present. */
  usage7d?: number;
}

/** The block-4 aggregated worker counts, already summed across live workers. */
export interface AfkInput {
  /** `wk` — number of live workers. */
  workers: number;
  /** `rq` — cached ready-for-agent (queue) count. */
  queue: number;
  /** `rh` — cached ready-for-human count. */
  human: number;
  /** `qtn` — cached ADR 0122 issue quarantine count. */
  quarantine?: number;
  /** `bk` — summed blocked count. */
  blocked: number;
  /** `adN` — summed insertions. */
  added: number;
  /** `rmN` — summed deletions. */
  removed: number;
  /** `wt` — summed `waiting_count` (heartbeat windows with zero new stream events)
   * across live workers. A rising value between glances is the clean
   * stuck-vs-working signal (silent agent), so it is shown only when > 0. */
  waiting?: number;
  /** `tk` — summed token spend (input + output) across live workers (ADR 0065 cost
   * group). Humanized (e.g. `tk12k`); shown only when > 0. */
  tokens?: number;
  /** `$` — summed USD cost across live workers, shown only when > 0 (most runners
   * report tokens but not cost, so this is frequently absent). */
  costUsd?: number;
  /** The fleet runner (`claude` / `codex` / `minimax` / …); first non-empty
   * across live workers. Rendered as a literal label leading the AFK line.
   * Themed line 2 only; absent on pre-runner state files. */
  runner?: string;
  /** `res` — issues the current supervisor has closed this session (the worker
   * state's `done`, the monitor's `issues done/total`). Themed line 2 only. */
  resolved?: number;
  /** #N issue numbers for the in-progress workers, in order. */
  issues: ReadonlyArray<number | string>;
  /** When true, {@link added}/{@link removed} reflect the per-attempt peak rather
   * than the live diff (current diff measured 0 but a prior non-zero value was
   * seen this attempt). The `loc=` token renders with a `~` prefix on its value
   * (`loc=~+50 -3`) to signal "last known, not current." */
  locIsPeak?: boolean;
  /** Per-issue `current.phase` aligned by index with {@link issues}. When a
   * phase is present and non-empty it renders as a `·phase` suffix on the
   * matching `#N` token (`#629·coding`), so the block shows WHERE each live
   * worker is in the pipeline. Absent/short arrays fall back to bare `#N`. */
  phases?: ReadonlyArray<string | undefined>;
  /** Per-issue worker alive time in milliseconds, aligned by index with
   * {@link issues}. Derived from the worker's top-level `started_at` timestamp.
   * When present and > 0, rendered as a human-friendly elapsed suffix after the
   * phase on each `#N` token (`#629·coding·5m`, `#817·setup·1h22m`). */
  aliveMs?: ReadonlyArray<number>;
  /** First non-empty model identifier across live workers (e.g. `claude-opus-4-8`).
   * Compact form rendered alongside `runner` on themed line 2 as `claude opus-max`.
   * Absent when no live worker has a non-empty model (pre-schema state files). */
  model?: string;
  /** First non-empty effort level across live workers (e.g. `max`, `high`).
   * Paired with `model` on the themed runner label (`claude opus-max`). */
  effort?: string;
  /** Per-origin worker counts derived from `state.origin` across live workers.
   * Populated by the IO layer (wire.ts collectStatuslineAfk) reading the SINGLE
   * `origin` field on each worker state; absent when no live worker has a
   * non-empty origin. Sorted by origin for a deterministic token order.
   * Rendered as `go=N afk=M` tokens immediately after `wrk=<total>`. */
  sourceCounts?: ReadonlyArray<{ origin: string; count: number }>;
  /** Age in seconds of the queue/human count cache when it was served TTL-stale
   * AND the background refresh failed or timed out. Absent when the cache was
   * fresh or the refresh succeeded. When set, the `rdy=` (or `hmn=`) token
   * carries a compact age suffix — e.g. `rdy=3 (12m)` — so stale counts are
   * never silently rendered as current. */
  cacheAgeS?: number;
}

/** Repo-global header inputs (themed line 1, always rendered). Independent of
 * live AFK workers: it shows where the repo stands even when nothing is running. */
export interface RepoInput {
  /** `pr` — open pull-request count (repo-global, GitHub-derived). */
  openPrs?: number;
  /** `cpr` — pull requests created on the local calendar day (GitHub-derived). */
  todayPrs?: number;
  /** `is` — open issue count (repo-global, GitHub-derived). */
  openIssues?: number;
  /** `+N` — LOCAL branch insertions (committed + uncommitted vs origin/main). */
  localAdded?: number;
  /** `-N` — LOCAL branch deletions (committed + uncommitted vs origin/main). */
  localRemoved?: number;
  /** Age in seconds of the PR/issue count cache when served TTL-stale and the
   * refresh failed or timed out. Absent when the cache was fresh or refresh
   * succeeded. When set, the `prs=` (or `iss=`) token carries a compact age
   * suffix so stale counts are not silently shown as current. */
  cacheAgeS?: number;
}

/** Cached/local unlanded `.red/` docs count. */
export interface DocsInput {
  /** `doc` — unlanded glossary/ADR docs detected from local git state. */
  count: number;
}

/** Repo-global fleet-supervisor segment, independent of live worker rows. */
export interface FleetInput {
  /** Supervisor runner (`codex`, `claude`, `opencode`, ...). */
  runner: string;
  /** Busy slots from the supervisor snapshot. */
  busy: number;
  /** Total slots from the supervisor snapshot. */
  total: number;
  /** Ready-for-agent queue depth from the supervisor snapshot. */
  queue: number;
  /** Parked slots from the supervisor snapshot. */
  parked?: number;
  /** True when supervisor busy slots are not corroborated by fresh local worker
   * liveness. Rendered as a visible marker on the occupancy token. */
  degraded?: boolean;
  /** The anchor says this snapshot has no live writer (ADR 0128 §6). Staleness
   * arrives INSIDE the payload, so the render marks the segment stale rather
   * than presenting a dead fleet's last numbers as current. */
  stale?: boolean;
  /** Age of the stale snapshot in seconds, shown beside the stale marker. */
  staleAgeS?: number;
  /** Recent death/respawn churn from the supervisor snapshot. Zero/absent stays
   * silent so healthy fleets render exactly as before. */
  churnDeaths?: number;
  churnRespawns?: number;
  churnWindowS?: number;
  /** Crashloop circuit breaker (#2527): present only while the breaker is OPEN
   * — N consecutive identical boot deaths suppressed the respawn loop. Rendered
   * as a loud token so the halted fleet is unmissable at a glance. */
  breaker?: { count: number };
  /** Dev bundle version the running supervisor was launched from. */
  bundleVersion?: string;
  /** Stable pointer version the shim would serve from the local cache. */
  pointerVersion?: string;
  /** Newest compatible dev bundle seen in the local cache. */
  latestBundleVersion?: string;
}

export type RspStatusInput =
  | {
      state: "ready";
      tokensSavedToday: number;
      dollarsSavedTodayUsd?: number;
      showHitRate?: number;
      decisions?: { contributed: number; seen: number };
    }
  | { state: "warming" }
  | { state: "error" };

/** All the resolved inputs for one statusline render. */
export interface StatuslineInput {
  project: ProjectInput;
  claude?: ClaudeInput;
  repo?: RepoInput;
  docs?: DocsInput;
  fleet?: FleetInput;
  afk?: AfkInput;
  rsp?: RspStatusInput;
}

export type StatuslinePreset = "full" | "short";

const BRANCH_MAX = 28;

/**
 * Humanizes a token count the way statusline.sh does: `X.XM` at/above 1e6,
 * integer-division `Xk` at/above 1e3, raw integer below.
 */
export function humanizeTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.floor(tokens / 1000)}k`;
  return String(tokens);
}

/**
 * Compact SI-style humanizer for an arbitrary count (issue #1175 — the themed
 * per-worker `tks=` token). Distinct from {@link humanizeTokens} (which the
 * header/plain forms use): this one shows AT MOST one decimal in every unit and
 * strips a trailing `.0`, so 45000 → `45k` (not `45.0k`) and 1e6 → `1M`.
 *
 *   < 1e3 → the raw integer (`100`, `999`)
 *   ≥ 1e3 → `k` (`1k`, `1.2k`, `45k`, `100k`)
 *   ≥ 1e6 → `M` (`1M`, `1.1M`, `100M`)
 *   ≥ 1e9 → `B` (`1B`, `2.3B`)
 *
 * Picks the largest unit whose scaled value is ≥ 1. Negative/zero → `0`.
 */
export function humanizeCount(n: number): string {
  const scale = (v: number, suffix: string): string => {
    const s = (Math.round(v * 10) / 10).toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}${suffix}`;
  };
  if (n >= 1e9) return scale(n / 1e9, "B");
  if (n >= 1e6) return scale(n / 1e6, "M");
  if (n >= 1e3) return scale(n / 1e3, "k");
  return String(n > 0 ? n : 0);
}

function threeSigFixed(value: number): string {
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  if (value >= 1) return value.toFixed(2);
  const decimals = Math.max(2, Math.ceil(-Math.log10(value)) + 2);
  return value.toFixed(decimals);
}

function formatThreeSigValue(value: number): string {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  if (n === 0) return "0";
  if (n >= 1e9) return `${threeSigFixed(n / 1e9)}B`;
  if (n >= 1e6) return `${threeSigFixed(n / 1e6)}M`;
  if (n >= 1e3) return `${threeSigFixed(n / 1e3)}k`;
  return threeSigFixed(n);
}

export function formatRspTickerValue(tokens: number): string {
  const n = Math.max(0, Math.floor(tokens));
  if (n < 1e3) return String(n);
  if (n < 1e6) return `${(Math.floor(n / 100) / 10).toFixed(1)}k`;
  return formatThreeSigValue(n);
}

/**
 * Humanizes an elapsed duration in milliseconds to a compact human-friendly
 * string that always carries the two most-significant units once past the
 * seconds floor: `10s`, `1m10s`, `1h10m`, `1d10h`. The lower unit is shown even
 * when zero (`1h` → `1h0m`) so the magnitude never collapses to a lone number.
 * Only sub-minute values render a single unit. Zero/negative → `0s`.
 */
export function humanizeAlive(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

/**
 * Compact age string for a TTL-stale cache entry: renders seconds as `45s`,
 * whole minutes as `12m`, and hours as `1h5m` / `2h`. Used as the `(Xm)`
 * suffix on remote-count tokens when the cache was stale and refresh failed.
 */
export function formatCacheAge(ageS: number): string {
  if (ageS < 60) return `${ageS}s`;
  const m = Math.floor(ageS / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

function hasCachedUpdate(project: ProjectInput): boolean {
  return compareSemver(project.latestCachedVersion, project.version) > 0;
}

export function renderProjectVersionLabel(project: ProjectInput, mode: "always" | "update-only"): string | null {
  if (!project.version) return null;
  const update = hasCachedUpdate(project);
  if (!update && mode === "update-only") return null;
  return `v${project.version}${update ? "*" : ""}`;
}

/**
 * Block 1: `basename` plus optional ` (branch)` / ` (detached sha)`. Branches
 * longer than 28 chars are truncated to 27 chars + `…`, matching the bash
 * `${branch:0:27}…`.
 */
export function renderProjectBlock(project: ProjectInput): string {
  const base = project.basename;
  const version = renderProjectVersionLabel(project, "update-only");
  const suffix = version ? ` ${version}` : "";
  if (project.branch) {
    let branch = project.branch;
    if (branch.length > BRANCH_MAX) branch = `${branch.slice(0, 27)}…`;
    return `${base} (${branch})${suffix}`;
  }
  if (project.detachedSha) return `${base} (detached ${project.detachedSha})${suffix}`;
  return `${base}${suffix}`;
}

/** Block 2: `model` or `model·effort`; null when there is no model. */
export function renderModelBlock(claude: ClaudeInput | undefined): string | null {
  if (!claude || !claude.model) return null;
  return claude.effort ? `${claude.model}·${claude.effort}` : claude.model;
}

/**
 * Block 3: humanized tokens plus optional ` Y%`. Null when tokens are absent or
 * zero, mirroring the bash `[[ -n "$ctx_tokens" && "$ctx_tokens" != "0" ]]`
 * guard. The percent is rounded to the nearest integer like `printf '%.0f'`.
 */
export function renderContextBlock(claude: ClaudeInput | undefined): string | null {
  if (!claude) return null;
  const tokens = claude.contextTokens;
  if (tokens === undefined || tokens === 0) return null;
  const human = humanizeTokens(tokens);
  if (claude.contextPercent === undefined) return human;
  return `${human} ${Math.round(claude.contextPercent)}%`;
}

/**
 * One AFK token, split so the styling slice can paint the numeric VALUE
 * independently of its label. `label` is the leading two-letter mnemonic (`wk`,
 * `rq`, …) or sigil (`#`, `$`); `value` is the number/humanized count the chip
 * highlights; `suffix` is any trailing non-numeric text (the `·phase` on an
 * issue token). Plain render = `label + value + suffix`; styled render chips
 * only `value`. See {@link renderAfkBlock} (plain) and the style module.
 */
export interface AfkToken {
  label: string;
  value: string;
  suffix: string;
}

/**
 * The ordered AFK token model behind block 4. Each KPI is emitted only when its
 * count is > 0, in the fixed order workers `wk`, queue `rq`, human `rh`, blocked
 * `bk`, added `ad`, removed `rm`, waiting `wt`, tokens `tk`, cost `$`, followed
 * by the `#N` issue tokens (always emitted, in order, each carrying an optional
 * `·phase` suffix). Empty when there are no live workers. Two-letter mnemonics
 * replace the legacy emojis (🤖📋🆘🚧+−💤🪙💵) so the line is emoji-free and the
 * style slice can chip each numeric value.
 */
export function afkTokens(afk: AfkInput | undefined): AfkToken[] {
  if (!afk || afk.workers <= 0) return [];
  const tokens: AfkToken[] = [];
  const kpi = (label: string, value: string): void => {
    tokens.push({ label, value, suffix: "" });
  };
  if (afk.workers > 0) kpi("wrk=", String(afk.workers));
  if (afk.sourceCounts && afk.sourceCounts.length > 0) {
    for (const { origin, count } of afk.sourceCounts) kpi(`${origin}=`, String(count));
  }
  // Age marker: appended to the first rendered remote-count token so stale
  // data is never silently shown as current. rdy= takes priority; when queue
  // is 0 the marker falls to hmn= (if present). Zero/zero with a stale cache
  // shows nothing — 0/0 stale vs 0/0 fresh is indistinguishable in meaning.
  const ageSuffix = afk.cacheAgeS !== undefined ? ` (${formatCacheAge(afk.cacheAgeS)})` : "";
  if (afk.queue > 0) tokens.push({ label: "rdy=", value: String(afk.queue), suffix: ageSuffix });
  if (afk.human > 0) {
    const hmSuffix = ageSuffix && afk.queue === 0 ? ageSuffix : "";
    tokens.push({ label: "hmn=", value: String(afk.human), suffix: hmSuffix });
  }
  if (afk.quarantine !== undefined && afk.quarantine > 0) {
    const qtnSuffix = ageSuffix && afk.queue === 0 && afk.human === 0 ? ageSuffix : "";
    tokens.push({ label: "qtn=", value: String(afk.quarantine), suffix: qtnSuffix });
  }
  if (afk.blocked > 0) kpi("blk=", String(afk.blocked));
  const diff: string[] = [];
  if (afk.added > 0) diff.push(`+${afk.added}`);
  if (afk.removed > 0) diff.push(`-${afk.removed}`);
  if (diff.length) kpi("loc=", afk.locIsPeak ? `~${diff.join(" ")}` : diff.join(" "));
  if (afk.waiting !== undefined && afk.waiting > 0) kpi("wai=", String(afk.waiting));
  if (afk.tokens !== undefined && afk.tokens > 0) kpi("tok=", humanizeTokens(afk.tokens));
  if (afk.costUsd !== undefined && afk.costUsd > 0) kpi("usd=", afk.costUsd.toFixed(2));
  afk.issues.forEach((issue, i) => {
    const phase = afk.phases?.[i];
    const alive = afk.aliveMs?.[i];
    let suffix = phase ? `·${phase}` : "";
    if (alive !== undefined && alive > 0) suffix += `·${humanizeAlive(alive)}`;
    tokens.push({ label: "#", value: String(issue), suffix });
  });
  return tokens;
}

/**
 * Usage block: the Pro/Max rate-limit windows `5h=<pct>% 7d=<pct>%`, each token
 * emitted only when its payload field is present (Claude Code exposes these only
 * for Pro/Max, only after the first API response). Null when neither is present,
 * so non-Pro/Max sessions render nothing here. Percents rounded like `%.0f`.
 */
export function renderUsageBlock(claude: ClaudeInput | undefined): string | null {
  if (!claude) return null;
  const parts: string[] = [];
  if (claude.usage5h !== undefined) parts.push(`5h=${Math.round(claude.usage5h)}%`);
  if (claude.usage7d !== undefined) parts.push(`7d=${Math.round(claude.usage7d)}%`);
  return parts.length ? parts.join(" ") : null;
}

/**
 * Repo-global block: `prs=<n> iss=<n> loc=+A -R`, each token emitted only when
 * its count is > 0 (no zero-noise). The open-PR/open-issue counts are the
 * repo-global GitHub-derived figures ({@link RepoInput.openPrs}/openIssues); the
 * `loc=` diff is the LOCAL branch delta vs origin/main
 * ({@link RepoInput.localAdded}/localRemoved). When the count cache was served
 * TTL-stale and its refresh failed, the first rendered count carries a compact
 * age suffix (`prs=3 (12m)`) so a day-old count is never silently shown as
 * current — the same discipline as the AFK block's `rdy=`. Null when the whole
 * block is empty. Wired into {@link renderStatusline} so the single-line (plain /
 * Codex-footer) form carries the repo header stats too, not only the themed one.
 */
export function renderRepoBlock(repo: RepoInput | undefined): string | null {
  if (!repo) return null;
  const parts: string[] = [];
  const ageSuffix = repo.cacheAgeS !== undefined ? ` (${formatCacheAge(repo.cacheAgeS)})` : "";
  if (repo.openPrs && repo.openPrs > 0) parts.push(`prs=${repo.openPrs}${ageSuffix}`);
  if (repo.todayPrs && repo.todayPrs > 0) {
    // cpr= carries the age suffix only when prs= didn't already carry it.
    const cprAge = ageSuffix && (!repo.openPrs || repo.openPrs === 0) ? ageSuffix : "";
    parts.push(`cpr=${repo.todayPrs}${cprAge}`);
  }
  if (repo.openIssues && repo.openIssues > 0) {
    // Age marker falls to iss= only when neither prs= nor cpr= already carried it.
    const issAge =
      ageSuffix && (!repo.openPrs || repo.openPrs === 0) && (!repo.todayPrs || repo.todayPrs === 0)
        ? ageSuffix
        : "";
    parts.push(`iss=${repo.openIssues}${issAge}`);
  }
  const diff: string[] = [];
  if (repo.localAdded && repo.localAdded > 0) diff.push(`+${repo.localAdded}`);
  if (repo.localRemoved && repo.localRemoved > 0) diff.push(`-${repo.localRemoved}`);
  if (diff.length) parts.push(`loc=${diff.join(" ")}`);
  return parts.length ? parts.join(" ") : null;
}

/** Short preset line-1 repo token: only the open issue count survives. */
export function renderShortRepoBlock(repo: RepoInput | undefined): string | null {
  if (!repo || !repo.openIssues || repo.openIssues <= 0) return null;
  const ageSuffix = repo.cacheAgeS !== undefined ? ` (${formatCacheAge(repo.cacheAgeS)})` : "";
  return `iss=${repo.openIssues}${ageSuffix}`;
}

/** Supervisor fleet cell: rendered only after IO proves pid-live and fresh. */
export function renderFleetBlock(fleet: FleetInput | undefined): string | null {
  if (!fleet) return null;
  // A stale chip is NEVER drawn as current occupancy (ADR 0128 §6). The compact
  // line has no room for a qualifier that would still read as a live fleet, so
  // it renders nothing; the staleness itself travels on in the chip payload,
  // where a consumer sees "fleet, but stale" instead of "no fleet".
  if (fleet.stale && !fleet.breaker) return null;
  const runner = fleet.runner || "?";
  const busy = Math.max(0, Math.floor(fleet.busy));
  const total = Math.max(0, Math.floor(fleet.total));
  const queue = Math.max(0, Math.floor(fleet.queue));
  const parts = [`flt=${runner} ${busy}/${total}${fleet.degraded ? "†" : ""}`];
  // A breaker-open fleet still renders (#2527) — mark its numbers as history.
  if (fleet.stale) {
    parts.push(`⏳stale=${Math.max(0, Math.floor(fleet.staleAgeS ?? 0))}s`);
  }
  if (fleet.breaker) {
    parts.push(`⛔brk=${Math.max(1, Math.floor(fleet.breaker.count))}×`);
  }
  if (fleet.bundleVersion) {
    const versions = [fleet.bundleVersion, fleet.pointerVersion, fleet.latestBundleVersion]
      .filter((v): v is string => Boolean(v));
    const skew = new Set(versions).size > 1;
    const latest =
      fleet.latestBundleVersion && fleet.latestBundleVersion !== fleet.bundleVersion
        ? `<${fleet.latestBundleVersion}`
        : "";
    parts.push(`@${fleet.bundleVersion}${skew ? "!" : ""}${latest}`);
  }
  parts.push(`q=${queue}`);
  if (fleet.parked !== undefined && fleet.parked > 0) {
    parts.push(`prk=${Math.floor(fleet.parked)}`);
  }
  const churnDeaths = Math.max(0, Math.floor(fleet.churnDeaths ?? 0));
  const churnRespawns = Math.max(0, Math.floor(fleet.churnRespawns ?? 0));
  if (churnDeaths > 0 || churnRespawns > 0) {
    const windowS = Math.max(1, Math.floor(fleet.churnWindowS ?? 1));
    parts.push(`churn=${churnDeaths}d/${churnRespawns}r/${windowS}s`);
  }
  return parts.join(" ");
}

export function renderUnlandedDocsBlock(docs: DocsInput | undefined): string | null {
  if (!docs || docs.count <= 0) return null;
  return `doc=${Math.floor(docs.count)}`;
}

export function renderRspBlock(rsp: RspStatusInput | undefined): string | null {
  if (!rsp) return null;
  if (rsp.state === "ready") {
    return `rsp=↓${formatRspTickerValue(rsp.tokensSavedToday)}`;
  }
  if (rsp.state === "warming") return "rsp=…";
  return "rsp=!";
}

/**
 * Block 4: the space-joined AFK token run in plain text. Null when there are no
 * live workers, matching the bash `(( total_workers > 0 ))` gate around the
 * block. The ANSI-painted variant lives in the style module and shares the
 * {@link afkTokens} model, so plain and styled never drift.
 */
export function renderAfkBlock(afk: AfkInput | undefined): string | null {
  const tokens = afkTokens(afk);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t.label}${t.value}${t.suffix}`).join(" ");
}

/**
 * Assembles the full statusline by joining the present blocks with ` · `,
 * byte-for-byte with statusline.sh's section loop. Absent blocks drop out
 * silently. The project block is always present, so the output is never empty
 * (the per-project opt-out is handled upstream by returning no render at all).
 *
 * TOON note (PRD #928 / ADR 0081, issue #941): TOON becomes the default
 * agent-facing wire format for the multi-row read surfaces (monitor, dashboard,
 * daily-review). The statusline is deliberately exempt from the *tabular* form.
 * Claude Code's `statusLine` DOES render multiple lines (issue #1165 — the themed
 * variant now emits a repo-global header line plus one line per live AFK worker),
 * but a TOON *table* — a schema-header row followed by bare CSV data rows — still
 * does not fit: this single-line plain form (the NO_COLOR / Codex-footer render)
 * is one aggregate line by contract, and even the themed multi-line form is a
 * header + per-worker prose, not a column-aligned table. The cheap AXI principles
 * still apply, and
 * already hold (story #27, "even where TOON does not help"):
 *   - minimal schema: each KPI token ({@link afkTokens}) is emitted only when its
 *     count is > 0 — no zero-noise;
 *   - pre-computed aggregates: the caller injects already-summed counts;
 *   - definitive state: no live workers → the whole AFK block is dropped (an
 *     unambiguous "nothing running here"), never a `wrk=0` placeholder;
 *   - per-source counts from #930 ({@link AfkInput.sourceCounts}) are preserved
 *     as `origin=N` tokens read from the same `state.origin` the monitor uses.
 */
export function renderStatusline(input: StatuslineInput): string {
  return renderStatuslineWithPreset(input, "full");
}

export function renderStatuslineWithPreset(input: StatuslineInput, preset: StatuslinePreset = "full"): string {
  if (preset === "short") {
    const sections: string[] = [renderProjectBlock(input.project)];
    const context = renderContextBlock(input.claude);
    if (context !== null) sections.push(`ctx=${context}`);
    const repo = renderShortRepoBlock(input.repo);
    if (repo !== null) sections.push(repo);
    const rsp = renderRspBlock(input.rsp);
    if (rsp !== null) sections.push(rsp);
    return sections.join(" · ");
  }

  const sections: string[] = [renderProjectBlock(input.project)];
  const model = renderModelBlock(input.claude);
  if (model !== null) sections.push(model);
  const context = renderContextBlock(input.claude);
  if (context !== null) sections.push(context);
  const usage = renderUsageBlock(input.claude);
  if (usage !== null) sections.push(usage);
  const repo = renderRepoBlock(input.repo);
  if (repo !== null) sections.push(repo);
  const docs = renderUnlandedDocsBlock(input.docs);
  if (docs !== null) sections.push(docs);
  const fleet = renderFleetBlock(input.fleet);
  if (fleet !== null) sections.push(fleet);
  const rsp = renderRspBlock(input.rsp);
  if (rsp !== null) sections.push(rsp);
  const afk = renderAfkBlock(input.afk);
  if (afk !== null) sections.push(afk);
  return sections.join(" · ");
}
