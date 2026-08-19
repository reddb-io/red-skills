import { readStructuralImpact } from "./structural-impact-reader.js";
import type { Confidence, EdgeLabel, MemoryEdge, MemoryNode, NodeType } from "./schema.js";

export interface PrePrReviewStore {
  listNodes(): Promise<Array<MemoryNode & { rid: number }>>;
  listEdges(): Promise<Array<MemoryEdge | Record<string, unknown>>>;
}

export interface PrePrReviewOptions {
  changedFiles: string[];
  comparison?: string;
}

export interface PrePrEvidenceRef {
  marker: string;
  rid: number;
  urn: string;
  label: string;
  nodeType: NodeType;
  title: string;
  excerpt: string;
  source: string | null;
  confidence: Confidence;
}

export interface PrePrReviewItem {
  title: string;
  summary: string;
  evidence: PrePrEvidenceRef[];
}

export interface PrePrReviewSection {
  items: PrePrReviewItem[];
  missing: boolean;
}

export interface PrePrMemoryReview {
  comparison: string | null;
  changedFiles: string[];
  impactedConcepts: PrePrReviewSection;
  relatedDecisions: PrePrReviewSection;
  knownFailures: PrePrReviewSection;
  suggestedValidations: PrePrReviewSection;
  risks: PrePrReviewSection;
  evidence: PrePrEvidenceRef[];
  missingEvidence: string[];
  readOnly: true;
}

type StoredNode = MemoryNode & { rid: number };

const DECISION_TYPES: readonly NodeType[] = ["decision", "why_note", "workflow"];
const FAILURE_TYPES: readonly NodeType[] = ["problem", "fix", "worker"];
const VALIDATION_TYPES: readonly NodeType[] = ["validation"];

export async function buildPrePrMemoryReview(
  store: PrePrReviewStore,
  opts: PrePrReviewOptions,
): Promise<PrePrMemoryReview> {
  const changedFiles = unique(opts.changedFiles.map(normalizePath).filter(Boolean));
  const nodes = await store.listNodes();
  const edges = (await store.listEdges())
    .map(normalizeEdge)
    .filter((edge): edge is MemoryEdge => edge != null);
  const nodeByRid = new Map(nodes.map((node) => [node.rid, node]));
  const markerFor = evidenceMarkerFactory(nodeByRid);

  const changedRids = new Set<number>();
  for (const file of changedFiles) {
    const impact = await readStructuralImpact({ listNodes: async () => nodes, listEdges: async () => edges }, { file });
    if (impact.definedIn) changedRids.add(impact.definedIn.rid);
    for (const node of impact.defines) changedRids.add(node.rid);
    for (const edge of [...impact.imports, ...impact.importedBy]) {
      changedRids.add(edge.from.rid);
      changedRids.add(edge.to.rid);
    }
  }

  for (const node of nodes) {
    if (node.node_type === "file" && changedFiles.some((file) => pathMatches(node, file))) {
      changedRids.add(node.rid);
    }
  }

  const relatedRids = expandByEdges(changedRids, edges, 2);
  const relatedNodes = [...relatedRids]
    .map((rid) => nodeByRid.get(rid))
    .filter((node): node is StoredNode => node != null);

  const impactedConcepts = section(
    relatedNodes.filter((node) => node.node_type === "concept"),
    markerFor,
  );
  const relatedDecisions = section(
    relatedNodes.filter((node) => includesType(DECISION_TYPES, node.node_type)),
    markerFor,
  );
  const knownFailures = section(
    relatedNodes.filter((node) => includesType(FAILURE_TYPES, node.node_type) && looksLikeFailure(node)),
    markerFor,
  );
  const suggestedValidations = section(
    relatedNodes.filter((node) => includesType(VALIDATION_TYPES, node.node_type)),
    markerFor,
  );
  const risks = riskSection(
    knownFailures.items,
    relatedNodes,
    markerFor,
    changedFiles,
    edges,
    nodeByRid,
    changedRids,
  );

  const missingEvidence: string[] = [];
  for (const [name, value] of [
    ["changed code", changedFiles.length],
    ["impacted concepts", impactedConcepts.items.length],
    ["related decisions", relatedDecisions.items.length],
    ["known failures", knownFailures.items.length],
    ["suggested validations", suggestedValidations.items.length],
    ["risks", risks.items.length],
  ] as const) {
    if (value === 0) missingEvidence.push(name);
  }

  return {
    comparison: opts.comparison ?? null,
    changedFiles,
    impactedConcepts,
    relatedDecisions,
    knownFailures,
    suggestedValidations,
    risks,
    evidence: markerFor.all(),
    missingEvidence,
    readOnly: true,
  };
}

function section(
  nodes: StoredNode[],
  markerFor: ReturnType<typeof evidenceMarkerFactory>,
): PrePrReviewSection {
  const items = uniqueNodes(nodes).map((node) => ({
    title: titleOf(node),
    summary: excerptOf(node),
    evidence: [markerFor(node.rid)],
  }));
  return { items, missing: items.length === 0 };
}

