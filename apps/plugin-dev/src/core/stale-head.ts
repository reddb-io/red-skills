/**
 * stale-head — merge refuses a head that moved past the validated tip (#4134).
 *
 * A caller that pinned the tip its gate validated must never merge a head
 * that advanced past it: one SHA passed the gate and a different one is what
 * the merge would ship. The single forgiven divergence is a clean rebase —
 * identical stable patch-id over the base — because it moves the validated
 * CHANGE without editing it. Symmetric to the base-OID pin that already
 * guards the other side of the merge.
 */
import type { Exec } from "./merge.js";

export interface StaleHeadCheckInput {
  readonly repoDir: string;
  readonly remote: string;
  readonly branch: string;
  readonly base: string;
  readonly intentBaseRef?: string;
  readonly validatedBranchTip: string;
}

export type StaleHeadVerdict =
  | { readonly stale: false }
  | { readonly stale: true; readonly liveTip: string; readonly message: string };

/** Resolve `refs/heads/<branch>` on the remote as one full object name, or null. */
export async function resolveRemoteBranchTip(
  exec: Exec,
  input: { repo: string; remote: string; branch: string },
): Promise<string | undefined> {
  const r = await exec([
    "git", "-C", input.repo,
    "rev-parse", "--verify", "--quiet", `${input.remote}/${input.branch}`,
  ]);
  const tip = r.stdout.trim();
  return r.code === 0 && tip !== "" ? tip : undefined;
}

/** Compare the live remote head against the validated tip; forgive one clean rebase. */
export async function staleHeadVerdict(exec: Exec, input: StaleHeadCheckInput): Promise<StaleHeadVerdict> {
  const liveTip = await resolveRemoteBranchTip(exec, {
    repo: input.repoDir,
    remote: input.remote,
    branch: input.branch,
  });
  if (!liveTip || liveTip === input.validatedBranchTip) return { stale: false };
  const baseRef = input.intentBaseRef ?? `origin/${input.base}`;
  const validatedId = await stablePatchId(exec, input.repoDir, baseRef, input.validatedBranchTip);
  const liveId = await stablePatchId(exec, input.repoDir, baseRef, liveTip);
  // An unanswerable patch-id is stale, never equivalence: forgiveness needs proof.
  if (validatedId != null && liveId != null && validatedId === liveId) return { stale: false };
  return {
    stale: true,
    liveTip,
    message:
      `the branch head moved after validation: gate validated ${input.validatedBranchTip.slice(0, 12)}, ` +
      `the live head is ${liveTip.slice(0, 12)}, and the divergence is not a clean rebase ` +
      "(stable patch-id differs) — re-run the gate on the live head or restore the validated tip",
  };
}

/** The stable patch-id of `base...tip`, or null when git cannot answer. */
async function stablePatchId(exec: Exec, repo: string, baseRef: string, tip: string): Promise<string | null> {
  const diff = await exec(["git", "-C", repo, "diff", `${baseRef}...${tip}`]);
  if (diff.code !== 0) return null;
  const id = await exec(["git", "-C", repo, "patch-id", "--stable"], { input: diff.stdout });
  if (id.code !== 0) return null;
  const token = id.stdout.trim().split(/\s+/)[0] ?? "";
  return token === "" ? null : token;
}
