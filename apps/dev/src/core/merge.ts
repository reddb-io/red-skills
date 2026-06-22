// merge — integrate / land primitives for the AFK merge stage (ADR 0030/0031).
//
// Ported from scripts/lib/merge.sh + the do_merge / land_pr landing in afk.sh.
// Pure decision logic and exact git/gh argv construction over an injected
// executor: every real command goes through `Exec`, and the facts that drive a
// branch ("is local strictly behind origin", "is the session locked") are
// inputs rather than IO. That keeps the integrate decision and the lock-toggled
// landing unit-testable against fixed inputs, with no real git/gh ever run.
//
// Landing is lock-toggled (ADR 0030):
//   - LOCKED   → merge the attempt directly into the locked branch with
//                `git merge --no-ff` and push it; a rejected push rolls the
//                merge commit back to the captured pre_merge_sha.
//   - UNLOCKED → land via an admin-merged PR into the pinned target (force-push
//                the attempt branch, open or reuse the PR, `gh pr merge --admin
//                --merge`), then fast-forward local <target> to the merge commit.

/** Result of a single executed command. Mirrors a child-process completion. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected git/gh executor. Receives a full argv (incl. the `git`/`gh` head). */
export type Exec = (args: string[]) => Promise<ExecResult>;

/** Inputs for {@link integrateOrigin}. The behind/sync facts are injected. */
export interface IntegrateOriginInput {
  /** Repo dir passed to `git -C`. */
  repo: string;
  /** Remote name (e.g. `origin`). */
  remote: string;
  /** Branch to sync (e.g. `main`). */
  branch: string;
  /**
   * True when local <branch> is strictly behind <remote>/<branch> — i.e. the
   * merge-base equals the local sha, so a clean fast-forward is possible.
   * Mirrors `base == local_sha` in merge.sh.
   */
  stillBehind: boolean;
  /** True when local already sits at the remote tip — nothing to integrate. */
  inSync: boolean;
}

/** Which path {@link integrateOrigin} took. */
export type IntegrateAction = "in-sync" | "fast-forward" | "rebase";

export interface IntegrateOriginResult {
  ok: boolean;
  action: IntegrateAction;
}

/**
 * Integrate the fetched `<remote>/<branch>` tip into local `<branch>` before the
 * merge, so the worker branch lands on the current tip rather than the stale
 * boot-time HEAD (issue #37). Decision, mirroring merge.sh:
 *   - already in sync          → no-op success;
 *   - local strictly behind    → `git merge --ff-only <remote>/<branch>`;
 *   - diverged / unrelated      → `git rebase <remote>/<branch>`, aborting and
 *                                 failing cleanly on conflict.
 */
export async function integrateOrigin(
  exec: Exec,
  input: IntegrateOriginInput,
): Promise<IntegrateOriginResult> {
  const { repo, remote, branch, stillBehind, inSync } = input;
  const remoteRef = `${remote}/${branch}`;

  if (inSync) return { ok: true, action: "in-sync" };

  if (stillBehind) {
    const ff = await exec(["git", "-C", repo, "merge", "--ff-only", remoteRef]);
    return { ok: ff.code === 0, action: "fast-forward" };
  }

  const rebase = await exec(["git", "-C", repo, "rebase", remoteRef]);
  if (rebase.code !== 0) {
    await exec(["git", "-C", repo, "rebase", "--abort"]);
    return { ok: false, action: "rebase" };
  }
  return { ok: true, action: "rebase" };
}

/** Inputs for the LOCKED landing path, {@link landMerge}. */
export interface LandMergeInput {
  /** Dir passed to `git -C` — the isolated landing worktree (#572), not the
   * primary checkout. */
  repo: string;
  /** Remote name (e.g. `origin`). */
  remote: string;
  /** Attempt branch being merged in (e.g. `afk/wAAAA/9-x`). */
  branch: string;
  /** Locked target branch to merge into and push. */
  target: string;
  /** Issue number, for the merge message. */
  n: number;
  /** Issue title, for the merge message. */
  title: string;
  /** Integrated tip captured before the merge, for rollback on push reject. */
  preMergeSha: string;
}

export interface LandMergeResult {
  ok: boolean;
  /** True when a rejected push triggered the reset back to preMergeSha. */
  rolledBack: boolean;
}

