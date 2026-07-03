// merge-conflict-reconcile — the NO-AGENT auto-reconcile route for a
// `blocked:merge-conflict` park (issue #1095, extends ADR 0055).
//
// Today a trunk conflict at land time (`reconcile land failed: pr-conflict`)
// AFTER a worker already validated its fix green parks the issue
// `blocked:merge-conflict` + `ready-for-human`, and recovery is a hand-rolled
// finish-from-branch that re-runs the FULL CI cold and resolves conflicts by
// hand. This module professionalises that: it routes the park back into the
// no-agent lane —
//   1. rebase the parked worker branch onto FRESH `origin/<trunk>`;
//   2. auto-resolve ONLY conflicts on the CLOSED mechanical allowlist
//      (shared-gate `MECHANICAL_KINDS`, intent-by-default, no catch-all);
//   3. reland trusting the PRIOR green validation — NEVER re-running the full
//      local build/suite; the opened PR's CI gates the merge.
// A conflict that is genuinely semantic — or mechanical-looking but OUTSIDE the
// closed allowlist — parks to `ready-for-human` unchanged.
//
// PURE SEQUENCING over injected IO, mirroring reconcile.ts / merge.ts: every
// git / gh / resolve touch is a port, so the whole decision tree is
// unit-testable with zero subprocesses. The real ports (rebase-in-worktree,
// mechanical-resolve, reland-via-PR) are wired at the call site.

import { classifyFinding, type GateFinding, type MechanicalKind } from "./shared-gate.js";

// ---------- conflict-content analyzer ----------
//
// Infers a mechanical KIND for a conflicted file so the orchestrator can decide,
// via the closed allowlist, whether it is safe to auto-resolve. CONSERVATIVE by
// construction: it recognises only conflicts whose two sides are provably
// equivalent, and defaults everything else to a non-mechanical `"semantic"` kind
// (→ park). Broadening the recognised classes (lockfile regen, append-only
// changelog union, import-ordering) is deliberate follow-up.

const CONFLICT_START = "<<<<<<<";
const CONFLICT_MID = "=======";
const CONFLICT_END = ">>>>>>>";

/** One conflicted hunk extracted from a file carrying git conflict markers: the
 * two competing versions (`ours` above `=======`, `theirs` below). */
export interface ConflictHunk {
  ours: string[];
  theirs: string[];
}

/**
 * Parse the conflict hunks out of a file body carrying `<<<<<<<` / `=======` /
 * `>>>>>>>` markers. Tolerant: an unterminated hunk (no closing `>>>>>>>`) is
 * dropped rather than throwing. Returns [] when the body has no conflict
 * markers. PURE.
 */
export function parseConflictHunks(body: string): ConflictHunk[] {
  const lines = body.split("\n");
  const hunks: ConflictHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith(CONFLICT_START)) {
      i++;
      continue;
    }
    const ours: string[] = [];
    const theirs: string[] = [];
    i++;
    let sawMid = false;
    let closed = false;
    for (; i < lines.length; i++) {
      if (lines[i].startsWith(CONFLICT_MID)) {
        sawMid = true;
        continue;
      }
      if (lines[i].startsWith(CONFLICT_END)) {
        i++;
        closed = true;
        break;
      }
      (sawMid ? theirs : ours).push(lines[i]);
    }
    if (closed) hunks.push({ ours, theirs });
  }
  return hunks;
}

/** True when the two sides are identical after stripping trailing whitespace on
 * every line AND ignoring trailing blank lines — a whitespace-only conflict that
 * resolves safely to either side. PURE. */
function whitespaceEquivalent(ours: readonly string[], theirs: readonly string[]): boolean {
  const norm = (ls: readonly string[]): string[] => {
    const trimmed = ls.map((l) => l.replace(/\s+$/, ""));
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
    return trimmed;
  };
  const a = norm(ours);
  const b = norm(theirs);
  if (a.length !== b.length) return false;
  return a.every((l, idx) => l === b[idx]);
}

/**
 * Infer the mechanical KIND of a single conflict hunk, or null when it is not
 * safely mechanical (→ intent). Recognises WHITESPACE-ONLY conflicts today. PURE.
 */
