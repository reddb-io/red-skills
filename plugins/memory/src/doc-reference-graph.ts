import type { MemoryStore, StoredNode } from "./graph-store.js";
import type { EdgeLabel, MemoryDoc, MemoryEdge, NodeType } from "./schema.js";

export interface DocReferenceGraphNode {
  id: string;
  kind: "doc" | "reference";
  rid: number;
  label: string;
  title: string;
  node_type: NodeType;
  path?: string;
  hash?: string;
  graph_status?: "grounded" | "ungrounded";
  outgoing_references?: number;
  incoming_docs?: number;
}

export interface DocReferenceGraphEdge {
  id: string;
  label: "REFERENCES";
  from: string;
  to: string;
  from_rid: number;
  to_rid: number;
  source_doc_rid: number;
  source_doc_path: string;
}

export interface DocReferenceGraphReport {
  schema_version: "memory.doc_reference_graph.v1";
  read_only: true;
  total_docs: number;
  grounded_docs: number;
  reference_nodes: number;
  reference_edges: number;
  nodes: DocReferenceGraphNode[];
  edges: DocReferenceGraphEdge[];
  top_references: Array<{
    node: DocReferenceGraphNode;
    incoming_docs: number;
  }>;
  warnings: string[];
}

export interface DocReferenceGraphStore {
  listDocs(): Promise<Array<MemoryDoc & { rid: number }>>;
  listNodes(): Promise<StoredNode[]>;
  listEdges(): Promise<Array<MemoryEdge | Record<string, unknown>>>;
}

export async function buildDocReferenceGraphReport(
  store: DocReferenceGraphStore | MemoryStore,
): Promise<DocReferenceGraphReport> {
  const [docs, nodes, edges] = await Promise.all([
    store.listDocs(),
    store.listNodes(),
    store.listEdges(),
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

  const graphNodes = new Map<string, DocReferenceGraphNode>();
  const graphEdges: DocReferenceGraphEdge[] = [];
  const incomingDocs = new Map<string, Set<number>>();
  let groundedDocs = 0;

  for (const doc of docs.sort((a, b) => a.path.localeCompare(b.path))) {
    const root = rootByHash.get(doc.hash) ?? null;
    const docId = docNodeId(doc.rid);
    if (root) groundedDocs += 1;

    const outgoing = root
      ? normalizedEdges.filter((edge) => edge.from_rid === root.rid && edge.label === "REFERENCES")
      : [];

    graphNodes.set(docId, {
      id: docId,
      kind: "doc",
      rid: doc.rid,
      label: root?.label ?? `doc:${doc.rid}`,
      title: doc.title ?? doc.path,
      node_type: root?.node_type ?? "concept",
      path: doc.path,
      hash: doc.hash,
      graph_status: root ? "grounded" : "ungrounded",
      outgoing_references: outgoing.length,
    });

    if (!root) continue;

    for (const edge of outgoing) {
      const target = nodeByRid.get(edge.to_rid);
      if (!target) continue;
      const refId = referenceNodeId(target.rid);
      const docsForRef = incomingDocs.get(refId) ?? new Set<number>();
      docsForRef.add(doc.rid);
      incomingDocs.set(refId, docsForRef);
      if (!graphNodes.has(refId)) {
        graphNodes.set(refId, {
          id: refId,
          kind: "reference",
          rid: target.rid,
          label: target.label,
          title: nodeTitle(target),
          node_type: target.node_type,
          incoming_docs: 0,
        });
      }
      graphEdges.push({
        id: `${docId}->${refId}`,
        label: "REFERENCES",
        from: docId,
        to: refId,
        from_rid: root.rid,
        to_rid: target.rid,
        source_doc_rid: doc.rid,
        source_doc_path: doc.path,
      });
    }
  }

  for (const [id, node] of graphNodes) {
    if (node.kind === "reference") {
      graphNodes.set(id, {
        ...node,
        incoming_docs: incomingDocs.get(id)?.size ?? 0,
      });
    }
  }

  const sortedNodes = [...graphNodes.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "doc" ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
  const sortedEdges = graphEdges.sort((a, b) =>
    `${a.source_doc_path}:${a.to}`.localeCompare(`${b.source_doc_path}:${b.to}`),
  );
  const topReferences = topReferencesByLabel(sortedNodes, incomingDocs).slice(0, 12);

  return {
    schema_version: "memory.doc_reference_graph.v1",
    read_only: true,
    total_docs: docs.length,
    grounded_docs: groundedDocs,
    reference_nodes: sortedNodes.filter((node) => node.kind === "reference").length,
    reference_edges: sortedEdges.length,
    nodes: sortedNodes,
    edges: sortedEdges,
    top_references: topReferences,
    warnings: buildWarnings(docs.length, docs.length - groundedDocs, sortedEdges.length),
  };
}

function topReferencesByLabel(
  nodes: DocReferenceGraphNode[],
  incomingDocs: Map<string, Set<number>>,
): DocReferenceGraphReport["top_references"] {
  const groups = new Map<string, { node: DocReferenceGraphNode; docs: Set<number> }>();
  for (const node of nodes) {
    if (node.kind !== "reference") continue;
    const existing = groups.get(node.label);
    const docs = incomingDocs.get(node.id) ?? new Set<number>();
    if (!existing) {
      groups.set(node.label, { node, docs: new Set(docs) });
      continue;
    }
    for (const doc of docs) existing.docs.add(doc);
    if (node.title.localeCompare(existing.node.title) < 0) existing.node = node;
  }
  return [...groups.values()]
    .map((group) => ({ node: group.node, incoming_docs: group.docs.size }))
    .sort((a, b) => b.incoming_docs - a.incoming_docs || a.node.title.localeCompare(b.node.title));
}

function docNodeId(rid: number): string {
  return `doc:${rid}`;
}

function referenceNodeId(rid: number): string {
  return `ref:${rid}`;
}

function nodeTitle(node: StoredNode): string {
  const title = node.properties.title;
  return typeof title === "string" && title.trim() ? title : node.label;
}

function buildWarnings(totalDocs: number, ungroundedDocs: number, referenceEdges: number): string[] {
  const warnings: string[] = [];
  if (totalDocs === 0) warnings.push("no ingested documents found");
  if (ungroundedDocs > 0) {
    warnings.push(`${ungroundedDocs} document(s) lack a matching graph root node`);
  }
  if (totalDocs > 0 && referenceEdges === 0) warnings.push("no document reference edges found");
  return warnings;
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
