/**
 * PromotionEngine (PRD #174, issue #183). Pure function
 * `(L2 candidates, L3 state) → (promote, reinforce, skipped)` with two gates:
 *
 * 1. **Type gate** — only typed candidates (`decision`, `fix`, `gotcha`,
 *    `validation`, `why_note`, …) promote. Raw turns / tool noise stay in L2
 *    until L2 eviction reaps them.
 * 2. **Dedup gate** — semantic + keyword match against L3. If a near-equivalent
 *    already exists, that node's `reinforced` count is bumped and the candidate
 *    is *not* re-written into L3.
 *
 * Pure: no IO, no clock, no random. The caller (runtime in `promote.ts`) pulls
 * L2 events + L3 candidates, hands them in, then applies the returned
 * decisions — that lets `promotion-engine.test.ts` cover every branch from
 * deterministic fixtures.
 *
 * Confidence thresholds are deliberately absent (issue #183): supersession
 * (#179) and `memory doctor` handle the long tail of low-signal entries.
 */

/** Node types the engine considers worth promoting out of L2. */
export const DEFAULT_PROMOTABLE_TYPES: ReadonlySet<string> = new Set([
  "decision",
  "fix",
  "gotcha",
  "validation",
  "why_note",
  "reasoning",
  "solution",
  "problem",
]);

export interface PromotionCandidate {
  /** Opaque candidate id (typically the L2 event rid). */
  id: string | number;
  /**
   * Candidate type — usually the L2 event's `decision_candidate` style label
   * stripped of the `_candidate` suffix, or the target L3 node_type.
   */
  type: string;
  title: string;
  content?: string;
  /** Optional pre-computed embedding for vector dedup. */
  embedding?: number[];
  /** Pre-extracted keyword set. The engine derives one from title/content if absent. */
  keywords?: string[];
  /** Free-form pass-through. */
  meta?: Record<string, unknown>;
}

export interface PromotionExistingNode {
  /** Stable RID of the existing L3 node. */
  rid: number;
  type: string;
  title: string;
  content?: string;
  embedding?: number[];
  keywords?: string[];
  /** Current reinforcement count; defaults to 0 when absent. */
  reinforced?: number;
}

export interface PromotionOptions {
  /** Promotable type whitelist. Defaults to {@link DEFAULT_PROMOTABLE_TYPES}. */
  promotableTypes?: ReadonlySet<string>;
  /**
   * Cosine-similarity threshold above which a candidate is treated as a near-
   * dup of an existing L3 node. Inclusive. Default `0.92`.
   */
  vectorThreshold?: number;
  /**
   * Jaccard-on-keywords threshold above which a candidate is treated as a
   * near-dup. Inclusive. Default `0.6`.
   */
  keywordThreshold?: number;
}

export type PromotionMatchKind = "exact" | "vector" | "keyword";

export interface PromotionDecisionPromote {
  decision: "promote";
  candidate: PromotionCandidate;
}

export interface PromotionDecisionReinforce {
  decision: "reinforce";
  candidate: PromotionCandidate;
  target_rid: number;
  match: PromotionMatchKind;
  reinforced: number;
}

export interface PromotionDecisionSkip {
  decision: "skip";
  candidate: PromotionCandidate;
  reason: "type-rejected";
}

export type PromotionDecision =
  | PromotionDecisionPromote
  | PromotionDecisionReinforce
  | PromotionDecisionSkip;

export interface PromotionResult {
  promote: PromotionDecisionPromote[];
  reinforce: PromotionDecisionReinforce[];
  skipped: PromotionDecisionSkip[];
  decisions: PromotionDecision[];
}

export interface PromotionInput {
  candidates: readonly PromotionCandidate[];
  existing: readonly PromotionExistingNode[];
  options?: PromotionOptions;
}

const DEFAULT_VECTOR_THRESHOLD = 0.92;
const DEFAULT_KEYWORD_THRESHOLD = 0.6;

/**
 * Pure engine entry point. Walks candidates in input order; for each, applies
 * the type gate then probes L3 (and any promotions accumulated in this run, so
 * a batch with two near-equivalent candidates doesn't double-promote) for an
 * exact/vector/keyword match.
 */
