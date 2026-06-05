import type { MemoryStore } from "./graph-store.js";
import {
  buildMemoryMergePassReport,
  type MemoryMergeCandidate,
} from "./memory-merge-pass.js";
import {
  resolveProvider,
  type AiProviderConfig,
  type ProviderClient,
} from "./extract-conversation.js";
import { redDbProviderClient } from "./provider-client.js";
import {
  DEFAULT_TIDY_REVIEW_POLICY_VERSION,
  listProviderReviewArtifacts,
  providerReviewArtifactId,
  providerReviewRecommendationId,
  type ProviderReviewArtifact,
  type ProviderReviewPairEvidence,
  type ProviderReviewRecommendationInput,
  type ProviderReviewStatus,
} from "./provider-review-artifacts.js";

export const DEFAULT_GOVERNANCE_TIDY_RECOMMENDATION_CAP = 5;
export const DEFAULT_GOVERNANCE_TIDY_CANDIDATE_LIMIT = 20;
export const DEFAULT_GOVERNANCE_TIDY_MAX_RECOMMENDATION_RATIO = 0.25;
export const GOVERNANCE_TIDY_OPERATION = "governance.tidy";

export type MemoryGovernanceTidyRecommendationsStatus =
  | "available"
  | "degraded"
  | "unavailable";
export type MemoryGovernanceTidyRelation = "duplicate" | "near_duplicate";

export interface MemoryGovernanceTidyRecommendation {
  id: string;
  artifact_id: string;
  recommendation_id: string;
  recommendation_key: string;
  operation: typeof GOVERNANCE_TIDY_OPERATION;
  review_status: ProviderReviewStatus;
  relation: MemoryGovernanceTidyRelation;
  confidence: number;
  rationale: string;
  proposed_soft_merge: {
    action: "SOFT_MERGE";
    edge_label: "SAME_AS";
    duplicate_rid: number;
    canonical_rid: number;
    direction: string;
  };
  pair_evidence: ProviderReviewPairEvidence[];
  provider?: {
    mode?: string;
    model?: string;
  };
}

export interface MemoryGovernanceTidyRecommendations {
  schema_version: "memory.governance_tidy_recommendations.v1";
  read_only: true;
  source: "provider-review-artifacts";
  status: MemoryGovernanceTidyRecommendationsStatus;
  reason: string | null;
  policy: {
    operation: typeof GOVERNANCE_TIDY_OPERATION;
    review_policy_version: typeof DEFAULT_TIDY_REVIEW_POLICY_VERSION;
    candidate_limit: number;
    recommendation_cap: number;
    max_recommendation_ratio: number;
    allowed_actions: ["SOFT_MERGE"];
    allowed_relations: ["duplicate", "near_duplicate"];
  };
  summary: {
    candidate_pairs: number;
    recommended_pairs: number;
    dropped_recommendations: number;
  };
  warnings: string[];
  recommendations: MemoryGovernanceTidyRecommendation[];
}

