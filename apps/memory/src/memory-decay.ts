import { PINNED_IMPORTANCE_THRESHOLD } from "./doctor.js";
import type { StoredNode } from "./graph-store.js";
import type { NodeType, Tier } from "./schema.js";

export type MemoryDecayAction = "keep" | "review" | "deprecate" | "expire";
export type MemoryDecayStatus = "clean" | "attention";

export interface MemoryDecayStore {
  listNodes(now?: number): Promise<StoredNode[]>;
  listEdges(): Promise<Record<string, unknown>[]>;
  supersededByMany(rids: number[]): Promise<Map<number, number>>;
  accessRecords(): Promise<Map<number, { count: number; accessed_at: number }>>;
}

export interface MemoryDecayInput {
  stale_days?: number;
  deprecate_days?: number;
  limit?: number;
  now?: number;
}

export interface MemoryDecayItem {
  rid: number;
  label: string;
  node_type: NodeType;
  title: string;
  tier: Tier | "unknown";
  action: MemoryDecayAction;
  score: number;
  age_days: number;
  access_count: number;
  importance: number;
  citation: string;
  superseded_by?: number;
  expires_at?: string;
  reasons: string[];
  recommendation: string;
}

export interface MemoryDecayReport {
  schema_version: "memory.decay_plan.v1";
  read_only: true;
  generated_at: string;
  status: MemoryDecayStatus;
  policy: {
    stale_days: number;
    deprecate_days: number;
    pinned_importance_threshold: number;
  };
  summary: {
    considered_nodes: number;
    keep: number;
    review: number;
    deprecate: number;
    expire: number;
    protected: number;
    superseded: number;
  };
  keep: MemoryDecayItem[];
  review: MemoryDecayItem[];
  deprecate: MemoryDecayItem[];
  expire: MemoryDecayItem[];
  markdown: string;
  recommended_next_actions: string[];
}

const DEFAULT_STALE_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const DEFAULT_LIMIT = 20;

export async function buildMemoryDecayReport(
  store: MemoryDecayStore,
  input: MemoryDecayInput = {},
): Promise<MemoryDecayReport> {
  const now = input.now ?? Date.now();
  const staleDays = input.stale_days ?? DEFAULT_STALE_DAYS;
  const deprecateDays = input.deprecate_days ?? staleDays * 2;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const nodes = await store.listNodes(0);
  const [edges, superseded, access] = await Promise.all([
    store.listEdges(),
    store.supersededByMany(nodes.map((node) => node.rid)),
    store.accessRecords(),
  ]);
  const contradicted = contradictionRidSet(edges);
  const items = nodes.map((node) =>
    classifyNode(node, {
      now,
      staleDays,
      deprecateDays,
      supersededBy: superseded.get(node.rid),
      access: access.get(node.rid),
      contradicted: contradicted.has(node.rid),
    }),
  );
  const keep = items.filter((item) => item.action === "keep").sort(compareItems);
  const review = items.filter((item) => item.action === "review").sort(compareItems);
  const deprecate = items.filter((item) => item.action === "deprecate").sort(compareItems);
  const expire = items.filter((item) => item.action === "expire").sort(compareItems);
  const summary = {
    considered_nodes: nodes.length,
    keep: keep.length,
    review: review.length,
    deprecate: deprecate.length,
    expire: expire.length,
    protected: keep.filter((item) =>
      item.reasons.some((reason) => reason.includes("protected")),
    ).length,
    superseded: deprecate.filter((item) => item.superseded_by != null).length,
  };
  const report = {
    schema_version: "memory.decay_plan.v1",
    read_only: true,
    generated_at: new Date(now).toISOString(),
    status:
      summary.review + summary.deprecate + summary.expire > 0 ? "attention" : "clean",
    policy: {
      stale_days: staleDays,
      deprecate_days: deprecateDays,
      pinned_importance_threshold: PINNED_IMPORTANCE_THRESHOLD,
    },
    summary,
    keep: keep.slice(0, limit),
    review: review.slice(0, limit),
    deprecate: deprecate.slice(0, limit),
    expire: expire.slice(0, limit),
    recommended_next_actions: nextActions(summary),
  } satisfies Omit<MemoryDecayReport, "markdown">;
  return { ...report, markdown: renderMarkdown(report) };
}