/**
 * LOCKED landing (ADR 0030): merge the attempt directly into the locked
 * `<target>` with `git merge --no-ff` and push it to `<remote>`. A rejected
 * push rolls the merge commit back to `preMergeSha` so the locked branch keeps
 * no orphan merge commit. No PR; nothing reaches main.
 *
 * `repo` is an ISOLATED landing worktree (issue #572), not the primary checkout:
 * the merge / push / rollback run on a detached HEAD there, so the `reset --hard`
 * on a push reject can never discard the primary checkout's WIP. The push is a
 * `HEAD:refs/heads/<target>` refspec rather than a bare `<target>` so it lands
 * the merge commit regardless of the worktree being detached.
 *
 * Conflict handling (the inner-agent resolver) is left to the caller — this
 * primitive surfaces a failed merge as `{ ok: false }` without pushing.
 */
export async function landMerge(exec: Exec, input: LandMergeInput): Promise<LandMergeResult> {
  const { repo, remote, branch, target, n, title, preMergeSha } = input;

  const merge = await exec([
    "git",
    "-C",
    repo,
    "merge",
    "--no-ff",
    // Bypass the consumer repo's commit-phase hooks (pre-merge-commit / commit-msg)
    // on AFK's merge commit (#840) — the merge lands in the isolated landing
    // worktree (#572) and AFK's binding validation already ran (feedback gate +
    // backpressure). post-commit still fires, so a continuous-push hook is intact.
    "--no-verify",
    branch,
    "-m",
    `merge: #${n} ${title}`,
  ]);
  if (merge.code !== 0) return { ok: false, rolledBack: false };

  const push = await exec(["git", "-C", repo, "push", remote, `HEAD:refs/heads/${target}`]);
  if (push.code !== 0) {
    // The worktree is disposable — the reset only rewinds the detached HEAD, it
    // never touches the primary checkout (issue #572).
    await exec(["git", "-C", repo, "reset", "--hard", preMergeSha]);
    return { ok: false, rolledBack: true };
  }

  return { ok: true, rolledBack: false };
}

/** Injected sleep between review-check polls. Tests pass a no-op so the wait
 * loop runs synchronously with no real timers. */
export type Sleep = (ms: number) => Promise<void>;

/**
 * Opt-in wait for an advisory review check to conclude before the admin-merge
 * (`afk.merge.wait_for_review`, ADR 0048). The review stays ADVISORY: AFK waits
 * for the named check to reach a terminal state, then merges regardless of its
 * verdict — `drift-guard` (the pre_merge hook) + in-process backpressure remain
 * the binding gates. Absent on {@link LandPrInput} → the merge proceeds
 * immediately (the default; current behaviour, now intentional).
 */
export interface WaitForReviewInput {
  /** Name (or substring, case-insensitive) of the review check to wait on, e.g. `CodeRabbit`. */
  check: string;
  /** Injected sleep between polls. */
  sleep: Sleep;
  /** Max poll attempts before proceeding fail-open. Default 30. */
  maxPolls?: number;
  /** Delay between polls, in ms. Default 10000. */
  intervalMs?: number;
}

/** Why {@link waitForReviewCheck} stopped waiting. All three proceed to merge —
 * the wait never blocks on the verdict (advisory). */
export type ReviewWaitOutcome = "concluded" | "absent" | "timeout";

interface PrCheck {
  name: string;
  state: string;
}

/** Parse `gh pr checks --json name,state` stdout. Tolerant: any parse failure
 * (non-JSON, partial output) yields an empty list so the caller polls again. */
function parsePrChecks(stdout: string): PrCheck[] {
  const text = stdout.trim();
  if (text === "") return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): PrCheck[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const name = (entry as { name?: unknown }).name;
      const state = (entry as { state?: unknown }).state;
      if (typeof name !== "string") return [];
      return [{ name, state: typeof state === "string" ? state : "" }];
    });
  } catch {
    return [];
  }
}

/** A gh check `state` is terminal once it leaves the pending family. gh
 * normalises in-flight runs to `PENDING`; everything else (SUCCESS, FAILURE,
 * SKIPPED, ERROR, …) has concluded. */
function isTerminalState(state: string): boolean {
  const s = state.trim().toUpperCase();
  return s !== "" && s !== "PENDING";
}

/**
 * Poll `gh pr checks <num>` until the configured review check reaches a terminal
 * state, the budget is exhausted, or the check never registers. Returns the
 * reason it stopped — but the caller proceeds to merge in every case: this waits
 * for *conclusion*, never gating on the verdict (the review is advisory, ADR
 * 0048). Fail-open by design — a missing/never-concluding reviewer must not wedge
 * the autonomous landing.
 */
