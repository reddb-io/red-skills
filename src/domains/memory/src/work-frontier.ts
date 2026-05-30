import type { MemoryStore, StoredNode } from "./graph-store.js";
import type { NodeType } from "./schema.js";

export interface WorkFrontierInput {
  focus?: string;
  limit?: number;
  now?: number;
}

export interface WorkFrontierBlocker {
  rid: number;
  label: string;
  title: string;
  status: string | null;
  citation: string;
  reason: string;
}

export interface WorkFrontierItem {
  rid: number;
  label: string;
  node_type: NodeType;
  title: string;
  summary: string;
  status: string | null;
  priority: number;
  updated_at: string | null;
  age_days: number | null;
  citation: string;
  blocked_by: WorkFrontierBlocker[];
  unlocks: number;
  reasons: string[];
}

export interface WorkFrontierReport {
  schema_version: "memory.work_frontier.v1";
  read_only: true;
  generated_at: string;
  focus: string | null;
  status: "ready" | "empty" | "blocked-only";
  summary: {
    considered_nodes: number;
    candidate_work: number;
    ready: number;
    blocked: number;
    completed: number;
  };
  ready: WorkFrontierItem[];
  blocked: WorkFrontierItem[];
  completed: WorkFrontierItem[];
  markdown: string;
  recommended_next_actions: string[];
}

const DEFAULT_LIMIT = 12;
const WORK_TYPES = new Set<NodeType>(["task", "goal", "issue", "prd"]);
const COMPLETED_STATUSES = new Set([
  "done",
  "complete",
  "completed",
  "closed",
  "resolved",
  "merged",
  "shipped",
  "succeeded",
  "success",
  "passed",
]);
const BLOCKED_STATUSES = new Set(["blocked", "waiting", "paused", "deferred"]);

export async function buildWorkFrontier(
  store: MemoryStore,
  input: WorkFrontierInput = {},
): Promise<WorkFrontierReport> {
  const now = input.now ?? Date.now();
  const focus = normalizeFocus(input.focus);
  const limit = clampLimit(input.limit);
  const [nodes, edges] = await Promise.all([store.listNodes(now), store.listEdges()]);
  const nodesByRid = new Map(nodes.map((node) => [node.rid, node]));
  const candidates = nodes
    .filter((node) => WORK_TYPES.has(node.node_type))
    .filter((node) => matchesFocus(node, focus))
    .sort((a, b) => b.rid - a.rid);

  const items = candidates.map((node) => toItem(node, now, nodesByRid, edges));
  const completed = items
    .filter((item) => isCompletedStatus(item.status))
    .sort(compareItems)
    .slice(0, limit);
  const active = items.filter((item) => !isCompletedStatus(item.status));
  const blocked = active
    .filter((item) => item.blocked_by.length > 0 || isBlockedStatus(item.status))
    .sort(compareItems)
    .slice(0, limit);
  const ready = active
    .filter((item) => item.blocked_by.length === 0 && !isBlockedStatus(item.status))
    .sort(compareItems)
    .slice(0, limit);

  const status =
    ready.length > 0 ? "ready" : blocked.length > 0 ? "blocked-only" : "empty";
  const report: Omit<WorkFrontierReport, "markdown"> = {
    schema_version: "memory.work_frontier.v1",
    read_only: true,
    generated_at: new Date(now).toISOString(),
    focus,
    status,
    summary: {
      considered_nodes: nodes.length,
      candidate_work: candidates.length,
      ready: active.filter((item) => item.blocked_by.length === 0 && !isBlockedStatus(item.status)).length,
      blocked: active.filter((item) => item.blocked_by.length > 0 || isBlockedStatus(item.status)).length,
      completed: items.filter((item) => isCompletedStatus(item.status)).length,
    },
    ready,
    blocked,
    completed,
    recommended_next_actions: nextActions(status, focus),
  };
  return { ...report, markdown: renderMarkdown(report) };
}

