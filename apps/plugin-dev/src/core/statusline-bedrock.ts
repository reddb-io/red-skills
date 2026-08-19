// core/statusline-bedrock — the Statusline Bedrock segment (ADR 0141 §1).
//
// The bedrock is everything the line can answer with ZERO network and ZERO
// daemon: the Claude Code stdin payload (model·effort, context tokens/percent,
// the `5h=`/`7d=` subscription windows), local git (repo basename, branch, local
// diff), and the running bundle version. It renders on EVERY invocation — a
// daemon that is down, connecting, or registering nothing costs the operator the
// tail, never the facts their own machine already holds.
//
// The render is PURE, like its sibling in `core/statusline.ts`: the caller
// injects already-resolved inputs and this module assembles text. The stdin
// parse, the build-info read, and the micro-TTL git read live in the adapter
// (`commands/statusline.ts`) and the wire (`runtime/wire/statusline-git.ts`).
//
// **Bedrock and tail are INTERNAL segments, not a configuration surface**
// (ADR 0141 §5). Drawing the seam now is what lets operator-composable segment
// selection land later without redrawing data ownership; the layout is fixed and
// nothing reads a setting to change it.

import {
  renderContextBlock,
  renderModelBlock,
  renderProjectBlock,
  renderProjectVersionLabel,
  renderUsageBlock,
  type ClaudeInput,
  type ProjectInput,
} from "./statusline.js";

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
