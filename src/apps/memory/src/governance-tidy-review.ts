import type { AiProviderConfig, ProviderClient } from "./extract-conversation.js";
import type { MemoryStore } from "./graph-store.js";
import {
  buildMemoryGovernanceTidyRecommendations,
  GOVERNANCE_TIDY_OPERATION,
  providerReviewInputFromGovernanceTidyRecommendation,
  type BuildGovernanceTidyRecommendationsOptions,
} from "./governance-tidy.js";
import {
  listProviderReviewArtifacts,
  persistProviderReviewArtifacts,
  updateProviderReviewArtifactStatus,
  type ProviderReviewArtifact,
} from "./provider-review-artifacts.js";

export interface GovernanceTidyReviewRefreshResult {
  schema_version: "memory.governance_tidy_review.v1";
  action: "refresh";
  refreshed_at: string;
  summary: {
    recommendations: number;
    stale: number;
  };
  artifacts: Array<{
    artifact_id: string;
    recommendation_id: string;
    status: string;
    fingerprint: string;
  }>;
  stale_artifacts: Array<{
    artifact_id: string;
    recommendation_id: string;
    status: "stale";
    fingerprint: string;
  }>;
}

export interface GovernanceTidyReviewAcceptResult {
  schema_version: "memory.governance_tidy_review.v1";
  action: "accept";
  recommendation_id: string;
  artifact_id: string;
  accepted_by: string;
  accepted_at: string;
  edge: {
    edge_rid: number;
    label: "SAME_AS" | "MERGED_INTO";
    from_rid: number;
    to_rid: number;
  };
  artifact: {
    status: "accepted";
    fingerprint: string;
  };
}

export interface GovernanceTidyReviewDismissResult {
  schema_version: "memory.governance_tidy_review.v1";
  action: "dismiss";
  recommendation_id: string;
  artifact_id: string;
  dismissed_by: string;
  dismissed_at: string;
  artifact: {
    status: "dismissed";
    fingerprint: string;
  };
}

export interface GovernanceTidyReviewDecisionInput {
  id: string;
  approver: string;
  reason?: string;
  now?: number;
}

interface RefreshInput extends BuildGovernanceTidyRecommendationsOptions {
  providerConfig?: AiProviderConfig;
  providerClient?: ProviderClient;
}

const SCHEMA_VERSION = "memory.governance_tidy_review.v1";
const REVIEW_SOURCE = "memory tidy-review";

export async function refreshGovernanceTidyReviewArtifacts(
  store: MemoryStore,
  input: RefreshInput = {},
): Promise<GovernanceTidyReviewRefreshResult> {
  const now = input.now ?? Date.now();
  const report = await buildMemoryGovernanceTidyRecommendations(store, input);
  const providerInputs = report.recommendations.map(
    providerReviewInputFromGovernanceTidyRecommendation,
  );
  const persisted = await persistProviderReviewArtifacts(store, providerInputs, {
    now,
    operation: GOVERNANCE_TIDY_OPERATION,
  });

  return {
    schema_version: SCHEMA_VERSION,
    action: "refresh",
    refreshed_at: new Date(now).toISOString(),
    summary: {
      recommendations: persisted.artifacts.length,
      stale: persisted.stale.length,
    },
    artifacts: persisted.artifacts.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      recommendation_id: artifact.recommendation_id,
      status: artifact.status,
      fingerprint: artifact.fingerprint,
    })),
    stale_artifacts: persisted.stale.map((artifact) => ({
      artifact_id: artifact.artifact_id,
      recommendation_id: artifact.recommendation_id,
      status: "stale" as const,
      fingerprint: artifact.fingerprint,
    })),
  };
}

