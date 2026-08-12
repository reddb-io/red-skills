/**
 * Queue reading for the AFK container lane.
 *
 * Selection only — the engine still owns the claim. This mirrors the Actions
 * lane's auto-pick predicate (reusable-afk-attempt.yml): the oldest open issue
 * carrying the queue label, skipping anything parked, because the engine's own
 * preflight would refuse a parked issue and the run would burn for nothing.
 */

import { planGithubRestRead } from "@reddb-io/github";

const PARKED_LABEL = "ready-for-human";
const PARKED_PREFIX = "blocked:";

function labelNames(issue) {
  return (issue.labels ?? []).map((label) => (typeof label === "string" ? label : (label?.name ?? "")));
}

/** True when a label parks the issue out of agent reach (`ready-for-human` / `blocked:*`). */
export function isParked(issue) {
  return labelNames(issue).some((name) => name === PARKED_LABEL || name.startsWith(PARKED_PREFIX));
}

/**
 * The queue head: oldest actionable issue, ties broken by issue number so the
 * pick is deterministic across containers reading the same queue.
 *
 * @returns the issue, or `null` when nothing is actionable.
 */
export function pickIssue(issues) {
  const actionable = (issues ?? []).filter((issue) => !isParked(issue));
  if (actionable.length === 0) return null;
  return [...actionable].sort((a, b) => {
    const byAge = String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
    return byAge !== 0 ? byAge : a.number - b.number;
  })[0];
}

/**
 * List the open issues carrying `label` in `repo`. `gh issue list` already
 * excludes pull requests, so the caller never sees one.
 *
 * @param {{ repo: string, label: string, exec: (cmd: string, args: string[]) => Promise<{code:number,stdout:string,stderr:string}> }} params
 */
export async function listReadyIssues({ repo, label, exec }) {
  const plan = planGithubRestRead({
    kind: "rest",
    path: `repos/${repo}/issues`,
    args: [
      "-f", "state=open", "-f", `labels=${label}`, "-f", "per_page=100",
      "--jq", 'map(select(.pull_request == null) | {number, createdAt: .created_at, labels})',
    ],
  });
  if (plan.outcome !== "plan") throw new Error(plan.reason);
  const result = await exec("gh", plan.args);
  if (result.code !== 0) {
    throw new Error(`gh issue list failed for ${repo} (exit ${result.code}): ${result.stderr.trim()}`);
  }
  const parsed = JSON.parse(result.stdout || "[]");
  return Array.isArray(parsed) ? parsed : [];
}

/** Rotate a list so run number `cycle` starts at a different element — fair sharing across repos. */
export function rotate(items, cycle) {
  if (items.length === 0) return [];
  const size = items.length;
  const start = ((cycle % size) + size) % size;
  return [...items.slice(start), ...items.slice(0, start)];
}
