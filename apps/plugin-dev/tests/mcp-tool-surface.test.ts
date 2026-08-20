import { describe, expect, it } from "vitest";
import { createRedskilledMcpServer } from "../src/mcp-server.js";
import {
  createCastleMcpTools,
  RS_DEV_MCP_SERVER_NAME,
  type CastleMcpDependencies,
} from "../src/mcp-tools/index.js";

/**
 * Frozen snapshot of the aggregated redskilled MCP tool surface.
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
    title: "Find the next redskilled action",
    description:
      "Read live daemon, registration, queue, Worker, and refusal state; return the pasteable next call and a generated intent map. Makes no GitHub request.",
    schema: [],
  },
  {
    name: "status",
    title: "Read redskilled status",
    description:
      "Answer the current worker, project, or host status through one intent-scoped read.",
    schema: ["scope", "worker", "live_only", "fields"],
  },
  {
    name: "project_activation",
    title: "Preview this project's redskilled activation",
    description:
      "READ-ONLY: report whether this project opted into RedSkills and the canonical runner and target a no-argument drain would register.",
    schema: [],
  },
  {
    name: "project_status",
    title: "Deprecated project status alias",
    description:
      "DEPRECATED: use status { scope: project }. Returns the project answer and names its replacement.",
    schema: ["fleet"],
  },
  {
    name: "drain",
    title: "Make this project drain",
    description:
      "MUTATING: ensure the daemon is reachable and this project is registered. Omitted runner and target resolve from this project's canonical RedSkills configuration; repeated calls report what was kept.",
    schema: ["runner", "target"],
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
    name: "project_reset",
    title: "Reset project execution latch",
    description:
      "MUTATING: clear a named in-memory latch for this project so autonomous demand may retry immediately.",
    schema: ["latch", "fleet"],
  },
  {
    name: "project_stop",
    title: "Stop this project's workers",
    description:
      "MUTATING: stop this project's work and give its registration back; force hard teardown explicitly.",
    schema: ["force", "fleet"],
  },
  {
    name: "logs",
    title: "Read redskilled logs",
    description:
      "Return the newest CastleLaneRecord entries from one structured lane; bounded by `limit` (default 200, max 10 000). Pass `kind` to filter before the limit.",
    schema: ["lane", "id", "limit", "kind"],
  },
  {
    name: "dashboard",
    title: "Build AFK dashboard",
    description:
      "Build the structured operational dashboard from GitHub and local state.",
    schema: ["periodDays"],
  },
  {
    name: "history",
    title: "Read redskilled history",
    description:
      "Return structured AFK history records, newest records last.",
    schema: ["limit"],
  },
  {
    name: "queue_status",
    title: "Read AFK queues",
    description:
      "Return ready-for-agent and ready-for-human queue candidates, retaining successful candidates and naming partial trust-read failures as a degraded result. Pass `selector` to preview the producer's scoped view of the ready queue (same facets as its work selector, e.g. tags/user).",
    schema: ["selector"],
  },
  {
    name: "events_since",
    title: "Poll events since cursor",
    description:
      "Return AFK history events and Worker lane records after an opaque cursor, plus the next cursor. Omit cursor to get a fresh baseline cursor with no events. Unknown or expired cursors are refused with a re-baseline prompt.",
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
      "MUTATING: hand one open PR to a live project merge-driver process — it owns the PR to a terminal state " +
      "(update-branch when BEHIND, merge-commit once green at head, bounded retries, " +
      "needs-medic/needs-human classification) without GitHub native auto-merge. " +
      "Refuses when the merge-driver process is missing so custody cannot become orphaned.",
    schema: ["pr"],
  },
  {
    name: "merge_status",
    title: "Read merge driver state",
    description:
      "Return whether the merge-driver process is ticking plus durable per-PR records: " +
      "armed records labeled driver-ticking or orphaned, attempts, last observed state, " +
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
      "Return the project-side statusline aggregate (project, repo counters, docs drift, drain, Worker rows, aggregated AFK block, queue) as structured data, using the same collector cores and cache discipline as the command-backed statusLine. Host-side fields (session model/effort, context %, usage quotas) are out of scope.",
    schema: [],
  },
  // ADR 0147 rule 1 (#4024): the verbs a shipped skill still names, promoted
  // from the dying CLI into tools that RETURN their core's value.
  {
    name: "manager",
    title: "Route work through the Manager",
    description:
      "MUTATING: take one operator intent into the Manager — intake, route an effort to a skill, attach an artifact, read effort status, or export/import the checkpoint — and return the effort record it acted on.",
    schema: ["intent", "action", "effort", "skill", "artifact", "checkpoint", "path"],
  },
  {
    name: "red_doctor",
    title: "Diagnose this repository's RedSkills setup",
    description:
      "READ-ONLY: return every doctor finding for this repository — operational probes, host toolchain, lane and process census, executable acceptance, HUMAN-ONLY type declarations and disposable-lane hygiene — each paired with the route that repairs it. Applying a repair is the `/red-doctor` skill's own fix lane, never a side effect of the read.",
    schema: ["checks"],
  },
  {
    name: "audit_skills",
    title: "Audit the shipped skills",
    description:
      "Return the ranked skill-audit scores for this repository's skill tree. Pass `mechanical_only` to score without the judge, which makes the read deterministic and free of agent cost.",
    schema: ["mechanical_only", "runner"],
  },
  {
    name: "install_type_labels",
    title: "Install Wayfinder type labels",
    description:
      "MUTATING: create the Wayfinder ticket type labels on the tracker AND declare the HUMAN-ONLY ones in this project's configuration, in one act — the two are one protection with two halves, and installing only the labels leaves the repository looking protected while unblocked decision Tickets enter the autonomous queue (#3013).",
    schema: ["labels", "repo", "dry_run"],
  },
  {
    name: "codex_statusline",
    title: "Inspect the Codex footer preference",
    description:
      "READ-ONLY: return the active Codex configuration's status-line inspection — the file read, the current preference, and the problem that keeps the RedSkills footer from rendering.",
    schema: ["config"],
  },
  {
    name: "codex_monitor_agent",
    title: "Build the Codex monitor agent brief",
    description:
      "Return the read-only monitor brief a Codex sub-agent is spawned with: what to poll, how often, and the conditions under which it closes itself. It spawns nothing — the host's own spawn primitive does.",
    schema: ["project_root", "mode", "interval_seconds"],
  },
  {
    name: "reconcile_engine",
    title: "Reconcile this project's engine delivery",
    description:
      "MUTATING: warm the published engine bundle into the stable cache path and re-point a standing registration at it in one operation, then return the version, the bundle path, and what happened to the registration.",
    schema: ["version"],
  },
  {
    name: "standing_orders_show",
    title: "Show standing orders for this project",
    description:
      "READ-ONLY: return all standing orders for this project. Standing orders are an append-only, numbered register injected verbatim into every Worker brief.",
    schema: ["project_label"],
  },
  {
    name: "standing_orders_append",
    title: "Append a standing order",
    description:
      "MUTATING: append a new standing order to this project's register. The order is injected verbatim into every Worker brief at admission and on resume. Append is append-only — existing orders are never mutated or renumbered.",
    schema: ["text", "project_label"],
  },
];

describe("aggregated rs_dev MCP tool surface", () => {
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

  // ADR 0147 rule 2: a plugin ships ONE Plugin MCP, named `rs_<plugin>`. The
  // name is part of the published surface — a host addresses every tool through
  // it — so it is frozen here beside the tool table rather than left to whatever
  // string the server happened to be constructed with (#4023).
  it("publishes the surface under the `rs_dev` server name", () => {
    expect(RS_DEV_MCP_SERVER_NAME).toBe("rs_dev");

    const server = createRedskilledMcpServer(process.cwd(), async () => ({}));
    const { name } = (server.server as unknown as {
      _serverInfo: { name: string; version: string };
    })._serverInfo;

    expect(name).toBe(RS_DEV_MCP_SERVER_NAME);
  });

  // The rename moved the schemas out of the Worker package and changed no tool
  // (ADR 0148): the adapter registers exactly the composed surface, in order.
  it("registers every composed tool and nothing else", () => {
    const registered = (
      createRedskilledMcpServer(process.cwd(), async () => ({})) as unknown as {
        _registeredTools: Record<string, unknown>;
      }
    )._registeredTools;

    expect(Object.keys(registered)).toEqual(SURFACE.map((tool) => tool.name));
  });
});