export async function acceptGovernanceTidyRecommendation(
  store: MemoryStore,
  input: GovernanceTidyReviewDecisionInput,
): Promise<GovernanceTidyReviewAcceptResult> {
  const approver = requiredApprover(input.approver, "accept");
  const now = input.now ?? Date.now();
  const artifact = await resolveOpenTidyArtifact(store, input.id);
  const proposal = softMergeProposal(artifact);

  const [fromNode, toNode] = await Promise.all([
    store.getNode(proposal.from_rid),
    store.getNode(proposal.to_rid),
  ]);
  if (!fromNode) throw new Error(`tidy recommendation source node not found: ${proposal.from_rid}`);
  if (!toNode) throw new Error(`tidy recommendation target node not found: ${proposal.to_rid}`);

  const edgeRid = await store.upsertEdge({
    label: proposal.label,
    from_rid: proposal.from_rid,
    to_rid: proposal.to_rid,
    properties: {
      reason: input.reason ?? "accepted provider tidy recommendation",
      approved_by: approver,
      approved_at: now,
      approval_source: `${REVIEW_SOURCE} accept`,
      provider_review_artifact_id: artifact.artifact_id,
      provider_review_recommendation_id: artifact.recommendation_id,
      provider_review_recommendation_key: artifact.recommendation_key,
      provider_review_fingerprint: artifact.fingerprint,
      schema_version: SCHEMA_VERSION,
    },
  });

  const accepted = await updateProviderReviewArtifactStatus(
    store,
    artifact.artifact_id,
    "accepted",
    {
      now,
      approver,
      reason: input.reason,
      source: `${REVIEW_SOURCE} accept`,
    },
  );

  return {
    schema_version: SCHEMA_VERSION,
    action: "accept",
    recommendation_id: accepted.recommendation_id,
    artifact_id: accepted.artifact_id,
    accepted_by: approver,
    accepted_at: new Date(now).toISOString(),
    edge: {
      edge_rid: edgeRid,
      label: proposal.label,
      from_rid: proposal.from_rid,
      to_rid: proposal.to_rid,
    },
    artifact: {
      status: "accepted",
      fingerprint: accepted.fingerprint,
    },
  };
}

export async function dismissGovernanceTidyRecommendation(
  store: MemoryStore,
  input: GovernanceTidyReviewDecisionInput,
): Promise<GovernanceTidyReviewDismissResult> {
  const approver = requiredApprover(input.approver, "dismiss");
  const now = input.now ?? Date.now();
  const artifact = await resolveOpenTidyArtifact(store, input.id);
  const dismissed = await updateProviderReviewArtifactStatus(
    store,
    artifact.artifact_id,
    "dismissed",
    {
      now,
      approver,
      reason: input.reason,
      source: `${REVIEW_SOURCE} dismiss`,
    },
  );

  return {
    schema_version: SCHEMA_VERSION,
    action: "dismiss",
    recommendation_id: dismissed.recommendation_id,
    artifact_id: dismissed.artifact_id,
    dismissed_by: approver,
    dismissed_at: new Date(now).toISOString(),
    artifact: {
      status: "dismissed",
      fingerprint: dismissed.fingerprint,
    },
  };
}

async function resolveOpenTidyArtifact(
  store: Pick<MemoryStore, "kvGet">,
  id: string,
): Promise<ProviderReviewArtifact> {
  const normalizedId = id.trim();
  if (!normalizedId) throw new Error("memory tidy-review requires a recommendation id");
  const matches = (
    await listProviderReviewArtifacts(store, { operation: GOVERNANCE_TIDY_OPERATION })
  ).filter(
    (artifact) =>
      artifact.artifact_id === normalizedId || artifact.recommendation_id === normalizedId,
  );
  if (matches.length === 0) {
    throw new Error(`tidy recommendation not found: ${normalizedId}`);
  }

  const open = matches.filter((artifact) => artifact.status === "open");
  if (open.length === 1) return open[0]!;
  if (open.length > 1) {
    throw new Error(
      `tidy recommendation id is ambiguous; use an artifact id: ${open
        .map((artifact) => artifact.artifact_id)
        .join(", ")}`,
    );
  }
  if (matches.some((artifact) => artifact.status === "stale")) {
    throw new Error(
      `tidy recommendation is stale: ${normalizedId}; refresh provider review evidence before accepting or dismissing it`,
    );
  }
  throw new Error(`tidy recommendation is not open: ${normalizedId} (${matches[0]!.status})`);
}

function softMergeProposal(artifact: ProviderReviewArtifact): {
  label: "SAME_AS" | "MERGED_INTO";
  from_rid: number;
  to_rid: number;
} {
  for (const pair of artifact.pair_evidence) {
    for (const evidence of pair.evidence ?? []) {
      const label = hiddenSoftMergeLabel(evidence.proposed_edge_label ?? evidence.edge_label);
      const duplicateRid = numberValue(evidence.duplicate_rid ?? evidence.from_rid ?? evidence.from);
      const canonicalRid = numberValue(evidence.canonical_rid ?? evidence.to_rid ?? evidence.to);
      if (label && duplicateRid != null && canonicalRid != null) {
        return { label, from_rid: duplicateRid, to_rid: canonicalRid };
      }
    }
  }
  throw new Error(`tidy recommendation has no supported Soft-merge edge: ${artifact.artifact_id}`);
}

function hiddenSoftMergeLabel(value: unknown): "SAME_AS" | "MERGED_INTO" | null {
  if (typeof value !== "string") return null;
  const label = value.trim().toUpperCase();
  return label === "SAME_AS" || label === "MERGED_INTO" ? label : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredApprover(value: string, action: "accept" | "dismiss"): string {
  const approver = value.trim();
  if (!approver) throw new Error(`memory tidy-review ${action} requires --approver`);
  return approver;
}
