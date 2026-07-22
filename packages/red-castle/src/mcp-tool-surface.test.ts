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
    name: "fleet_list",
    title: "List AFK fleets",
    description: "List every registered named AFK fleet profile.",
    schema: [],
  },
  {
    name: "fleet_status",
    title: "Get AFK fleet status",
    description:
      "Return structured supervisor, slots, churn, and live-worker status for a named fleet.",
    schema: ["fleet"],
  },
  {
    name: "fleet_create",
    title: "Create AFK fleet",
    description:
      "MUTATING: persist a named fleet profile and spawn its supervisor.",
    schema: ["name", "runner", "target", "selector", "config", "base"],
  },
  {
    name: "fleet_edit",
    title: "Edit AFK fleet",
    description:
      "MUTATING: update a named fleet profile and send a live resize directive when requested.",
    schema: ["name", "runner", "target", "selector", "config", "base"],
  },
  {
    name: "fleet_stop",
    title: "Stop AFK fleet",
    description: "MUTATING: stop one named fleet and its detached workers.",
    schema: ["fleet"],
  },
  {
    name: "fleet_register",
    title: "Adopt AFK fleet",
    description:
      "MUTATING: persist a profile for an already-running supervisor without restarting it.",
    schema: ["name", "runner", "selector", "config", "base"],
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
      "Return the current workers, history events, and fleet monitor inputs.",
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
    description: "Return ready-for-agent and ready-for-human queue candidates.",
    schema: [],
  },
  {
    name: "events_since",
    title: "Poll events since cursor",
    description:
      "Return castle history events and worker lane records after an opaque cursor, plus the next cursor. Omit cursor to get a fresh baseline cursor with no events. Unknown or expired cursors are refused with a re-baseline prompt.",
    schema: ["cursor"],
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
      "Return the parsed claim marker records for one issue and the worker currently holding it.",
    schema: ["issue"],
  },
  {
    name: "claim_release",
    title: "Release AFK claim",
    description:
      "MUTATING: post a concede marker for every un-conceded claim holder so the issue becomes claimable again.",
    schema: ["issue"],
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
});
