import type { JsonValue } from "@reddb-io/toon";
import { parse as decode, serialize as encode } from "@reddb-io/toon/legacy";

export function encodeDevSnapshotToon(value: JsonValue): string {
  return encode(value, { keyedMapCollapse: true });
}

/**
 * Sniff-decode a converted snapshot document: legacy raw JSON first, TOON
 * fallback. This is the in-place migration reader every castle-engine snapshot
 * surface uses (wave-1 convention — the filename is retained and only the
 * content flips to TOON, so a bundle written before the flip still reads). TOON
 * `decode` throws on the JSON `{`/`[` header shapes, so the JSON-first order
 * never mis-parses a TOON document as JSON.
 */
export function decodeDevSnapshotSniff(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return decode(text);
  }
}

export function assertDevSnapshotToonLossless(value: JsonValue): string {
  const toon = encodeDevSnapshotToon(value);
  const decoded = decode(toon);
  if (JSON.stringify(decoded) !== JSON.stringify(value)) {
    throw new Error("dev snapshot TOON round-trip failed");
  }
  return toon;
}
