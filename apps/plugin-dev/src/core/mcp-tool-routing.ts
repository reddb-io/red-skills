/**
 * mcp-tool-routing — what actually answers each `rs_dev` tool (#4113).
 *
 * The Plugin MCP publishes 55 tools. Four of them reach a real ACP control
 * call. The other 51 fell through to `session.prompt("/<tool> {…}")` — the
 * literal text of the call, handed to a Worker that has no ticket handoff for
 * it, which narrated "native Worker is executing the prompt" and ended the
 * turn. **The caller got a healthy-looking EMPTY envelope, having birthed and
 * killed a Worker to produce it.** Two operators burned sessions ruling out
 * version skew, capacity, bridge version, runner and socket against what was
 * actually a routing table with five rows in it.
 *
 * The verbs are implemented in NO process: ADR 0147 deleted the engine that
 * held them, ADR 0120 and #4026 made the MCP thin ("this process owns no engine
 * port"), and the daemon's `_redskills/*` surface contains none of the public
 * capability verbs. A fallthrough to a prompt is therefore not a degradation —
 * it is a fabrication, because there is no second implementation for it to
 * degrade TO.
 *
 * So the routing is DECLARED, one row per published tool, and the adapter reads
 * its control map from here rather than keeping a second list. Each row is one
 * of three answers:
 *
 *   - `control` — reaches `session.control(op)` on the daemon's Project control
 *     surface. These are the four that work today.
 *   - `served` — reaches a named `_redskills/*` daemon method. **Empty today**;
 *     this is the landing pad slice 2 fills, one verb at a time.
 *   - `unserved` — declared absent, with the reason. The caller is refused BY
 *     NAME instead of being handed an empty envelope.
 *
 * The ratchet beside it (`tests/mcp-tool-routing-guard.test.ts`) pins the table
 * against both live sources in both directions: the live MCP tool registry, so
 * a NEW tool cannot land without a routing decision; and `REDSKILLS_ACP_METHODS`,
 * so a `served` row naming a method the daemon does not serve fails. The
 * `unserved` list is **shrink-only** — {@link UNSERVED_MCP_TOOL_BASELINE} may
 * only go down, because a number that can go up is a budget, not a ratchet.
 */
import { REDSKILLS_ACP_METHODS, type RedskillsAcpMethod } from "@reddb-io/protocol-acp";

/** The operations the daemon's Project control surface accepts. */
export type McpToolControlOperation = "drain" | "stop" | "status";

/** Which of the three answers a tool's row gives. */
export type McpToolRoutingKind = "control" | "served" | "unserved";

/** One published `rs_dev` tool and what answers it. */
export interface McpToolRoute {
  /** The published tool name, exactly as the MCP registry spells it. */
  readonly tool: string;
  readonly kind: McpToolRoutingKind;
  /** The control operation, for `control` rows only. */
  readonly operation?: McpToolControlOperation;
  /** The `_redskills/*` method that serves it, for `served` rows only. */
  readonly method?: RedskillsAcpMethod;
  /** Why nothing serves it, for `unserved` rows only. Refusals quote it. */
  readonly reason?: string;
}

/**
 * The body was the engine ADR 0147 deleted: tracker reads, engine lanes, the
 * landing tail. Slice 2 serves these by giving the daemon the method.
 */
const ENGINE_GONE =
  "its engine went with ADR 0147; no _redskills/* daemon method serves it yet";

/**
 * The authority is the daemon's — process birth, placement, registration shape,
 * the standing register — but no `_redskills/*` method exposes this verb, so a
 * client that asks reaches nothing.
 */
const DAEMON_OWNED =
  "the daemon owns this authority (ADR 0130/0148) but publishes no _redskills/* method for it yet";

/**
 * The answer needs no daemon at all — it is a read of THIS checkout. Named
 * apart because slice 2 can serve these in-process, without a wire change.
 */
const LOCAL_ANSWER =
  "it is answerable from this checkout alone, but the adapter owns no body for it since ADR 0147";

/** One `unserved` row, spelled once. */
function unserved(tool: string, reason: string): McpToolRoute {
  return { tool, kind: "unserved", reason };
}

