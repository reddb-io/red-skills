import type { StoredNode } from "./graph-store.js";
import type { HiddenByEdgeLabel, NodeType } from "./schema.js";

export type MemoryMergePassStatus = "no-candidates" | "candidates";

export interface MemoryMergePassStore {
  listNodes(now?: number): Promise<StoredNode[]>;
  listEdges(): Promise<Record<string, unknown>[]>;
  supersededByMany(rids: number[]): Promise<Map<number, number>>;
}

export interface MemoryMergeExecutionStore extends MemoryMergePassStore {
  upsertEdge(edge: {
    label: HiddenByEdgeLabel;
    from_rid: number;
    to_rid: number;
    properties?: Record<string, unknown>;
  }): Promise<number>;
  removeEdge(from: number, to: number, label: HiddenByEdgeLabel): Promise<boolean>;
}

export interface MemoryMergePassInput {
  min_score?: number;
  limit?: number;
  now?: number;
}

export interface MemoryMergePassNodeEvidence {
  rid: number;
  label: string;
  node_type: NodeType;
  title: string;
  excerpt: string;
  citation: string;
  importance: number;
  updated_at?: string;
  provenance_evidence: string[];
}

export interface MemoryMergeCandidate {
  rank: number;
  score: number;
  duplicate_rid: number;
  canonical_rid: number;
  proposed_edge_label: HiddenByEdgeLabel;
  left: MemoryMergePassNodeEvidence;
  right: MemoryMergePassNodeEvidence;
  evidence: {
    title_similarity: number;
    content_similarity: number;
    label_similarity: number;
    same_node_type: boolean;
    shared_terms: string[];
    reasons: string[];
  };
  recommendation: string;
}

export interface MemoryMergePassReport {
  schema_version: "memory.merge_pass.v1";
  read_only: true;
  generated_at: string;
  status: MemoryMergePassStatus;
  policy: {
    min_score: number;
    limit: number;
    suppress_existing_hidden_edges: true;
  };
  summary: {
    considered_nodes: number;
    compared_pairs: number;
    suppressed_existing_hidden_edges: number;
    candidates: number;
  };
  candidates: MemoryMergeCandidate[];
  markdown: string;
  recommended_next_actions: string[];
}

export interface MemoryMergeBatchExecuteInput extends MemoryMergePassInput {
  candidate_ranks: number[];
  approver: string;
  batch_id?: string;
  reason?: string;
}

export interface MemoryMergeBatchEdge {
  edge_rid: number;
  duplicate_rid: number;
  canonical_rid: number;
  label: HiddenByEdgeLabel;
  candidate_rank: number;
  score: number;
}

export interface MemoryMergeBatchExecutionResult {
  schema_version: "memory.merge_pass_batch.v1";
  action: "execute";
  batch_id: string;
  approved_by: string;
  executed_at: string;
  selected_candidate_ranks: number[];
  merged_edges: MemoryMergeBatchEdge[];
  summary: {
    requested: number;
    merged: number;
  };
}

export interface MemoryMergeBatchUnmergeResult {
  schema_version: "memory.merge_pass_batch.v1";
  action: "unmerge";
  batch_id: string;
  unmerged_at: string;
  removed_edges: Array<{
    duplicate_rid: number;
    canonical_rid: number;
    label: HiddenByEdgeLabel;
    removed: boolean;
  }>;
  summary: {
    found: number;
    removed: number;
  };
}

const DEFAULT_MIN_SCORE = 0.72;
const DEFAULT_LIMIT = 20;
const MAX_SHARED_TERMS = 12;
const MERGE_BATCH_SCHEMA_VERSION = "memory.merge_pass_batch.v1";

export async function buildMemoryMergePassReport(
  store: MemoryMergePassStore,
  input: MemoryMergePassInput = {},
): Promise<MemoryMergePassReport> {
  const now = input.now ?? Date.now();
  const minScore = input.min_score ?? DEFAULT_MIN_SCORE;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const nodes = await store.listNodes(0);
  const [edges, hiddenBy] = await Promise.all([
    store.listEdges(),
    store.supersededByMany(nodes.map((node) => node.rid)),
  ]);
  const hiddenPairs = hiddenPairSet(edges, hiddenBy);
  let comparedPairs = 0;
  let suppressedExistingHiddenEdges = 0;
  const candidates: MemoryMergeCandidate[] = [];

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const left = nodes[i]!;
      const right = nodes[j]!;
      if (isOutOfScope(left) || isOutOfScope(right)) continue;
      const key = pairKey(left.rid, right.rid);
      if (hiddenPairs.has(key)) {
        suppressedExistingHiddenEdges += 1;
        continue;
      }
      comparedPairs += 1;
      const candidate = scorePair(left, right);
      if (!candidate || candidate.score < minScore) continue;
      candidates.push(candidate);
    }
  }

  const ranked = candidates
    .sort(compareCandidates)
    .slice(0, limit)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
  const summary = {
    considered_nodes: nodes.length,
    compared_pairs: comparedPairs,
    suppressed_existing_hidden_edges: suppressedExistingHiddenEdges,
    candidates: candidates.length,
  };
  const report = {
    schema_version: "memory.merge_pass.v1",
    read_only: true,
    generated_at: new Date(now).toISOString(),
    status: candidates.length > 0 ? "candidates" : "no-candidates",
    policy: {
      min_score: minScore,
      limit,
      suppress_existing_hidden_edges: true,
    },
    summary,
    candidates: ranked,
    recommended_next_actions: nextActions(candidates.length),
  } satisfies Omit<MemoryMergePassReport, "markdown">;
  return { ...report, markdown: renderMarkdown(report) };
}

