import type { MemoryStore } from "./graph-store.js";
import type { Confidence, MemoryProvenance } from "./schema.js";
import { slugify } from "./store.js";
import { createEvidenceCard, writeEvidenceCard } from "./evidence-card.js";

export type GovernedWriteOutcome = "stored" | "rejected" | "proposed";
export type GovernedWriteRisk = "low" | "medium" | "high" | "unknown";

export interface MemoryStoreEvidenceInput {
  claim?: string;
  sourceRef?: string;
  citationExcerpt?: string;
  intent?: string;
  observer?: string;
  blastRadius?: string;
  confidence?: Confidence;
  route?: string;
  proposalKind?: string;
  proposalId?: string;
  proposalPath?: string;
}

export interface MemoryStoreEvidenceOptions {
  rootDir?: string;
  now?: Date;
}

export interface GovernedWriteResult {
  schema_version: "memory.governed_write.v1";
  operation: "memory_store_evidence";
  outcome: GovernedWriteOutcome;
  reason: string;
  policy: {
    reason: string;
    risk: GovernedWriteRisk;
    mode_required: "graph" | "evidence_review";
  };
  provenance: {
    source_kind: MemoryProvenance["source_kind"];
    writer: string | null;
    evidence: string[];
    citation_excerpt: string | null;
    source_ref: string | null;
  };
  memory: {
    id: number | null;
    urn: string | null;
  };
  review_artifact: {
    kind: "evidence_card";
    id: string;
    path: string;
  } | null;
}

const REQUIRED_FIELDS = ["claim", "sourceRef", "citationExcerpt", "intent", "observer"] as const;

export function rejectMemoryStoreEvidence(
  input: MemoryStoreEvidenceInput,
  reason: string,
): GovernedWriteResult {
  return governedWriteResult("rejected", reason, input, null);
}

export async function memoryStoreEvidence(
  store: MemoryStore,
  input: MemoryStoreEvidenceInput,
  options: MemoryStoreEvidenceOptions = {},
): Promise<GovernedWriteResult> {
  const missing = REQUIRED_FIELDS.filter((field) => !nonEmpty(input[field]));
  if (missing.length > 0) {
    return rejectMemoryStoreEvidence(input, `missing_required_fields:${missing.join(",")}`);
  }

  const normalized = normalizeInput(input);
  const policy = governedWritePolicy(normalized);
  if (policy.risk !== "low") {
    if (!options.rootDir) {
      return governedWriteResult("rejected", "evidence_review_root_required", normalized, null, {
        risk: "unknown",
      });
    }

    const card = await createEvidenceCard(
      options.rootDir,
      {
        source: {
          kind: "governed-write",
          ref: normalized.sourceRef,
          collected_at: options.now?.toISOString(),
        },
        summary: normalized.claim,
        citations: [
          {
            label: normalized.sourceRef,
            quote: normalized.citationExcerpt,
          },
        ],
        proposedLesson: {
          text: normalized.claim,
          scope: normalized.blastRadius || undefined,
        },
        route: {
          target: normalized.route || "evidence_review",
          rationale: policy.reason,
        },
        confidence: normalized.confidence,
        blastRadius: {
          scope: normalized.blastRadius || policy.risk,
          rationale: blastRadiusRationale(policy.risk),
        },
        privacyNotes: ["Review before promoting this governed write into durable Memory."],
        judge: {
          score: policy.risk === "medium" ? 0.62 : 0.38,
          rationale: policy.reason,
        },
        proposalLink: {
          kind: normalized.proposalKind || "governed-write",
          id: normalized.proposalId || undefined,
          path: normalized.proposalPath || undefined,
          apply_state: "pending",
        },
      },
      options.now,
    );
    const linkedCard = {
      ...card,
      proposal_link: {
        ...card.proposal_link,
        id: card.proposal_link.id ?? card.id,
      },
    };
    await writeEvidenceCard(options.rootDir, linkedCard);

    return governedWriteResult("proposed", policy.reason, normalized, null, {
      risk: policy.risk,
      reviewArtifact: {
        kind: "evidence_card",
        id: linkedCard.id,
        path: `.red/memory/inbox/evidence/${linkedCard.id}.yaml`,
      },
    });
  }

  const rid = await store.upsertNode({
    label: slugify(normalized.claim).slice(0, 96),
    node_type: "validation",
    properties: {
      title: normalized.claim,
      content: normalized.claim,
      summary: normalized.claim,
      confidence: "EXTRACTED",
      source: normalized.sourceRef,
      tags: ["operational-evidence", "validation"],
      tier: "durable",
      layer: "L3",
      intent: normalized.intent,
      observer: normalized.observer,
      citation_excerpt: normalized.citationExcerpt,
      provenance: {
        source_kind: "manual",
        writer: normalized.observer,
        command: "memory store-evidence",
        confidence: "EXTRACTED",
        evidence: [normalized.sourceRef, normalized.citationExcerpt],
      },
    },
  });

  return governedWriteResult(
    "stored",
    "low_risk_validation_evidence_stored",
    normalized,
    rid,
  );
}

