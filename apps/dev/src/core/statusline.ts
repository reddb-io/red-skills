// Port of the RENDER path of statusline.sh — the /afk statusline aggregator for
// Claude Code. statusline.sh reads the Claude Code stdin JSON payload (cwd,
// model, effort, context window) and combines it with live /afk worker state
// from <root>/.red/tmp/workers/*/* to emit ONE compact line like:
//
//   red-skills · Opus·high · 47k 24% · wrk=4 rdy=1 hmn=11 blk=10 loc=+12 -3 #17
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
// parse, the worker-state read, the git/gh reads, the 60 s GitHub-count cache,
// and the OSC-8/ANSI colouring all belong to the orchestration slice and are
// out of scope — the test asserts the plain/structural content exactly as
// statusline.test.sh does after stripping escapes.

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
}

/** The block-4 aggregated worker counts, already summed across live workers. */
export interface AfkInput {
  /** `wk` — number of live workers. */
  workers: number;
  /** `rq` — cached ready-for-agent (queue) count. */
  queue: number;
  /** `rh` — cached ready-for-human count. */
  human: number;
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
  /** Per-issue `current.stage` aligned by index with {@link issues}. When a
   * stage is present and non-empty it renders as a `·stage` suffix on the
   * matching `#N` token (`#629·impl`), so the block shows WHAT each live worker
   * is doing, not just that it exists. Absent/short arrays fall back to bare
   * `#N`, preserving the pre-stage render. */
  stages?: ReadonlyArray<string | undefined>;
  /** Per-origin worker counts derived from `state.origin` across live workers.
   * Populated by the IO layer (wire.ts collectStatuslineAfk) reading the SINGLE
   * `origin` field on each worker state; absent when no live worker has a
   * non-empty origin. Sorted by origin for a deterministic token order.
   * Rendered as `go=N afk=M` tokens immediately after `wrk=<total>`. */
  sourceCounts?: ReadonlyArray<{ origin: string; count: number }>;
}

/** Repo-global header inputs (themed line 1, always rendered). Independent of
 * live AFK workers: it shows where the repo stands even when nothing is running. */
export interface RepoInput {
  /** `pr` — open pull-request count (repo-global, GitHub-derived). */
  openPrs?: number;
  /** `is` — open issue count (repo-global, GitHub-derived). */
  openIssues?: number;
  /** `+N` — LOCAL branch insertions (committed + uncommitted vs origin/main). */
  localAdded?: number;
  /** `-N` — LOCAL branch deletions (committed + uncommitted vs origin/main). */
  localRemoved?: number;
}

/** All the resolved inputs for one statusline render. */
export interface StatuslineInput {
  project: ProjectInput;
  claude?: ClaudeInput;
  repo?: RepoInput;
  afk?: AfkInput;
}

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
 * Block 1: `basename` plus optional ` (branch)` / ` (detached sha)`. Branches
 * longer than 28 chars are truncated to 27 chars + `…`, matching the bash
 * `${branch:0:27}…`.
 */
export function renderProjectBlock(project: ProjectInput): string {
  const base = project.basename;
  if (project.branch) {
    let branch = project.branch;
    if (branch.length > BRANCH_MAX) branch = `${branch.slice(0, 27)}…`;
    return `${base} (${branch})`;
  }
  if (project.detachedSha) return `${base} (detached ${project.detachedSha})`;
  return base;
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
 * highlights; `suffix` is any trailing non-numeric text (the `·stage` on an
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
 * `·stage` suffix). Empty when there are no live workers. Two-letter mnemonics
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
  if (afk.queue > 0) kpi("rdy=", String(afk.queue));
  if (afk.human > 0) kpi("hmn=", String(afk.human));
  if (afk.blocked > 0) kpi("blk=", String(afk.blocked));
  const diff: string[] = [];
  if (afk.added > 0) diff.push(`+${afk.added}`);
  if (afk.removed > 0) diff.push(`-${afk.removed}`);
  if (diff.length) kpi("loc=", diff.join(" "));
  if (afk.waiting !== undefined && afk.waiting > 0) kpi("wai=", String(afk.waiting));
  if (afk.tokens !== undefined && afk.tokens > 0) kpi("tok=", humanizeTokens(afk.tokens));
  if (afk.costUsd !== undefined && afk.costUsd > 0) kpi("usd=", afk.costUsd.toFixed(2));
  afk.issues.forEach((issue, i) => {
    const stage = afk.stages?.[i];
    tokens.push({ label: "#", value: String(issue), suffix: stage ? `·${stage}` : "" });
  });
  return tokens;
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
 */
export function renderStatusline(input: StatuslineInput): string {
  const sections: string[] = [renderProjectBlock(input.project)];
  const model = renderModelBlock(input.claude);
  if (model !== null) sections.push(model);
  const context = renderContextBlock(input.claude);
  if (context !== null) sections.push(context);
  const afk = renderAfkBlock(input.afk);
  if (afk !== null) sections.push(afk);
  return sections.join(" · ");
}
