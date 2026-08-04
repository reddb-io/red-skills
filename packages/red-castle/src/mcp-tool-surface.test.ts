import { describe, expect, it } from "vitest";
import {
  createCastleMcpTools,
  type CastleMcpDependencies,
} from "./mcp-server.js";

/**
 * Frozen snapshot of the aggregated castle MCP tool surface.
 *
 * Domain modules may be split, merged, or reordered internally; this table is
 * the contract that the composed surface — order, names, titles, descriptions,
 * MUTATING prefixes, and input-schema keys — stays byte-identical. Changing an
 * entry here is a deliberate protocol change, never a refactor side effect.
 */
const SURFACE: ReadonlyArray<{
  name: string;
  title: string;
  description: string;
  schema: string[];
}> = [
  {
    name: "help",
    title: "Find the next castle action",
    description:
      "Read live daemon, registration, queue, Worker, and refusal state; return the pasteable next call and a generated intent map. Makes no GitHub request.",
    schema: [],
  },
  {
    name: "project_status",
    title: "Get project worker status",
    description:
      "Return this project's host registration, slots, and live-worker status.",
    schema: ["fleet"],
  },
  {
    name: "project_start",
    title: "Start this project's workers",
    description:
      "MUTATING: register this project with the host daemon — a runner, a target width, and its work policy. " +
      "Registers rather than launches: the project contributes a record, never a process of its own.",
    schema: ["runner", "target", "selector", "config", "base", "fleet"],
  },
  {
    name: "project_resize",
    title: "Re-aim this project's workers",
    description:
      "MUTATING: change this project's target width, runner, or work policy and send the live directive.",
    schema: ["runner", "target", "selector", "config", "base", "fleet"],
  },
  {
    name: "project_stop",
    title: "Stop this project's workers",
    description:
      "MUTATING: stop this project's work and give its registration back; force hard teardown explicitly.",
    schema: ["force", "fleet"],
  },
  {
    name: "host_state",
    title: "Read daemon host state",
    description:
      "Return every project and Worker the redskilled daemon holds on this machine.",
    schema: [],
  },
  {
    name: "host_dashboard",
    title: "Read daemon host dashboard",
    description:
      "Return the structured global dashboard for every project's Workers on this machine.",
    schema: [],
  },
  {
    name: "host_provision_check",
    title: "Check daemon host provisioning",
    description:
      "Read whether this machine is ready to run redskilled and what is missing; creates and starts nothing.",
    schema: [],
  },
  {
    name: "host_unit_status",
    title: "Read daemon unit status",
    description:
      "Return whether the optional redskilled supervisor unit is installed, enabled, and active.",
    schema: [],
  },
  {
    name: "logs",
    title: "Read Castle logs",
    description:
      "Return the newest CastleLaneRecord entries from one structured lane; bounded by `limit` (default 200, max 10 000). Pass `kind` to filter before the limit.",
    schema: ["lane", "id", "limit", "kind"],
  },
  {
    name: "worker_vitals",
    title: "Read worker vitals",
    description:
      "Return the liveness-qualified state of local workers. Defaults to live workers only; pass `live_only: false` to include stopped/dead workers. Pass `fields` to project top-level keys.",
    schema: ["live_only", "fields"],
  },
  {
    name: "dashboard",
    title: "Build AFK dashboard",
    description:
      "Build the structured operational dashboard from GitHub and local state.",
    schema: ["periodDays"],
  },
  {
    name: "monitor",
    title: "Read AFK monitor",
    description:
      "Return the current workers, history events, and monitor inputs.",
    schema: [],
  },
  {
    name: "history",
    title: "Read Castle history",
    description:
      "Return structured Castle history records, newest records last.",
    schema: ["limit"],
  },
  {
    name: "queue_status",
    title: "Read AFK queues",
    description:
      "Return ready-for-agent and ready-for-human queue candidates. Pass `selector` to preview the producer's scoped view of the ready queue (same facets as its work selector, e.g. tags/user).",
    schema: ["selector"],
  },
  {
    name: "events_since",
    title: "Poll events since cursor",
    description:
      "Return castle history events and worker lane records after an opaque cursor, plus the next cursor. Omit cursor to get a fresh baseline cursor with no events. Unknown or expired cursors are refused with a re-baseline prompt.",
    schema: ["cursor"],
  },
  {
    name: "deadend_audit",
    title: "Audit AFK deadends",
    description:
      "Return the read-only deadend audit: dangling claims, red PRs with dead owners, superseded PRs, executable Tickets carrying an active Current blocker, dependency blocks whose req targets all closed, human-queue age outliers, and stale worktrees — each class paired with its recommended cure. Cache-backed: repeated calls within the refresh window cost zero GitHub quota.",
    schema: [],
  },
  {
    name: "worker_dispatch",
    title: "Dispatch AFK worker",
    description:
      "MUTATING: run one tracked issue or mint and run one disposable demand through the AFK worker lifecycle.",
    schema: ["issue", "demand", "runner", "mode"],
  },
  {
    name: "worker_status",
    title: "Read worker status",
    description:
      "Return normalized, liveness-qualified state for one worker or every local worker. Defaults to live workers only; pass `live_only: false` to include stopped/dead workers.",
    schema: ["worker", "live_only", "fields"],
  },
  {
    name: "worker_stop",
    title: "Stop AFK worker",
    description: "MUTATING: terminate one worker process tree.",
    schema: ["worker"],
  },
  {
    name: "worker_recycle",
    title: "Recycle AFK worker",
    description:
      "MUTATING: terminate one fleet worker so its supervisor can replace the slot.",
    schema: ["worker"],
  },
  {
    name: "runner_list",
    title: "List AFK runners",
    description: "Return the canonical runner specification registry.",
    schema: [],
  },
  {
    name: "runner_detect",
    title: "Detect AFK runner",
    description:
      "Resolve the runner selected by an explicit override or the current host environment.",
    schema: ["runner"],
  },
  {
    name: "runner_steer",
    title: "Steer live AFK worker",
    description:
      "MUTATING: write a live-steer request into a running worker's next iteration.",
    schema: ["worker", "text"],
  },
  {
    name: "steer_status",
    title: "Read steer status",
    description:
      "Return the live-steer status for a worker: none (no steer ever written), pending (written, not yet consumed), or consumed (consumed at a specific iteration).",
    schema: ["worker"],
  },
  {
    name: "worker_request",
    title: "Dispatch worker with request",
    description:
      "MUTATING: dispatch a new worker and inject a special request into its spawn-time handoff.",
    schema: ["issue", "demand", "runner", "mode", "text"],
  },
  {
    name: "requeue",
    title: "Requeue AFK issue",
    description:
      "MUTATING: apply the complete parked-issue requeue transition and record human guidance.",
    schema: ["issue", "guidance", "repo", "dryRun", "adoptBranch"],
  },
  {
    name: "retake",
    title: "Recommend AFK retake",
    description:
      "Return the structured issue, PR, branch, worktree, worker-state, and recommended-next-action report.",
    schema: ["issue", "repo", "prLimit"],
  },
  {
    name: "reap",
    title: "Reap AFK branches",
    description:
      "MUTATING: classify and delete stale local and remote AFK branches.",
    schema: [],
  },
  {
    name: "unblock_sweep",
    title: "Sweep dependency blocks",
    description:
      "MUTATING: promote dependency-blocked issues whose requirements are all closed.",
    schema: [],
  },
  {
    name: "gate_run",
    title: "Run the AFK gate",
    description:
      "MUTATING: materialize the branch's feedback worktree and run the package-scoped validation gate against it.",
    schema: ["branch", "base"],
  },
  {
    name: "land_branch",
    title: "Land AFK branch",
    description:
      "MUTATING: land one validated worker branch into its base through the complete landing sequence.",
    schema: ["issue", "branch", "base", "title", "openPr"],
  },
  {
    name: "cascade_status",
    title: "Read close cascade",
    description:
      "Return the dependents of one issue and which of them the close cascade would promote.",
    schema: ["issue"],
  },
  {
    name: "claim_status",
    title: "Read AFK claim",
    description:
      "Return the parsed claim marker records and current holder for one issue (`issue`) " +
      "or a batch (`issues`), keyed per issue.",
    schema: ["issue", "issues"],
  },
  {
    name: "claim_release",
    title: "Release AFK claim",
    description:
      "MUTATING: post a concede marker for every un-conceded claim holder so the issue (`issue`) " +
      "or each issue in a batch (`issues`) becomes claimable again.",
    schema: ["issue", "issues"],
  },
  {
    name: "merge_arm",
    title: "Arm PR for the merge driver",
    description:
      "MUTATING: hand one open PR to the castle merge driver — it owns the PR to a terminal state " +
      "(update-branch when BEHIND, merge-commit once green at head, bounded retries, " +
      "needs-medic/needs-human classification) without GitHub native auto-merge.",
    schema: ["pr"],
  },
  {
    name: "merge_status",
    title: "Read merge driver state",
    description:
      "Return the driver's durable per-PR records: armed set, attempts, last observed state, " +
      "and terminal classifications.",
    schema: [],
  },
  {
    name: "merge_release",
    title: "Release PR from the merge driver",
    description:
      "MUTATING: stop driver ownership of one PR. The record is kept as released for observability.",
    schema: ["pr"],
  },
  {
    name: "hitl_resolve",
    title: "Resolve parked issue with a human decision",
    description:
      "MUTATING: encode one human decision on a parked issue atomically — " +
      "requeue (concede dangling claims, strip park labels, ready-for-agent), " +
      "retake (route to the no-agent landing lane), park (keep ready-for-human, record why), " +
      "or close. The rationale is posted as an issue comment for the audit trail.",
    schema: ["issue", "decision", "rationale"],
  },
  {
    name: "worktree_list",
    title: "List disposable worktrees",
    description:
      "Enumerate every checkout under the disposable `.red/tmp/worktrees/*` lanes.",
    schema: [],
  },
  {
    name: "worktree_remove",
    title: "Remove disposable worktree",
    description:
      "MUTATING: remove one checkout under the disposable `.red/tmp/worktrees/*` lanes.",
    schema: ["path"],
  },
  {
    name: "wait_start",
    title: "Start rsp wait",
    description:
      "MUTATING: spawn a detached rsp wait (pr | run | release | cmd) and return its registry id.",
    schema: ["kind", "target", "timeout_ms", "reason"],
  },
  {
    name: "wait_list",
    title: "List active rsp waits",
    description: "Return the active-wait registry from .red/tmp/waits.",
    schema: [],
  },
  {
    name: "wait_status",
    title: "Read rsp wait status",
    description:
      "Return the registry entry for a running wait or the sealed result envelope for a finished one.",
    schema: ["id"],
  },
  {
    name: "daily_review",
    title: "Build daily activity review",
    description:
      "Return the structured daily activity review report for the local window.",
    schema: [],
  },
  {
    name: "weekly_review",
    title: "Build weekly activity review",
    description:
      "Return the structured weekly activity review report for the local window.",
    schema: [],
  },
  {
    name: "triage",
    title: "Apply triage decision",
    description:
      "MUTATING: apply the decided triage transition to one issue, gated by the per-repo trust policy.",
    schema: ["issue", "decision", "summon", "repo"],
  },
  {
    name: "respond",
    title: "Handle comment event",
    description:
      "MUTATING: parse a /dev comment summon, authorize the commenter, and route the advisory or mutation verb.",
    schema: ["body", "number", "author", "is_pr", "runner", "repo"],
  },
  {
    name: "statusline_aggregate",
    title: "Read statusline aggregate",
    description:
      "Return the castle-side statusline aggregate (project, repo counters, docs drift, fleet, worker rows, aggregated AFK block, queue) as structured data, using the same collector cores and cache discipline as the command-backed statusLine. Host-side fields (session model/effort, context %, usage quotas) are out of scope.",
    schema: [],
  },
];

describe("aggregated castle MCP tool surface", () => {
  const tools = createCastleMcpTools({} as CastleMcpDependencies);

  it("composes the frozen tool surface in order", () => {
    expect(
      tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        schema: Object.keys(tool.inputSchema),
      })),
    ).toEqual(SURFACE);
  });

  it("publishes every tool name exactly once", () => {
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });

  // ADR 0130: the cross-host aggregate is retired, not rebuilt — it grouped by
  // host identity over heartbeats and slots that no longer exist. Federation
  // across machines, if ever demanded, builds on the daemon socket instead.
  it("publishes no host-grouped fleet view", () => {
    for (const tool of tools) {
      expect(tool.name).not.toMatch(/federat/i);
      expect(tool.description).not.toMatch(/cross-host|per-host/i);
    }
  });
});
