// exit-barrier — ADR 0083 §4: "work is saved iff its branch ref is pushed to
// origin". The single owner of an attempt's terminal exit: it salvage-commits any
// uncommitted worktree changes, pushes the attempt branch to origin (create or
// update), and produces an auditable RECEIPT the caller records in the attempt
// record / Envelope. A terminal path that bypasses this barrier is a bug by
// definition (ADR 0083).
//
// This slice (issue #1020) is the tracer: only the successful-attempt (DONE) path
// obtains its exit through the barrier. The remaining terminal paths (guard abort,
// stall-kill, teardown, reconcile) are the follow-up slice — they will call the
// SAME `passExitBarrier` so the "one owner" guarantee holds without re-derivation.
//
// PURE of a concrete git: every git touch is an injected port so unit tests drive
// salvage / push / head-sha with fakes and never touch an OS git.

/**
 * The auditable proof that an attempt's work reached origin. The caller records
 * it in the attempt record / Envelope so "was this work saved?" is answerable
 * from the record alone, never re-derived from the live repo.
 */
export interface ExitReceipt {
  /** The attempt branch whose ref was pushed. */
  branch: string;
  /** The branch head sha AFTER salvage + push (the ref origin now carries). */
  head: string;
  /** ISO-8601 timestamp of the successful push. */
  pushedAt: string;
  /** True when the barrier created a salvage commit (dirty worktree at exit). */
  salvaged: boolean;
  /** Number of files the salvage step committed (0 when the worktree was clean). */
  salvagedFiles: number;
}

/** The result of one push attempt through the {@link ExitBarrierPorts.push} port. */
export interface PushResult {
  ok: boolean;
  /** Failure detail surfaced in the thrown error when both attempts fail. */
  error?: string;
}

/**
 * The injected git surface the barrier needs. run.ts binds these to the concrete
 * `runtime/git.ts` closures over a GitContext; tests bind recording fakes.
 */
export interface ExitBarrierPorts {
  /**
   * Salvage-commit any uncommitted worktree changes onto `branch`, one commit per
   * file (the existing salvage convention, `runtime/git.ts::salvageUncommitted`).
   * Returns the count committed (0 = clean worktree). Best-effort: MUST NOT throw
   * — a salvage failure never blocks the push, which is the barrier's hard
   * guarantee.
   */
  salvage(branch: string): Promise<number>;
  /**
   * Push `branch` to origin (create or update the remote ref). Returns
   * `{ok:true}` on success; `{ok:false, error}` on a rejected/failed push. MUST
   * NOT throw — the barrier owns the retry + hard-error policy.
   */
  push(branch: string): Promise<PushResult>;
  /**
   * Resolve the current head sha of `branch` (after salvage + push). Empty string
   * when the ref cannot be read.
   */
  headSha(branch: string): Promise<string>;
  /** ISO-8601 timestamp source for the receipt's `pushedAt`. */
  nowIso(): string;
}

/**
 * Thrown when the barrier cannot push the attempt branch after its retry. The
 * caller MUST treat this as a non-clean termination: an attempt is never reported
 * as cleanly terminated without a receipt (ADR 0083 §4).
 */
export class ExitBarrierError extends Error {
  readonly branch: string;
  constructor(branch: string, detail: string) {
    super(`exit barrier: failed to push attempt branch \`${branch}\` after retry — ${detail}`);
    this.name = "ExitBarrierError";
    this.branch = branch;
  }
}

/**
 * Run the exit barrier for a terminating attempt on `branch`:
 *
 *   1. Salvage-commit uncommitted worktree changes (best-effort; count captured).
 *   2. Push the branch to origin — on failure, retry EXACTLY ONCE.
 *   3. Both attempts failed → throw {@link ExitBarrierError} (attempt NOT clean).
 *   4. Success → return the {@link ExitReceipt} (branch / head / pushedAt / salvage).
 *
 * The salvage step is best-effort by contract (it never blocks the push); the
 * PUSH is the load-bearing guarantee, so only a push failure aborts the exit.
 */
export async function passExitBarrier(ports: ExitBarrierPorts, branch: string): Promise<ExitReceipt> {
  // 1. Salvage-commit any dirty worktree paths. `salvage` is best-effort and must
  //    not throw; guard defensively so a misbehaving port can never strand the
  //    push behind an exception.
  let salvagedFiles = 0;
  try {
    salvagedFiles = await ports.salvage(branch);
  } catch {
    // A salvage failure leaves the committed subset intact and is never fatal —
    // the push below still saves whatever reached the branch ref.
    salvagedFiles = 0;
  }

  // 2. Push the branch — retry once on failure, then surface a hard error.
  const first = await ports.push(branch).catch((err: unknown) => ({ ok: false, error: String(err) }) as PushResult);
  if (!first.ok) {
    const retry = await ports.push(branch).catch((err: unknown) => ({ ok: false, error: String(err) }) as PushResult);
    if (!retry.ok) {
      throw new ExitBarrierError(branch, retry.error ?? first.error ?? "push rejected");
    }
  }

  // 3. Success → assemble the receipt from the pushed ref.
  const head = await ports.headSha(branch).catch(() => "");
  return {
    branch,
    head,
    pushedAt: ports.nowIso(),
    salvaged: salvagedFiles > 0,
    salvagedFiles,
  };
}