export function runPromotionEngine(input: PromotionInput): PromotionResult {
  const promotableTypes = input.options?.promotableTypes ?? DEFAULT_PROMOTABLE_TYPES;
  const vectorThreshold = input.options?.vectorThreshold ?? DEFAULT_VECTOR_THRESHOLD;
  const keywordThreshold = input.options?.keywordThreshold ?? DEFAULT_KEYWORD_THRESHOLD;

  const decisions: PromotionDecision[] = [];
  const promote: PromotionDecisionPromote[] = [];
  const reinforce: PromotionDecisionReinforce[] = [];
  const skipped: PromotionDecisionSkip[] = [];

  // Existing nodes participate in dedup; freshly-promoted candidates within
  // this same batch also dedup so we never emit two promotes that collapse to
  // one node downstream. Tracked separately because they have no RID yet.
  const existingShadow: PromotionExistingNode[] = input.existing.map((n) => ({
    ...n,
    keywords: n.keywords ?? extractKeywords(`${n.title} ${n.content ?? ""}`),
    reinforced: n.reinforced ?? 0,
  }));

  for (const candidate of input.candidates) {
    if (!promotableTypes.has(candidate.type)) {
      const skip: PromotionDecisionSkip = {
        decision: "skip",
        candidate,
        reason: "type-rejected",
      };
      skipped.push(skip);
      decisions.push(skip);
      continue;
    }

    const candidateKeywords =
      candidate.keywords ?? extractKeywords(`${candidate.title} ${candidate.content ?? ""}`);

    const match = findMatch(
      candidate,
      candidateKeywords,
      existingShadow,
      vectorThreshold,
      keywordThreshold,
    );

    if (match) {
      const target = existingShadow[match.index];
      const reinforced = (target.reinforced ?? 0) + 1;
      target.reinforced = reinforced;
      const r: PromotionDecisionReinforce = {
        decision: "reinforce",
        candidate,
        target_rid: target.rid,
        match: match.kind,
        reinforced,
      };
      reinforce.push(r);
      decisions.push(r);
      continue;
    }

    const p: PromotionDecisionPromote = { decision: "promote", candidate };
    promote.push(p);
    decisions.push(p);
    // Shadow-add so a later candidate in the same batch dedups against it.
    existingShadow.push({
      rid: -1 - promote.length, // sentinel; never surfaced to callers
      type: candidate.type,
      title: candidate.title,
      content: candidate.content,
      embedding: candidate.embedding,
      keywords: candidateKeywords,
      reinforced: 0,
    });
  }

  return { promote, reinforce, skipped, decisions };
}

interface MatchHit {
  index: number;
  kind: PromotionMatchKind;
}

function findMatch(
  candidate: PromotionCandidate,
  candidateKeywords: string[],
  existing: readonly PromotionExistingNode[],
  vectorThreshold: number,
  keywordThreshold: number,
): MatchHit | null {
  const candidateContent = normalizeText(`${candidate.title}\n${candidate.content ?? ""}`);

  // Exact match on normalized title+content has highest precedence.
  for (let i = 0; i < existing.length; i++) {
    const node = existing[i];
    if (existing[i].type !== candidate.type) continue;
    const nodeContent = normalizeText(`${node.title}\n${node.content ?? ""}`);
    if (nodeContent === candidateContent) return { index: i, kind: "exact" };
  }

  // Vector near-dup: cosine similarity above threshold.
  if (candidate.embedding && candidate.embedding.length > 0) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < existing.length; i++) {
      const node = existing[i];
      if (node.type !== candidate.type) continue;
      if (!node.embedding || node.embedding.length === 0) continue;
      const score = cosineSimilarity(candidate.embedding, node.embedding);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0 && bestScore >= vectorThreshold) {
      return { index: best, kind: "vector" };
    }
  }

  // Keyword near-dup: Jaccard over keyword sets above threshold.
  if (candidateKeywords.length > 0) {
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < existing.length; i++) {
      const node = existing[i];
      if (node.type !== candidate.type) continue;
      const nodeKeywords = node.keywords ?? [];
      if (nodeKeywords.length === 0) continue;
      const score = jaccard(candidateKeywords, nodeKeywords);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0 && bestScore >= keywordThreshold) {
      return { index: best, kind: "keyword" };
    }
  }

  return null;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on",
  "for", "with", "is", "are", "was", "were", "be", "been", "being",
  "by", "at", "from", "as", "that", "this", "it", "its", "we", "you",
  "i", "they", "them", "he", "she", "his", "her", "our", "your",
  "not", "no", "do", "does", "did", "have", "has", "had", "will",
  "would", "should", "could", "can", "may", "might", "must", "so",
  "than", "then", "there", "here", "which", "who", "what", "when",
  "where", "why", "how", "all", "any", "each", "some", "such", "into",
  "about", "between", "after", "before", "over", "under", "again",
  "out", "off", "up", "down",
]);

/** Public for tests — extract a simple keyword set from free text. */
export function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .match(/[a-z0-9_][a-z0-9_-]{1,}/g) ?? [];
  const set = new Set<string>();
  for (const token of tokens) {
    if (token.length < 3) continue;
    if (STOPWORDS.has(token)) continue;
    set.add(token);
  }
  return [...set];
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