/**
 * The routing of every published `rs_dev` tool, in registry order.
 *
 * Order matches `createCastleMcpTools` so a reader can diff the two by eye;
 * the ratchet checks membership, not order.
 */
export const MCP_TOOL_ROUTING: readonly McpToolRoute[] = [
  unserved("help", LOCAL_ANSWER),
  { tool: "status", kind: "control", operation: "status" },
  unserved("project_activation", LOCAL_ANSWER),
  { tool: "project_status", kind: "control", operation: "status" },
  { tool: "drain", kind: "control", operation: "drain" },
  unserved("project_start", DAEMON_OWNED),
  unserved("project_resize", DAEMON_OWNED),
  unserved("project_reset", DAEMON_OWNED),
  { tool: "project_stop", kind: "control", operation: "stop" },
  unserved("logs", ENGINE_GONE),
  unserved("dashboard", ENGINE_GONE),
  unserved("history", ENGINE_GONE),
  unserved("queue_status", ENGINE_GONE),
  unserved("events_since", ENGINE_GONE),
  unserved("deadend_audit", ENGINE_GONE),
  // The first slice-2 landing: the daemon has served its go-dispatch method
  // since ADR 0150 §3, with zero callers — the /go skill dispatched through
  // this tool, which refused. Demand-form dispatches now reach the method;
  // issue-form and mode/runner arguments refuse by name in the adapter, since
  // the wire deliberately carries one field (the demand).
  { tool: "worker_dispatch", kind: "served", method: REDSKILLS_ACP_METHODS.goDispatch },
  unserved("worker_stop", DAEMON_OWNED),
  unserved("worker_recycle", DAEMON_OWNED),
  unserved("runner_list", DAEMON_OWNED),
  unserved("runner_detect", DAEMON_OWNED),
  unserved("runner_steer", DAEMON_OWNED),
  unserved("steer_status", DAEMON_OWNED),
  unserved("worker_request", DAEMON_OWNED),
  unserved("requeue", ENGINE_GONE),
  unserved("retake", ENGINE_GONE),
  unserved("reap", ENGINE_GONE),
  unserved("unblock_sweep", ENGINE_GONE),
  unserved("gate_run", DAEMON_OWNED),
  unserved("land_branch", ENGINE_GONE),
  unserved("cascade_status", ENGINE_GONE),
  unserved("claim_status", ENGINE_GONE),
  unserved("claim_release", ENGINE_GONE),
  unserved("merge_arm", ENGINE_GONE),
  unserved("merge_status", ENGINE_GONE),
  unserved("merge_release", ENGINE_GONE),
  unserved("hitl_resolve", ENGINE_GONE),
  unserved("worktree_list", LOCAL_ANSWER),
  unserved("worktree_remove", LOCAL_ANSWER),
  unserved("wait_start", LOCAL_ANSWER),
  unserved("wait_list", LOCAL_ANSWER),
  unserved("wait_status", LOCAL_ANSWER),
  unserved("daily_review", ENGINE_GONE),
  unserved("weekly_review", ENGINE_GONE),
  unserved("triage", ENGINE_GONE),
  unserved("respond", ENGINE_GONE),
  unserved("statusline_aggregate", LOCAL_ANSWER),
  unserved("manager", DAEMON_OWNED),
  unserved("red_doctor", LOCAL_ANSWER),
  unserved("audit_skills", LOCAL_ANSWER),
  unserved("install_type_labels", ENGINE_GONE),
  unserved("codex_statusline", LOCAL_ANSWER),
  unserved("codex_monitor_agent", LOCAL_ANSWER),
  unserved("reconcile_engine", DAEMON_OWNED),
  unserved("standing_orders_show", DAEMON_OWNED),
  unserved("standing_orders_append", DAEMON_OWNED),
];

/**
 * How many tools are declared unserved right now.
 *
 * **Shrink-only.** Slice 2 lowers it by moving a row from `unserved` to
 * `served`; nothing may raise it. A new tool that arrives unserved must be
 * served instead — the whole point of the ratchet is that "we added another
 * verb nothing implements" cannot pass review as a number bump.
 */
export const UNSERVED_MCP_TOOL_BASELINE = 50;

const BY_TOOL: ReadonlyMap<string, McpToolRoute> = new Map(
  MCP_TOOL_ROUTING.map((route) => [route.tool, route]),
);

