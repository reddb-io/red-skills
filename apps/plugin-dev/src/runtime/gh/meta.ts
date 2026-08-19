import type { IssueMeta } from "../../core/branch-cleanup.js";
import type { GhContext } from "./common.js";
import { readSingleObject } from "./single-object.js";

export async function issueMeta(ctx: GhContext, issue: number): Promise<IssueMeta | null | undefined> {
  // One issue by number → REST (ADR 0132 decision 4).
  const read = await readSingleObject(ctx, "issue", issue, ["state", "closedAt"]);
  if (read.out.code !== 0) {
    // gh prints a 404 "Could not resolve" / "not found" on a real miss.
    if (/not found|could not resolve|no issues? match/i.test(read.out.stderr)) return null;
    return undefined;
  }
  if (!read.row) return undefined;
  const parsed = read.row as { state?: string; closedAt?: string | null };
  return { state: String(parsed.state ?? ""), closedAt: parsed.closedAt ?? null };
}
