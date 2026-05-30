// Port of the RENDER path of statusline.sh — the /afk statusline aggregator for
// Claude Code. statusline.sh reads the Claude Code stdin JSON payload (cwd,
// model, effort, context window) and combines it with live /afk worker state
// from <root>/.red/tmp/workers/*/* to emit ONE compact line like:
//
//   red-skills · Opus·high · 47k 24% · 🤖4 📋1 🆘11 🚧10 +12 -3 #17
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
  /** 🤖 — number of live workers. */
  workers: number;
  /** 📋 — cached ready-for-agent (queue) count. */
  queue: number;
  /** 🆘 — cached ready-for-human count. */
  human: number;
  /** 🚧 — summed blocked count. */
  blocked: number;
  /** +N — summed insertions. */
  added: number;
  /** -N — summed deletions. */
  removed: number;
  /** #N issue numbers for the in-progress workers, in order. */
  issues: ReadonlyArray<number | string>;
}

/** All the resolved inputs for one statusline render. */
export interface StatuslineInput {
  project: ProjectInput;
  claude?: ClaudeInput;
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
 * Block 4: the space-joined AFK token run. Each emoji+number is emitted only
 * when its count is > 0, in the fixed order 🤖 📋 🆘 🚧 +N -N, followed by the
 * `#N` issue numbers (always emitted, in order). Null when there are no live
 * workers, matching the bash `(( total_workers > 0 ))` gate around the block.
 */
export function renderAfkBlock(afk: AfkInput | undefined): string | null {
  if (!afk || afk.workers <= 0) return null;
  const tokens: string[] = [];
  if (afk.workers > 0) tokens.push(`🤖${afk.workers}`);
  if (afk.queue > 0) tokens.push(`📋${afk.queue}`);
  if (afk.human > 0) tokens.push(`🆘${afk.human}`);
  if (afk.blocked > 0) tokens.push(`🚧${afk.blocked}`);
  if (afk.added > 0) tokens.push(`+${afk.added}`);
  if (afk.removed > 0) tokens.push(`-${afk.removed}`);
  for (const issue of afk.issues) tokens.push(`#${issue}`);
  if (tokens.length === 0) return null;
  return tokens.join(" ");
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
