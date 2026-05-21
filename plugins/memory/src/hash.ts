import { createHash } from "node:crypto";

/** Stable, short content hash (used for dedupe across re-indexes). */
export function contentHash(...parts: Array<string | undefined | null>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p ?? "");
  return h.digest("hex").slice(0, 16);
}