export function classifyConflictHunk(hunk: ConflictHunk): MechanicalKind | null {
  if (whitespaceEquivalent(hunk.ours, hunk.theirs)) return "trailing-whitespace";
  return null;
}

/**
 * Infer the KIND of a whole conflicted file body. A file is mechanical only when
 * it carries at least one conflict hunk AND every hunk is mechanical; the shared
 * kind is returned. Any non-mechanical (or unparseable) hunk yields `"semantic"`
 * — the conservative, non-allowlisted default. PURE.
 */
export function classifyConflictedFileKind(body: string): string {
  const hunks = parseConflictHunks(body);
  if (hunks.length === 0) return "semantic";
  let kind: MechanicalKind | null = null;
  for (const h of hunks) {
    const k = classifyConflictHunk(h);
    if (k === null) return "semantic";
    kind = k;
  }
  return kind ?? "semantic";
}

// ---------- findings ----------

/**
 * One conflicted region surfaced by the rebase, tagged with the mechanical
 * KIND an analyzer inferred for it. Extends the shared {@link GateFinding} shape
 * so the SAME closed allowlist (`MECHANICAL_KINDS`) classifies it — a merge
 * conflict is mechanical for exactly the reasons a gate finding is. `path` is
 * the conflicted file, carried for the park comment / audit trail.
 */
export interface ConflictFinding extends GateFinding {
  /** The conflicted file path (relative to the repo root). */
  path: string;
}

/**
 * Split conflict findings by the closed mechanical allowlist. A finding whose
 * `kind` is on the allowlist is mechanical (auto-resolvable); everything else is
 * INTENT by default — no catch-all. PURE.
 */
export function partitionConflicts(
  findings: readonly ConflictFinding[],
): { mechanical: ConflictFinding[]; nonMechanical: ConflictFinding[] } {
  const mechanical: ConflictFinding[] = [];
  const nonMechanical: ConflictFinding[] = [];
  for (const f of findings) {
    if (classifyFinding(f) === "mechanical") mechanical.push(f);
    else nonMechanical.push(f);
  }
  return { mechanical, nonMechanical };
}

// ---------- injected IO ----------

/** The outcome of rebasing the parked worker branch onto fresh `origin/<trunk>`. */
export type RebaseOutcome =
  | { status: "clean" }
  | { status: "conflicted"; findings: ConflictFinding[] }
  | { status: "error"; detail: string };

/** Why a {@link MergeConflictReconcileDeps.reland} did not land the branch. */
export type RelandOutcome = { ok: true } | { ok: false; reason: string };

/** Why the auto-reconcile route parked the issue to `ready-for-human`. */
export type MergeConflictParkReason =
  // At least one conflict is OUTSIDE the closed mechanical allowlist — it needs
  // a human (genuinely semantic, or a mechanical-looking kind not on the list).
  | "semantic-conflict"
  // Every conflict was mechanical, but applying the resolution / continuing the
  // rebase failed — bail rather than land a half-resolved tree.
  | "resolution-failed"
  // The rebase clean/resolved, but the reland (force-push / open PR) failed.
  | "reland-failed"
  // The rebase could not even run (fetch / worktree setup failure).
  | "rebase-error";

/** All injected IO for one auto-reconcile. */
export interface MergeConflictReconcileDeps {
  /**
   * Fetch fresh `origin/<trunk>` and rebase the parked worker branch onto it in
   * an ISOLATED worktree (never the primary checkout). Returns the classified
   * conflict findings when the rebase stops on conflict, `clean` when it applied
   * with no conflicts, or `error` when it could not run at all.
   */
  rebaseOntoTrunk(): Promise<RebaseOutcome>;
  /**
   * Apply the resolution for every (already-classified mechanical) finding,
   * `git add` each, and `git rebase --continue`. Returns false when the
   * resolution or the continue failed — the caller then aborts + parks.
   */
  resolveMechanical(findings: ConflictFinding[]): Promise<boolean>;
  /** `git rebase --abort` — leaves the parked branch exactly as it was. */
  abortRebase(): Promise<void>;
  /**
   * Force-push the rebased branch and open/merge its PR, trusting the PRIOR
   * green validation — NO local suite is re-run here; the PR's CI gates the
   * merge. Returns whether the reland succeeded.
   */
  reland(): Promise<RelandOutcome>;
  /** Park to `ready-for-human` with the reason + the conflict audit. */
  park(reason: MergeConflictParkReason, findings: ConflictFinding[]): Promise<void>;
  /** Append one plain line to the iteration's afk.log. */
  appendIterLog(line: string): void;
}

