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
  { name: "open_pull_requests", key: "prs" },
  { name: "open_issues", key: "iss" },
  { name: "ready_queue", key: "rdy" },
  { name: "human_queue", key: "hmn" },
];

/**
 * The counter tokens for one project, ready to be joined into a head. PURE.
 *
 * Ordered `prs cpr iss rdy hmn`: the repository's own totals, then what closed
 * inside the poll's window, then the two queues an operator acts on. `cpr` comes
 * from the activity report rather than the counter block because it is not one
 * of the four dated counters — it is the poll's own window figure.
 *
 * A daemon that predates the counter block still renders `prs`/`cpr`/`iss` from
 * the poll-dated counts (ADR 0130 rule 3); it simply cannot date them
 * individually, and the caller's blanket staleness marker stays its answer.
 */
export function remoteCounterTokens(
  payload: RedskilledRenderPayload,
  project: string | null,
): readonly string[] {
  const block = counterProject(payload, project);
  const activity = activityProject(payload, project);
  const tokens: string[] = [];
  for (const { name, key } of REDSKILLED_COUNTER_LABELS) {
    if (key === "iss") {
      const closed = activity?.counts?.recently_closed;
      if (closed != null) tokens.push(`cpr=${closed}`);
    }
    const token = counterToken(key, block?.counters[name], fallbackValue(activity, name));
    if (token != null) tokens.push(token);
  }
  return tokens;
}

/** The repo-global counts a header carries as structure, each `null` when unpolled. */
export interface RedskilledDashboardCounts {
  readonly open_pull_requests: number | null;
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