export interface BuildGovernanceTidyRecommendationsOptions {
  providerConfig?: AiProviderConfig;
  providerClient?: ProviderClient;
  now?: number;
  candidateLimit?: number;
  recommendationCap?: number;
  maxRecommendationRatio?: number;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | JsonRecord;
type JsonRecord = { [key: string]: JsonValue | undefined };

interface ProviderTidyRecommendationCandidate {
  candidateId: string;
  relation: MemoryGovernanceTidyRelation;
  confidence: number;
  rationale: string;
  raw: JsonRecord;
}

export async function buildMemoryGovernanceTidyRecommendations(
  store: MemoryStore,
  opts: BuildGovernanceTidyRecommendationsOptions = {},
): Promise<MemoryGovernanceTidyRecommendations> {
  const policy = tidyPolicy(opts);
  if (!opts.providerConfig) {
    return emptyTidyRecommendations(policy, "unavailable", "no AI provider configured for governance tidy");
  }

  let provider: ReturnType<typeof resolveProvider>;
  try {
    provider = resolveProvider(opts.providerConfig);
  } catch (err) {
    return emptyTidyRecommendations(policy, "degraded", errorMessage(err));
  }

  const mergePass = await buildMemoryMergePassReport(store, {
    limit: policy.candidate_limit,
    now: opts.now,
  });
  const candidates = mergePass.candidates;
  if (candidates.length === 0) {
    const reviewed = await reviewedGovernanceRecommendations(store);
    return {
      ...emptyTidyRecommendations(policy, "available", null),
      summary: {
        candidate_pairs: 0,
        recommended_pairs: reviewed.length,
        dropped_recommendations: 0,
      },
      recommendations: reviewed,
    };
  }

  const warnings: string[] = [];
  let raw: string;
  try {
    const client = opts.providerClient ?? redDbProviderClient(store, opts.providerConfig);
    raw = await client.complete(buildProviderTidyPrompt(candidates, policy));
  } catch (err) {
    return emptyTidyRecommendations(
      policy,
      "degraded",
      `provider tidy failed: ${errorMessage(err)}`,
      candidates.length,
    );
  }

  const parsed = parseProviderTidyResponse(raw, candidates);
  warnings.push(...parsed.warnings);
  const allowedByGuard = allowedRecommendationCount(candidates.length, policy);
  let bounded = parsed.recommendations;
  if (parsed.recommendations.length > allowedByGuard) {
    warnings.push(
      `provider tidy returned ${parsed.recommendations.length} recommendation(s), exceeding guard ${allowedByGuard}; output was bounded`,
    );
    bounded = parsed.recommendations.slice(0, allowedByGuard);
  }

  const statusByArtifact = await providerReviewStatusLookup(store);
  const recommendations = bounded.map((rec) =>
    toGovernanceRecommendation(rec, candidates, provider, statusByArtifact),
  );
  const reviewed = await reviewedGovernanceRecommendations(
    store,
    new Set(recommendations.map((rec) => rec.artifact_id)),
  );
  recommendations.push(...reviewed);
  const dropped = parsed.dropped + Math.max(0, parsed.recommendations.length - bounded.length);
  return {
    schema_version: "memory.governance_tidy_recommendations.v1",
    read_only: true,
    source: "provider-review-artifacts",
    status: warnings.length > 0 ? "degraded" : "available",
    reason: warnings[0] ?? null,
    policy,
    summary: {
      candidate_pairs: candidates.length,
      recommended_pairs: recommendations.length,
      dropped_recommendations: dropped,
    },
    warnings,
    recommendations,
  };
}

async function reviewedGovernanceRecommendations(
  store: Pick<MemoryStore, "kvGet">,
  skipArtifactIds: Set<string> = new Set(),
): Promise<MemoryGovernanceTidyRecommendation[]> {
  const reviewed: MemoryGovernanceTidyRecommendation[] = [];
  for (const artifact of await listProviderReviewArtifacts(store, {
    operation: GOVERNANCE_TIDY_OPERATION,
  })) {
    if (skipArtifactIds.has(artifact.artifact_id)) continue;
    if (artifact.status !== "accepted" && artifact.status !== "dismissed") continue;
    const recommendation = governanceRecommendationFromArtifact(artifact);
    if (recommendation) reviewed.push(recommendation);
  }
  return reviewed.sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
}

function governanceRecommendationFromArtifact(
  artifact: ProviderReviewArtifact,
): MemoryGovernanceTidyRecommendation | null {
  const relation = tidyRelation(artifact.pair_evidence[0]?.relation);
  const proposal = softMergeProposalFromPairEvidence(artifact.pair_evidence);
  if (!relation || !proposal) return null;
  const providerOutput = artifact.recommendation.provider_output;
  const confidence = isRecord(providerOutput) ? confidenceValue(providerOutput.confidence) : null;
  return {
    id: artifact.recommendation_id,
    artifact_id: artifact.artifact_id,
    recommendation_id: artifact.recommendation_id,
    recommendation_key: artifact.recommendation_key,
    operation: GOVERNANCE_TIDY_OPERATION,
    review_status: artifact.status,
    relation,
    confidence: confidence ?? 0,
    rationale: artifact.recommendation.rationale ?? "",
    proposed_soft_merge: {
      action: "SOFT_MERGE",
      edge_label: proposal.label,
      duplicate_rid: proposal.duplicate_rid,
      canonical_rid: proposal.canonical_rid,
      direction: `${proposal.label} memory_nodes:${proposal.duplicate_rid} -> memory_nodes:${proposal.canonical_rid}`,
    },
    pair_evidence: artifact.pair_evidence,
    provider: artifact.provider,
  };
}

function softMergeProposalFromPairEvidence(
  pairEvidence: ProviderReviewPairEvidence[],
): { label: "SAME_AS"; duplicate_rid: number; canonical_rid: number } | null {
  for (const pair of pairEvidence) {
    for (const evidence of pair.evidence ?? []) {
      if (!isSameAsEdge(evidence.proposed_edge_label ?? evidence.edge_label)) continue;
      const duplicateRid = numberValue(evidence.duplicate_rid);
      const canonicalRid = numberValue(evidence.canonical_rid);
      if (duplicateRid != null && canonicalRid != null) {
        return { label: "SAME_AS", duplicate_rid: duplicateRid, canonical_rid: canonicalRid };
      }
    }
  }
  return null;
}

export function providerReviewInputFromGovernanceTidyRecommendation(
  recommendation: MemoryGovernanceTidyRecommendation,
): ProviderReviewRecommendationInput {
  const candidateId =
    recommendation.pair_evidence[0]?.pair_id ??
    recommendation.recommendation_key.replace(/^[^:]+:/, "");
  return {
    operation: GOVERNANCE_TIDY_OPERATION,
    policyVersion: DEFAULT_TIDY_REVIEW_POLICY_VERSION,
    recommendationKey: recommendation.recommendation_key,
    pairEvidence: recommendation.pair_evidence,
    recommendation: {
      title: `Review ${recommendation.relation.replace("_", "-")} Memory Soft-merge candidate`,
      rationale: recommendation.rationale,
      suggested_action: `Review and, if approved outside governance, create ${recommendation.proposed_soft_merge.direction}`,
      provider_output: {
        candidate_id: candidateId,
        relation: recommendation.relation,
        confidence: recommendation.confidence,
      },
    },
    provider: recommendation.provider,
  };
}

function tidyPolicy(
  opts: BuildGovernanceTidyRecommendationsOptions,
): MemoryGovernanceTidyRecommendations["policy"] {
  return {
    operation: GOVERNANCE_TIDY_OPERATION,
    review_policy_version: DEFAULT_TIDY_REVIEW_POLICY_VERSION,
    candidate_limit: opts.candidateLimit ?? DEFAULT_GOVERNANCE_TIDY_CANDIDATE_LIMIT,
    recommendation_cap: opts.recommendationCap ?? DEFAULT_GOVERNANCE_TIDY_RECOMMENDATION_CAP,
    max_recommendation_ratio:
      opts.maxRecommendationRatio ?? DEFAULT_GOVERNANCE_TIDY_MAX_RECOMMENDATION_RATIO,
    allowed_actions: ["SOFT_MERGE"],
    allowed_relations: ["duplicate", "near_duplicate"],
  };
}

function emptyTidyRecommendations(
  policy: MemoryGovernanceTidyRecommendations["policy"],
  status: MemoryGovernanceTidyRecommendationsStatus,
  reason: string | null,
  candidatePairs = 0,
): MemoryGovernanceTidyRecommendations {
  return {
    schema_version: "memory.governance_tidy_recommendations.v1",
    read_only: true,
    source: "provider-review-artifacts",
    status,
    reason,
    policy,
    summary: {
      candidate_pairs: candidatePairs,
      recommended_pairs: 0,
      dropped_recommendations: 0,
    },
    warnings: reason ? [reason] : [],
    recommendations: [],
  };
}

function buildProviderTidyPrompt(
  candidates: MemoryMergeCandidate[],
  policy: MemoryGovernanceTidyRecommendations["policy"],
): { system: string; user: string } {
  return {
    system: [
      "You review Memory graph tidy candidates.",
      "Return ONLY JSON with this shape:",
      '{"recommendations":[{"candidate_id":string,"relation":"duplicate"|"near_duplicate","confidence":number,"rationale":string,"proposed_action":"SOFT_MERGE"}]}',
      "Recommend only semantically duplicate or near-duplicate Soft-merge candidates.",
      "Do not recommend supersession, deprecation, retention, contradiction resolution, deletion, pruning, or content rewrite.",
    ].join("\n"),
    user: JSON.stringify({
      policy,
      candidates: candidates.map((candidate) => ({
        candidate_id: candidateId(candidate),
        rank: candidate.rank,
        score: candidate.score,
        proposed_soft_merge: {
          action: "SOFT_MERGE",
          edge_label: "SAME_AS",
          duplicate_rid: candidate.duplicate_rid,
          canonical_rid: candidate.canonical_rid,
        },
        left: candidate.left,
        right: candidate.right,
        evidence: candidate.evidence,
      })),
    }),
  };
}

function parseProviderTidyResponse(
  raw: string,
  candidates: MemoryMergeCandidate[],
): {
  recommendations: ProviderTidyRecommendationCandidate[];
  dropped: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(raw));
  } catch {
    return {
      recommendations: [],
      dropped: 0,
      warnings: ["provider tidy returned malformed JSON"],
    };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.recommendations)) {
    return {
      recommendations: [],
      dropped: 0,
      warnings: ["provider tidy response missing recommendations[]"],
    };
  }

  const knownCandidates = new Map(candidates.map((candidate) => [candidateId(candidate), candidate]));
  const seen = new Set<string>();
  const recommendations: ProviderTidyRecommendationCandidate[] = [];
  let dropped = 0;
  for (const item of parsed.recommendations) {
    const rawItem = normalizeJson(item);
    if (!isRecord(rawItem)) {
      dropped += 1;
      warnings.push("provider tidy dropped non-object recommendation");
      continue;
    }
    const candidateIdValue = stringValue(rawItem.candidate_id);
    const candidate = candidateIdValue ? knownCandidates.get(candidateIdValue) : undefined;
    if (!candidateIdValue || !candidate) {
      dropped += 1;
      warnings.push("provider tidy dropped recommendation for an unknown candidate");
      continue;
    }
    if (seen.has(candidateIdValue)) {
      dropped += 1;
      warnings.push("provider tidy dropped duplicate recommendation for the same candidate");
      continue;
    }
    const relation = tidyRelation(rawItem.relation ?? rawItem.kind);
    if (!relation) {
      dropped += 1;
      warnings.push("provider tidy dropped non-duplicate recommendation");
      continue;
    }
    if (!isSoftMergeAction(rawItem.proposed_action ?? rawItem.action)) {
      dropped += 1;
      warnings.push("provider tidy dropped non-Soft-merge recommendation");
      continue;
    }
    if (!isSameAsEdge(rawItem.proposed_edge_label ?? rawItem.edge_label)) {
      dropped += 1;
      warnings.push("provider tidy dropped non-SAME_AS merge direction");
      continue;
    }
    if (!matchesOptionalRid(rawItem.duplicate_rid, candidate.duplicate_rid)) {
      dropped += 1;
      warnings.push("provider tidy dropped recommendation with conflicting duplicate direction");
      continue;
    }
    if (!matchesOptionalRid(rawItem.canonical_rid, candidate.canonical_rid)) {
      dropped += 1;
      warnings.push("provider tidy dropped recommendation with conflicting canonical direction");
      continue;
    }
    const confidence = confidenceValue(rawItem.confidence);
    if (confidence == null) {
      dropped += 1;
      warnings.push("provider tidy dropped recommendation without confidence");
      continue;
    }
    const rationale = stringValue(rawItem.rationale);
    if (!rationale) {
      dropped += 1;
      warnings.push("provider tidy dropped recommendation without rationale");
      continue;
    }
    seen.add(candidateIdValue);
    recommendations.push({
      candidateId: candidateIdValue,
      relation,
      confidence,
      rationale,
      raw: rawItem,
    });
  }
  recommendations.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      (knownCandidates.get(a.candidateId)?.rank ?? 0) -
        (knownCandidates.get(b.candidateId)?.rank ?? 0),
  );
  return { recommendations, dropped, warnings: [...new Set(warnings)] };
}

