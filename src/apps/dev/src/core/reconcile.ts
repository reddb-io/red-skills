// reconcile — the NO-AGENT worker mode (ADR 0055).
//
// For an issue AFK *owns* — one carrying an `afk/{id}/{N}-*` worker branch that
// was parked under a MECHANICAL failure class (`blocked:stalled` /
// `blocked:crashed`, or, inline, a just-fired attempt-progress-guard timeout) —
// reconcile validates the pushed branch and lands it WITHOUT re-running the
// agent. The agent re-run stays recovery.ts; this is the cheaper path that
// catches the common case where the agent finished the work but stalled / exited
// before a final non-committing step, so a complete-and-green branch was left
// parked.
//
// The flow mirrors the DONE path's tail, composing the SAME building blocks — no
// new merge code:
//   1. guard      — mechanical class only (never blocked:spec / a non-mechanical
//                    active `## Current blocker`).
//   2. fetch gate — branchPresent() fetches origin-only branches before the diff.
//   3. commits gate — the branch must carry work (changedFiles vs base).
//   4. runFeedback — the scoped gate is the verdict, the SAME authority the DONE
//                    path trusts.
//   4a. green     → doLanding (landing.ts) + close + drop blocked:*/ready-for-human.
//   4b. red       → ready-for-human with the REAL failing checks (blocked:validation).
//
// PURE SEQUENCING over injected IO: every git/gh/pnpm/fs touch is a port, so the
// whole decision tree is unit-testable with zero subprocesses. `ReconcileDeps`
// is a structural SUBSET of `ProcessIssueDeps`, so process-issue's terminal path
// passes its own `deps` (plus the landing `fireHook`) straight through.

import {
  relevantScopes,
  runFeedback,
  type Exec as PnpmExec,
  type FeedbackCheck,
  type PackageLayout,
  type RunFeedbackResult,
} from "./feedback.js";
import { doLanding } from "./landing.js";
import { type ConflictResolver, type Exec as MergeExec, type WaitForReviewInput } from "./merge.js";
import {
  buildRefFromSlug,
  deleteRemote,
  slugifyRef,
  type GitExec,
} from "./remote-branch.js";
import { emitEnvelope, type EmitEnvelopeDeps } from "./envelope-emit.js";
import { parseCurrentBlocker } from "./blocker-state.js";
import { parseReqLabels, planCloseCascade, type DependentIssue } from "./boot-sweep.js";
import { buildAttemptRecordPayload, type AttemptRecordPayload } from "./attempt-record.js";
import type { HistoryClock } from "./history.js";
import type { Runner } from "../types/runner.js";

const LABEL_READY = "ready-for-agent";
const LABEL_RUNNING = "running";
const LABEL_HUMAN = "ready-for-human";
const LABEL_VALIDATION = "blocked:validation";

/**
 * The blocked-failure classes reconcile is allowed to act on: MECHANICAL ones
 * that a fresh validate-and-land can clear without a human decision. A stalled or
 * crashed (or merge-conflict) branch may simply carry complete, green work; a
 * `spec` / `validation` / `dependency` block needs a human to change something,
 * so reconcile never auto-lands those.
 */
const MECHANICAL_BLOCKER_KINDS = new Set(["stalled", "crashed", "merge-conflict"]);

/**
 * Labels that DISQUALIFY an issue from reconcile outright — the human-decision
 * blocked classes. `blocked:spec` is the boundary the ADR calls out explicitly;
 * `blocked:validation` means a prior gate already failed for a reason a human
 * must resolve, so re-running the same gate is pointless.
 */
const NON_MECHANICAL_LABELS = ["blocked:spec", LABEL_VALIDATION];

// ---------- injected IO ----------

/** gh side effects reconcile drives — a strict subset of process-issue's `ProcessGh`. */
export interface ReconcileGh {
  /** gh issue edit --remove-label … --add-label … (returns false on failure). */
  editLabels(issue: number, remove: string[], add: string[]): Promise<boolean>;
  /** Idempotently create a label on the fly (best-effort). */
  ensureLabel(name: string): Promise<void>;
  /** gh issue comment --body … */
  comment(issue: number, body: string): Promise<void>;
  /** gh issue close --reason completed. */
  close(issue: number): Promise<void>;
  /** List open issues carrying `label` — backs the close cascade's dependent lookup. */
  listByLabel(label: string): Promise<{ number: number; labels: string[] }[]>;
  /** Resolve whether issue `n` is CLOSED (a transient failure resolves to false). */
  issueClosed(n: number): Promise<boolean>;
}

