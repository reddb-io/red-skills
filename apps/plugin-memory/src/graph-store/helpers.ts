import { contentHash } from "../hash.js";
import type { DetectedConflict } from "../conflict-detector.js";
import {
  COLLECTIONS,
  type EdgeLabel,
  HIDDEN_BY_EDGE_LABELS,
  type MemoryDoc,
  type MemoryEdge,
  type MemoryNode,
  type MemoryScope,
  type NodeType,
  type ProvenanceTier,
} from "../schema.js";
import type { GraphRow, NodeScopeInput, StoredNode } from "./types.js";

export type TraverseStrategy = "bfs" | "dfs";
export type GraphDirection = "outgoing" | "incoming" | "both";
export type PathAlgorithm = "bfs" | "dijkstra";

export const STRATEGIES: readonly TraverseStrategy[] = ["bfs", "dfs"];
export const DIRECTIONS: readonly GraphDirection[] = ["outgoing", "incoming", "both"];
export const ALGORITHMS: readonly PathAlgorithm[] = ["bfs", "dijkstra"];
const CAUSAL_EDGE_LABELS = new Set<EdgeLabel>(["CAUSES", "PREVENTS", "BLOCKS", "ENABLES"]);

/** Reject anything not in the allowlist — these tokens are interpolated raw
 *  into the graph DSL (they cannot be bound as `$1` params), so they must never
 *  carry caller-supplied text. */
export function guard<T extends string>(value: string, allowed: readonly T[], kind: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`invalid ${kind}: ${value}`);
}

/** Marker appended to a doc body whose tail was dropped to fit the engine's
 *  per-value byte cap. */
const TRUNCATION_MARKER = "\n\n[…truncated to fit memory store…]";

/**
 * Per-document-record byte budget. The SDK packs an inserted document into a
 * single JSON value (one `body` column), and the engine hard-rejects any value
 * over its per-value cap — `PAGE_SIZE / 4`, i.e. 1 KB on the 4 KB-page builds
 * (ADR 0007). Crucially, that rejection is **not recoverable on the same
 * connection**: a failed oversized insert desyncs the embedded engine's stdio
 * RPC stream, after which every later query comes back as a bogus parser error.
 * So a doc must be sized to fit *before* it is sent, never trimmed-and-retried.
 * We target a value below the cap, leaving headroom for the engine's framing.
 */
export const DOC_RECORD_MAX_BYTES = 1000;

/** Truncate `text` so its UTF-8 byte length stays within `budget` bytes,
 *  reserving room for the truncation marker and never splitting a multi-byte
 *  codepoint. `budget` is the absolute byte ceiling for the returned string. */
export function truncateBytes(text: string, budget: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= budget) return text;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  let end = Math.max(0, budget - markerBytes);
  // Back off to a codepoint boundary: UTF-8 continuation bytes are 0b10xxxxxx.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8") + TRUNCATION_MARKER;
}

export function conflictEdgeProps(conflict: DetectedConflict): {
  reason: string;
  kind: DetectedConflict["kind"];
  candidate_session: string | null;
  existing_session: string | null;
} {
  return {
    reason: conflict.reason,
    kind: conflict.kind,
    candidate_session: conflict.sessions.candidate,
    existing_session: conflict.sessions.existing,
  };
}

export function defaultProvenanceTier(input: {
  confidence?: unknown;
  provenance?: { confidence?: unknown } | null;
}): ProvenanceTier {
  const confidence = input.confidence ?? input.provenance?.confidence;
  return confidence === "EXTRACTED" ? "oracle" : "proxy";
}

export function enforceEdgeProvenance(edge: MemoryEdge): void {
  if (!CAUSAL_EDGE_LABELS.has(edge.label)) return;
  if (!isCoOccurrenceEdge(edge.properties)) return;
  throw new Error(`co-occurrence edge cannot use causal label ${edge.label}`);
}

function isCoOccurrenceEdge(props: MemoryEdge["properties"]): boolean {
  if (!props) return false;
  const candidates = [
    props.relation_kind,
    props.source_kind,
    props.extraction_kind,
    props.inference_kind,
  ];
  return candidates.some((value) => normalizeProvenanceMarker(value) === "co-occurrence");
}

function normalizeProvenanceMarker(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.toLowerCase().replace(/_/g, "-");
}

