/**
 * counters — the four remote numbers a line carries, drawn from the daemon's
 * dated block.
 *
 * **One builder, every density.** The statusline head and the dashboard header
 * both end a repository summary with the same four counters, and two builders
 * would be two answers to "how old is this number" for one poll — the drift ADR
 * 0141 decision 2 removed from the FETCH side and this removes from the render
 * side.
 *
 * **A counter states its age only when it is stale.** A fresh number needs no
 * qualifier and a line has no characters to spare on one; a number past the
 * daemon's window is the case where the reader must not take it as current, so
 * that one carries `(15m)` and nothing else does.
 *
 * **An absent counter costs the line nothing.** `value: null` is the daemon
 * saying this poll produced no such count — a spent quota, an unregistered
 * project, a label nobody named — and rendering it as `rdy=0` would state a
 * drained queue as fact (#2801, the same mistake one layer down).
 *
 * PURE.
 */
import { humanizeTokens } from "@reddb-io/shared/statusline-bedrock.js";
import { formatDuration } from "./format.js";
import type {
  RedskilledRenderActivityProject,
  RedskilledRenderCounter,
  RedskilledRenderCounterName,
  RedskilledRenderCounterProject,
  RedskilledRenderPayload,
} from "./payload.js";

/** The terminal mnemonic each counter is read by, in the order a line prints. */
export const REDSKILLED_COUNTER_LABELS: ReadonlyArray<{
  readonly name: RedskilledRenderCounterName;
  readonly key: string;
}> = [
  { name: "ready_queue", key: "rdy" },
  { name: "open_issues", key: "iss" },
  { name: "open_pull_requests", key: "pr" },
  { name: "merged_today", key: "mrg" },
];

/**
 * The counters the ONE-LINE density prints, out of the four a table can afford.
 *
 * `iss` — the repository's total open issues — is the one that left. The line
 * was already at 119 columns of a ~120 budget, and two cells the operator asked
 * for needed the width: what the host just finished, and how much landed today.
 * Something had to go, and of the four this is the only number that neither
 * drives an action nor measures output: `rdy` is the drain's fuel, `pr` is what
 * awaits review, `mrg` is the day's result, and a slow-moving backlog total is
 * read on a dashboard, not glanced at between keystrokes.
 *
 * It is DROPPED FROM ONE DENSITY, never from the payload: `dashboardCounts`
 * still carries `open_issues`, the table still prints it, and the daemon still
 * polls it. A number removed from a document is a number nobody can get back;
 * a number removed from a line is a layout decision.
 */
export const REDSKILLED_LINE_COUNTER_NAMES: readonly RedskilledRenderCounterName[] = [
  "ready_queue",
  "open_pull_requests",
  "merged_today",
];

/**
 * The counter tokens for one project, ready to be joined into a head. PURE.
 *
 * Ordered `rdy iss pr mrg`: the actionable queue first, then the compact
 * repository panorama. The older seven-day `cpr` and human-queue cells remain
 * available as structured dashboard counts but no longer spend tail width.
 *
 * `only` narrows the set for a density that cannot afford all four; the ORDER
 * stays this module's, so no caller can reshuffle the row it prints.
 *
 * A daemon that predates the counter block still renders `pr`/`iss` from the
 * poll-dated counts (ADR 0130 rule 3); it simply cannot date them
 * individually, and the caller's blanket staleness marker stays its answer.
 */
export function remoteCounterTokens(
  payload: RedskilledRenderPayload,
  project: string | null,
  only?: readonly RedskilledRenderCounterName[],
): readonly string[] {
  const block = counterProject(payload, project);
  const activity = activityProject(payload, project);
  const tokens: string[] = [];
  for (const { name, key } of REDSKILLED_COUNTER_LABELS) {
    if (only != null && !only.includes(name)) continue;
    const token = counterToken(key, block?.counters[name], fallbackValue(activity, name));
    if (token != null) tokens.push(token);
  }
  return tokens;
}

/**
 * The day's LANDED lines, as the one token that sits beside `mrg=`. PURE.
 *
 * **`loc=` and this are two different questions.** The bedrock's `loc=` is the
 * working tree against its base — what the operator is HOLDING — and this is
 * what actually reached the trunk since the calendar day began. An operator
 * asking "how much did we ship today" was reading the first and getting the
 * second's answer only by coincidence.
 *
 * Drawn from the repository-activity poll that already counted `merged_today`,
 * never from a git walk: this function is on the render path, and the render
 * path opens nothing.
 *
 * `null` when the poll carried no measurement — the counters module's own rule,
 * one layer along: `rdy=0` is a drained queue and an absent `rdy` is a queue
 * nobody counted, and a `+0 -0` printed for an unreachable trunk would state the
 * calmest possible day for the noisiest possible failure. A measured zero is
 * absent too, but for the opposite reason: it is the no-zero-noise rule every
 * other cell on this line already follows.
 */
