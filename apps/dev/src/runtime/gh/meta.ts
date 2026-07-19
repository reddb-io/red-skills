import type { IssueMeta } from "../../core/branch-cleanup.js";
import { repoArgs, runGh, type GhContext } from "./common.js";

export async function issueMeta(ctx: GhContext, issue: number): Promise<IssueMeta | null | undefined> {
  const r = await runGh(ctx, 
    ["issue", "view", String(issue), ...repoArgs(ctx), "--json", "state,closedAt"],
  );
  if (r.code !== 0) {
    // gh prints a 404 "Could not resolve" / "not found" on a real miss.
    if (/not found|could not resolve|no issues? match/i.test(r.stderr)) return null;
    return undefined;
  }
  try {
    const parsed = JSON.parse(r.stdout) as { state?: string; closedAt?: string | null };
    return { state: String(parsed.state ?? ""), closedAt: parsed.closedAt ?? null };
  } catch {
    return undefined;
  }
}