function toItem(
  node: StoredNode,
  now: number,
  nodesByRid: Map<number, StoredNode>,
  edges: Record<string, unknown>[],
): WorkFrontierItem {
  const timestamp = nodeTime(node);
  const status = stringProp(node.properties.status);
  const blockers = blockersFor(node, nodesByRid, edges);
  const unlocks = edges.filter((edge) => isDependencyEdge(edge) && edgeFrom(edge) === node.rid).length;
  const priority = priorityScore(node, blockers.length, unlocks, now);
  return {
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    title: stringProp(node.properties.title) ?? node.label,
    summary: compact(
      stringProp(node.properties.summary) ??
        stringProp(node.properties.content) ??
        stringProp(node.properties.title) ??
        node.label,
      220,
    ),
    status,
    priority,
    updated_at: timestamp > 0 ? new Date(timestamp).toISOString() : null,
    age_days: timestamp > 0 ? Math.max(0, Math.floor((now - timestamp) / 86_400_000)) : null,
    citation: `${node.node_type}:${node.label}#${node.rid}`,
    blocked_by: blockers,
    unlocks,
    reasons: itemReasons(node, blockers, unlocks, priority),
  };
}

function blockersFor(
  node: StoredNode,
  nodesByRid: Map<number, StoredNode>,
  edges: Record<string, unknown>[],
): WorkFrontierBlocker[] {
  return edges
    .filter((edge) => isDependencyEdge(edge) && edgeTo(edge) === node.rid)
    .map((edge) => {
      const blocker = nodesByRid.get(edgeFrom(edge));
      if (!blocker) return null;
      const status = stringProp(blocker.properties.status);
      if (isCompletedStatus(status)) return null;
      return {
        rid: blocker.rid,
        label: blocker.label,
        title: stringProp(blocker.properties.title) ?? blocker.label,
        status,
        citation: `${blocker.node_type}:${blocker.label}#${blocker.rid}`,
        reason: edgeReason(edge),
      } satisfies WorkFrontierBlocker;
    })
    .filter((item): item is WorkFrontierBlocker => item != null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

function isDependencyEdge(edge: Record<string, unknown>): boolean {
  return ["BLOCKS", "PRECEDES", "ENABLES", "RUNS_AFTER"].includes(edgeLabel(edge));
}

function edgeLabel(edge: Record<string, unknown>): string {
  return String(edge.label ?? edge.edge_label ?? edge.LABEL ?? "");
}

function edgeFrom(edge: Record<string, unknown>): number {
  return Number(edge.from_rid ?? edge.from ?? edge.from_id ?? edge.source ?? edge.source_id ?? 0);
}

function edgeTo(edge: Record<string, unknown>): number {
  return Number(edge.to_rid ?? edge.to ?? edge.to_id ?? edge.target ?? edge.target_id ?? 0);
}

function edgeReason(edge: Record<string, unknown>): string {
  const props = edge.properties;
  if (!props || typeof props !== "object") return edgeLabel(edge);
  const reason = (props as { reason?: unknown }).reason;
  return reason == null ? edgeLabel(edge) : String(reason);
}

function priorityScore(
  node: StoredNode,
  blockers: number,
  unlocks: number,
  now: number,
): number {
  const importance =
    typeof node.properties.importance === "number" ? node.properties.importance : 0.5;
  const ageDays = Math.max(0, (now - nodeTime(node)) / 86_400_000);
  const recency = Math.max(0, 3 - Math.min(3, ageDays / 14));
  const type = node.node_type === "issue" ? 2 : node.node_type === "task" ? 1.5 : 1;
  return Number((importance * 10 + unlocks * 2 + recency + type - blockers * 4).toFixed(4));
}

function itemReasons(
  node: StoredNode,
  blockers: WorkFrontierBlocker[],
  unlocks: number,
  priority: number,
): string[] {
  const reasons = [`${node.node_type} evidence has priority score ${priority.toFixed(4)}`];
  if (blockers.length > 0) {
    reasons.push(`${blockers.length} incomplete blocker(s) found through dependency edges`);
  } else {
    reasons.push("no incomplete dependency blocker found");
  }
  if (unlocks > 0) reasons.push(`completing this may unlock ${unlocks} downstream item(s)`);
  return reasons;
}

function renderMarkdown(report: Omit<WorkFrontierReport, "markdown">): string {
  const lines = [
    "# Memory work frontier",
    "",
    report.focus ? `Focus: ${report.focus}` : "Focus: all remembered work",
    `Status: ${report.status}`,
    "",
  ];
  if (report.ready.length > 0) {
    lines.push("## Ready Next");
    for (const item of report.ready) {
      lines.push(`- ${item.title} [${item.citation}]`);
      lines.push(`  Priority: ${item.priority.toFixed(4)}; status: ${item.status ?? "unknown"}`);
      lines.push(`  Why: ${item.reasons.join("; ")}`);
    }
    lines.push("");
  }
  if (report.blocked.length > 0) {
    lines.push("## Blocked");
    for (const item of report.blocked) {
      const blockers = item.blocked_by.map((blocker) => blocker.citation).join(", ") || "status";
      lines.push(`- ${item.title} [${item.citation}]`);
      lines.push(`  Blocked by: ${blockers}`);
      if (item.blocked_by.length > 0) {
        lines.push(
          `  Reasons: ${item.blocked_by.map((blocker) => blocker.reason).join("; ")}`,
        );
      }
    }
    lines.push("");
  }
  if (report.completed.length > 0) {
    lines.push("## Recently Completed");
    for (const item of report.completed) lines.push(`- ${item.title} [${item.citation}]`);
    lines.push("");
  }
  if (report.ready.length === 0 && report.blocked.length === 0) {
    lines.push("No remembered active work items matched this frontier request.", "");
  }
  if (report.recommended_next_actions.length > 0) {
    lines.push("## Next Actions");
    for (const action of report.recommended_next_actions) lines.push(`- ${action}`);
  }
  return lines.join("\n").trimEnd();
}

function nextActions(status: WorkFrontierReport["status"], focus: string | null): string[] {
  if (status === "ready") return ["start with the highest-priority ready item or call memory_work_frontier from an agent handoff"];
  if (status === "blocked-only") return ["resolve the listed blockers before assigning new agent work"];
  if (focus) return ["store or ingest task/issue evidence for this focus before relying on Memory frontier"];
  return ["store active task or issue nodes before relying on Memory frontier"];
}

function compareItems(a: WorkFrontierItem, b: WorkFrontierItem): number {
  return b.priority - a.priority || (b.age_days ?? 0) - (a.age_days ?? 0) || a.title.localeCompare(b.title);
}

function matchesFocus(node: StoredNode, focus: string | null): boolean {
  if (!focus) return true;
  const terms = focus.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${node.label} ${node.node_type} ${String(node.properties.title ?? "")} ${String(node.properties.summary ?? "")} ${String(node.properties.content ?? "")}`.toLowerCase();
  return terms.every((term) => text.includes(term));
}

function normalizeFocus(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(100, Math.floor(value ?? DEFAULT_LIMIT)));
}

function isCompletedStatus(value: string | null | undefined): boolean {
  return value != null && COMPLETED_STATUSES.has(value.toLowerCase());
}

function isBlockedStatus(value: string | null | undefined): boolean {
  return value != null && BLOCKED_STATUSES.has(value.toLowerCase());
}

function nodeTime(node: StoredNode): number {
  const updated = numberProp(node.properties.updated_at);
  const created = numberProp(node.properties.created_at);
  return updated ?? created ?? 0;
}

function stringProp(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberProp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compact(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, Math.max(0, max - 3))}...`;
}
