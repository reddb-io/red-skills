/**
 * Reasoning replay — first vertical slice of the replay surface (issue #166).
 *
 * Reads `attempt` nodes from the `reasoning` tier and ranks them by token
 * similarity to a task descriptor. Outcome attachment and gap detection are
 * scheduled for slice #1b; this report always returns `gaps: []` and omits
 * `outcome` from each result.
 */

import type { MemoryStore, StoredNode } from "../graph-store.js";
import { tokenize } from "../recall.js";

export interface ReasoningReplayResult {
  attempt_id: string;
  similarity: number;
  when: string;
  summary: string;
}

export interface ReasoningReplayReport {
  schema_version: "memory.reasoning_replay.v1";
  read_only: true;
  task: string;
  generated_at: string;
  limit: number;
  total_attempts: number;
  results: ReasoningReplayResult[];
  gaps: string[];
}

export interface ReasoningReplayOptions {
  limit?: number;
  now?: number;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

export async function buildReasoningReplay(
  store: MemoryStore,
  task: string,
  opts: ReasoningReplayOptions = {},
): Promise<ReasoningReplayReport> {
  const trimmed = task.trim();
  const limit = clampLimit(opts.limit);
  const generatedAt = new Date(opts.now ?? Date.now()).toISOString();
  const terms = tokenize(trimmed);

  const nodes = await store.listNodes(opts.now);
  const attempts = nodes.filter((n) => n.node_type === "attempt");

  const scored = attempts
    .map((node) => ({ node, similarity: jaccardSimilarity(terms, tokenize(attemptText(node))) }))
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      return a.node.label.localeCompare(b.node.label);
    });

  const results: ReasoningReplayResult[] = scored.slice(0, limit).map(({ node, similarity }) => ({
    attempt_id: node.label,
    similarity: roundSimilarity(similarity),
    when: attemptWhen(node, generatedAt),
    summary: attemptSummary(node),
  }));

  return {
    schema_version: "memory.reasoning_replay.v1",
    read_only: true,
    task: trimmed,
    generated_at: generatedAt,
    limit,
    total_attempts: attempts.length,
    results,
    gaps: [],
  };
}

function clampLimit(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

function attemptText(node: StoredNode): string {
  const props = node.properties;
  return [
    node.label,
    String(props.title ?? ""),
    String(props.summary ?? ""),
    String(props.notes ?? ""),
    String(props.validation_summary ?? ""),
    String(props.branch ?? ""),
    String(props.error_class ?? ""),
    Array.isArray(props.touched_files) ? (props.touched_files as unknown[]).join(" ") : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function attemptSummary(node: StoredNode): string {
  const props = node.properties;
  const summary = typeof props.summary === "string" ? props.summary.trim() : "";
  if (summary) return summary;
  const title = typeof props.title === "string" ? props.title.trim() : "";
  if (title && title !== node.label) return title;
  return node.label;
}

function attemptWhen(node: StoredNode, fallback: string): string {
  const props = node.properties;
  const candidate =
    pickEpochMs(props.updated_at) ?? pickEpochMs(props.created_at) ?? pickEpochMs(props.accessed_at);
  if (candidate == null) return fallback;
  return new Date(candidate).toISOString();
}

function pickEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return null;
}

/**
 * Jaccard similarity over the deduplicated token sets of two texts. Returns 0
 * for empty intersections (or when either side has no tokens), 1 when the sets
 * are equal. Deterministic and dependency-free so this slice has no provider /
 * vector requirement.
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const unionSize = setA.size + setB.size - intersection;
  if (unionSize === 0) return 0;
  return intersection / unionSize;
}

function roundSimilarity(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
