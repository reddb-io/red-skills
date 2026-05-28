/**
 * Reasoning replay surface (issues #166, #169).
 *
 * Reads `attempt` nodes from the `reasoning` tier and ranks them by token
 * similarity to a task descriptor. Each result carries an `outcome` derived
 * from the AFK envelope `data-attempt-status` (mirrored on the attempt node
 * `status` property). `gaps[]` surfaces `learning-debt` repeated-failure
 * patterns scoped to the matched attempts' issues.
 */
import { buildLearningDebtReport, } from "../learning-debt.js";
import { tokenize } from "../recall.js";
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const KNOWN_OUTCOMES = new Set([
    "done",
    "blocked",
    "no-sentinel",
]);
export async function buildReasoningReplay(store, task, opts = {}) {
    const trimmed = task.trim();
    const limit = clampLimit(opts.limit);
    const now = opts.now ?? Date.now();
    const generatedAt = new Date(now).toISOString();
    const terms = tokenize(trimmed);
    const nodes = await store.listNodes(opts.now);
    const attempts = nodes.filter((n) => n.node_type === "attempt");
    const scored = attempts
        .map((node) => ({ node, similarity: jaccardSimilarity(terms, tokenize(attemptText(node))) }))
        .sort((a, b) => {
        if (b.similarity !== a.similarity)
            return b.similarity - a.similarity;
        return a.node.label.localeCompare(b.node.label);
    });
    const top = scored.slice(0, limit);
    const results = top.map(({ node, similarity }) => ({
        attempt_id: node.label,
        similarity: roundSimilarity(similarity),
        when: attemptWhen(node, generatedAt),
        summary: attemptSummary(node),
        outcome: outcomeForAttempt(node),
    }));
    const gaps = await collectGaps(store, top.map(({ node }) => node), now);
    return {
        schema_version: "memory.reasoning_replay.v1",
        read_only: true,
        task: trimmed,
        generated_at: generatedAt,
        limit,
        total_attempts: attempts.length,
        results,
        gaps,
    };
}
function clampLimit(value) {
    if (value == null || !Number.isFinite(value))
        return DEFAULT_LIMIT;
    return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}
function attemptText(node) {
    const props = node.properties;
    return [
        node.label,
        String(props.title ?? ""),
        String(props.summary ?? ""),
        String(props.notes ?? ""),
        String(props.validation_summary ?? ""),
        String(props.branch ?? ""),
        String(props.error_class ?? ""),
        Array.isArray(props.touched_files) ? props.touched_files.join(" ") : "",
    ]
        .filter(Boolean)
        .join(" ");
}
function attemptSummary(node) {
    const props = node.properties;
    const summary = typeof props.summary === "string" ? props.summary.trim() : "";
    if (summary)
        return summary;
    const title = typeof props.title === "string" ? props.title.trim() : "";
    if (title && title !== node.label)
        return title;
    return node.label;
}
function attemptWhen(node, fallback) {
    const props = node.properties;
    const candidate = pickEpochMs(props.updated_at) ?? pickEpochMs(props.created_at) ?? pickEpochMs(props.accessed_at);
    if (candidate == null)
        return fallback;
    return new Date(candidate).toISOString();
}
function pickEpochMs(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0)
        return value;
    return null;
}
function outcomeForAttempt(node) {
    const raw = node.properties.status;
    if (typeof raw !== "string")
        return "unknown";
    const status = raw.trim().toLowerCase();
    return KNOWN_OUTCOMES.has(status)
        ? status
        : "unknown";
}
/**
 * AFK envelope wire schema (see plugins/dev/skills/engineering/afk/scripts/lib/envelope.sh):
 *   <details data-attempt-status="<status>"><summary>...</summary>...</details>
 *
 * Returns the raw status string when found, or null otherwise. Useful for
 * back-filling outcomes from raw GitHub comment bodies; the reasoning-replay
 * surface itself reads the mirrored `status` property on attempt nodes.
 */
export function parseAttemptStatusFromEnvelope(body) {
    if (!body)
        return null;
    const match = /<details[^>]*\bdata-attempt-status\s*=\s*"([^"]+)"/i.exec(body);
    return match?.[1]?.trim() || null;
}
/**
 * Maps a raw envelope/attempt status to the bounded replay outcome vocabulary.
 */
export function mapStatusToOutcome(status) {
    if (typeof status !== "string")
        return "unknown";
    const normalized = status.trim().toLowerCase();
    return KNOWN_OUTCOMES.has(normalized)
        ? normalized
        : "unknown";
}
async function collectGaps(store, matchedAttempts, now) {
    if (matchedAttempts.length === 0)
        return [];
    const matchedIssues = new Set();
    for (const node of matchedAttempts) {
        const issue = Number(node.properties.issue_number);
        if (Number.isFinite(issue))
            matchedIssues.add(issue);
    }
    if (matchedIssues.size === 0)
        return [];
    let report;
    try {
        report = await buildLearningDebtReport(store, { now });
    }
    catch {
        return [];
    }
    const gaps = [];
    for (const debt of report.categories.repeatedFailurePatterns) {
        if (debt.issueNumber == null)
            continue;
        if (!matchedIssues.has(debt.issueNumber))
            continue;
        gaps.push(`${debt.pattern} (${debt.attemptCount} attempts) — no durable lesson recorded (${debt.citations.join(", ")})`);
    }
    return gaps;
}
/**
 * Jaccard similarity over the deduplicated token sets of two texts. Returns 0
 * for empty intersections (or when either side has no tokens), 1 when the sets
 * are equal. Deterministic and dependency-free so this slice has no provider /
 * vector requirement.
 */
export function jaccardSimilarity(a, b) {
    if (a.length === 0 || b.length === 0)
        return 0;
    const setA = new Set(a);
    const setB = new Set(b);
    let intersection = 0;
    for (const token of setA) {
        if (setB.has(token))
            intersection++;
    }
    const unionSize = setA.size + setB.size - intersection;
    if (unionSize === 0)
        return 0;
    return intersection / unionSize;
}
function roundSimilarity(value) {
    return Math.round(value * 10_000) / 10_000;
}