/** The declared route for one tool name, or `undefined` when undeclared. PURE. */
export function mcpToolRoute(tool: string): McpToolRoute | undefined {
  return BY_TOOL.get(tool);
}

/**
 * The `[tool, operation]` pairs the ACP adapter builds its control map from.
 *
 * The adapter derives rather than restates: a second hand-kept list is exactly
 * how `drain` and `project_drain` came to disagree about which names were real.
 * PURE.
 */
export function mcpControlRoutes(): [string, McpToolControlOperation][] {
  return MCP_TOOL_ROUTING.flatMap((route) =>
    route.kind === "control" && route.operation != null
      ? [[route.tool, route.operation] as [string, McpToolControlOperation]]
      : [],
  );
}

/** The published tools that reach a control call, sorted — quoted in refusals. PURE. */
export function servedControlToolNames(): string[] {
  return mcpControlRoutes().map(([tool]) => tool).sort();
}

/**
 * The refusal an unserved tool answers with.
 *
 * It has to carry three things, because the operator reading it has already
 * been misled once: WHICH tool refused, WHY nothing answers it, and WHAT does
 * work. A refusal that omits the third sends the reader back to the same
 * fruitless capacity-and-socket hunt this defect cost two of them. PURE.
 */
export function renderUnservedToolRefusal(route: McpToolRoute): string {
  return (
    `rs_dev tool ${JSON.stringify(route.tool)} is not served: ${route.reason} (#4113). ` +
    `The adapter refuses rather than degrade the call to a Worker prompt, which returns ` +
    `an empty envelope that looks healthy. The Project control surface serves only: ` +
    `${servedControlToolNames().join(", ")}.`
  );
}

/** One way the declared table and a live source disagree. */
export interface McpToolRoutingFinding {
  readonly tool: string;
  readonly reason: string;
}

/** The live sources the table is pinned against. */
export interface McpToolRoutingSources {
  /** Every tool name the live MCP registry publishes. */
  readonly published: readonly string[];
  /** Every `_redskills/*` method the daemon declares. */
  readonly methods: readonly string[];
}

/**
 * Every disagreement between the declared table and the live sources. PURE.
 *
 * Both directions, because only one of them survives us: "nothing declared is
 * fiction" catches a rename, and "nothing undeclared publishes" is what makes a
 * NEW tool inherit the routing decision the moment its row lands in the
 * registry — rather than the next time somebody remembers to look.
 */
export function auditMcpToolRouting(
  sources: McpToolRoutingSources,
  table: readonly McpToolRoute[] = MCP_TOOL_ROUTING,
): McpToolRoutingFinding[] {
  const findings: McpToolRoutingFinding[] = [];
  const declared = new Set<string>();
  for (const route of table) {
    if (declared.has(route.tool)) {
      findings.push({ tool: route.tool, reason: "declared twice; one row per tool" });
      continue;
    }
    declared.add(route.tool);
    if (!sources.published.includes(route.tool)) {
      findings.push({
        tool: route.tool,
        reason: "declared here but the MCP registry publishes no such tool",
      });
    }
    findings.push(...auditRouteBody(route, sources));
  }
  for (const tool of sources.published) {
    if (declared.has(tool)) continue;
    findings.push({
      tool,
      reason:
        "published by the MCP registry with no declared route; add a control, served or unserved row",
    });
  }
  return findings;
}

/** The per-row obligations of each routing kind. PURE. */
function auditRouteBody(
  route: McpToolRoute,
  sources: McpToolRoutingSources,
): McpToolRoutingFinding[] {
  if (route.kind === "control") {
    return route.operation == null
      ? [{ tool: route.tool, reason: "control route names no control operation" }]
      : [];
  }
  if (route.kind === "served") {
    if (route.method == null) {
      return [{ tool: route.tool, reason: "served route names no _redskills/* method" }];
    }
    return sources.methods.includes(route.method)
      ? []
      : [{
        tool: route.tool,
        reason: `served route names ${JSON.stringify(route.method)}, which the daemon does not serve`,
      }];
  }
  return (route.reason ?? "").trim().length >= 40
    ? []
    : [{ tool: route.tool, reason: "unserved route states no reason a reader can act on" }];
}
