import type { MemoryStore, StoredNode } from "./graph-store.js";

export interface MemoryAssetInventoryItem {
  rid: number;
  label: string;
  path: string;
  title: string;
  asset_kind: string;
  media_type: string;
  bytes: number;
  binary: boolean;
  hash: string | null;
}

export interface MemoryAssetKindSummary {
  kind: string;
  count: number;
  bytes: number;
}

export interface MemoryAssetInventoryReport {
  schema_version: "memory.asset_inventory.v1";
  read_only: true;
  query: string | null;
  total_assets: number;
  total_bytes: number;
  kinds: MemoryAssetKindSummary[];
  assets: MemoryAssetInventoryItem[];
  warnings: string[];
}

export interface AssetInventoryStore {
  listNodes(): Promise<StoredNode[]>;
}

export async function buildMemoryAssetInventory(
  store: AssetInventoryStore | MemoryStore,
  opts: { kind?: string; query?: string; limit?: number } = {},
): Promise<MemoryAssetInventoryReport> {
  const wantedKind = opts.kind?.trim();
  const query = opts.query?.trim();
  const assets = (await store.listNodes())
    .map(assetItem)
    .filter((item): item is MemoryAssetInventoryItem => item != null)
    .filter((item) => !wantedKind || item.asset_kind === wantedKind)
    .map((item) => ({ item, score: query ? assetScore(item, query) : 1 }))
    .filter(({ score }) => !query || score > 0)
    .sort((a, b) => b.score - a.score || a.item.path.localeCompare(b.item.path))
    .slice(0, clampLimit(opts.limit))
    .map(({ item }) => item);
  const totalBytes = assets.reduce((sum, item) => sum + item.bytes, 0);
  return {
    schema_version: "memory.asset_inventory.v1",
    read_only: true,
    query: query || null,
    total_assets: assets.length,
    total_bytes: totalBytes,
    kinds: kindSummary(assets),
    assets,
    warnings:
      assets.length === 0
        ? [
            wantedKind
              ? `no ${wantedKind} assets found; run memory ingest over matching files`
              : "no binary/document assets found; run memory ingest over PDFs, images, audio/video, or Office files",
          ]
        : [],
  };
}

function assetScore(item: MemoryAssetInventoryItem, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_.:/-]+/)
    .filter(Boolean);
  if (terms.length === 0) return 1;
  const haystack = [
    item.title,
    item.path,
    item.asset_kind,
    item.media_type,
    item.hash ?? "",
  ]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  return score;
}

function clampLimit(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function assetItem(node: StoredNode): MemoryAssetInventoryItem | null {
  const props = node.properties;
  if (typeof props.asset_kind !== "string") return null;
  const path = typeof props.source === "string" ? props.source : node.label.replace(/^asset:/, "");
  return {
    rid: node.rid,
    label: node.label,
    path,
    title: typeof props.title === "string" ? props.title : path,
    asset_kind: props.asset_kind,
    media_type: typeof props.media_type === "string" ? props.media_type : "application/octet-stream",
    bytes: typeof props.bytes === "number" && Number.isFinite(props.bytes) ? props.bytes : 0,
    binary: props.binary !== false,
    hash: typeof props.hash === "string" ? props.hash : null,
  };
}

function kindSummary(assets: MemoryAssetInventoryItem[]): MemoryAssetKindSummary[] {
  const byKind = new Map<string, MemoryAssetKindSummary>();
  for (const asset of assets) {
    const current = byKind.get(asset.asset_kind) ?? {
      kind: asset.asset_kind,
      count: 0,
      bytes: 0,
    };
    current.count += 1;
    current.bytes += asset.bytes;
    byKind.set(asset.asset_kind, current);
  }
  return [...byKind.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}