export async function waitForReviewCheck(
  exec: Exec,
  repo: string,
  prNumber: number,
  input: WaitForReviewInput,
): Promise<ReviewWaitOutcome> {
  const maxPolls = input.maxPolls ?? 30;
  const intervalMs = input.intervalMs ?? 10_000;
  const needle = input.check.trim().toLowerCase();
  let everSeen = false;

  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const res = await exec(["gh", "-R", repo, "pr", "checks", String(prNumber), "--json", "name,state"]);
    const match = parsePrChecks(res.stdout).find((c) => c.name.toLowerCase().includes(needle));
    if (match !== undefined) {
      everSeen = true;
      if (isTerminalState(match.state)) return "concluded";
    }
    if (attempt + 1 < maxPolls) await input.sleep(intervalMs);
  }
  return everSeen ? "timeout" : "absent";
}

/** Inputs for the UNLOCKED landing path, {@link landPr}. */
export interface LandPrInput {
  /** `owner/repo` slug passed to `gh -R`. */
  repo: string;
  /** Repo dir passed to `git -C` for the local fast-forward (primary checkout). */
  gitRepo: string;
  /** Remote name (e.g. `origin`). */
  remote: string;
  /** Attempt branch (PR head, e.g. `afk/wBBBB/9-x`). */
  branch: string;
  /** Pinned target branch (PR base). */
  target: string;
  /** Issue number, for the PR title/body. */
  n: number;
  /** Issue title, for the PR title. */
  title: string;
  /** Worktree dir to force-push the attempt branch from; skipped when absent. */
  worktree?: string;
  /**
   * Opt-in advisory-review wait (`afk.merge.wait_for_review`, ADR 0048). When
   * present, the PR is held until the named review check concludes before the
   * admin-merge; the merge then proceeds regardless of the verdict. Absent (the
   * default) → admin-merge immediately, ignoring advisory checks.
   */
  waitForReview?: WaitForReviewInput;
}

export interface LandPrResult {
  ok: boolean;
  /** PR number that was admin-merged, when one resolved. */
  prNumber?: number;
}

const PR_BODY_PREFIX = "Automated AFK landing for #";

/**
 * UNLOCKED landing (ADR 0030): land the attempt via an admin-merged PR into
 * `<target>`. Steps mirror land_pr in afk.sh:
 *   1. force-push the attempt branch to `<remote>` (when a worktree is given);
 *   2. reuse an open PR for this head/base, else `gh pr create --base <target>
 *      --head <branch>`;
 *   3. `gh pr merge <num> --admin --merge`;
 *   4. fast-forward local `<target>` to the merge commit (best-effort) so HEAD
 *      carries the merge for the closing envelope.
 * Idempotent: a re-attempt reuses the open PR rather than creating a second.
 */
export async function landPr(exec: Exec, input: LandPrInput): Promise<LandPrResult> {
  const { repo, gitRepo, remote, branch, target, n, title, worktree, waitForReview } = input;

  // 1. Make the attempt branch's origin state certain before opening the PR.
  if (worktree) {
    const push = await exec([
      "git",
      "-C",
      worktree,
      "push",
      remote,
      `HEAD:refs/heads/${branch}`,
      "--force-with-lease",
    ]);
    if (push.code !== 0) return { ok: false };
  }

  // 2. Reuse an open PR for this head/base, else create one.
  const prNumber = await ensurePr(exec, { repo, branch, target, n, title });
  if (prNumber === undefined) return { ok: false };

  // 2b. Opt-in advisory-review wait (afk.merge.wait_for_review, ADR 0048). Hold
  // until the configured review check concludes, then fall through to merge
  // regardless of its verdict — the review is advisory; drift-guard (pre_merge)
  // + in-process backpressure stay the binding gates. Default (absent) → no wait.
  if (waitForReview) {
    await waitForReviewCheck(exec, repo, prNumber, waitForReview);
  }

  // 3. Admin-merge: the worker is autonomous, so bypass required-review checks.
  const merge = await exec(["gh", "-R", repo, "pr", "merge", String(prNumber), "--admin", "--merge"]);
  if (merge.code !== 0) return { ok: false, prNumber };

  // 4. Fast-forward local <target> to the merge commit (best-effort).
  await exec(["git", "-C", gitRepo, "fetch", remote, target, "--quiet"]);
  await exec(["git", "-C", gitRepo, "merge", "--ff-only", `${remote}/${target}`]);

  return { ok: true, prNumber };
}