function governedWriteResult(
  outcome: GovernedWriteOutcome,
  reason: string,
  input: MemoryStoreEvidenceInput,
  rid: number | null,
  extra: {
    risk?: GovernedWriteRisk;
    reviewArtifact?: GovernedWriteResult["review_artifact"];
  } = {},
): GovernedWriteResult {
  const normalized = normalizeInput(input);
  const risk = extra.risk ?? (outcome === "stored" ? "low" : "unknown");
  return {
    schema_version: "memory.governed_write.v1",
    operation: "memory_store_evidence",
    outcome,
    reason,
    policy: {
      reason,
      risk,
      mode_required: outcome === "proposed" ? "evidence_review" : "graph",
    },
    provenance: {
      source_kind: "manual",
      writer: normalized.observer || null,
      evidence:
        normalized.sourceRef && normalized.citationExcerpt
          ? [normalized.sourceRef, normalized.citationExcerpt]
          : [],
      citation_excerpt: normalized.citationExcerpt || null,
      source_ref: normalized.sourceRef || null,
    },
    memory: {
      id: rid,
      urn: rid == null ? null : `memory_nodes:${rid}`,
    },
    review_artifact: extra.reviewArtifact ?? null,
  };
}

function normalizeInput(input: MemoryStoreEvidenceInput): Required<MemoryStoreEvidenceInput> {
  return {
    claim: input.claim?.trim() ?? "",
    sourceRef: input.sourceRef?.trim() ?? "",
    citationExcerpt: input.citationExcerpt?.trim() ?? "",
    intent: input.intent?.trim() ?? "",
    observer: input.observer?.trim() ?? "",
    blastRadius: input.blastRadius?.trim().toLowerCase() ?? "",
    confidence: input.confidence ?? "EXTRACTED",
    route: input.route?.trim() ?? "",
    proposalKind: input.proposalKind?.trim() ?? "",
    proposalId: input.proposalId?.trim() ?? "",
    proposalPath: input.proposalPath?.trim() ?? "",
  };
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function governedWritePolicy(input: Required<MemoryStoreEvidenceInput>): {
  risk: Exclude<GovernedWriteRisk, "unknown">;
  reason: string;
} {
  if (input.blastRadius === "high") {
    return { risk: "high", reason: "risk_requires_evidence_review:high_blast_radius" };
  }
  if (input.blastRadius === "medium") {
    return { risk: "medium", reason: "risk_requires_evidence_review:medium_blast_radius" };
  }

  const text = `${input.claim}\n${input.citationExcerpt}\n${input.intent}`.toLowerCase();
  if (/\b(user preference|personal fact|personal context|human-facing|biographical|identity context)\b/.test(text)) {
    return { risk: "high", reason: "risk_requires_evidence_review:personal_or_human_context" };
  }
  if (/\b(always|never|must|should|do not|don't|remember to|instruction|agent rule)\b/.test(text)) {
    return { risk: "high", reason: "risk_requires_evidence_review:instruction_like_memory" };
  }

  return { risk: "low", reason: "low_risk_validation_evidence_stored" };
}

function blastRadiusRationale(risk: Exclude<GovernedWriteRisk, "unknown" | "low">): string {
  return risk === "medium"
    ? "Medium blast-radius governed writes require Evidence review before promotion."
    : "High blast-radius governed writes require Evidence review before promotion.";
}
