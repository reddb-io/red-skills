/**
 * Pure conflict detector for L3 graph writes (issue #179, PRD #174).
 *
 * Compares a candidate node against the existing L3 graph and flags
 * contradictions worth emitting `CONTRADICTS` edges for. Has no I/O — the
 * write path is responsible for fetching existing L3 nodes and persisting the
 * edges this module returns.
 *
 * Three conflict kinds:
 *
 *   - `same-fact-different-value`: same topic, divergent value text.
 *   - `semantically-opposite`: same topic, one side carries a negation marker
 *     the other lacks.
 *   - `same-text-different-session`: byte-identical fact written from two
 *     independent sessions — the cross-session contention case AMS cannot
 *     structurally express.
 *
 * Anything else (different topics, distinct claims, identical text from the
 * same session) returns no conflict.
 */
import type { MemoryNodeProps, NodeType } from "./schema.js";

export type ConflictKind =
  | "same-fact-different-value"
  | "semantically-opposite"
  | "same-text-different-session";

export interface ConflictNode {
  rid?: number;
  label: string;
  node_type: NodeType;
  properties: MemoryNodeProps;
}

export interface DetectedConflict {
  rid: number;
  kind: ConflictKind;
  reason: string;
  sessions: { candidate: string | null; existing: string | null };
}

/** Node types where contradictions are meaningful to surface. */
export const CONFLICT_NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
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

const NEGATION_MARKERS: readonly RegExp[] = [
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
export function detectConflicts(
  candidate: ConflictNode,
  existing: ConflictNode[],
): DetectedConflict[] {
  if (!CONFLICT_NODE_TYPES.has(candidate.node_type)) return [];

  const out: DetectedConflict[] = [];
  const candTopic = topicTokens(candidate);
  if (candTopic.size === 0) return [];

  const candValue = valueText(candidate);
  const candValueTokens = tokenize(candValue);
  const candNegated = isNegated(candValue);
  const candHash = (candidate.properties.hash as string | undefined) ?? null;
  const candSession = sessionId(candidate);

  for (const other of existing) {
    if (other.rid == null) continue;
    if (other.node_type !== candidate.node_type) continue;
    if (candidate.rid != null && other.rid === candidate.rid) continue;

    const otherTopic = topicTokens(other);
    if (otherTopic.size === 0) continue;
    if (jaccard(candTopic, otherTopic) < 0.5) continue;

    const otherSession = sessionId(other);
    const otherValue = valueText(other);
    const otherValueTokens = tokenize(otherValue);
    const otherHash = (other.properties.hash as string | undefined) ?? null;

    // Same-text-different-session: byte-identical content from two sessions.
    if (
      candHash != null &&
      otherHash != null &&
      candHash === otherHash &&
      candSession != null &&
      otherSession != null &&
      candSession !== otherSession
    ) {
      out.push({
        rid: other.rid,
        kind: "same-text-different-session",
        reason: `identical ${candidate.node_type} written by sessions ${candSession} and ${otherSession}`,
        sessions: { candidate: candSession, existing: otherSession },
      });
      continue;
    }

    // Same-text same-session is a duplicate (handled by upstream dedupe).
    if (candHash != null && otherHash != null && candHash === otherHash) continue;

    const otherNegated = isNegated(otherValue);
    const valueOverlap = jaccard(
      new Set(candValueTokens),
      new Set(otherValueTokens),
    );

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

function topicTokens(node: ConflictNode): Set<string> {
  const title =
    typeof node.properties.title === "string" ? node.properties.title : "";
  const tags = Array.isArray(node.properties.tags)
    ? (node.properties.tags as string[]).join(" ")
    : "";
  return new Set(tokenize(`${node.label} ${title} ${tags}`));
}

function valueText(node: ConflictNode): string {
  const summary =
    typeof node.properties.summary === "string" ? node.properties.summary : "";
  const content =
    typeof node.properties.content === "string" ? node.properties.content : "";
  return `${summary} ${content}`.trim();
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (token) => token.length > 1 && !STOP_WORDS.has(token),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const term of a) if (b.has(term)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function isNegated(text: string): boolean {
  if (!text) return false;
  return NEGATION_MARKERS.some((re) => re.test(text));
}

function sessionId(node: ConflictNode): string | null {
  const props = node.properties;
  const provenance = props.provenance as
    | { scope?: { level?: string; id?: string }; writer?: string }
    | undefined;
  if (provenance?.scope?.level === "session" && provenance.scope.id) {
    return provenance.scope.id;
  }
  if (props.scope === "session" && typeof props.scope_id === "string") {
    return props.scope_id;
  }
  const sessionIdProp = (props as { session_id?: unknown }).session_id;
  if (typeof sessionIdProp === "string") return sessionIdProp;
  if (provenance?.writer) return provenance.writer;
  return null;
}