/**
 * Reuse the open PR for this head/base, else `gh pr create`. Shared by the
 * admin-merge landing ({@link landPr}) and the review-gate handoff
 * ({@link openReviewPr}) so the PR title/body shape stays defined once.
 * `Closes #${n}` links the PR to the issue for GitHub's auto-close on merge.
 * Returns the PR number, or undefined when create failed / no PR resolved.
 */
async function ensurePr(
  exec: Exec,
  input: { repo: string; branch: string; target: string; n: number; title: string },
): Promise<number | undefined> {
  const { repo, branch, target, n, title } = input;
  let prNumber = await listOpenPr(exec, repo, branch, target);
  if (prNumber === undefined) {
    const create = await exec([
      "gh",
      "-R",
      repo,
      "pr",
      "create",
      "--base",
      target,
      "--head",
      branch,
      "--title",
      `merge: #${n} ${title}`,
      "--body",
      `${PR_BODY_PREFIX}${n}. Per-attempt history lives in the issue Envelopes, the JSONL logs, and the \`afk-attempts/*\` snapshot branches.\n\nCloses #${n}`,
    ]);
    if (create.code !== 0) return undefined;
    prNumber = await listOpenPr(exec, repo, branch, target);
  }
  return prNumber;
}

/** Inputs for the review-gate PR handoff, {@link openReviewPr}. */
export interface OpenReviewPrInput {
  /** `owner/repo` slug passed to `gh -R`. */
  repo: string;
  /** Attempt branch (PR head, already pushed to the remote). */
  branch: string;
  /** Pinned target branch (PR base). */
  target: string;
  /** Issue number, for the PR title/body. */
  n: number;
  /** Issue title, for the PR title. */
  title: string;
  /** Label that fires the advisory review (e.g. `ready-for-review`). */
  reviewLabel: string;
}

export interface OpenReviewPrResult {
  ok: boolean;
  /** PR number that was opened/reused and labelled, when one resolved. */
  prNumber?: number;
}

/**
 * Review-gate handoff for a NON-mechanical attempt (ADR 0064 §10, #749). Open (or
 * reuse) the PR for the attempt branch and apply `reviewLabel` — which fires the
 * advisory review from #746 — WITHOUT admin-merging. The caller then parks the
 * issue for the review→merge flow instead of fast-merging. Mirrors {@link landPr}
 * steps 1–2 but stops before the merge: the whole point is to hold the merge for
 * a fresh-agent review by a different agent than the one that implemented it.
 *
 * The branch must already be on the remote (the caller pushes it, exactly as the
 * landing path does). Idempotent: a re-attempt reuses the open PR and re-adds the
 * label (a no-op when already present).
 */
export async function openReviewPr(exec: Exec, input: OpenReviewPrInput): Promise<OpenReviewPrResult> {
  const { repo, branch, target, n, title, reviewLabel } = input;

  const prNumber = await ensurePr(exec, { repo, branch, target, n, title });
  if (prNumber === undefined) return { ok: false };

  const label = await exec(["gh", "-R", repo, "pr", "edit", String(prNumber), "--add-label", reviewLabel]);
  if (label.code !== 0) return { ok: false, prNumber };

  return { ok: true, prNumber };
}

/** Inputs for the one-shot merge-conflict self-resolver, {@link resolveMergeConflict}. */
export interface ResolveConflictInput {
  /** Dir passed to `git -C` — the isolated landing worktree where the merge
   * stalled (#572); also the cwd the resolver runner is dispatched in. */
  repo: string;
  /** Attempt branch whose `git merge --no-ff` left conflicts. */
  branch: string;
  /** Issue number, for the resolver prompt. */
  n: number;
  /** Issue title, for the resolver prompt. */
  title: string;
  /** Target branch the merge was into (e.g. `main`). */
  target: string;
}

/** Dispatch the configured runner against the landing checkout (`cwd`, the
 * isolated landing worktree #572) with the conflict resolver prompt. Best-effort
 * — a non-zero / thrown runner is swallowed, and the resolved-or-not verdict is
 * decided afterwards by inspecting git state. Injected so the resolver stays
 * testable over a fake. */
export type ConflictResolver = (prompt: string, cwd: string) => Promise<void>;

