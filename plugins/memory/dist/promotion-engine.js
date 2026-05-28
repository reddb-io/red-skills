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
export const DEFAULT_PROMOTABLE_TYPES = new Set([
    "decision",
    "fix",
    "gotcha",
    "validation",
    "why_note",
    "reasoning",
    "solution",
    "problem",
]);
const DEFAULT_VECTOR_THRESHOLD = 0.92;
const DEFAULT_KEYWORD_THRESHOLD = 0.6;
/**
 * Pure engine entry point. Walks candidates in input order; for each, applies
 * the type gate then probes L3 (and any promotions accumulated in this run, so
 * a batch with two near-equivalent candidates doesn't double-promote) for an
 * exact/vector/keyword match.
 */
export function runPromotionEngine(input) {
    const promotableTypes = input.options?.promotableTypes ?? DEFAULT_PROMOTABLE_TYPES;
    const vectorThreshold = input.options?.vectorThreshold ?? DEFAULT_VECTOR_THRESHOLD;
    const keywordThreshold = input.options?.keywordThreshold ?? DEFAULT_KEYWORD_THRESHOLD;
    const decisions = [];
    const promote = [];
    const reinforce = [];
    const skipped = [];
    // Existing nodes participate in dedup; freshly-promoted candidates within
    // this same batch also dedup so we never emit two promotes that collapse to
    // one node downstream. Tracked separately because they have no RID yet.
    const existingShadow = input.existing.map((n) => ({
        ...n,
        keywords: n.keywords ?? extractKeywords(`${n.title} ${n.content ?? ""}`),
        reinforced: n.reinforced ?? 0,
    }));
    for (const candidate of input.candidates) {
        if (!promotableTypes.has(candidate.type)) {
            const skip = {
                decision: "skip",
                candidate,
                reason: "type-rejected",
            };
            skipped.push(skip);
            decisions.push(skip);
            continue;
        }
        const candidateKeywords = candidate.keywords ?? extractKeywords(`${candidate.title} ${candidate.content ?? ""}`);
        const match = findMatch(candidate, candidateKeywords, existingShadow, vectorThreshold, keywordThreshold);
        if (match) {
            const target = existingShadow[match.index];
            const reinforced = (target.reinforced ?? 0) + 1;
            target.reinforced = reinforced;
            const r = {
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
        const p = { decision: "promote", candidate };
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
function findMatch(candidate, candidateKeywords, existing, vectorThreshold, keywordThreshold) {
    const candidateContent = normalizeText(`${candidate.title}\n${candidate.content ?? ""}`);
    // Exact match on normalized title+content has highest precedence.
    for (let i = 0; i < existing.length; i++) {
        const node = existing[i];
        if (existing[i].type !== candidate.type)
            continue;
        const nodeContent = normalizeText(`${node.title}\n${node.content ?? ""}`);
        if (nodeContent === candidateContent)
            return { index: i, kind: "exact" };
    }
    // Vector near-dup: cosine similarity above threshold.
    if (candidate.embedding && candidate.embedding.length > 0) {
        let best = -1;
        let bestScore = -Infinity;
        for (let i = 0; i < existing.length; i++) {
            const node = existing[i];
            if (node.type !== candidate.type)
                continue;
            if (!node.embedding || node.embedding.length === 0)
                continue;
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
            if (node.type !== candidate.type)
                continue;
            const nodeKeywords = node.keywords ?? [];
            if (nodeKeywords.length === 0)
                continue;
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
function normalizeText(text) {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}
const STOPWORDS = new Set([
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
export function extractKeywords(text) {
    const tokens = text
        .toLowerCase()
        .match(/[a-z0-9_][a-z0-9_-]{1,}/g) ?? [];
    const set = new Set();
    for (const token of tokens) {
        if (token.length < 3)
            continue;
        if (STOPWORDS.has(token))
            continue;
        set.add(token);
    }
    return [...set];
}
function jaccard(a, b) {
    if (a.length === 0 || b.length === 0)
        return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    let intersection = 0;
    for (const x of setA)
        if (setB.has(x))
            intersection++;
    const union = setA.size + setB.size - intersection;
    if (union === 0)
        return 0;
    return intersection / union;
}
function cosineSimilarity(a, b) {
    const length = Math.min(a.length, b.length);
    if (length === 0)
        return 0;
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    if (magA === 0 || magB === 0)
        return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