export async function executeMemoryMergeBatch(
  store: MemoryMergeExecutionStore,
  input: MemoryMergeBatchExecuteInput,
): Promise<MemoryMergeBatchExecutionResult> {
  const approver = input.approver.trim();
  if (!approver) throw new Error("memory merge-pass execute requires --approver");
  const requestedRanks = uniquePositiveIntegers(input.candidate_ranks);
  if (requestedRanks.length === 0) {
    throw new Error("memory merge-pass execute requires --candidate-ranks");
  }

  const executedAtMs = input.now ?? Date.now();
  const executedAt = new Date(executedAtMs).toISOString();
  const report = await buildMemoryMergePassReport(store, input);
  const byRank = new Map(report.candidates.map((candidate) => [candidate.rank, candidate]));
  const missing = requestedRanks.filter((rank) => !byRank.has(rank));
  if (missing.length > 0) {
    throw new Error(`candidate rank(s) not present in current merge pass: ${missing.join(", ")}`);
  }

  const batchId = input.batch_id?.trim() || defaultBatchId(executedAtMs, requestedRanks);
  const mergedEdges: MemoryMergeBatchEdge[] = [];
  for (const rank of requestedRanks) {
    const candidate = byRank.get(rank)!;
    const edgeRid = await store.upsertEdge({
      label: candidate.proposed_edge_label,
      from_rid: candidate.duplicate_rid,
      to_rid: candidate.canonical_rid,
      properties: {
        reason: input.reason ?? "approved memory merge pass",
        merge_pass_batch_id: batchId,
        merge_pass_candidate_rank: rank,
        merge_pass_candidate_score: candidate.score,
        approved_by: approver,
        approved_at: executedAtMs,
        approval_source: "memory merge-pass execute",
        schema_version: MERGE_BATCH_SCHEMA_VERSION,
      },
    });
    mergedEdges.push({
      edge_rid: edgeRid,
      duplicate_rid: candidate.duplicate_rid,
      canonical_rid: candidate.canonical_rid,
      label: candidate.proposed_edge_label,
      candidate_rank: rank,
      score: candidate.score,
    });
  }

  return {
    schema_version: MERGE_BATCH_SCHEMA_VERSION,
    action: "execute",
    batch_id: batchId,
    approved_by: approver,
    executed_at: executedAt,
    selected_candidate_ranks: requestedRanks,
    merged_edges: mergedEdges,
    summary: {
      requested: requestedRanks.length,
      merged: mergedEdges.length,
    },
  };
}

export async function unmergeMemoryMergeBatch(
  store: MemoryMergeExecutionStore,
  batchId: string,
  now = Date.now(),
): Promise<MemoryMergeBatchUnmergeResult> {
  const normalizedBatchId = batchId.trim();
  if (!normalizedBatchId) throw new Error("memory merge-pass unmerge requires --batch-id");

  const removedEdges: MemoryMergeBatchUnmergeResult["removed_edges"] = [];
  for (const edge of await store.listEdges()) {
    const props = edgeProperties(edge);
    if (props.merge_pass_batch_id !== normalizedBatchId) continue;
    const label = edgeLabel(edge);
    if (!isMergeEdgeLabel(label)) continue;
    const duplicateRid = edgeRid(edge, "from");
    const canonicalRid = edgeRid(edge, "to");
    if (!Number.isFinite(duplicateRid) || !Number.isFinite(canonicalRid)) continue;
    const removed = await store.removeEdge(duplicateRid, canonicalRid, label);
    removedEdges.push({
      duplicate_rid: duplicateRid,
      canonical_rid: canonicalRid,
      label,
      removed,
    });
  }

  return {
    schema_version: MERGE_BATCH_SCHEMA_VERSION,
    action: "unmerge",
    batch_id: normalizedBatchId,
    unmerged_at: new Date(now).toISOString(),
    removed_edges: removedEdges,
    summary: {
      found: removedEdges.length,
      removed: removedEdges.filter((edge) => edge.removed).length,
    },
  };
}