export interface ResolveConflictResult {
  /** True iff no unmerged paths remain AND the merge was committed (MERGE_HEAD
   * cleared). When false, the caller falls back to `git merge --abort`. */
  resolved: boolean;
  /** Reason the resolve was abandoned, for logging. */
  reason?: "unmerged-paths" | "uncommitted-merge";
}

/**
 * Build the resolver prompt. Mirrors the heredoc in merge_resolve_conflict:
 * a strict instruction set (resolve every conflict, `git add`, `git commit
 * --no-edit`, no branch switches / aborts / resets / pushes), with the
 * `git status` + truncated `git diff` appended as context.
 */
export function buildConflictPrompt(
  input: Pick<ResolveConflictInput, "branch" | "n" | "title" | "target">,
  status: string,
  diff: string,
): string {
  const { branch, n, title, target } = input;
  const truncatedDiff = diff.split("\n").slice(0, 400).join("\n");
  return [
    `You are an AFK merge-conflict resolver. A \`git merge --no-ff ${branch}\` into \`${target}\` for issue #${n} ("${title}") hit conflicts in THIS checkout. Resolve every conflict, then commit the merge.`,
    ``,
    `Rules:`,
    `- Work only in this checkout. Do NOT switch branches, \`git merge --abort\`, \`git reset\`, \`git rebase\`, or push.`,
    `- Resolve each conflicted file by hand, honouring both sides' intent, then \`git add\` it.`,
    `- When all conflicts are staged, run \`git commit --no-edit --no-verify\` to complete the merge (\`--no-verify\` bypasses the consumer repo's commit hooks, which AFK does not gate on). Do not change the merge message or introduce unrelated edits.`,
    `- When the merge is committed (or you have determined you cannot resolve it), emit \`<promise>DONE</promise>\` on a line by itself as your final output.`,
    ``,
    "`git status`:",
    status,
    ``,
    "`git diff` (truncated to 400 lines):",
    truncatedDiff,
  ].join("\n");
}

/**
 * One-shot inner-agent merge-conflict resolver (SKILL.md per-issue loop step 8,
 * merge_resolve_conflict). A `git merge --no-ff <branch>` into `<target>` has
 * left conflicts in the isolated landing worktree (`repo`, #572). Capture
 * `git status` + a truncated
 * `git diff`, dispatch the configured runner once with the resolver prompt, then
 * verify: the merge is resolved iff NO unmerged paths remain AND MERGE_HEAD has
 * cleared (the merge was committed). On either failure the caller runs
 * `git merge --abort` and flips the issue to ready-for-human.
 *
 * Pure modulo the two injected ports (`exec` for git reads, `resolve` for the
 * runner). The runner dispatch is best-effort: a thrown resolver still falls
 * through to the git-state verdict.
 */
export async function resolveMergeConflict(
  exec: Exec,
  resolve: ConflictResolver,
  input: ResolveConflictInput,
): Promise<ResolveConflictResult> {
  const { repo } = input;

  const statusRes = await exec(["git", "-C", repo, "status"]);
  const diffRes = await exec(["git", "-C", repo, "diff"]);
  // buildConflictPrompt truncates the diff to 400 lines.
  const prompt = buildConflictPrompt(input, statusRes.stdout, diffRes.stdout);

  try {
    await resolve(prompt, repo);
  } catch {
    // Best-effort: the git-state verdict below is the real gate.
  }

  const unmerged = await exec(["git", "-C", repo, "diff", "--name-only", "--diff-filter=U"]);
  if (unmerged.stdout.trim() !== "") {
    return { resolved: false, reason: "unmerged-paths" };
  }

  // `git rev-parse -q --verify MERGE_HEAD` exits 0 while a merge is pending.
  const mergeHead = await exec(["git", "-C", repo, "rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (mergeHead.code === 0) {
    return { resolved: false, reason: "uncommitted-merge" };
  }

  return { resolved: true };
}

/** Resolve the open PR number for `<branch>` → `<target>`, or undefined. */
async function listOpenPr(
  exec: Exec,
  repo: string,
  branch: string,
  target: string,
): Promise<number | undefined> {
  const res = await exec([
    "gh",
    "-R",
    repo,
    "pr",
    "list",
    "--head",
    branch,
    "--base",
    target,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ]);
  const text = res.stdout.trim();
  if (text === "") return undefined;
  const num = Number.parseInt(text, 10);
  return Number.isInteger(num) ? num : undefined;
}
