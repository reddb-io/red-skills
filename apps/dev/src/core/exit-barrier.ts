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
  /**
   * Whether the branch ref reached origin. The DONE barrier ({@link passExitBarrier})
   * OMITS this — a DONE receipt only exists after a successful push, so its absence
   * reads as "pushed". A FAILURE {@link TerminalReceipt} always sets it explicitly
   * (true/false), because a failing attempt still terminates even when the push is
   * rejected. Consumers treat `undefined` as pushed.
   */
  pushed?: boolean;
}

/**
 * The terminal-path variant of {@link ExitReceipt}. A FAILURE terminal (guard
 * abort, stall-kill, crash teardown, reconcile) is ALREADY terminating, so its
 * barrier crossing never throws on a rejected push — it records whether the
 * branch actually reached origin in {@link pushed} instead of converting the
 * failure into a second one. `pushed:false` means the branch could not be saved
 * (absent / rejected); the caller still terminates but the receipt tells the
 * truth about whether the work is on origin ("work is saved iff its branch ref
 * is pushed", ADR 0083 §4).
 */
export interface TerminalReceipt extends ExitReceipt {
  /** True iff the branch ref reached origin (create or update); false on a failed
   * or skipped push. Unlike the optional base field, a terminal receipt ALWAYS
   * sets this — the whole point of the failure crossing is to report truthfully
   * whether the work is on origin. */
  pushed: boolean;
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

/**
 * Run the exit barrier for a FAILURE terminal on `branch` — the shared crossing
 * for every non-DONE terminal path (guard abort, stall-kill, crash teardown,
 * reconcile). Unlike {@link passExitBarrier} it NEVER throws: a failing attempt
 * is already terminal, so a rejected push is RECORDED (`pushed:false`) rather
 * than escalated into a second failure that could strand the terminal handler.
 *
 *   1. Salvage-commit uncommitted worktree changes (best-effort; count captured).
 *   2. Push the branch to origin — on failure, retry EXACTLY ONCE.
 *   3. Assemble a {@link TerminalReceipt} whose `pushed` flag is the load-bearing
 *      truth: consumers report the terminal WITH this receipt so "was this work
 *      saved?" is answerable from the record alone.
 *
 * The receipt is the REQUIRED input to terminal-status reporting: a terminal path
 * obtains its exit through this barrier, then reports its status with the receipt,
 * so a path that reports a status without a receipt is not representable.
 */
export async function passTerminalBarrier(ports: ExitBarrierPorts, branch: string): Promise<TerminalReceipt> {
  // 1. Salvage-commit any dirty worktree paths (best-effort; never blocks push).
  let salvagedFiles = 0;
  try {
    salvagedFiles = await ports.salvage(branch);
  } catch {
    salvagedFiles = 0;
  }

  // 2. Push the branch — retry once on failure. A still-failing push is NOT fatal
  //    here (the attempt already failed); it is recorded as `pushed:false` below.
  const first = await ports.push(branch).catch((err: unknown) => ({ ok: false, error: String(err) }) as PushResult);
  let pushed = first.ok;
  if (!pushed) {
    const retry = await ports.push(branch).catch((err: unknown) => ({ ok: false, error: String(err) }) as PushResult);
    pushed = retry.ok;
  }

  // 3. Assemble the terminal receipt. The head sha is only meaningful once the ref
  //    reached origin; a not-pushed terminal reports an empty head.
  const head = pushed ? await ports.headSha(branch).catch(() => "") : "";
  return {
    branch,
    head,
    pushedAt: ports.nowIso(),
    salvaged: salvagedFiles > 0,
    salvagedFiles,
    pushed,
  };
}
