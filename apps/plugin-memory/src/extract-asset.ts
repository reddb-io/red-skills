import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { MemoryNode } from "./schema.js";

export interface AssetExtraction {
  nodes: MemoryNode[];
  edges: [];
}

const ASSET_TYPES: Record<string, { kind: string; media_type: string }> = {
  ".pdf": { kind: "document", media_type: "application/pdf" },
  ".png": { kind: "image", media_type: "image/png" },
  ".jpg": { kind: "image", media_type: "image/jpeg" },
  ".jpeg": { kind: "image", media_type: "image/jpeg" },
  ".gif": { kind: "image", media_type: "image/gif" },
  ".webp": { kind: "image", media_type: "image/webp" },
  ".svg": { kind: "image", media_type: "image/svg+xml" },
  ".mp3": { kind: "audio", media_type: "audio/mpeg" },
  ".wav": { kind: "audio", media_type: "audio/wav" },
  ".m4a": { kind: "audio", media_type: "audio/mp4" },
  ".flac": { kind: "audio", media_type: "audio/flac" },
  ".ogg": { kind: "audio", media_type: "audio/ogg" },
  ".mp4": { kind: "video", media_type: "video/mp4" },
  ".mov": { kind: "video", media_type: "video/quicktime" },
  ".webm": { kind: "video", media_type: "video/webm" },
  ".mkv": { kind: "video", media_type: "video/x-matroska" },
  ".doc": { kind: "office-document", media_type: "application/msword" },
  ".docx": {
    kind: "office-document",
    media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  ".ppt": { kind: "office-document", media_type: "application/vnd.ms-powerpoint" },
  ".pptx": {
    kind: "office-document",
    media_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
  ".xls": { kind: "office-document", media_type: "application/vnd.ms-excel" },
  ".xlsx": {
    kind: "office-document",
    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
};

export function isAssetFile(path: string): boolean {
  return assetType(path) != null;
}

/**
 * Binary/document asset inventory for heterogeneous corpus awareness. This
 * stores deterministic metadata only; it does not claim OCR, transcript, or
 * multimodal embedding extraction.
 */
export async function extractAsset(path: string): Promise<AssetExtraction> {
  const type = assetType(path);
  if (!type) return { nodes: [], edges: [] };
  const [info, bytes] = await Promise.all([stat(path), readFile(path)]);
  const hash = createHash("sha256").update(path).update(bytes).digest("hex").slice(0, 16);
  const title = basename(path);
  return {
    nodes: [
      {
        label: `asset:${path}`,
        node_type: "file",
        properties: {
          title,
          summary: `${type.kind} asset at ${path}`,
          source: path,
          confidence: "EXTRACTED",
          provenance: {
            source_kind: "derived",
            writer: "extract-asset",
            confidence: "EXTRACTED",
            evidence: [path],
          },
          hash,
          asset_kind: type.kind,
          media_type: type.media_type,
          bytes: info.size,
          binary: type.media_type !== "image/svg+xml",
        },
      },
    ],
    edges: [],
  };
}

function assetType(path: string): { kind: string; media_type: string } | undefined {
  return ASSET_TYPES[extname(path).toLowerCase()];
}