/**
 * Normalize a RedDB graph row into a MemoryNode. The engine returns promoted
 * columns uppercased (`PROPERTIES`, `HASH`) alongside lowercase `rid`, `label`,
 * `node_type`, so read both cases.
 */
export function rowToNode(row: Record<string, unknown>): StoredNode {
  const properties = (row.properties ?? row.PROPERTIES ?? {}) as MemoryNode["properties"];
  return {
    rid: Number(row.rid ?? row.red_entity_id),
    label: String(row.label ?? ""),
    node_type: (row.node_type as NodeType) ?? "concept",
    properties: properties ?? { title: String(row.label ?? "") },
  };
}

export function applySupersessionArchive(
  node: StoredNode,
  archive?: SupersessionArchiveRecord,
): StoredNode {
  if (!archive) return node;
  return {
    ...node,
    properties: {
      ...node.properties,
      ...(archive.valid_from != null ? { valid_from: archive.valid_from } : {}),
      valid_until: archive.valid_until,
      valid_to: archive.valid_until,
      archived_at: archive.archived_at,
      superseded_by: archive.superseded_by,
      superseded_by_rid: archive.superseded_by,
      ...(archive.reason ? { supersession_reason: archive.reason } : {}),
    },
  };
}

/**
 * Turn a free-text fact (as `/memory:store` receives it) into a graph node:
 * a `concept` whose label is the slugified first line, full text in `content`.
 * Mirrors the markdown-only note shape so the two modes capture the same thing.
 */
export function factToNode(
  fact: string,
  slugify: (t: string) => string,
  scopeInput: NodeScopeInput = {},
): MemoryNode {
  const trimmed = fact.trim();
  const title = trimmed.split("\n")[0]?.slice(0, 120) ?? trimmed;
  return {
    label: slugify(title),
    node_type: "concept",
    properties: {
      title,
      content: trimmed,
      source: "manual",
      ...(scopeInput.provenance ? { provenance: scopeInput.provenance } : {}),
      ...(scopeInput.scope ? { scope: scopeInput.scope } : {}),
      ...(scopeInput.scopeId ? { scope_id: scopeInput.scopeId } : {}),
    },
  };
}

export function defaultScopeId(
  scope: MemoryScope,
  nodeProject: string | undefined,
  storeProject: string | undefined,
): string | undefined {
  if (scope !== "project") return undefined;
  return nodeProject ?? storeProject;
}

/**
 * Normalize a graph-walk row (NEIGHBORHOOD/TRAVERSE) into a `GraphRow`. These
 * rows carry `node_id` (the rid as a string) and a synthetic `node_type` like
 * `label_64` — the real type lives on the node read back via `listNodes`.
 */
export function rowToGraphRow(row: Record<string, unknown>): GraphRow {
  return {
    rid: Number(row.node_id ?? row.rid ?? row.red_entity_id),
    label: String(row.label ?? ""),
    depth: Number(row.depth ?? 0),
  };
}

