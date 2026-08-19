import type { MemoryStore, StoredNode, VectorStatusReport } from "./graph-store.js";
import type { EdgeLabel, MemoryDoc, MemoryEdge, NodeType } from "./schema.js";

export interface DocCoverageNodeRef {
  rid: number;
  label: string;
  node_type: NodeType;
  title: string;
}

export interface DocCoverageItem {
  rid: number;
  path: string;
  title: string | null;
  hash: string;
  body_bytes: number;
  truncated: boolean;
  graph_status: "grounded" | "ungrounded";
  root_node: DocCoverageNodeRef | null;
  references: {
    count: number;
    examples: DocCoverageNodeRef[];
  };
  vector_status: "ready" | "stale" | "unavailable" | "failed" | "missing";
}

export interface DocCoverageReport {
  schema_version: "memory.doc_coverage.v1";
  read_only: true;
  total_docs: number;
  grounded_docs: number;
  ungrounded_docs: number;
  docs_with_references: number;
  total_references: number;
  vector: Pick<
    VectorStatusReport,
    "overall" | "total" | "ready" | "stale" | "unavailable" | "failed"
  > & { error?: string };
  docs: DocCoverageItem[];
  warnings: string[];
}

export interface DocCoverageStore {
  listDocs(): Promise<Array<MemoryDoc & { rid: number }>>;
  listNodes(): Promise<StoredNode[]>;
  listEdges(): Promise<Array<MemoryEdge | Record<string, unknown>>>;
  vectorStatus(): Promise<VectorStatusReport>;
}

const TRUNCATION_MARKER = "[…truncated to fit memory store…]";

export async function buildDocCoverageReport(
  store: DocCoverageStore | MemoryStore,
): Promise<DocCoverageReport> {
  const [docs, nodes, edges, vector] = await Promise.all([
    store.listDocs(),
    store.listNodes(),
    store.listEdges(),
    vectorSummary(store),
  ]);
  const nodeByRid = new Map(nodes.map((node) => [node.rid, node]));
  const rootByHash = new Map<string, StoredNode>();
  for (const node of nodes) {
    const hash = node.properties.hash;
    if (typeof hash === "string" && !rootByHash.has(hash)) rootByHash.set(hash, node);
  }
  const normalizedEdges = edges
    .map(normalizeEdge)
    .filter((edge): edge is MemoryEdge => edge != null);
  const vectorDocStatus = new Map(
    "docs" in vector
      ? vector.docs.map((doc) => [doc.rid, doc.status] as const)
      : [],
  );

  const items = docs
    .map((doc) =>
      coverageItem(doc, rootByHash.get(doc.hash) ?? null, normalizedEdges, nodeByRid, vectorDocStatus),
    )
    .sort((a, b) => a.path.localeCompare(b.path));

  const totalReferences = items.reduce((sum, item) => sum + item.references.count, 0);
  const groundedDocs = items.filter((item) => item.graph_status === "grounded").length;
  const warnings = buildWarnings(docs.length, docs.length - groundedDocs, vector);

  return {
    schema_version: "memory.doc_coverage.v1",
    read_only: true,
    total_docs: docs.length,
    grounded_docs: groundedDocs,
    ungrounded_docs: docs.length - groundedDocs,
    docs_with_references: items.filter((item) => item.references.count > 0).length,
    total_references: totalReferences,
    vector: vectorSummaryShape(vector),
    docs: items,
    warnings,
  };
}

function coverageItem(
  doc: MemoryDoc & { rid: number },
  rootNode: StoredNode | null,
  edges: MemoryEdge[],
  nodeByRid: Map<number, StoredNode>,
  vectorDocStatus: Map<number, DocCoverageItem["vector_status"]>,
): DocCoverageItem {
  const referenced = rootNode
    ? edges
        .filter((edge) => edge.from_rid === rootNode.rid && edge.label === "REFERENCES")
        .map((edge) => nodeByRid.get(edge.to_rid))
        .filter((node): node is StoredNode => node != null)
        .sort((a, b) => nodeTitle(a).localeCompare(nodeTitle(b)))
    : [];

  return {
    rid: doc.rid,
    path: doc.path,
    title: doc.title ?? null,
    hash: doc.hash,
    body_bytes: Buffer.byteLength(doc.body, "utf8"),
    truncated: doc.body.includes(TRUNCATION_MARKER),
    graph_status: rootNode ? "grounded" : "ungrounded",
    root_node: rootNode ? nodeRef(rootNode) : null,
    references: {
      count: referenced.length,
      examples: referenced.slice(0, 5).map(nodeRef),
    },
    vector_status: vectorDocStatus.get(doc.rid) ?? "missing",
  };
}

async function vectorSummary(
  store: Pick<DocCoverageStore, "vectorStatus">,
): Promise<VectorStatusReport | DocCoverageReport["vector"]> {
  try {
    return await store.vectorStatus();
  } catch (err) {
    return {
      overall: "unavailable",
      total: 0,
      ready: 0,
      stale: 0,
      unavailable: 0,
      failed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function vectorSummaryShape(
  vector: VectorStatusReport | DocCoverageReport["vector"],
): DocCoverageReport["vector"] {
  return {
    overall: vector.overall,
    total: vector.total,
    ready: vector.ready,
    stale: vector.stale,
    unavailable: vector.unavailable,
    failed: vector.failed,
    ...("error" in vector && vector.error ? { error: vector.error } : {}),
  };
}

function buildWarnings(
  totalDocs: number,
  ungroundedDocs: number,
  vector: VectorStatusReport | DocCoverageReport["vector"],
): string[] {
  const warnings: string[] = [];
  if (totalDocs === 0) warnings.push("no ingested documents found");
  if (ungroundedDocs > 0) {
    warnings.push(`${ungroundedDocs} document(s) lack a matching graph root node`);
  }
  if (vector.failed > 0) warnings.push(`${vector.failed} vector projection(s) failed`);
  if (vector.overall === "unavailable") {
    warnings.push("vector projection is unavailable");
  }
  return warnings;
}

function nodeRef(node: StoredNode): DocCoverageNodeRef {
  return {
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    title: nodeTitle(node),
  };
}

function nodeTitle(node: StoredNode): string {
  const title = node.properties.title;
  return typeof title === "string" && title.trim() ? title : node.label;
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