/** git reads/cleanup reconcile needs beyond the merge/remote primitives. */
export interface ReconcileGit {
  /** git -C primary rev-parse --short HEAD after a successful merge. */
  headShortSha(): Promise<string>;
  /** git -C primary branch -d <branch> after landing (best-effort). */
  deleteLocalBranch(branch: string): Promise<void>;
}

/** filesystem side effects: completion sweep + the optional validation sidecar. */
export interface ReconcileFs {
  /** Remove every attempt dir for a completed issue (completion_sweep_issue). */
  completionSweep(issue: number): Promise<string[]>;
  /** Write the machine-readable validation sidecar (best-effort; optional). */
  writeValidationSidecar?(path: string, lines: string[]): Promise<void>;
}

/** Injected lookups: the branch's changed files + host presence + lock state. */
export interface ReconcileLookups {
  /** Changed files of the worker branch vs the base, for feedback scope resolution. */
  changedFiles(branch: string, base: string): Promise<string[]>;
  /** Confirm the worker branch actually reached the host (optional → assume present). */
  branchPresent?(branch: string): Promise<boolean>;
  /** True when the session is locked to a branch — drives the landing toggle. */
  isLocked(): Promise<boolean>;
}

/**
 * All injected IO for one reconcile. Deliberately a structural SUBSET of
 * `ProcessIssueDeps` (same nested member shapes) so process-issue can pass its
 * own `deps` (augmented with the landing `fireHook`) directly. Tests build a
 * minimal object matching exactly this interface.
 */
export interface ReconcileDeps {
  gh: ReconcileGh;
  git: ReconcileGit;
  fs: ReconcileFs;
  lookups: ReconcileLookups;
  /** git executor for merge.ts (integrateOrigin / landMerge / landPr). */
  mergeExec: MergeExec;
  /** git executor for remote-branch.ts (pushAttempt / deleteRemote). */
  remoteGit: GitExec;
  /** pnpm executor for the feedback gate. */
  pnpm: PnpmExec;
  /** Package layout probe for feedback scope resolution. */
  layout: PackageLayout;
  /** One-shot inner-agent merge-conflict resolver for the LOCKED land (optional). */
  conflictResolver?: ConflictResolver;
  /**
   * Isolated landing-worktree provisioner/teardown for the LOCKED land (#572):
   * the locked merge/push/rollback runs in a throwaway worktree, never the
   * primary checkout. Threaded from process-issue's deps; absent → the locked
   * land is refused rather than mutating the primary.
   */
  makeLandingWorktree?(base: string): Promise<string | null>;
  removeLandingWorktree?(dir: string): Promise<void>;
  /** Opt-in advisory-review wait for the UNLOCKED admin-PR landing (optional). */
  waitForReview?: WaitForReviewInput;
  /** Envelope-emit IO (poster / marker writer / posted writer / git push). */
  envelope: EmitEnvelopeDeps;
  /**
   * Fire a landing lifecycle hook (pre_merge / post_merge), threaded from
   * process-issue's dispatcher so reconcile lands with the SAME hooks the DONE
   * path fires. Optional → when absent the landing runs with no merge hooks.
   */
  fireHook?(name: "pre_merge" | "post_merge", context: string): Promise<boolean>;
  /** Clock: epoch seconds. */
  nowEpoch(): number;
  /** Append one plain line to the iteration's afk.log. */
  appendIterLog(line: string): void;
  /** AFK→Memory reasoning-attempt recording (best-effort; optional). */
  recordAttempt?(payload: AttemptRecordPayload): Promise<void>;
  /** History ledger path + clock for the terminal envelope (optional). */
  historyPath?: string;
  historyClock?: HistoryClock;
}

