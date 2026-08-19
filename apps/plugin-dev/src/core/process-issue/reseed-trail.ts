// reseed-trail — the Re-seed's two DERIVED surfaces (ADR 0129, Spec #2723,
// issue #2731): a lazily-minted draft pull request and ONE Issue comment
// upserted in place.
//
// The trail becomes visible without paying a pull request per Worker. The first
// Re-seed of any cause opens the draft; a Worker that never re-seeds opens none
// and lands exactly as it always did. Landing reuses that draft and marks it
// ready — opening a second pull request is a defect, not a fallback.
//
// Both surfaces are PROJECTIONS of what the Worker did — its committed branch
// and its iteration log — so a failed post, a failed edit, or a forge that
// refuses the draft costs fidelity on a projection and never the round: every
// call here is best-effort and the publisher retries the missing half on the
// next round.

import { openDraftPr, editPrBody, labelPr, type Exec as MergeExec } from "../merge.js";
import { pushAttempt, type GitExec } from "../remote-branch.js";
import { LABEL_VALIDATION } from "../triage-labels.js";
import type { ReseedCause, ReseedTrigger } from "./reseed-budget.js";

/** The marker that makes the comment findable for the in-place edit. Carries the
 * issue so a comment posted on the wrong Ticket can never be mistaken for it. */
export function reseedTrailMarker(issue: number): string {
  return `<!-- afk:reseed-trail v1 issue=${issue} -->`;
}

/** The park marker both surfaces carry (#2732). It names `blocked:validation` —
 * the SAME state the Ticket's label carries — so one query over the marker
 * separates parked work from live work without joining two vocabularies. */
export function reseedParkMarker(issue: number): string {
  return `<!-- afk:reseed-park v1 issue=${issue} blocked=${LABEL_VALIDATION} -->`;
}

/** One round on the trail. `note` is the same line the iteration log carries, so
 * the two surfaces cannot disagree about what a round was asked to fix. */
export interface ReseedTrailRound {
  readonly round: number;
  readonly trigger: ReseedTrigger;
  readonly cause: ReseedCause;
  readonly note: string;
}

/** The exhaustion that ended the Worker's run (#2732). One shape for every cause: a
 * budget spent on gate churn and a budget spent on a blocking review finding
 * park through the same rendering, because a human reading the park needs the
 * evidence and the open diff either way. */
export interface ReseedTrailPark {
  /** Whatever the exhausted round left red — the gate tail or the blocker
   * summary — verbatim, so the park needs no re-run to be diagnosed. */
  readonly evidence: string;
}

export interface ReseedTrailView {
  readonly issue: number;
  readonly branch: string;
  readonly lane: string;
  readonly ceiling: number;
  readonly rounds: readonly ReseedTrailRound[];
  /** Present once the budget is exhausted with work still outstanding. */
  readonly park?: ReseedTrailPark;
}

/** Render the trail. Pure, and the SAME body reaches both surfaces — the draft
 * mirrors the comment rather than maintaining a second narrative. */
export function renderReseedTrail(view: ReseedTrailView): string {
  const lines = [
    reseedTrailMarker(view.issue),
    `🤖 **Re-seed trail** — #${view.issue} on \`${view.branch}\`, lane \`${view.lane}\`.`,
    "",
    `Rounds spent: ${view.rounds.length}/${view.ceiling}. A Re-seed re-instructs the implementer in place —`,
    "same Worker, same Worktree, same branch — after a gate stage blocked the work.",
    "",
    "| round | trigger | what it was asked to fix |",
    "| --- | --- | --- |",
  ];
  for (const r of view.rounds) {
    lines.push(`| ${r.round}/${view.ceiling} | \`${r.trigger}\` (${r.cause}) | ${r.note.replace(/\|/g, "\\|")} |`);
  }
  lines.push(
    "",
    "The Worker's branch and iteration log are the source of truth; this is a derived projection.",
  );
  if (view.park) {
    lines.push(
      "",
      reseedParkMarker(view.issue),
      `🛑 **Parked — \`${LABEL_VALIDATION}\`.** The Re-seed budget is exhausted with work still`,
      "outstanding, so a human owns it from here. This pull request stays OPEN: a validation park is",
      "precisely the moment the diff must be readable.",
      "",
      "**Evidence at park time**",
      "",
      "```",
      view.park.evidence.trim(),
      "```",
    );
  }
  return lines.join("\n");
}

/** The Issue half of the trail. Posting returns the comment's numeric id, which
 * is what makes the SECOND round an edit rather than another notification. */
export interface ReseedTrailGh {
  postComment(issue: number, body: string): Promise<number | undefined>;
  editComment(commentId: number, body: string): Promise<boolean>;
}

