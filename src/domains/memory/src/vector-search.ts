import type { SearchRow, StoredNode } from "./graph-store.js";
import type { Confidence, MemoryNode, NodeType } from "./schema.js";

export interface VectorSearchHitDetail {
  rid: number;
  score: number;
  kind: "memory" | "asset";
  label: string;
  node_type: NodeType;
  title: string;
  excerpt: string;
  confidence: Confidence;
  source: string | null;
  path?: string;
  asset_kind?: string;
  media_type?: string;
}

export interface VectorSearchReport {
  query: string;
  limit: number;
  status: "available" | "unavailable";
  hits: VectorSearchHitDetail[];
  error?: string;
  read_only: true;
}

export interface VectorSearchStore {
  searchVector(query: string, limit?: number): Promise<SearchRow[]>;
  getNode(rid: number): Promise<(MemoryNode & { rid: number }) | null>;
}

export async function buildVectorSearchReport(
  store: VectorSearchStore,
  query: string,
  options: { limit?: number } = {},
): Promise<VectorSearchReport> {
  const limit = clampLimit(options.limit);
  try {
    const rows = dedupeRows(await store.searchVector(query, limit));
    const hits: VectorSearchHitDetail[] = [];
    for (const row of rows) {
      const node = await store.getNode(row.rid);
      if (!node) continue;
      hits.push(vectorHitFromNode(node, row.score));
    }
    return { query, limit, status: "available", hits, read_only: true };
  } catch (err) {
    return {
      query,
      limit,
      status: "unavailable",
      hits: [],
      error: err instanceof Error ? err.message : String(err),
      read_only: true,
    };
  }
}

function vectorHitFromNode(node: StoredNode, score: number): VectorSearchHitDetail {
  const props = node.properties;
  const title = stringValue(props.title) ?? node.label;
  const assetKind = stringValue(props.asset_kind);
  const path = stringValue(props.source);
  return {
    rid: node.rid,
    score,
    kind: assetKind ? "asset" : "memory",
    label: node.label,
    node_type: node.node_type,
    title,
    excerpt: excerptFromNode(node),
    confidence: confidenceValue(props.confidence),
    source: stringValue(props.source),
    ...(assetKind ? { asset_kind: assetKind } : {}),
    ...(assetKind && path ? { path } : {}),
    ...(assetKind && stringValue(props.media_type)
      ? { media_type: stringValue(props.media_type) ?? undefined }
      : {}),
  };
}

function excerptFromNode(node: StoredNode): string {
  const props = node.properties;
  const text =
    stringValue(props.summary) ??
    stringValue(props.content) ??
    stringValue(props.title) ??
    node.label;
  return cleanExcerpt(text, 220);
}

function dedupeRows(rows: SearchRow[]): SearchRow[] {
  const byRid = new Map<number, SearchRow>();
  for (const row of rows) {
    const existing = byRid.get(row.rid);
    if (!existing) {
      byRid.set(row.rid, row);
      continue;
    }
    existing.score = Math.max(existing.score, row.score);
  }
  return [...byRid.values()];
}

function cleanExcerpt(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function confidenceValue(value: unknown): Confidence {
  return value === "EXTRACTED" || value === "INFERRED" || value === "AMBIGUOUS"
    ? value
    : "INFERRED";
}

function clampLimit(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 20;
  return Math.min(50, Math.max(1, Math.trunc(value)));
}
