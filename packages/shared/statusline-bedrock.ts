// statusline-bedrock — the Statusline Bedrock segment (ADR 0141 §1), PURE.
//
// The bedrock is everything the line can answer with ZERO network and ZERO
// daemon: the Claude Code stdin payload (model·effort, context tokens/percent,
// the `5h=`/`7d=` subscription windows), local git (repo basename, branch, local
// diff), and the running bundle version. It renders on EVERY invocation — a
// daemon that is down, connecting, or registering nothing costs the operator the
// tail, never the facts their own machine already holds.
//
// **It lives in `packages/shared` because BOTH halves of the line are now drawn
// by one process.** ADR 0147 deleted the dev bundle that used to own the
// bedrock, and PR #4272 pointed the host's statusline at the `redskilled`
// bundle — which renders only the tail. The daemon may not import a runtime
// (dependency-direction guard #4135: daemon rank 4, runtime rank 5), so the
// bedrock moved DOWN to rank 1, where the daemon and every runtime can reach the
// same spelling. Two spellings of one line is the drift the move ends.
//
// The render is PURE: the caller injects already-resolved inputs and this module
// assembles text. The stdin parse lives in `./statusline-stdin.ts`, the local git
// read in `./statusline-local-git.ts`, and the paint in
// `@reddb-io/redskilled-render/bedrock-style.js` — rank 1 holds no colour.
//
// **Bedrock and tail are INTERNAL segments, not a configuration surface**
// (ADR 0141 §5). Drawing the seam now is what lets operator-composable segment
// selection land later without redrawing data ownership; the layout is fixed and
// nothing reads a setting to change it.

import { compareSemver } from "./self-update.js";

/** Longest branch name rendered whole; past it the bash `${branch:0:27}…` form. */
const BRANCH_MAX = 28;

/** The block-1 project inputs: basename plus optional git ref. */
export interface ProjectInput {
  /** `basename "$cwd"` — always present. */
  basename: string;
  /** `git symbolic-ref --short HEAD` when on a branch; "" / undefined otherwise. */
  branch?: string;
  /** `git rev-parse --short HEAD` when detached (used only when branch is absent). */
  detachedSha?: string;
  /** Running bundle version (e.g. `4.1.22`), from build-info. Rendered as a
   * `v<version>` tag so the operator can see which RedSkills version is
   * producing the statusline. */
  version?: string;
  /** Newest locally cached bundle version. The render path uses this cache-only
   * fact to mark a stale session without doing network discovery. */
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

/** The bedrock's local git diff — the LOCAL branch delta vs the base ref. */
export interface LocalDiffInput {
  localAdded?: number;
  localRemoved?: number;
}

/** Everything the bedrock renders, already resolved by the adapter. */
export interface StatuslineBedrockInput {
  project: ProjectInput;
  claude?: ClaudeInput;
  localDiff?: LocalDiffInput;
}

/**
 * Humanizes a token count the way statusline.sh does: `X.XM` at/above 1e6,
 * integer-division `Xk` at/above 1e3, raw integer below.
 */
export function humanizeTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.floor(tokens / 1000)}k`;
  return String(tokens);
}

function hasCachedUpdate(project: ProjectInput): boolean {
  return compareSemver(project.latestCachedVersion ?? "", project.version ?? "") > 0;
}

/**
 * `v<version>`, with a `*` when a newer bundle sits in the local cache. `always`
 * states the version unconditionally; `update-only` states it solely to announce
 * the update.
 */
export function renderProjectVersionLabel(
  project: ProjectInput,
  mode: "always" | "update-only",
): string | null {
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
 * `loc=+A -R` for the LOCAL branch diff, each half emitted only when non-zero
 * and the whole token dropped when both are — the no-zero-noise rule the AFK and
 * repo blocks already follow. This is the same `loc=` the repo block used to
 * carry; ownership moved, spelling did not.
 */
export function renderLocalDiffBlock(diff: LocalDiffInput | undefined): string | null {
  if (!diff) return null;
  const parts: string[] = [];
  if (diff.localAdded && diff.localAdded > 0) parts.push(`+${diff.localAdded}`);
  if (diff.localRemoved && diff.localRemoved > 0) parts.push(`-${diff.localRemoved}`);
  return parts.length ? `loc=${parts.join(" ")}` : null;
}

/**
 * `basename (branch) v<version>` — the project block with the bundle version
 * ALWAYS shown. The header's own project block shows the version only when a
 * newer bundle is cached; the bedrock states it unconditionally, because "which
 * version is producing this line" is precisely the question asked when the rest
 * of the line is missing.
 */
export function renderBedrockProjectBlock(project: ProjectInput): string {
  const withoutVersion: ProjectInput = { ...project };
  delete withoutVersion.version;
  const base = renderProjectBlock(withoutVersion);
  const version = renderProjectVersionLabel(project, "always");
  return version ? `${base} ${version}` : base;
}

/**
 * The bedrock segment, space-separated so the only ` · ` on its header is
 * the boundary before the daemon tail.
 * Never empty: the project block always renders, so a daemon-absent invocation
 * still puts the operator's own facts on screen.
 */
export function renderStatuslineBedrock(input: StatuslineBedrockInput): string {
  const sections: string[] = [renderBedrockProjectBlock(input.project)];
  const model = renderModelBlock(input.claude);
  if (model !== null) sections.push(model);
  const context = renderContextBlock(input.claude);
  if (context !== null) sections.push(`ctx=${context}`);
  const usage = renderUsageBlock(input.claude);
  if (usage !== null) sections.push(usage);
  const localDiff = renderLocalDiffBlock(input.localDiff);
  if (localDiff !== null) sections.push(localDiff);
  return sections.join(" ");
}

/**
 * Join the bedrock to the daemon tail: the bedrock LEADS the header line and the
 * tail's remaining lines follow untouched. A tail that produced nothing — an
 * unreachable daemon, an empty document — leaves the bedrock alone on the line
 * rather than an empty separator, because the seam is a composition rule, not a
 * layout the tail can veto.
 */
export function composeStatuslineLines(bedrock: string, tail: readonly string[]): string[] {
  const lines = [...tail];
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  const [head, ...rest] = lines;
  const header = head && head.trim() !== "" ? `${bedrock} · ${head}` : bedrock;
  return [header, ...rest];
}