async function providerReviewStatusLookup(
  store: Pick<MemoryStore, "kvGet">,
): Promise<Map<string, ProviderReviewStatus>> {
  const statuses = new Map<string, ProviderReviewStatus>();
  for (const artifact of await listProviderReviewArtifacts(store, { operation: GOVERNANCE_TIDY_OPERATION })) {
    statuses.set(artifact.artifact_id, artifact.status);
    if (!statuses.has(artifact.recommendation_id)) {
      statuses.set(artifact.recommendation_id, artifact.status);
    }
  }
  return statuses;
}

function toGovernanceRecommendation(
  rec: ProviderTidyRecommendationCandidate,
  candidates: MemoryMergeCandidate[],
  provider: ReturnType<typeof resolveProvider>,
  statusByArtifact: Map<string, ProviderReviewStatus>,
): MemoryGovernanceTidyRecommendation {
  const candidate = candidates.find((item) => candidateId(item) === rec.candidateId);
  if (!candidate) throw new Error(`missing validated governance tidy candidate: ${rec.candidateId}`);
  const input = providerReviewInput(rec, candidate, provider);
  const recommendationId = providerReviewRecommendationId(input);
  const artifactId = providerReviewArtifactId(input);
  return {
    id: recommendationId,
    artifact_id: artifactId,
    recommendation_id: recommendationId,
    recommendation_key: input.recommendationKey,
    operation: GOVERNANCE_TIDY_OPERATION,
    review_status: statusByArtifact.get(artifactId) ?? statusByArtifact.get(recommendationId) ?? "open",
    relation: rec.relation,
    confidence: rec.confidence,
    rationale: rec.rationale,
    proposed_soft_merge: {
      action: "SOFT_MERGE",
      edge_label: "SAME_AS",
      duplicate_rid: candidate.duplicate_rid,
      canonical_rid: candidate.canonical_rid,
      direction: `SAME_AS memory_nodes:${candidate.duplicate_rid} -> memory_nodes:${candidate.canonical_rid}`,
    },
    pair_evidence: input.pairEvidence,
    provider: input.provider,
  };
}