/** Static per-reconcile inputs the caller resolves before `reconcile`. */
export interface ReconcileInput {
  issue: number;
  title: string;
  body: string;
  /** The issue's CURRENT label set (routing + blocked + domain labels). */
  labels: string[];
  /** The worker branch to validate-and-land (`afk/{id}/{N}-{slug}`). */
  branch: string;
  /** Resolved base branch (lock > pin > main). */
  base: string;
  repo: string;
  repoDir: string;
  remote: string;
  workerId: string;
  attempt: number;
  attemptDir: string;
  runner: Runner;
}

// ---------- result ----------

export type ReconcileSkipReason = "not-mechanical" | "active-blocker" | "no-commits" | "branch-absent" | "already-closed";

export type ReconcileResult =
  | { outcome: "landed"; mergeSha: string; locked: boolean; posted: boolean }
  | { outcome: "parked"; reason: "feedback-failed" | "merge-conflict"; posted: boolean }
  | { outcome: "skipped"; reason: ReconcileSkipReason };

// ---------- the orchestration ----------

/**
 * Validate a parked-or-just-stalled worker branch and land it WITHOUT re-running
 * the agent (ADR 0055). Returns:
 *   - `landed`  — the scoped gate passed and the branch merged + the issue closed.
 *   - `parked`  — the gate (or the land) failed; routed to ready-for-human with
 *                 the real failing checks.
 *   - `skipped` — the issue is not a mechanical reconcile candidate, or the branch
 *                 carries no work; the caller proceeds with its own routing.
 */
export async function reconcile(deps: ReconcileDeps, input: ReconcileInput): Promise<ReconcileResult> {
  const { issue, branch, base, labels, body } = input;

  // ---- 1. guard: mechanical class only ----
  const disqualifier = mechanicalDisqualifier(labels, body);
  if (disqualifier) {
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: skipped (${disqualifier}) — not a mechanical reconcile candidate; leaving routing to the caller.`,
    );
    return { outcome: "skipped", reason: disqualifier };
  }

  // ---- 2. fetch gate: materialize origin-only branches before the commits diff ----
  // branchPresent() fetches from origin on a local miss, so a branch force-pushed
  // by a now-dead worker (present on origin, absent locally) is available for the
  // three-dot diff below. Without this fetch, changedFiles() would silently return
  // [] for the missing ref, triggering a false skipped:no-commits.
  if (deps.lookups.branchPresent && !(await deps.lookups.branchPresent(branch))) {
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: skipped (branch-absent) — \`${branch}\` is not present on the host; cannot validate.`,
    );
    return { outcome: "skipped", reason: "branch-absent" };
  }

  // ---- 3. commits gate: the branch must carry work ----
  // changedFiles() is a three-dot diff that returns [] for an EMPTY branch.
  // The fetch gate above guarantees the branch is local, so [] here means
  // genuinely no commits — not a missing ref.
  const changedFiles = await deps.lookups.changedFiles(branch, base);
  if (changedFiles.length === 0) {
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: skipped (no-commits) — \`${branch}\` carries no work vs \`${base}\`.`,
    );
    return { outcome: "skipped", reason: "no-commits" };
  }

  // ---- 4. feedback gate (the verdict — SAME authority as the DONE path) ----
  const startedEpoch = deps.nowEpoch();
  const feedback: RunFeedbackResult = await runFeedback(deps.pnpm, {
    worktree: branch,
    scopes: relevantScopes(deps.layout, changedFiles),
    layout: deps.layout,
    now: deps.nowEpoch,
  });
  await writeValidationSidecar(deps, input.attemptDir, feedback.sidecar);

  // ---- 4b. RED → ready-for-human with the real failing checks ----
  if (!feedback.ok) {
    return await park(deps, input, feedback, startedEpoch);
  }

  // ---- 4a-pre. re-verify the issue is still open immediately before landing ----
  // The candidate list and the claim window can go stale between selection and
  // here: a concurrent worker or a human may have closed the issue. Landing +
  // closing an already-closed issue churns labels on a closed thread (#568), so
  // bail before doLanding when it is no longer open.
  if (await deps.gh.issueClosed(issue)) {
    deps.appendIterLog(
      `🤖 /afk reconcile #${issue}: skipped (already-closed) — issue closed since selection; not landing.`,
    );
    return { outcome: "skipped", reason: "already-closed" };
  }

  // ---- 4a. GREEN → land via the existing landing path, then close ----
  const locked = await deps.lookups.isLocked();
  const landing = await doLanding(
    {
      mergeExec: deps.mergeExec,
      remoteGit: deps.remoteGit,
      fireHook: deps.fireHook ?? (async () => true),
      conflictResolver: deps.conflictResolver,
      waitForReview: deps.waitForReview,
      makeLandingWorktree: deps.makeLandingWorktree,
      removeLandingWorktree: deps.removeLandingWorktree,
    },
    {
      locked,
      repo: input.repo,
      repoDir: input.repoDir,
      remote: input.remote,
      branch,
      base,
      issue,
      title: input.title,
    },
    {
      preMerge: () => landingHookContext(input, branch),
      postMerge: () => landingHookContext(input, branch),
    },
  );
  if (!landing.ok) {
    // The land path's own gates (drift-guard + integrate/rebase) rejected the
    // branch — park it as a merge conflict, exactly like the DONE path does.
    return await parkMergeConflict(deps, input, landing.reason, startedEpoch);
  }

  // ---- close: done envelope → gh close + drop routing/blocked labels → cleanup ----
  // Prefer the sha doLanding captured (the locked landing runs in an isolated
  // worktree, #572, so the primary HEAD no longer advances); fall back to the
  // primary HEAD for the unlocked path.
  const mergeSha = landing.mergeSha ?? (await deps.git.headShortSha());
  const durationS = deps.nowEpoch() - startedEpoch;
  const posted = await emitDone(deps, input, mergeSha, durationS, feedback.sidecar);
  await recordAttemptBestEffort(deps, input, "done", { durationS, mergeSha, validationSummary: feedback.sidecar.join("\n") });
  await deps.gh.close(issue);
  await deps.gh.editLabels(issue, landDropLabels(labels), []);
  await deleteRemote(deps.remoteGit, input.repoDir, branch);
  await deps.git.deleteLocalBranch(branch);
  await deps.fs.completionSweep(issue);
  await runCloseCascade(deps, issue);
  deps.appendIterLog(
    `🤖 /afk reconcile #${issue}: \`${branch}\` validated green and landed without re-running the agent (merge \`${mergeSha}\`).`,
  );
  return { outcome: "landed", mergeSha, locked, posted };
}