function classifyNode(
  node: StoredNode,
  context: {
    now: number;
    staleDays: number;
    deprecateDays: number;
    supersededBy?: number;
    access?: { count: number; accessed_at: number };
    contradicted: boolean;
  },
): MemoryDecayItem {
  const tier = parseTier(node.properties.tier);
  const importance = numberValue(node.properties.importance);
  const accessCount = context.access?.count ?? numberValue(node.properties.access_count);
  const accessedAt =
    context.access?.accessed_at ??
    optionalNumber(node.properties.accessed_at) ??
    optionalNumber(node.properties.updated_at) ??
    optionalNumber(node.properties.created_at) ??
    context.now;
  const ageDays = Math.max(0, Math.floor((context.now - accessedAt) / MS_PER_DAY));
  const expiresAt = optionalNumber(node.properties.expires_at);
  const expired = tier === "ephemeral" && expiresAt != null && context.now >= expiresAt;
  const stale = accessCount === 0 && ageDays >= context.staleDays;
  const veryStale = accessCount === 0 && ageDays >= context.deprecateDays;
  const protectedNode = importance >= PINNED_IMPORTANCE_THRESHOLD || accessCount > 0;
  const reasons: string[] = [];
  let action: MemoryDecayAction = "keep";

  if (expired) {
    action = "expire";
    reasons.push("ephemeral TTL horizon has passed and live reads already hide this node");
  } else if (context.supersededBy != null) {
    action = "deprecate";
    reasons.push(`superseded by memory_nodes:${context.supersededBy}`);
  } else if (context.contradicted) {
    action = "review";
    reasons.push("active contradiction evidence exists");
  } else if (!protectedNode && veryStale && importance < 0.5) {
    action = "deprecate";
    reasons.push(`unrecalled for ${ageDays} day(s), beyond deprecate threshold`);
  } else if (!protectedNode && stale) {
    action = "review";
    reasons.push(`unrecalled for ${ageDays} day(s), beyond stale threshold`);
  } else if (protectedNode) {
    reasons.push(
      importance >= PINNED_IMPORTANCE_THRESHOLD
        ? "protected by pinned importance"
        : "protected by recall access evidence",
    );
  } else {
    reasons.push("recent or low-risk memory evidence");
  }

  return {
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    title: String(node.properties.title ?? node.label),
    tier: tier ?? "unknown",
    action,
    score: score(action, ageDays, importance, accessCount),
    age_days: ageDays,
    access_count: accessCount,
    importance,
    citation: `${node.node_type}:${node.label}#${node.rid}`,
    ...(context.supersededBy != null ? { superseded_by: context.supersededBy } : {}),
    ...(expiresAt != null ? { expires_at: new Date(expiresAt).toISOString() } : {}),
    reasons,
    recommendation: recommendationFor(action),
  };
}

function score(
  action: MemoryDecayAction,
  ageDays: number,
  importance: number,
  accessCount: number,
): number {
  const base = { expire: 100, deprecate: 80, review: 50, keep: 10 }[action];
  return Number((base + ageDays / 30 - importance * 5 - Math.min(accessCount, 10)).toFixed(4));
}

function recommendationFor(action: MemoryDecayAction): string {
  if (action === "expire") {
    return "expired ephemeral evidence is already hidden by live reads; storage cleanup must remain explicit";
  }
  if (action === "deprecate") {
    return "prefer newer or superseding evidence before relying on this memory";
  }
  if (action === "review") {
    return "review before using as implementation guidance";
  }
  return "keep as active recall evidence";
}

function renderMarkdown(
  report: Omit<MemoryDecayReport, "markdown">,
): string {
  const lines = [
    "# Memory decay plan",
    "",
    `Status: ${report.status}`,
    `Policy: stale ${report.policy.stale_days}d; deprecate ${report.policy.deprecate_days}d`,
    "",
  ];
  appendSection(lines, "Expire", report.expire);
  appendSection(lines, "Deprecate", report.deprecate);
  appendSection(lines, "Review", report.review);
  appendSection(lines, "Keep", report.keep.slice(0, 5));
  lines.push("## Next Actions");
  for (const action of report.recommended_next_actions) lines.push(`- ${action}`);
  return lines.join("\n").trimEnd();
}

function appendSection(lines: string[], title: string, items: MemoryDecayItem[]): void {
  lines.push(`## ${title}`);
  if (items.length === 0) {
    lines.push("- none");
    lines.push("");
    return;
  }
  for (const item of items) {
    lines.push(`- ${item.title} [${item.citation}]`);
    lines.push(
      `  Action: ${item.action}; tier: ${item.tier}; age: ${item.age_days}d; score: ${item.score.toFixed(4)}`,
    );
    lines.push(`  Why: ${item.reasons.join("; ")}`);
  }
  lines.push("");
}

function nextActions(summary: MemoryDecayReport["summary"]): string[] {
  const actions: string[] = [];
  if (summary.expire > 0) {
    actions.push("inspect expired ephemeral evidence; live reads already exclude it");
  }
  if (summary.deprecate > 0) {
    actions.push("prefer superseding or newer Memory evidence before relying on deprecate candidates");
  }
  if (summary.review > 0) {
    actions.push("review stale or contradicted Memory before turning it into agent guidance");
  }
  if (actions.length === 0) actions.push("memory retention posture is clean");
  return actions;
}

function contradictionRidSet(edges: Record<string, unknown>[]): Set<number> {
  const out = new Set<number>();
  for (const edge of edges) {
    if (edgeLabel(edge) !== "CONTRADICTS") continue;
    const from = edgeEndpoint(edge, "from");
    const to = edgeEndpoint(edge, "to");
    if (from != null) out.add(from);
    if (to != null) out.add(to);
  }
  return out;
}

function edgeLabel(edge: Record<string, unknown>): string {
  return String(edge.label ?? edge.edge_label ?? edge.LABEL ?? "");
}

function edgeEndpoint(edge: Record<string, unknown>, side: "from" | "to"): number | null {
  const value =
    side === "from"
      ? (edge.from ?? edge.from_id ?? edge.from_rid ?? edge.source ?? edge.FROM)
      : (edge.to ?? edge.to_id ?? edge.to_rid ?? edge.target ?? edge.TO);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTier(value: unknown): Tier | null {
  return value === "durable" || value === "ephemeral" || value === "reasoning"
    ? value
    : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compareItems(a: MemoryDecayItem, b: MemoryDecayItem): number {
  return b.score - a.score || b.age_days - a.age_days || a.rid - b.rid;
}
