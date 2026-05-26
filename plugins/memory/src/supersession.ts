import type { StoredNode } from "./graph-store.js";
import { tokenize } from "./recall.js";

export interface SupersessionStore {
  listNodes(): Promise<StoredNode[]>;
  listEdges(): Promise<Record<string, unknown>[]>;
  supersededByMany(rids: number[]): Promise<Map<number, number>>;
  supersede(oldRid: number, newRid: number, reason?: string): Promise<number>;
}

export interface NodeSummary {
  rid: number;
  label: string;
  nodeType: string;
  title: string;
  content: string;
}

export interface ContradictionSummary {
  from: NodeSummary;
  to: NodeSummary;
  reason: string | null;
  resolved: boolean;
  activeRid: number | null;
}

export interface TimelineEntry extends NodeSummary {
  status: "active" | "superseded";
  activeRid: number;
  createdAt: number;
  updatedAt: number;
}

export interface TimelineAuditLink {
  label: "CONTRADICTS" | "SUPERSEDED_BY";
  fromRid: number;
  toRid: number;
  reason: string | null;
  createdAt: number | null;
}

export interface TopicTimeline {
  topic: string;
  entries: TimelineEntry[];
  auditLinks: TimelineAuditLink[];
}

export async function listContradictions(
  store: SupersessionStore,
  opts: { includeResolved?: boolean } = {},
): Promise<ContradictionSummary[]> {
  const nodes = new Map((await store.listNodes()).map((node) => [node.rid, node]));
  const superseded = await store.supersededByMany([...nodes.keys()]);
  const out: ContradictionSummary[] = [];
  // `CONTRADICTS` is symmetric in meaning but stored as a directed edge. Two
  // edges between the same pair (one from each side) are the same contradiction;
  // dedupe on the unordered {min,max} pair so callers don't double-count.
  const seenPairs = new Set<string>();

  for (const edge of await store.listEdges()) {
    if (edgeLabel(edge) !== "CONTRADICTS") continue;
    const fromRid = edgeFrom(edge);
    const toRid = edgeTo(edge);
    const from = nodes.get(fromRid);
    const to = nodes.get(toRid);
    if (!from || !to) continue;
    const pairKey = fromRid < toRid ? `${fromRid}:${toRid}` : `${toRid}:${fromRid}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const fromHead = activeHead(fromRid, superseded, nodes);
    const toHead = activeHead(toRid, superseded, nodes);
    const resolved = fromHead === toHead;
    if (resolved && !opts.includeResolved) continue;

    out.push({
      from: summarizeNode(from),
      to: summarizeNode(to),
      reason: edgeReason(edge),
      resolved,
      activeRid: resolved ? fromHead : null,
    });
  }

  return out;
}

export async function resolveConflict(
  store: SupersessionStore,
  input: { activeRid: number; supersededRid: number; reason?: string },
): Promise<number> {
  const nodes = new Map((await store.listNodes()).map((node) => [node.rid, node]));
  if (!nodes.has(input.activeRid)) throw new Error(`active node not found: ${input.activeRid}`);
  if (!nodes.has(input.supersededRid)) {
    throw new Error(`superseded node not found: ${input.supersededRid}`);
  }
  if (input.activeRid === input.supersededRid) {
    throw new Error("active and superseded nodes must be different");
  }
  return store.supersede(input.supersededRid, input.activeRid, input.reason);
}

export async function supersessionTimeline(
  store: SupersessionStore,
  topic: string,
): Promise<TopicTimeline> {
  const allNodes = await store.listNodes();
  const nodes = new Map(allNodes.map((node) => [node.rid, node]));
  const superseded = await store.supersededByMany([...nodes.keys()]);
  const reverse = reverseSupersededMap(superseded);
  const seeds = matchingNodeRids(allNodes, topic);
  const timelineRids = new Set<number>();

  for (const seed of seeds) addChain(seed, superseded, reverse, nodes, timelineRids);

  const entries = [...timelineRids]
    .map((rid) => nodes.get(rid))
    .filter((node): node is StoredNode => Boolean(node))
    .map((node) => {
      const head = activeHead(node.rid, superseded, nodes);
      return {
        ...summarizeNode(node),
        status: head === node.rid ? ("active" as const) : ("superseded" as const),
        activeRid: head,
        createdAt: numericProp(node, "created_at"),
        updatedAt: numericProp(node, "updated_at"),
      };
    })
    .sort((a, b) => a.createdAt - b.createdAt || a.rid - b.rid);

  const auditLinks = (await store.listEdges())
    .filter((edge) => {
      const label = edgeLabel(edge);
      return label === "SUPERSEDED_BY" || label === "CONTRADICTS";
    })
    .map((edge) => ({
      label: edgeLabel(edge) as "CONTRADICTS" | "SUPERSEDED_BY",
      fromRid: edgeFrom(edge),
      toRid: edgeTo(edge),
      reason: edgeReason(edge),
      createdAt: edgeCreatedAt(edge),
    }))
    .filter((edge) => timelineRids.has(edge.fromRid) && timelineRids.has(edge.toRid))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.fromRid - b.fromRid);

  return { topic, entries, auditLinks };
}

function matchingNodeRids(nodes: StoredNode[], topic: string): number[] {
  const trimmed = topic.trim();
  if (!trimmed) return [];
  const rid = Number(trimmed.replace(/^#/, ""));
  if (Number.isInteger(rid) && /^#?\d+$/.test(trimmed)) {
    return nodes.some((node) => node.rid === rid) ? [rid] : [];
  }

  const terms = tokenize(trimmed);
  if (terms.length === 0) return [];
  return nodes
    .filter((node) => {
      const text = tokenize(nodeText(node));
      return terms.some((term) => text.includes(term));
    })
    .map((node) => node.rid);
}

function addChain(
  seed: number,
  superseded: Map<number, number>,
  reverse: Map<number, number[]>,
  nodes: Map<number, StoredNode>,
  out: Set<number>,
): void {
  const visit = (rid: number) => {
    if (out.has(rid) || !nodes.has(rid)) return;
    out.add(rid);
    const next = superseded.get(rid);
    if (next != null) visit(next);
    for (const prev of reverse.get(rid) ?? []) visit(prev);
  };
  visit(seed);
}

function reverseSupersededMap(map: Map<number, number>): Map<number, number[]> {
  const reverse = new Map<number, number[]>();
  for (const [from, to] of map) {
    const list = reverse.get(to) ?? [];
    list.push(from);
    reverse.set(to, list);
  }
  return reverse;
}

function activeHead(
  rid: number,
  superseded: Map<number, number>,
  nodes: Map<number, StoredNode>,
): number {
  const seen = new Set<number>([rid]);
  let current = rid;
  while (true) {
    const next = superseded.get(current);
    if (next == null || seen.has(next) || !nodes.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

function summarizeNode(node: StoredNode): NodeSummary {
  return {
    rid: node.rid,
    label: node.label,
    nodeType: node.node_type,
    title: node.properties.title ?? node.label,
    content: node.properties.summary ?? node.properties.content ?? "",
  };
}

function nodeText(node: StoredNode): string {
  const tags = Array.isArray(node.properties.tags) ? node.properties.tags.join(" ") : "";
  return [
    node.label,
    node.properties.title,
    node.properties.summary,
    node.properties.content,
    tags,
  ]
    .filter(Boolean)
    .join(" ");
}

function edgeLabel(edge: Record<string, unknown>): string {
  return String(edge.label ?? edge.LABEL ?? "");
}

function edgeFrom(edge: Record<string, unknown>): number {
  return Number(edge.from ?? edge.from_id ?? edge.from_rid ?? edge.source ?? edge.FROM);
}

function edgeTo(edge: Record<string, unknown>): number {
  return Number(edge.to ?? edge.to_id ?? edge.to_rid ?? edge.target ?? edge.TO);
}

function edgeProperties(edge: Record<string, unknown>): Record<string, unknown> {
  const props = edge.properties ?? edge.PROPERTIES ?? {};
  return props && typeof props === "object" ? (props as Record<string, unknown>) : {};
}

function edgeReason(edge: Record<string, unknown>): string | null {
  const reason = edgeProperties(edge).reason;
  return typeof reason === "string" && reason ? reason : null;
}

function edgeCreatedAt(edge: Record<string, unknown>): number | null {
  const created = edgeProperties(edge).created_at;
  return typeof created === "number" ? created : null;
}

function numericProp(node: StoredNode, key: "created_at" | "updated_at"): number {
  const value = node.properties[key];
  return typeof value === "number" ? value : 0;
}