export interface ReseedTrailDeps {
  gh?: ReseedTrailGh;
  mergeExec: MergeExec;
  remoteGit: GitExec;
  appendIterLog(line: string): void;
  recordWorkerEvent?(kind: `worker.${string}`, payload?: Record<string, unknown>): void;
}

export interface ReseedTrailContext {
  readonly issue: number;
  readonly repo: string;
  readonly repoDir: string;
  readonly branch: string;
  readonly base: string;
  readonly title: string;
  readonly lane: string;
  readonly ceiling: number;
}

export interface ReseedTrail {
  /** Record one round and upsert both projections. */
  publish(round: ReseedTrailRound): Promise<void>;
  /** Seal both projections on the exhausted budget: the draft stays OPEN and
   * both surfaces carry the same `blocked:validation` state and evidence. */
  park(park: ReseedTrailPark): Promise<void>;
  /** The draft's number once minted, for the landing that reuses it. */
  prNumber(): number | undefined;
}

/** The draft's body: the trail plus the auto-close link, so the pull request
 * landing reuses carries the same issue linkage {@link ensurePr} would have
 * given it had it been opened at landing time. */
function draftBody(issue: number, trail: string): string {
  return `${trail}\n\nCloses #${issue}`;
}

export function createReseedTrail(deps: ReseedTrailDeps, ctx: ReseedTrailContext): ReseedTrail {
  const rounds: ReseedTrailRound[] = [];
  let commentId: number | undefined;
  let prNumber: number | undefined;
  let pushed = false;

  /** The branch must be on the remote before a pull request can name it as head.
   * Pushed ONCE per Worker: later rounds ride the post-commit hook and the
   * landing's own force-push. */
  const ensurePushed = async (): Promise<boolean> => {
    if (pushed) return true;
    pushed = (await pushAttempt(deps.remoteGit, ctx.repoDir, ctx.branch, ctx.branch)).ok;
    return pushed;
  };

  const render = (park?: ReseedTrailPark): string =>
    renderReseedTrail({
      issue: ctx.issue,
      branch: ctx.branch,
      lane: ctx.lane,
      ceiling: ctx.ceiling,
      rounds,
      park,
    });

  /** ONE Issue comment: posted the first time the trail says anything, edited in
   * place every time after, so five rounds and a park are one notification
   * rather than six. */
  const upsertComment = async (body: string): Promise<void> => {
    if (!deps.gh) return;
    if (commentId === undefined) commentId = await deps.gh.postComment(ctx.issue, body);
    else await deps.gh.editComment(commentId, body);
  };

  /** The draft, minted lazily on the first round and mirrored thereafter.
   * Returns whether a pull request carries the body — the park needs to know,
   * because a draft the forge refused cannot be labelled. */
  const upsertDraft = async (body: string, round?: number): Promise<boolean> => {
    if (prNumber !== undefined) {
      await editPrBody(deps.mergeExec, ctx.repo, prNumber, draftBody(ctx.issue, body));
      return true;
    }
    if (!(await ensurePushed())) return false;
    prNumber = await openDraftPr(deps.mergeExec, {
      repo: ctx.repo,
      branch: ctx.branch,
      target: ctx.base,
      n: ctx.issue,
      title: ctx.title,
      body: draftBody(ctx.issue, body),
    });
    if (prNumber === undefined) return false;
    deps.appendIterLog(
      `🤖 ${ctx.lane}: first Re-seed — opened draft PR #${prNumber} carrying the correction trail.`,
    );
    deps.recordWorkerEvent?.("worker.reseed_draft_opened", { pr: prNumber, round });
    return true;
  };

  const publish = async (round: ReseedTrailRound): Promise<void> => {
    rounds.push(round);
    const body = render();
    await upsertComment(body);
    await upsertDraft(body, round.round);
  };

  /** The exhausted budget's last act, and deliberately NOT a close: a validation
   * park is exactly when a human needs the diff open, so the draft is left
   * standing and marked `blocked:validation` — the same state the Ticket
   * carries, which is what makes one query answer for both surfaces. */
  const park = async (parked: ReseedTrailPark): Promise<void> => {
    const body = render(parked);
    await upsertComment(body);
    if (!(await upsertDraft(body))) return;
    await labelPr(deps.mergeExec, ctx.repo, prNumber!, LABEL_VALIDATION);
    deps.appendIterLog(
      `🤖 ${ctx.lane}: Re-seed budget exhausted — draft PR #${prNumber} left open and marked \`${LABEL_VALIDATION}\`.`,
    );
    deps.recordWorkerEvent?.("worker.reseed_parked", { pr: prNumber, rounds: rounds.length });
  };

  return { publish, park, prNumber: () => prNumber };
}
