import type { MemoryStore } from "./graph-store.js";
import type { MemoryProvenance } from "./schema.js";
import { slugify } from "./store.js";

export type GovernedWriteOutcome = "stored" | "rejected";

export interface MemoryStoreEvidenceInput {
  claim?: string;
  sourceRef?: string;
  citationExcerpt?: string;
  intent?: string;
  observer?: string;
}

export interface GovernedWriteResult {
  schema_version: "memory.governed_write.v1";
  operation: "memory_store_evidence";
  outcome: GovernedWriteOutcome;
  reason: string;
  policy: {
    reason: string;
    risk: "low" | "unknown";
    mode_required: "graph";
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
): Promise<GovernedWriteResult> {
  const missing = REQUIRED_FIELDS.filter((field) => !nonEmpty(input[field]));
  if (missing.length > 0) {
    return rejectMemoryStoreEvidence(input, `missing_required_fields:${missing.join(",")}`);
  }

  const normalized = normalizeInput(input);
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
): GovernedWriteResult {
  const normalized = normalizeInput(input);
  return {
    schema_version: "memory.governed_write.v1",
    operation: "memory_store_evidence",
    outcome,
    reason,
    policy: {
      reason,
      risk: outcome === "stored" ? "low" : "unknown",
      mode_required: "graph",
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
  };
}

function normalizeInput(input: MemoryStoreEvidenceInput): Required<MemoryStoreEvidenceInput> {
  return {
    claim: input.claim?.trim() ?? "",
    sourceRef: input.sourceRef?.trim() ?? "",
    citationExcerpt: input.citationExcerpt?.trim() ?? "",
    intent: input.intent?.trim() ?? "",
    observer: input.observer?.trim() ?? "",
  };
}

function nonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