// ---------- guard ----------

/**
 * The reason an issue is NOT a mechanical reconcile candidate, or null when it
 * is. Disqualified when it carries a human-decision blocked label
 * (`blocked:spec` / `blocked:validation`), or an ACTIVE `## Current blocker`
 * whose kind is not mechanical (stalled / crashed / merge-conflict). A stalled /
 * crashed blocker is mechanical and therefore allowed — it is exactly the parked
 * state reconcile exists to clear.
 */
export function mechanicalDisqualifier(labels: string[], body: string): "not-mechanical" | "active-blocker" | null {
  if (labels.some((l) => NON_MECHANICAL_LABELS.includes(l))) return "not-mechanical";
  const blocker = parseCurrentBlocker(body);
  if (blocker && !MECHANICAL_BLOCKER_KINDS.has(blocker.kind)) return "active-blocker";
  return null;
}

/** Routing/blocked labels to shed on a successful land — domain labels (type:,
 * priority:, slice:, req:) are left untouched. */
function landDropLabels(labels: string[]): string[] {
  return labels.filter(
    (l) => l === LABEL_RUNNING || l === LABEL_HUMAN || l === LABEL_READY || l.startsWith("blocked:"),
  );
}

// ---------- red / merge-conflict parking ----------

/**
 * RED gate → ready-for-human carrying the REAL failing checks. Sheds any
 * mechanical `blocked:*` reason + the routing labels, adds
 * `ready-for-human` + `blocked:validation` (the now-known reason), comments the
 * failing-check summaries, and emits the feedback failure envelope.
 */