function scorePair(left: StoredNode, right: StoredNode): MemoryMergeCandidate | null {
  const leftText = nodeText(left);
  const rightText = nodeText(right);
  const leftTokens = new Set(normalizedTokens(leftText));
  const rightTokens = new Set(normalizedTokens(rightText));
  if (leftTokens.size < 3 || rightTokens.size < 3) return null;

  const titleSimilarity = jaccard(
    new Set(normalizedTokens(String(left.properties.title ?? left.label))),
    new Set(normalizedTokens(String(right.properties.title ?? right.label))),
  );
  const contentSimilarity = jaccard(leftTokens, rightTokens);
  const labelSimilarity = jaccard(
    new Set(normalizedTokens(left.label.replace(/[-_]/g, " "))),
    new Set(normalizedTokens(right.label.replace(/[-_]/g, " "))),
  );
  const sameNodeType = left.node_type === right.node_type;
  const sharedTerms = [...leftTokens]
    .filter((token) => rightTokens.has(token))
    .sort()
    .slice(0, MAX_SHARED_TERMS);
  const score = round4(
    contentSimilarity * 0.55 +
      titleSimilarity * 0.25 +
      labelSimilarity * 0.1 +
      (sameNodeType ? 0.1 : 0),
  );
  const { duplicate, canonical } = canonicalPair(left, right);
  const reasons = reasonsFor({
    titleSimilarity,
    contentSimilarity,
    labelSimilarity,
    sameNodeType,
    sharedTerms,
  });

  return {
    rank: 0,
    score,
    duplicate_rid: duplicate.rid,
    canonical_rid: canonical.rid,
    proposed_edge_label: "SAME_AS",
    left: nodeEvidence(left),
    right: nodeEvidence(right),
    evidence: {
      title_similarity: round4(titleSimilarity),
      content_similarity: round4(contentSimilarity),
      label_similarity: round4(labelSimilarity),
      same_node_type: sameNodeType,
      shared_terms: sharedTerms,
      reasons,
    },
    recommendation: `review and, if approved, create SAME_AS memory_nodes:${duplicate.rid} -> memory_nodes:${canonical.rid}`,
  };
}

function canonicalPair(
  left: StoredNode,
  right: StoredNode,
): { duplicate: StoredNode; canonical: StoredNode } {
  const leftRank = canonicalRank(left);
  const rightRank = canonicalRank(right);
  if (leftRank > rightRank) return { duplicate: right, canonical: left };
  if (rightRank > leftRank) return { duplicate: left, canonical: right };
  return left.rid <= right.rid
    ? { duplicate: right, canonical: left }
    : { duplicate: left, canonical: right };
}

function canonicalRank(node: StoredNode): number {
  const props = node.properties;
  return (
    numberValue(props.importance) * 10 +
    numberValue(props.access_count) +
    (optionalNumber(props.updated_at) ?? optionalNumber(props.created_at) ?? 0) / 1_000_000_000_000
  );
}

function nodeEvidence(node: StoredNode): MemoryMergePassNodeEvidence {
  const updatedAt = optionalNumber(node.properties.updated_at);
  return {
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    title: String(node.properties.title ?? node.label),
    excerpt: excerpt(String(node.properties.content ?? node.properties.summary ?? node.properties.title ?? node.label)),
    citation: `${node.node_type}:${node.label}#${node.rid}`,
    importance: numberValue(node.properties.importance),
    ...(updatedAt != null ? { updated_at: new Date(updatedAt).toISOString() } : {}),
    provenance_evidence: provenanceEvidence(node.properties.provenance),
  };
}

function reasonsFor(input: {
  titleSimilarity: number;
  contentSimilarity: number;
  labelSimilarity: number;
  sameNodeType: boolean;
  sharedTerms: string[];
}): string[] {
  const reasons: string[] = [];
  if (input.sameNodeType) reasons.push("same node type");
  if (input.titleSimilarity >= 0.7) reasons.push("high title overlap");
  if (input.contentSimilarity >= 0.7) reasons.push("high content overlap");
  if (input.labelSimilarity >= 0.7) reasons.push("high label overlap");
  if (input.sharedTerms.length > 0) {
    reasons.push(`shared terms: ${input.sharedTerms.slice(0, 6).join(", ")}`);
  }
  return reasons;
}

