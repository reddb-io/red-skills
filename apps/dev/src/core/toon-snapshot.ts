import { decode, encode, type JsonValue } from "@reddb-io/toon";

export function encodeDevSnapshotToon(value: JsonValue): string {
  return encode(value, { keyedMapCollapse: true });
}

export function assertDevSnapshotToonLossless(value: JsonValue): string {
  const toon = encodeDevSnapshotToon(value);
  const decoded = decode(toon);
  if (JSON.stringify(decoded) !== JSON.stringify(value)) {
    throw new Error("dev snapshot TOON round-trip failed");
  }
  return toon;
}
