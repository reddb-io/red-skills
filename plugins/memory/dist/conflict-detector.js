/** Node types where contradictions are meaningful to surface. */
export const CONFLICT_NODE_TYPES = new Set([
    "decision",
    "fix",
    "solution",
    "problem",
    "goal",
    "validation",
    "why_note",
]);
const STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
    "have", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to",
    "was", "we", "will", "with",
]);
const NEGATION_MARKERS = [
    /\bnot\b/i,
    /\bnever\b/i,
    /\bno\b/i,
    /\bdon't\b/i,
    /\bdo\s+not\b/i,
    /\bwon't\b/i,
    /\bwill\s+not\b/i,
    /\bshouldn't\b/i,
    /\bshould\s+not\b/i,
    /\bmust\s+not\b/i,
    /\bcannot\b/i,
    /\bcan't\b/i,
    /\bavoid\b/i,
    /\bforbidden\b/i,
];
/** Detect conflicts between a candidate node and existing L3 nodes. */
export function detectConflicts(candidate, existing) {
    if (!CONFLICT_NODE_TYPES.has(candidate.node_type))
        return [];
    const out = [];
    const candTopic = topicTokens(candidate);
    if (candTopic.size === 0)
        return [];
    const candValue = valueText(candidate);
    const candValueTokens = tokenize(candValue);
    const candNegated = isNegated(candValue);
    const candHash = candidate.properties.hash ?? null;
    const candSession = sessionId(candidate);
    for (const other of existing) {
        if (other.rid == null)
            continue;
        if (other.node_type !== candidate.node_type)
            continue;
        if (candidate.rid != null && other.rid === candidate.rid)
            continue;
        const otherTopic = topicTokens(other);
        if (otherTopic.size === 0)
            continue;
        if (jaccard(candTopic, otherTopic) < 0.5)
            continue;
        const otherSession = sessionId(other);
        const otherValue = valueText(other);
        const otherValueTokens = tokenize(otherValue);
        const otherHash = other.properties.hash ?? null;
        // Same-text-different-session: byte-identical content from two sessions.
        if (candHash != null &&
            otherHash != null &&
            candHash === otherHash &&
            candSession != null &&
            otherSession != null &&
            candSession !== otherSession) {
            out.push({
                rid: other.rid,
                kind: "same-text-different-session",
                reason: `identical ${candidate.node_type} written by sessions ${candSession} and ${otherSession}`,
                sessions: { candidate: candSession, existing: otherSession },
            });
            continue;
        }
        // Same-text same-session is a duplicate (handled by upstream dedupe).
        if (candHash != null && otherHash != null && candHash === otherHash)
            continue;
        const otherNegated = isNegated(otherValue);
        const valueOverlap = jaccard(new Set(candValueTokens), new Set(otherValueTokens));
        // Semantically opposite: same topic, polarity flipped.
        if (candNegated !== otherNegated && valueOverlap >= 0.4) {
            out.push({
                rid: other.rid,
                kind: "semantically-opposite",
                reason: `polarity flip on overlapping ${candidate.node_type} statement`,
                sessions: { candidate: candSession, existing: otherSession },
            });
            continue;
        }
        // Same-fact-different-value: same topic, divergent value text.
        if (valueOverlap < 0.4 && (candValueTokens.length > 0 || otherValueTokens.length > 0)) {
            out.push({
                rid: other.rid,
                kind: "same-fact-different-value",
                reason: `same ${candidate.node_type} topic, divergent value`,
                sessions: { candidate: candSession, existing: otherSession },
            });
        }
    }
    return out;
}
function topicTokens(node) {
    const title = typeof node.properties.title === "string" ? node.properties.title : "";
    const tags = Array.isArray(node.properties.tags)
        ? node.properties.tags.join(" ")
        : "";
    return new Set(tokenize(`${node.label} ${title} ${tags}`));
}
function valueText(node) {
    const summary = typeof node.properties.summary === "string" ? node.properties.summary : "";
    const content = typeof node.properties.content === "string" ? node.properties.content : "";
    return `${summary} ${content}`.trim();
}
function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}
function jaccard(a, b) {
    if (a.size === 0 && b.size === 0)
        return 0;
    let intersection = 0;
    for (const term of a)
        if (b.has(term))
            intersection += 1;
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}
function isNegated(text) {
    if (!text)
        return false;
    return NEGATION_MARKERS.some((re) => re.test(text));
}
function sessionId(node) {
    const props = node.properties;
    const provenance = props.provenance;
    if (provenance?.scope?.level === "session" && provenance.scope.id) {
        return provenance.scope.id;
    }
    if (props.scope === "session" && typeof props.scope_id === "string") {
        return props.scope_id;
    }
    const sessionIdProp = props.session_id;
    if (typeof sessionIdProp === "string")
        return sessionIdProp;
    if (provenance?.writer)
        return provenance.writer;
    return null;
}
