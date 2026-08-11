import { decode, encode, type JsonValue } from "@reddb-io/toon";

export function encodeDevSnapshotToon(value: JsonValue): string {
  return encode(value);
}

/**
 * Sniff-decode a converted snapshot document: legacy raw JSON first, TOON
 * fallback. This is the migration reader every castle-engine snapshot surface
 * uses. A JSON-looking header is committed to JSON parsing: malformed legacy
 * JSON must fail instead of being accepted as a permissive TOON object whose
 * unknown fields the state schema would silently default away.
 */
export function decodeDevSnapshotSniff(text: string): unknown {
  const first = text.trimStart()[0];
  if (first === "{" || first === "[") return JSON.parse(text);
  return decode(text);
}

export function assertDevSnapshotToonLossless(value: JsonValue): string {
  const toon = encodeDevSnapshotToon(value);
  const decoded = decode(toon);
  if (JSON.stringify(decoded) !== JSON.stringify(value)) {
    throw new Error("dev snapshot TOON round-trip failed");
  }
  return toon;
}
