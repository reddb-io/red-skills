import { recall, type RecalledNode } from "./engine.js";
import type { MemoryStore, StoredNode } from "./graph-store.js";
import type { Confidence, NodeType } from "./schema.js";

export type ClaimCheckStatus =
  | "supported"
  | "contradicted"
  | "superseded-evidence"
  | "insufficient-evidence";

export interface ClaimCitation {
  marker: number;
  urn: string;
}

export interface ClaimEvidence {
  citation: string;
  rid: number;
  label: string;
  node_type: NodeType;
  title: string;
  excerpt: string;
  confidence: Confidence;
  source: string | null;
  status: "active" | "superseded";
  activeRid: number;
}

export interface ClaimConflict {
  from: ClaimEvidence;
  to: ClaimEvidence;
  reason: string | null;
  kind: string | null;
  sessions: {
    from: string | null;
    to: string | null;
    cross_session: boolean;
  };
}

export interface ClaimCheckResult {
  assertion: string;
  status: ClaimCheckStatus;
  answer: string;
  citations: ClaimCitation[];
  evidence: {
    active: ClaimEvidence[];
    superseded: ClaimEvidence[];
    conflicting: ClaimConflict[];
  };
}

export async function claimCheck(
  store: MemoryStore,
  assertion: string,
): Promise<ClaimCheckResult> {
  const recalled = await recall(store, assertion, {
    includeSuperseded: true,
    depth: 0,
    k: 8,
  });
  const allNodes = await store.listNodes();
  const nodesByRid = new Map(allNodes.map((node) => [node.rid, node]));
  const superseded = await store.supersededByMany(allNodes.map((node) => node.rid));
  const evidence = recalled.nodes.map((node, index) =>
    toClaimEvidence(node, index + 1, superseded),
  );
  const supportingEvidence = evidence.filter((item) => supportsAssertion(item, assertion));
  const evidenceByRid = new Map(supportingEvidence.map((item) => [item.rid, item]));
  const conflicts = collectConflicts(
    await store.listEdges(),
    evidenceByRid,
    nodesByRid,
    superseded,
  );
  const active = supportingEvidence.filter((item) => item.status === "active");
  const supersededEvidence = supportingEvidence.filter((item) => item.status === "superseded");
  const activeWithConflicts = mergeEvidence(
    active,
    conflicts.flatMap((item) => [item.from, item.to]),
  );
  const citations = activeWithConflicts.map((item) => citationFor(item));

  if (conflicts.length > 0) {
    return {
      assertion,
      status: "contradicted",
      answer: "Contradicted by active Memory evidence.",
      citations,
      evidence: {
        active: activeWithConflicts,
        superseded: supersededEvidence,
        conflicting: conflicts,
      },
    };
  }

  if (active.length > 0) {
    return {
      assertion,
      status: "supported",
      answer: "Supported by active Memory evidence.",
      citations,
      evidence: { active: activeWithConflicts, superseded: supersededEvidence, conflicting: [] },
    };
  }

  if (supersededEvidence.length > 0) {
    return {
      assertion,
      status: "superseded-evidence",
      answer: "Only superseded Memory evidence supports this assertion.",
      citations: supersededEvidence.map((item) => citationFor(item)),
      evidence: { active, superseded: supersededEvidence, conflicting: [] },
    };
  }

  return {
    assertion,
    status: "insufficient-evidence",
    answer: "Insufficient evidence in Memory to verify this assertion.",
    citations: [],
    evidence: { active: [], superseded: [], conflicting: [] },
  };
}

function toClaimEvidence(
  node: RecalledNode,
  marker: number,
  superseded: Map<number, number>,
): ClaimEvidence {
  const activeRid = activeHead(node.rid, superseded);
  return {
    citation: `[${marker}]`,
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    title: node.properties.title ?? node.label,
    excerpt: node.excerpt,
    confidence: node.properties.confidence ?? "AMBIGUOUS",
    source: typeof node.properties.source === "string" ? node.properties.source : null,
    status: activeRid === node.rid ? "active" : "superseded",
    activeRid,
  };
}

function activeHead(rid: number, superseded: Map<number, number>): number {
  const seen = new Set<number>();
  let current = rid;
  while (!seen.has(current)) {
    seen.add(current);
    const next = superseded.get(current);
    if (next == null) return current;
    current = next;
  }
  return current;
}

function citationFor(item: ClaimEvidence): ClaimCitation {
  return {
    marker: Number(item.citation.replace(/\D/g, "")),
    urn: `memory_nodes:${item.rid}`,
  };
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "by",
  "for",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
]);

function supportsAssertion(item: ClaimEvidence, assertion: string): boolean {
  const terms = meaningfulTokens(assertion);
  if (terms.length === 0) return false;
  const evidenceTokens = new Set(
    meaningfulTokens([item.label, item.title, item.excerpt].join(" ")),
  );
  const matched = terms.filter((term) => evidenceTokens.has(term)).length;
  return matched / terms.length >= 0.75;
}

function meaningfulTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length > 1 && !STOP_WORDS.has(token),
  );
}

function collectConflicts(
  edges: Record<string, unknown>[],
  evidenceByRid: Map<number, ClaimEvidence>,
  nodesByRid: Map<number, StoredNode>,
  superseded: Map<number, number>,
): ClaimConflict[] {
  const conflicts: ClaimConflict[] = [];
  let marker = evidenceByRid.size + 1;

  for (const edge of edges) {
    if (edgeLabel(edge) !== "CONTRADICTS") continue;
    const fromRid = edgeFrom(edge);
    const toRid = edgeTo(edge);
    const fromSeed = evidenceByRid.get(fromRid);
    const toSeed = evidenceByRid.get(toRid);
    if (!fromSeed && !toSeed) continue;

    const from = fromSeed ?? evidenceForStored(nodesByRid.get(fromRid), marker++, superseded);
    const to = toSeed ?? evidenceForStored(nodesByRid.get(toRid), marker++, superseded);
    if (!from || !to) continue;
    if (from.status !== "active" || to.status !== "active") continue;
    if (from.activeRid === to.activeRid) continue;

    evidenceByRid.set(from.rid, from);
    evidenceByRid.set(to.rid, to);
    const fromSession = sessionFromEdge(edge, "candidate") ?? sessionFromNode(nodesByRid.get(from.rid));
    const toSession = sessionFromEdge(edge, "existing") ?? sessionFromNode(nodesByRid.get(to.rid));
    conflicts.push({
      from,
      to,
      reason: edgeReason(edge),
      kind: edgeKind(edge),
      sessions: {
        from: fromSession,
        to: toSession,
        cross_session: Boolean(fromSession && toSession && fromSession !== toSession),
      },
    });
  }

  return conflicts;
}

function edgeKind(edge: Record<string, unknown>): string | null {
  const props = edge.properties ?? edge.PROPERTIES;
  if (props && typeof props === "object" && "kind" in props) {
    const kind = (props as { kind?: unknown }).kind;
    return typeof kind === "string" ? kind : null;
  }
  return null;
}

function sessionFromEdge(
  edge: Record<string, unknown>,
  side: "candidate" | "existing",
): string | null {
  const props = edge.properties ?? edge.PROPERTIES;
  if (!props || typeof props !== "object") return null;
  const key = side === "candidate" ? "candidate_session" : "existing_session";
  const value = (props as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

function sessionFromNode(node: StoredNode | undefined): string | null {
  if (!node) return null;
  const props = node.properties;
  const provenance = props.provenance as
    | { scope?: { level?: string; id?: string } }
    | undefined;
  if (provenance?.scope?.level === "session" && provenance.scope.id) {
    return provenance.scope.id;
  }
  if (props.scope === "session" && typeof props.scope_id === "string") {
    return props.scope_id;
  }
  const sid = (props as { session_id?: unknown }).session_id;
  return typeof sid === "string" ? sid : null;
}

function evidenceForStored(
  node: StoredNode | undefined,
  marker: number,
  superseded: Map<number, number>,
): ClaimEvidence | null {
  if (!node) return null;
  const activeRid = activeHead(node.rid, superseded);
  return {
    citation: `[${marker}]`,
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    title: node.properties.title ?? node.label,
    excerpt: (
      node.properties.summary ??
      node.properties.content ??
      node.properties.title ??
      node.label
    ).slice(0, 200),
    confidence: node.properties.confidence ?? "AMBIGUOUS",
    source: typeof node.properties.source === "string" ? node.properties.source : null,
    status: activeRid === node.rid ? "active" : "superseded",
    activeRid,
  };
}

function mergeEvidence(items: ClaimEvidence[], extras: ClaimEvidence[]): ClaimEvidence[] {
  const byRid = new Map<number, ClaimEvidence>();
  for (const item of [...items, ...extras]) byRid.set(item.rid, item);
  return [...byRid.values()].sort((a, b) => citationMarker(a) - citationMarker(b));
}

function citationMarker(item: ClaimEvidence): number {
  return Number(item.citation.replace(/\D/g, ""));
}

function edgeLabel(edge: Record<string, unknown>): string {
  return String(edge.label ?? edge.edge_label ?? edge.LABEL ?? "");
}

function edgeFrom(edge: Record<string, unknown>): number {
  return Number(
    edge.from_rid ?? edge.from ?? edge.from_id ?? edge.source ?? edge.source_id ?? edge.FROM,
  );
}

function edgeTo(edge: Record<string, unknown>): number {
  return Number(
    edge.to_rid ?? edge.to ?? edge.to_id ?? edge.target ?? edge.target_id ?? edge.TO,
  );
}

function edgeReason(edge: Record<string, unknown>): string | null {
  const props = edge.properties ?? edge.PROPERTIES;
  if (props && typeof props === "object" && "reason" in props) {
    const reason = (props as { reason?: unknown }).reason;
    return reason == null ? null : String(reason);
  }
  return null;
}
