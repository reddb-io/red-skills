import type { MemoryScope, Tier } from "./schema.js";

export type StoreClassificationKind =
  | "store"
  | "reject"
  | "scope-narrowly"
  | "ephemeral"
  | "reasoning"
  | "redact";

export interface StoreClassification {
  kind: StoreClassificationKind;
  recommendedTier: Tier;
  recommendedScope: MemoryScope;
  safetyWarnings: string[];
  explanation: string;
}

export function classifyCandidateMemory(candidate: string): StoreClassification {
  const text = candidate.trim();
  if (!text) {
    throw new Error("nothing to classify — pass a candidate memory");
  }
  const lower = text.toLowerCase();

  if (/(secret|token|api[_-]?key|password|private[_-]?key)/i.test(text) && /[A-Za-z0-9_+=/.-]{24,}/.test(text)) {
    return {
      kind: "redact",
      recommendedTier: "ephemeral",
      recommendedScope: "session",
      safetyWarnings: ["likely-secret"],
      explanation: "Candidate contains secret-like content; redact it before any persistence.",
    };
  }

  if (/\[\d{1,2}:\d{2}\]/.test(text) || /\b(running pnpm|typecheck passed|committing)\b/.test(lower)) {
    return {
      kind: "reject",
      recommendedTier: "ephemeral",
      recommendedScope: "agent-run",
      safetyWarnings: [],
      explanation: "Candidate is a raw task log, not a durable fact.",
    };
  }

  if (/\b(decision rationale|rationale|why we|because we|chose .+ because)\b/.test(lower)) {
    return {
      kind: "reasoning",
      recommendedTier: "reasoning",
      recommendedScope: "project",
      safetyWarnings: [],
      explanation: "Candidate records decision rationale, so route it into reasoning memory.",
    };
  }

  if (/\buser preference\b/.test(lower)) {
    return {
      kind: "store",
      recommendedTier: "durable",
      recommendedScope: "user",
      safetyWarnings: [],
      explanation: "Candidate describes a durable user preference.",
    };
  }

  if (/\b(on branch|branch [a-z0-9/_-]+)\b/.test(lower)) {
    return {
      kind: "scope-narrowly",
      recommendedTier: "durable",
      recommendedScope: "branch",
      safetyWarnings: [],
      explanation: "Candidate is branch-specific, so scope it narrowly instead of project-wide.",
    };
  }

  if (/\b(current progress|progress|halfway|in progress|tests are running|todo|wip)\b/.test(lower)) {
    return {
      kind: "ephemeral",
      recommendedTier: "ephemeral",
      recommendedScope: "session",
      safetyWarnings: [],
      explanation: "Candidate is temporary progress, so keep it ephemeral instead of durable memory.",
    };
  }

  return {
    kind: "store",
    recommendedTier: "durable",
    recommendedScope: "project",
    safetyWarnings: [],
    explanation: "Candidate describes a stable project rule, so durable project memory is appropriate.",
  };
}