async function park(
  deps: ReconcileDeps,
  input: ReconcileInput,
  feedback: RunFeedbackResult,
  startedEpoch: number,
): Promise<ReconcileResult> {
  const { issue, labels } = input;
  const failed = feedback.checks.filter((c) => c.status === "failed");
  await deps.gh.ensureLabel(LABEL_VALIDATION);
  await deps.gh.editLabels(issue, parkDropLabels(labels), [LABEL_HUMAN, LABEL_VALIDATION]);
  await deps.gh.comment(
    issue,
    `🤖 /afk reconcile validated parked branch \`${input.branch}\` WITHOUT re-running the agent — validation FAILED, so it was not landed:\n${formatFailingChecks(failed)}`,
  );
  const validationSummary = feedback.sidecar.join("\n");
  const posted = await emitFailure(deps, input, "blocked", startedEpoch, {
    validation: validationSummary,
  });
  await recordAttemptBestEffort(deps, input, "feedback-failed", {
    durationS: deps.nowEpoch() - startedEpoch,
    notes: "Reconcile re-validated a parked branch; the scoped gate failed, so it was not landed.",
    validationSummary,
  });
  deps.appendIterLog(
    `🤖 /afk reconcile #${issue}: \`${input.branch}\` failed re-validation — parked to ready-for-human with the failing checks.`,
  );
  return { outcome: "parked", reason: "feedback-failed", posted };
}

/** The land path rejected the branch (integrate/rebase/drift) → park as a merge
 * conflict, mirroring the DONE path's merge-failed terminal. */
async function parkMergeConflict(
  deps: ReconcileDeps,
  input: ReconcileInput,
  reason: string,
  startedEpoch: number,
): Promise<ReconcileResult> {
  const { issue, labels } = input;
  await deps.gh.ensureLabel("blocked:merge-conflict");
  await deps.gh.editLabels(issue, parkDropLabels(labels), [LABEL_HUMAN, "blocked:merge-conflict"]);
  const posted = await emitFailure(deps, input, "merge-conflict", startedEpoch, {
    log: `reconcile land failed: ${reason}`,
  });
  await recordAttemptBestEffort(deps, input, "merge-conflict", {
    durationS: deps.nowEpoch() - startedEpoch,
    notes: `Reconcile validated the branch green but the land failed (${reason}).`,
  });
  deps.appendIterLog(
    `🤖 /afk reconcile #${issue}: \`${input.branch}\` validated green but the land failed (${reason}) — parked to ready-for-human.`,
  );
  return { outcome: "parked", reason: "merge-conflict", posted };
}

/** Routing/blocked labels to shed when parking — keeps `blocked:validation`
 * (re-added below) and domain labels; drops `running`/`ready-for-agent` + the
 * mechanical blocked reasons that no longer describe the state. */
function parkDropLabels(labels: string[]): string[] {
  return labels.filter(
    (l) =>
      l === LABEL_RUNNING ||
      l === LABEL_READY ||
      (l.startsWith("blocked:") && l !== LABEL_VALIDATION && l !== "blocked:merge-conflict"),
  );
}

function formatFailingChecks(failed: FeedbackCheck[]): string {
  if (failed.length === 0) return "- (no per-check detail captured)";
  return failed.map((c) => `- \`${c.name}\`: ${c.record.summary ?? "command exited non-zero"}`).join("\n");
}

// ---------- envelope emission (reused from envelope-emit) ----------

async function emitDone(
  deps: ReconcileDeps,
  input: ReconcileInput,
  mergeSha: string,
  durationS: number,
  validationSidecar: string[],
): Promise<boolean> {
  const result = await emitEnvelope(deps.envelope, {
    status: "done",
    issue: input.issue,
    worker: input.workerId,
    durationS,
    branch: input.branch,
    attempt: input.attempt,
    mergeSha,
    diff: "merged",
    sections: { validation: validationSidecar.join("\n") },
    historyPath: deps.historyPath,
    historyClock: deps.historyClock,
    historyFields: { runner: input.runner, merge_sha: mergeSha },
  });
  return result.posted;
}