function nextActions(candidateCount: number): string[] {
  if (candidateCount === 0) {
    return ["no near-duplicate merge candidates crossed the configured similarity bar"];
  }
  return [
    "review highest-scored candidates first and approve only semantically identical entities",
    "apply approved merges through the explicit merge/supersession path; this report is advisory only",
  ];
}

function renderMarkdown(report: Omit<MemoryMergePassReport, "markdown">): string {
  const lines = [
    "# Memory merge pass",
    "",
    `Status: ${report.status}`,
    `Policy: score >= ${report.policy.min_score.toFixed(2)}; limit ${report.policy.limit}`,
    "",
    `Compared ${report.summary.compared_pairs} pair(s); suppressed ${report.summary.suppressed_existing_hidden_edges} already-hidden pair(s).`,
    "",
    "## Candidates",
  ];
  if (report.candidates.length === 0) {
    lines.push("- none");
  } else {
    for (const candidate of report.candidates) {
      lines.push(
        `- #${candidate.rank} score ${candidate.score.toFixed(4)}: ${candidate.left.title} <-> ${candidate.right.title}`,
      );
      lines.push(
        `  Propose: ${candidate.proposed_edge_label} memory_nodes:${candidate.duplicate_rid} -> memory_nodes:${candidate.canonical_rid}`,
      );
      lines.push(`  Evidence: ${candidate.evidence.reasons.join("; ")}`);
    }
  }
  lines.push("", "## Next Actions");
  for (const action of report.recommended_next_actions) lines.push(`- ${action}`);
  return lines.join("\n").trimEnd();
}

function hiddenPairSet(
  edges: Record<string, unknown>[],
  hiddenBy: Map<number, number>,
): Set<string> {
  const out = new Set<string>();
  for (const [from, to] of hiddenBy.entries()) out.add(pairKey(from, to));
  for (const edge of edges) {
    if (!["SUPERSEDED_BY", "SAME_AS", "MERGED_INTO"].includes(edgeLabel(edge))) continue;
    const from = edgeRid(edge, "from");
    const to = edgeRid(edge, "to");
    if (Number.isFinite(from) && Number.isFinite(to)) out.add(pairKey(from, to));
  }
  return out;
}

function pairKey(left: number, right: number): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

function isOutOfScope(node: StoredNode): boolean {
  return node.properties.tier === "ephemeral" || node.node_type === "session";
}

function nodeText(node: StoredNode): string {
  return [
    node.label,
    node.properties.title,
    node.properties.summary,
    node.properties.content,
    ...(Array.isArray(node.properties.tags) ? node.properties.tags : []),
  ]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join("\n");
}

function normalizedTokens(text: string): string[] {
  const stop = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "be",
    "for",
    "in",
    "is",
    "must",
    "of",
    "on",
    "the",
    "this",
    "to",
    "with",
  ]);
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .map(stemToken)
    .filter((token) => token.length > 1 && !stop.has(token));
}

function stemToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function provenanceEvidence(value: unknown): string[] {
  if (value == null || typeof value !== "object") return [];
  const provenance = value as Record<string, unknown>;
  return Array.isArray(provenance.evidence)
    ? provenance.evidence.filter((item): item is string => typeof item === "string")
    : [];
}

function edgeLabel(edge: Record<string, unknown>): string {
  return String(edge.label ?? edge.edge_label ?? edge.LABEL ?? "");
}

function isMergeEdgeLabel(label: string): label is HiddenByEdgeLabel {
  return label === "SAME_AS" || label === "MERGED_INTO";
}

function edgeRid(edge: Record<string, unknown>, side: "from" | "to"): number {
  const upper = side.toUpperCase();
  return Number(
    edge[side] ??
      edge[`${side}_id`] ??
      edge[`${side}_rid`] ??
      edge[side === "from" ? "source" : "target"] ??
      edge[upper],
  );
}

function edgeProperties(edge: Record<string, unknown>): Record<string, unknown> {
  const props = edge.properties ?? edge.PROPERTIES ?? {};
  if (props != null && typeof props === "object" && !Array.isArray(props)) {
    return props as Record<string, unknown>;
  }
  if (typeof props === "string") {
    try {
      const parsed = JSON.parse(props) as unknown;
      return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function compareCandidates(a: MemoryMergeCandidate, b: MemoryMergeCandidate): number {
  return b.score - a.score || a.duplicate_rid - b.duplicate_rid || a.canonical_rid - b.canonical_rid;
}

function uniquePositiveIntegers(values: number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`candidate rank must be a positive integer: ${value}`);
    }
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function defaultBatchId(now: number, ranks: number[]): string {
  return `merge-pass-${new Date(now).toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${ranks.join("-")}`;
}
