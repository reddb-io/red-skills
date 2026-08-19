import { planGithubWrite } from "@reddb-io/github";
import { listOpenPr, openDraftPr, type Exec } from "./merge.js";

export const MERGE_HOLD_MARKER = "<!-- afk:merge-hold v1 -->";

export function hasMergeHold(issueBody: string): boolean {
  return issueBody.includes(MERGE_HOLD_MARKER);
}

/** Resolve a visible PR for an explicit merge hold and guarantee it is draft. */
export async function openHeldDraftPr(
  exec: Exec,
  input: { repo: string; branch: string; target: string; n: number; title: string },
): Promise<{ ok: boolean; prNumber?: number }> {
  const existing = await listOpenPr(exec, input.repo, input.branch, input.target);
  if (existing !== undefined) {
    const held = await exec([
      ...planGithubWrite([
        "gh", "-R", input.repo, "pr", "ready", String(existing), "--undo",
      ]).args,
    ]);
    const alreadyDraft = /already (?:a )?draft/i.test(`${held.stdout}\n${held.stderr}`);
    return { ok: held.code === 0 || alreadyDraft, prNumber: existing };
  }

  const prNumber = await openDraftPr(exec, {
    repo: input.repo,
    branch: input.branch,
    target: input.target,
    n: input.n,
    title: input.title,
    prTitle: `afk: #${input.n} ${input.title} (merge hold)`,
    body: `Implementation for #${input.n}. Merge is held for an explicit human decision.\n\n${MERGE_HOLD_MARKER}`,
  });
  return prNumber === undefined ? { ok: false } : { ok: true, prNumber };
}