export function trunkLinesToken(
  payload: RedskilledRenderPayload,
  project: string | null,
): string | null {
  const counts = activityProject(payload, project)?.counts;
  const added = counts?.trunk_lines_added;
  const removed = counts?.trunk_lines_removed;
  if (added == null || removed == null) return null;
  const parts: string[] = [];
  if (added > 0) parts.push(`+${humanizeTokens(added, { fractionalThousands: true })}`);
  if (removed > 0) parts.push(`-${humanizeTokens(removed, { fractionalThousands: true })}`);
  return parts.length === 0 ? null : parts.join(" ");
}

/** The repo-global counts a header carries as structure, each `null` when unpolled. */
export interface RedskilledDashboardCounts {
  readonly open_pull_requests: number | null;
  readonly merged_today: number | null;
  /** Pull requests and Issues closed inside the poller's window — the `cpr` cell. */
  readonly recently_closed: number | null;
  readonly open_issues: number | null;
  /** `ready-for-agent` depth, from the daemon's dated block; `null` without one. */
  readonly ready_queue: number | null;
  /** `ready-for-human` depth, from the same block and on the same terms. */
  readonly human_queue: number | null;
  /** True when the counts are older than the poller's own staleness window. */
  readonly stale: boolean;
}

/**
 * The same counters as {@link remoteCounterTokens}, as structure rather than
 * tokens — for a surface that lays them out itself. PURE.
 *
 * The dated block first and the poll-dated report second: both are projections
 * of ONE stored activity, so the precedence is a choice of dating, never of
 * value.
 */
export function dashboardCounts(
  payload: RedskilledRenderPayload,
  project: string | null,
): RedskilledDashboardCounts {
  const dated = counterProject(payload, project);
  const activity = activityProject(payload, project);
  return {
    open_pull_requests: dated?.counters.open_pull_requests.value
      ?? activity?.counts?.open_pull_requests ?? null,
    merged_today: dated?.counters.merged_today.value ?? activity?.counts?.merged_today ?? null,
    recently_closed: activity?.counts?.recently_closed ?? null,
    open_issues: dated?.counters.open_issues.value ?? activity?.counts?.open_issues ?? null,
    ready_queue: dated?.counters.ready_queue.value ?? null,
    human_queue: dated?.counters.human_queue.value ?? null,
    stale: activity?.stale === true,
  };
}

/** True when this project's counters are dated one by one on the payload. PURE. */
export function hasDatedCounters(payload: RedskilledRenderPayload, project: string | null): boolean {
  return counterProject(payload, project) != null;
}

/** One project's dated counters; `null` when the daemon carries none for it. */
export function counterProject(
  payload: RedskilledRenderPayload,
  project: string | null,
): RedskilledRenderCounterProject | null {
  if (project == null) return null;
  return (payload.remote_counters?.projects ?? []).find(
    (entry) => entry.project_label === project,
  ) ?? null;
}

function activityProject(
  payload: RedskilledRenderPayload,
  project: string | null,
): RedskilledRenderActivityProject | null {
  if (project == null) return null;
  return (payload.repository_activity?.projects ?? []).find(
    (entry) => entry.project_label === project,
  ) ?? null;
}

/** What an older daemon's poll-dated report holds for a counter; `null` otherwise. */
function fallbackValue(
  activity: RedskilledRenderActivityProject | null,
  name: RedskilledRenderCounterName,
): number | null {
  const counts = activity?.counts;
  if (counts == null) return null;
  if (name === "open_pull_requests") return counts.open_pull_requests;
  if (name === "open_issues") return counts.open_issues;
  if (name === "merged_today") return counts.merged_today ?? null;
  // The queue counts exist only on the dated block: a daemon that never counted
  // them has no number to fall back to, and inventing a zero would render an
  // empty queue for a poll that never asked.
  return null;
}

function counterToken(
  key: string,
  counter: RedskilledRenderCounter | undefined,
  fallback: number | null,
): string | null {
  if (counter == null) return fallback == null ? null : `${key}=${fallback}`;
  if (counter.value == null) return null;
  return `${key}=${counter.value}${counter.stale ? `(${compactAge(counter.age_ms)})` : ""}`;
}

/** A stale counter's age without zero-valued trailing units (`15m`, not `15m0s`). PURE. */
function compactAge(ageMs: number | null): string {
  return formatDuration(ageMs)
    .replace(/m0s$/, "m")
    .replace(/h0m$/, "h")
    .replace(/d0h$/, "d");
}