async function emitFailure(
  deps: ReconcileDeps,
  input: ReconcileInput,
  status: "blocked" | "merge-conflict",
  startedEpoch: number,
  sections: { validation?: string; log?: string },
): Promise<boolean> {
  const remoteName = buildRefFromSlug("afk-attempts", input.workerId, input.issue, slugifyRef(input.title)) ?? "";
  const result = await emitEnvelope(deps.envelope, {
    status,
    issue: input.issue,
    worker: input.workerId,
    durationS: deps.nowEpoch() - startedEpoch,
    branch: input.branch,
    attempt: input.attempt,
    diff: "not-landed",
    remoteName,
    repo: input.repo,
    repoDir: input.repoDir,
    worktreeRel: input.attemptDir,
    diffstat: "",
    sections,
    historyPath: deps.historyPath,
    historyClock: deps.historyClock,
    historyFields: { runner: input.runner },
  });
  return result.posted;
}

// ---------- AFK→Memory reasoning-attempt recording (best-effort) ----------

async function recordAttemptBestEffort(
  deps: ReconcileDeps,
  input: ReconcileInput,
  outcome: string,
  fields: { durationS?: number; mergeSha?: string; notes?: string; validationSummary?: string },
): Promise<void> {
  if (!deps.recordAttempt) return;
  try {
    await deps.recordAttempt(
      buildAttemptRecordPayload({
        repo: input.repo,
        issue: input.issue,
        attempt: input.attempt,
        outcome,
        title: input.title,
        body: input.body,
        workerId: input.workerId,
        branch: input.branch,
        durationS: fields.durationS,
        mergeSha: fields.mergeSha,
        notes: fields.notes,
        validationSummary: fields.validationSummary,
      }),
    );
  } catch (err) {
    deps.appendIterLog(
      `🤖 /afk reconcile memory attempt-record for #${input.issue} failed (best-effort; ignored): ${String(err)}`,
    );
  }
}

// ---------- validation sidecar ----------

async function writeValidationSidecar(deps: ReconcileDeps, attemptDir: string, lines: string[]): Promise<void> {
  if (!deps.fs.writeValidationSidecar) return;
  if (lines.length === 0) return;
  try {
    await deps.fs.writeValidationSidecar(`${attemptDir}/validation.jsonl`, lines);
  } catch {
    // best-effort: the sidecar is a Memory optimisation; never fail the reconcile.
  }
}

// ---------- close cascade (event-driven auto-unblock) ----------

/**
 * Re-evaluate the dependents of a just-closed issue and promote any whose
 * `req:*` dependencies are now ALL closed. The SAME cascade process-issue runs on
 * its DONE close — composed from boot-sweep's pure planner — so a reconcile-landed
 * issue unblocks its dependents exactly like an agent-landed one. Entirely
 * best-effort: any gh failure is swallowed (the boot Unblock Sweep is the net).
 */
async function runCloseCascade(deps: ReconcileDeps, closedIssue: number): Promise<void> {
  try {
    const dependentsRaw = await deps.gh.listByLabel(`req:${closedIssue}`);
    if (dependentsRaw.length === 0) return;

    const closedCache = new Map<number, boolean>([[closedIssue, true]]);
    const resolveClosed = async (n: number): Promise<boolean> => {
      const cached = closedCache.get(n);
      if (cached !== undefined) return cached;
      const closed = await deps.gh.issueClosed(n);
      closedCache.set(n, closed);
      return closed;
    };

    const dependents: DependentIssue[] = [];
    for (const dep of dependentsRaw) {
      const reqIds = parseReqLabels(dep.labels);
      const reqs: { n: number; closed: boolean }[] = [];
      for (const n of reqIds) reqs.push({ n, closed: await resolveClosed(n) });
      dependents.push({ number: dep.number, reqs });
    }

    for (const p of planCloseCascade(closedIssue, dependents)) {
      await deps.gh.editLabels(p.number, ["blocked:dependency"], [LABEL_READY]);
      await deps.gh.comment(p.number, p.comment);
    }
  } catch (err) {
    deps.appendIterLog(
      `🤖 /afk reconcile close-cascade for #${closedIssue} failed (best-effort; boot sweep will retry): ${String(err)}`,
    );
  }
}

// ---------- hook context ----------

/** The pre_merge / post_merge hook context JSON, matching process-issue's shape. */
function landingHookContext(input: ReconcileInput, branch: string): string {
  return JSON.stringify({
    issue: { number: input.issue, title: input.title },
    workspace: input.repoDir,
    branch,
  });
}