function providerReviewInput(
  rec: ProviderTidyRecommendationCandidate,
  candidate: MemoryMergeCandidate,
  provider: ReturnType<typeof resolveProvider>,
): ProviderReviewRecommendationInput {
  return {
    operation: GOVERNANCE_TIDY_OPERATION,
    policyVersion: DEFAULT_TIDY_REVIEW_POLICY_VERSION,
    recommendationKey: `${rec.relation}:${rec.candidateId}`,
    pairEvidence: [pairEvidence(candidate, rec.relation)],
    recommendation: {
      title: `Review ${rec.relation.replace("_", "-")} Memory Soft-merge candidate`,
      rationale: rec.rationale,
      suggested_action: `Review and, if approved outside governance, create SAME_AS memory_nodes:${candidate.duplicate_rid} -> memory_nodes:${candidate.canonical_rid}`,
      provider_output: {
        candidate_id: rec.candidateId,
        relation: rec.relation,
        confidence: rec.confidence,
      },
    },
    provider: { mode: provider.mode, model: provider.model },
  };
}

function pairEvidence(
  candidate: MemoryMergeCandidate,
  relation: MemoryGovernanceTidyRelation,
): ProviderReviewPairEvidence {
  return {
    pair_id: candidateId(candidate),
    relation,
    subjects: [candidate.left, candidate.right].map((node) => ({
      collection: "memory_nodes",
      rid: node.rid,
      label: node.label,
      node_type: node.node_type,
      title: node.title,
      content: node.excerpt,
    })),
    evidence: [
      {
        kind: "merge-pass-candidate",
        rank: candidate.rank,
        score: candidate.score,
        proposed_edge_label: "SAME_AS",
        duplicate_rid: candidate.duplicate_rid,
        canonical_rid: candidate.canonical_rid,
      },
      {
        kind: "similarity",
        title_similarity: candidate.evidence.title_similarity,
        content_similarity: candidate.evidence.content_similarity,
        label_similarity: candidate.evidence.label_similarity,
        same_node_type: candidate.evidence.same_node_type,
        shared_terms: candidate.evidence.shared_terms,
      },
    ],
  };
}