export function escapeLabel(label: string): string {
  return label.replace(/'/g, "''");
}

/** Clamp a depth to a sane non-negative integer for the graph DSL. */
export function clampDepth(depth: number): number {
  return Math.max(0, Math.floor(Number.isFinite(depth) ? depth : 0));
}

/** Clamp a limit to a positive integer for the search DSL. */
export function clampLimit(limit: number): number {
  return Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
}

/** KV key for the node dedupe index (hash → rid). */
export function nodeHashKey(hash: string): string {
  return `node:hash:${hash}`;
}

/** KV key for the edge dedupe index (from→to→label → rid). */
export function edgeKey(from: number, to: number, label: string): string {
  return `edge:${from}:${to}:${label}`;
}

export function isRemovedEdge(
  edge: Record<string, unknown>,
  removed: { rids: Set<number>; keys: Set<string> },
): boolean {
  const rid = edgeRid(edge);
  if (Number.isFinite(rid) && removed.rids.has(rid)) return true;
  const from = edgeFrom(edge);
  const to = edgeTo(edge);
  const label = edgeLabel(edge);
  return (
    Number.isFinite(from) &&
    Number.isFinite(to) &&
    removed.keys.has(edgeKey(from, to, label))
  );
}

export function isHiddenByEdgeLabel(label: string): label is (typeof HIDDEN_BY_EDGE_LABELS)[number] {
  return (HIDDEN_BY_EDGE_LABELS as readonly string[]).includes(label);
}

export function edgeRid(edge: Record<string, unknown>): number {
  return Number(
    edge.rid ?? edge.red_entity_id ?? edge.RED_ENTITY_ID ?? edge.edge_id ?? edge.EDGE_ID,
  );
}

export function edgeLabel(edge: Record<string, unknown>): string {
  return String(edge.label ?? edge.edge_label ?? edge.LABEL ?? "");
}

export function edgeFrom(edge: Record<string, unknown>): number {
  return Number(
    edge.from_rid ?? edge.from ?? edge.FROM ?? edge.from_id ?? edge.source ?? edge.source_id,
  );
}

export function edgeTo(edge: Record<string, unknown>): number {
  return Number(edge.to_rid ?? edge.to ?? edge.TO ?? edge.to_id ?? edge.target ?? edge.target_id);
}

/** Aggregate head-of-chain map: oldRid → newRid. One KV key for the whole
 *  graph, not one per node — see `supersede`. */
export const SUPERSEDED_KEY = "node:superseded:all";

export type SupersessionArchiveRecord = {
  superseded_by: number;
  valid_from?: number;
  valid_until: number;
  archived_at: number;
  reason?: string;
};

export type SupersessionArchiveMap = Record<string, SupersessionArchiveRecord>;

/** Aggregate archive overlay: oldRid → validity/linkage stamp. The original
 *  graph node row is preserved; read paths merge this stamp for audit recall.
 */
export const SUPERSESSION_ARCHIVE_KEY = "node:supersession_archive:all";

/** Aggregate logical edge-deletion map: edge rid → removed. */
export const REMOVED_EDGES_KEY = "edge:removed:all";

/** KV key carrying an ephemeral node's TTL horizon (forward-compat reaping). */
export function nodeExpiryKey(rid: number): string {
  return `node:expiry:${rid}`;
}

/**
 * Whether an `ephemeral` node has passed its TTL horizon. Only `ephemeral`
 * nodes carry `expires_at`; `durable`/`reasoning` nodes never expire.
 */
export function isExpired(node: StoredNode, now: number = Date.now()): boolean {
  if (node.properties.tier !== "ephemeral") return false;
  const expiresAt = node.properties.expires_at;
  return typeof expiresAt === "number" && now >= expiresAt;
}

export function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Aggregate access overlay: rid → {recall count, last-accessed time}. One KV
 *  key for the whole graph, not one per node — see `recordAccess`. */
export type AccessOverlayMap = Record<string, { count: number; accessed_at: number }>;
export const ACCESS_KEY = "node:access:all";

/** Aggregate reinforcement overlay: rid → reinforced count. One KV key for the
 *  whole graph, mirrors {@link ACCESS_KEY}. PromotionEngine bumps this on each
 *  dedup hit instead of mutating the node row (graph collections reject UPDATE,
 *  ADR 0007). */
export type ReinforceOverlayMap = Record<string, number>;
export const REINFORCE_KEY = "node:reinforce:all";

/** Aggregate eviction overlay: rid → evicted_at (ms). Filtered out by
 *  {@link MemoryStore.listNodes}, so consumers stop seeing the node even
 *  though the underlying row may still live on disk (see
 *  {@link MemoryStore.recordEvicted}). */
export const EVICTED_KEY = "node:evicted:all";

export function rowToDoc(row: Record<string, unknown>): (MemoryDoc & { rid: number }) | null {
  const get = (key: string) => row[key] ?? row[key.toUpperCase()];
  const rid = Number(get("rid") ?? row.red_entity_id ?? 0);
  const path = get("path");
  const hash = get("hash");
  if (!Number.isFinite(rid) || typeof path !== "string" || typeof hash !== "string") {
    return null;
  }
  const frontmatter = get("frontmatter");
  return {
    rid,
    path,
    title: get("title") == null ? undefined : String(get("title")),
    body: String(get("body") ?? ""),
    frontmatter:
      frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter)
        ? (frontmatter as Record<string, unknown>)
        : undefined,
    hash,
    updated_at: Number(get("source_updated_at") ?? get("updated_at") ?? 0),
  };
}