// ---------- result ----------

export type MergeConflictReconcileResult =
  | { outcome: "relanded" }
  | { outcome: "parked"; reason: MergeConflictParkReason };

// ---------- the orchestration ----------

/**
 * Rebase a `blocked:merge-conflict`-parked worker branch onto fresh trunk,
 * auto-resolve ONLY mechanical conflicts, and reland trusting the prior green
 * validation (issue #1095). Decision tree:
 *   - rebase clean            → reland.
 *   - rebase conflicted, ALL mechanical → resolveMechanical → reland (or park
 *                               `resolution-failed` when the resolve/continue
 *                               failed).
 *   - rebase conflicted, ANY non-mechanical (or no classifiable findings)
 *                             → abort + park `semantic-conflict`.
 *   - rebase error            → park `rebase-error` (no abort — nothing started).
 *   - reland failed           → park `reland-failed`.
 */
export async function reconcileMergeConflict(
  deps: MergeConflictReconcileDeps,
): Promise<MergeConflictReconcileResult> {
  const rebase = await deps.rebaseOntoTrunk();

  if (rebase.status === "error") {
    await deps.park("rebase-error", []);
    deps.appendIterLog(
      `🤖 /afk merge-conflict reconcile: rebase onto fresh trunk could not run (${rebase.detail}) — parked to ready-for-human.`,
    );
    return { outcome: "parked", reason: "rebase-error" };
  }

  if (rebase.status === "conflicted") {
    const { mechanical, nonMechanical } = partitionConflicts(rebase.findings);

    // A conflict with NO classifiable findings cannot be proven safe → treat as
    // semantic (the conservative default the closed allowlist enforces).
    if (nonMechanical.length > 0 || rebase.findings.length === 0) {
      await deps.abortRebase();
      await deps.park("semantic-conflict", nonMechanical);
      deps.appendIterLog(
        `🤖 /afk merge-conflict reconcile: ${nonMechanical.length || "un-classifiable"} conflict(s) outside the mechanical allowlist — aborted the rebase and parked to ready-for-human.`,
      );
      return { outcome: "parked", reason: "semantic-conflict" };
    }

    // Every conflict is on the closed mechanical allowlist → auto-resolve.
    const resolved = await deps.resolveMechanical(mechanical);
    if (!resolved) {
      await deps.abortRebase();
      await deps.park("resolution-failed", mechanical);
      deps.appendIterLog(
        `🤖 /afk merge-conflict reconcile: mechanical resolution of ${mechanical.length} conflict(s) failed — aborted the rebase and parked to ready-for-human.`,
      );
      return { outcome: "parked", reason: "resolution-failed" };
    }
    deps.appendIterLog(
      `🤖 /afk merge-conflict reconcile: auto-resolved ${mechanical.length} mechanical conflict(s) on the closed allowlist — relanding trusting the prior green validation.`,
    );
  }

  // Clean rebase OR all-mechanical resolved → reland trusting prior green. The
  // opened PR's CI is the merge gate; the local suite is NOT re-run.
  const relanded = await deps.reland();
  if (!relanded.ok) {
    await deps.park("reland-failed", []);
    deps.appendIterLog(
      `🤖 /afk merge-conflict reconcile: rebase succeeded but the reland failed (${relanded.reason}) — parked to ready-for-human.`,
    );
    return { outcome: "parked", reason: "reland-failed" };
  }
  deps.appendIterLog(
    `🤖 /afk merge-conflict reconcile: rebased onto fresh trunk and relanded without re-running the agent or the local suite.`,
  );
  return { outcome: "relanded" };
}