function allowedRecommendationCount(
  candidateCount: number,
  policy: MemoryGovernanceTidyRecommendations["policy"],
): number {
  if (candidateCount <= 0) return 0;
  const proportional = Math.max(1, Math.floor(candidateCount * policy.max_recommendation_ratio));
  return Math.min(policy.recommendation_cap, proportional);
}

function candidateId(candidate: MemoryMergeCandidate): string {
  return `merge-pass:${candidate.rank}`;
}

function tidyRelation(value: unknown): MemoryGovernanceTidyRelation | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return normalized === "duplicate" || normalized === "near_duplicate" ? normalized : null;
}

function isSoftMergeAction(value: unknown): boolean {
  if (value == null) return true;
  return typeof value === "string" && value.trim().toUpperCase().replace(/[-\s]+/g, "_") === "SOFT_MERGE";
}

function isSameAsEdge(value: unknown): boolean {
  if (value == null) return true;
  return typeof value === "string" && value.trim().toUpperCase() === "SAME_AS";
}

function matchesOptionalRid(value: unknown, expected: number): boolean {
  if (value == null) return true;
  return typeof value === "number" && Number.isFinite(value) && value === expected;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function confidenceValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "high") return 0.9;
  if (normalized === "medium") return 0.65;
  if (normalized === "low") return 0.35;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : null;
}

function unfence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}

function normalizeJson(value: unknown): JsonValue | undefined {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item) ?? null);
  if (typeof value === "object") {
    const out: JsonRecord = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeJson(child);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return String(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
