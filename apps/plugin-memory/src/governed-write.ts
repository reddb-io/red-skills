import type { MemoryStore } from "./graph-store.js";
import type { Confidence, MemoryNode, MemoryProvenance } from "./schema.js";
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

export interface AnsweredQuerySourceElement {
  kind: "node" | "edge" | "community";
  rid?: number;
  label?: string;
  title?: string;
  from_rid?: number;
  to_rid?: number;
  community_id?: string;
}

export interface MemoryStoreAnsweredQueryInput {
  question?: string;
  answer?: string;
  sourceElements?: AnsweredQuerySourceElement[];
  observer?: string;
  confidence?: Confidence;
}

export interface MemoryStoreEvidenceOptions {
  rootDir?: string;
  now?: Date;
}

export interface GovernedWriteResult {
  schema_version: "memory.governed_write.v1";
  operation: "memory_store_evidence" | "memory_store_answered_query";
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

export async function memoryStoreAnsweredQuery(
  store: MemoryStore,
  input: MemoryStoreAnsweredQueryInput,
): Promise<GovernedWriteResult> {
  const normalized = normalizeAnsweredQueryInput(input);
  const missing = [
    ...(!normalized.question ? ["question"] : []),
    ...(!normalized.answer ? ["answer"] : []),
    ...(normalized.sourceElements.length === 0 ? ["sourceElements"] : []),
    ...(!normalized.observer ? ["observer"] : []),
  ];
  const resultInput = answeredQueryResultInput(normalized);
  if (missing.length > 0) {
    return governedWriteResult(
      "rejected",
      `missing_required_fields:${missing.join(",")}`,
      resultInput,
      null,
      { operation: "memory_store_answered_query", sourceKind: "derived" },
    );
  }

  const existingRid = await store.findNodeByLabel(normalized.label, "answer");
  if (existingRid != null) {
    const existing = await store.getNode(existingRid);
    if (existing) {
      await removeOutgoingReferences(store, existingRid);
      await store.deleteNode(existing);
    }
  }

  const node: MemoryNode = {
    label: normalized.label,
    node_type: "answer",
    properties: {
      title: normalized.question,
      summary: normalized.answer,
      content: normalized.answer,
      question: normalized.question,
      answer: normalized.answer,
      confidence: normalized.confidence,
      seal: normalized.confidence,
      source: normalized.sourceRef,
      source_elements: normalized.sourceElements,
      tags: ["answered-query", "graph-feedback"],
      tier: "durable",
      layer: "L3",
      provenance_tier: "proxy",
      provenance: {
        source_kind: "derived",
        writer: normalized.observer,
        command: "memory store-answered-query",
        confidence: normalized.confidence,
        evidence: normalized.evidence,
      },
    },
  };
  const rid = await store.upsertNode(node);
  for (const sourceRid of sourceNodeRids(normalized.sourceElements)) {
    await store.upsertEdge({
      label: "REFERENCES",
      from_rid: rid,
      to_rid: sourceRid,
      properties: {
        confidence: normalized.confidence,
        source: normalized.sourceRef,
        provenance_tier: "proxy",
        provenance: {
          source_kind: "derived",
          writer: normalized.observer,
          command: "memory store-answered-query",
          confidence: normalized.confidence,
          evidence: normalized.evidence,
        },
      },
    });
  }

  return governedWriteResult(
    "stored",
    existingRid == null ? "answered_query_stored" : "answered_query_updated",
    resultInput,
    rid,
    { operation: "memory_store_answered_query", sourceKind: "derived" },
  );
}

function governedWriteResult(
  outcome: GovernedWriteOutcome,
  reason: string,
  input: MemoryStoreEvidenceInput,
  rid: number | null,
  extra: {
    operation?: GovernedWriteResult["operation"];
    sourceKind?: MemoryProvenance["source_kind"];
    risk?: GovernedWriteRisk;
    reviewArtifact?: GovernedWriteResult["review_artifact"];
  } = {},
): GovernedWriteResult {
  const normalized = normalizeInput(input);
  const risk = extra.risk ?? (outcome === "stored" ? "low" : "unknown");
  return {
    schema_version: "memory.governed_write.v1",
    operation: extra.operation ?? "memory_store_evidence",
    outcome,
    reason,
    policy: {
      reason,
      risk,
      mode_required: outcome === "proposed" ? "evidence_review" : "graph",
    },
    provenance: {
      source_kind: extra.sourceKind ?? "manual",
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

function normalizeAnsweredQueryInput(input: MemoryStoreAnsweredQueryInput): {
  question: string;
  answer: string;
  sourceElements: AnsweredQuerySourceElement[];
  observer: string;
  confidence: Exclude<Confidence, "EXTRACTED">;
  label: string;
  sourceRef: string;
  evidence: string[];
} {
  const question = input.question?.replace(/\s+/g, " ").trim() ?? "";
  const answer = input.answer?.replace(/\s+/g, " ").trim() ?? "";
  const observer = input.observer?.trim() ?? "";
  const confidence = input.confidence === "AMBIGUOUS" ? "AMBIGUOUS" : "INFERRED";
  const label = `answered-query:${slugify(question, 80)}`;
  const sourceRef = label;
  const sourceElements = (input.sourceElements ?? []).map(normalizeSourceElement).filter((item) => item != null);
  return {
    question,
    answer,
    sourceElements,
    observer,
    confidence,
    label,
    sourceRef,
    evidence: [`question: ${question}`, ...sourceElements.map(sourceElementEvidence)],
  };
}

function normalizeSourceElement(
  element: AnsweredQuerySourceElement,
): AnsweredQuerySourceElement | null {
  if (element.kind === "node") {
    const rid = finitePositive(element.rid);
    if (rid == null && !element.label) return null;
    return {
      kind: "node",
      ...(rid == null ? {} : { rid }),
      ...(element.label ? { label: element.label.trim() } : {}),
      ...(element.title ? { title: element.title.trim() } : {}),
    };
  }
  if (element.kind === "edge") {
    const from = finitePositive(element.from_rid);
    const to = finitePositive(element.to_rid);
    if (from == null && to == null && !element.label) return null;
    return {
      kind: "edge",
      ...(element.label ? { label: element.label.trim() } : {}),
      ...(from == null ? {} : { from_rid: from }),
      ...(to == null ? {} : { to_rid: to }),
    };
  }
  if (element.kind === "community") {
    const communityId = element.community_id?.trim();
    return communityId ? { kind: "community", community_id: communityId } : null;
  }
  return null;
}

function sourceElementEvidence(element: AnsweredQuerySourceElement): string {
  if (element.kind === "node") {
    return `node:${element.rid ?? "unknown"}:${element.label ?? element.title ?? "unknown"}`;
  }
  if (element.kind === "edge") {
    return `edge:${element.from_rid ?? "unknown"}->${element.to_rid ?? "unknown"}:${element.label ?? "unknown"}`;
  }
  return `community:${element.community_id ?? "unknown"}`;
}

function sourceNodeRids(elements: AnsweredQuerySourceElement[]): number[] {
  const rids = new Set<number>();
  for (const element of elements) {
    if (element.kind === "node" && element.rid != null) rids.add(element.rid);
    if (element.kind === "edge") {
      if (element.from_rid != null) rids.add(element.from_rid);
      if (element.to_rid != null) rids.add(element.to_rid);
    }
  }
  return [...rids];
}

async function removeOutgoingReferences(store: MemoryStore, fromRid: number): Promise<void> {
  for (const edge of await store.listEdges()) {
    if (String(edge.label ?? edge.LABEL ?? "") !== "REFERENCES") continue;
    const from = Number(edge.from ?? edge.from_id ?? edge.from_rid ?? edge.FROM);
    const to = Number(edge.to ?? edge.to_id ?? edge.to_rid ?? edge.TO);
    if (from === fromRid && Number.isFinite(to)) {
      await store.removeEdge(fromRid, to, "REFERENCES");
    }
  }
}

function answeredQueryResultInput(input: {
  question: string;
  sourceRef: string;
  observer: string;
  evidence: string[];
  confidence: Confidence;
}): MemoryStoreEvidenceInput {
  return {
    claim: input.question,
    sourceRef: input.sourceRef,
    citationExcerpt: input.question,
    intent: "answered-query-feedback",
    observer: input.observer,
    confidence: input.confidence,
  };
}

function finitePositive(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
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