function riskSection(
  knownFailureItems: PrePrReviewItem[],
  relatedNodes: StoredNode[],
  markerFor: ReturnType<typeof evidenceMarkerFactory>,
  changedFiles: string[],
  edges: MemoryEdge[],
  nodeByRid: Map<number, StoredNode>,
  changedRids: Set<number>,
): PrePrReviewSection {
  const items: PrePrReviewItem[] = knownFailureItems.map((item) => ({
    title: `Known failure risk: ${item.title}`,
    summary: item.summary,
    evidence: item.evidence,
  }));
  for (const node of uniqueNodes(relatedNodes.filter((n) => n.node_type === "file"))) {
    if (!node.label.startsWith("file:")) continue;
    if (changedFiles.some((file) => pathMatches(node, file))) continue;
    items.push({
      title: `Downstream file may be affected: ${titleOf(node)}`,
      summary: excerptOf(node),
      evidence: [markerFor(node.rid)],
    });
  }
  for (const edge of edges) {
    if (edge.label !== "CALLS" && edge.label !== "USES_TYPE" && edge.label !== "REFERENCES") continue;
    const fromChanged = changedRids.has(edge.from_rid);
    const toChanged = changedRids.has(edge.to_rid);
    if (fromChanged === toChanged) continue;
    const impacted = nodeByRid.get(fromChanged ? edge.to_rid : edge.from_rid);
    if (!impacted || impacted.node_type !== "symbol") continue;
    if (changedFiles.some((file) => pathMatches(impacted, file))) continue;
    const kind =
      edge.label === "CALLS" ? "Call graph" : edge.label === "USES_TYPE" ? "Type-use" : "Reference";
    items.push({
      title: `${kind} dependency may be affected: ${titleOf(impacted)}`,
      summary: excerptOf(impacted),
      evidence: [markerFor(impacted.rid)],
    });
  }
  return { items, missing: items.length === 0 };
}

function evidenceMarkerFactory(nodeByRid: Map<number, StoredNode>) {
  const markers = new Map<number, PrePrEvidenceRef>();
  return Object.assign(
    (rid: number): PrePrEvidenceRef => {
      const existing = markers.get(rid);
      if (existing) return existing;
      const node = nodeByRid.get(rid);
      if (!node) throw new Error(`missing evidence node ${rid}`);
      const marker = `[${markers.size + 1}]`;
      const ref: PrePrEvidenceRef = {
        marker,
        rid,
        urn: `memory_nodes:${rid}`,
        label: node.label,
        nodeType: node.node_type,
        title: titleOf(node),
        excerpt: excerptOf(node),
        source: typeof node.properties.source === "string" ? node.properties.source : null,
        confidence: node.properties.confidence ?? "AMBIGUOUS",
      };
      markers.set(rid, ref);
      return ref;
    },
    {
      all: () => [...markers.values()],
    },
  );
}

function expandByEdges(start: Set<number>, edges: MemoryEdge[], depth: number): Set<number> {
  const seen = new Set(start);
  let frontier = new Set(start);
  for (let i = 0; i < depth; i++) {
    const next = new Set<number>();
    for (const edge of edges) {
      if (frontier.has(edge.from_rid) && !seen.has(edge.to_rid)) next.add(edge.to_rid);
      if (frontier.has(edge.to_rid) && !seen.has(edge.from_rid)) next.add(edge.from_rid);
    }
    for (const rid of next) seen.add(rid);
    frontier = next;
    if (frontier.size === 0) break;
  }
  return seen;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueNodes(nodes: StoredNode[]): StoredNode[] {
  const byRid = new Map<number, StoredNode>();
  for (const node of nodes) byRid.set(node.rid, node);
  return [...byRid.values()].sort((a, b) => a.rid - b.rid);
}

function includesType(types: readonly NodeType[], type: NodeType): boolean {
  return types.includes(type);
}

function looksLikeFailure(node: StoredNode): boolean {
  if (node.node_type === "problem") return true;
  const text = `${node.properties.title} ${node.properties.summary ?? ""} ${node.properties.content ?? ""}`;
  return /\b(fail|failed|failure|broken|error|regression|timeout)\b/i.test(text);
}

function titleOf(node: StoredNode): string {
  return node.properties.title || node.label;
}

function excerptOf(node: StoredNode): string {
  const text = node.properties.summary ?? node.properties.content ?? node.properties.title ?? node.label;
  return String(text).replace(/\s+/g, " ").trim().slice(0, 300);
}

function normalizeEdge(row: MemoryEdge | Record<string, unknown>): MemoryEdge | null {
  const r = row as Record<string, unknown>;
  const label = r.label ?? r.LABEL;
  const from = r.from ?? r.from_id ?? r.from_rid ?? r.source ?? r.FROM;
  const to = r.to ?? r.to_id ?? r.to_rid ?? r.target ?? r.TO;
  const fromRid = Number(from);
  const toRid = Number(to);
  if (typeof label !== "string" || !Number.isFinite(fromRid) || !Number.isFinite(toRid)) {
    return null;
  }
  return {
    rid: numberOrUndefined(r.rid ?? r.red_entity_id),
    label: label as EdgeLabel,
    from_rid: fromRid,
    to_rid: toRid,
    weight: numberOrUndefined(r.weight ?? r.WEIGHT),
    properties: (r.properties ?? r.PROPERTIES) as MemoryEdge["properties"],
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function pathMatches(node: StoredNode, targetFile: string): boolean {
  const target = normalizePath(targetFile);
  return [node.label.replace(/^file:/, ""), node.properties.title, node.properties.source]
    .filter((value): value is string => typeof value === "string")
    .map(normalizePath)
    .some((candidate) => candidate === target || candidate.endsWith(`/${target}`) || target.endsWith(`/${candidate}`));
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}
