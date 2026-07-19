/**
 * Arm the attempt progress guard. Polls `headProbe` every `intervalMs`; the
 * deadline resets whenever the HEAD sha advances, the diff reaches a new
 * high-water mark, activity counters advance, or an active build/test descendant
 * is observed. `abort` fires once `capMs` elapses with none of those soft
 * progress signals. Pure over its injected clock / scheduler — no real timers,
 * no git — so it is fully unit-testable. The first observed head anchors the
 * clock (≈ from spawn). A `headProbe` rejection is treated as "no progress
 * observed" (never resets), so a flaky git read cannot keep a hung agent alive.
 */
export interface AttemptProgressInfo {
  /** The worker branch HEAD observed this tick (undefined when unresolved). */
  head: string | undefined;
  /** Epoch ms of the last observed soft progress (commit, diff growth, activity,
   * active validation descendant, or spawn). */
  lastProgressMs: number;
  /** The guard's clock (epoch ms) at this tick. */
  nowMs: number;
  /** Resolved base branch (lock > pin > main) for this attempt — populated by
   * processIssue so the emitHeartbeat sink can diff against the correct ref. */
  base?: string;
}

/**
 * Per-attempt resource budget (GNHF Track A, #908). Optional ceilings the
 * attempt guard enforces ALONGSIDE the commit-anchored wall-clock cap. Any unset
 * field is ignored, so an empty budget is a no-op (today's behaviour). The point
 * is to stop a runaway BEFORE it burns the whole token allowance — the #788
 * failure (2.1M tokens on one slice, never emitted DONE, 0 closed).
 */
export interface AttemptBudget {
  /** Abort once cumulative (input+output) tokens reach this. Lives only for
   * runners that stream usage on the wire (codex/opencode); a pure-claude
   * attempt accrues 0 live tokens (usage folds in at the iteration boundary),
   * so for claude/minimax the PROXY ceilings below carry the protection. */
  maxTotalTokens?: number;
  /** Abort once cumulative USD cost reaches this (runners that report cost). */
  maxCostUsd?: number;
  /** Runner-agnostic proxy: abort once this many tool calls have been made.
   * Accrues live for ALL runners (incl. claude/minimax), so it is the ceiling
   * that actually covers the #788 runner. */
  maxToolCalls?: number;
  /** Runner-agnostic proxy: abort once this many heartbeat windows have passed
   * with zero new stream events (waiting/blocked) — a long wedged run. */
  maxWaitingWindows?: number;
}

/** The cumulative counters the guard reads each poll to evaluate the budget —
 * exactly the subset of the activity meter's `peek()` snapshot the ceilings
 * compare against. */
export interface AttemptBudgetUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolsCalled: number;
  waiting: number;
}

export interface AttemptActivityUsage extends AttemptBudgetUsage {
  textChunks?: number;
  reasoningCount?: number;
}

export type AttemptTimeoutReason = "stalled" | "edit-loop-stall" | "hard-cap";
type AttemptGuardAbortReason = AttemptTimeoutReason | "goal-moot" | "budget";

/**
 * Pure budget predicate: is any configured ceiling reached? Returns the breached
 * ceiling's name (for the abort message / observability) or `undefined`. Unset
 * ceilings never fire, so an empty budget always returns `undefined`.
 */
export function exceedsBudget(
  usage: AttemptBudgetUsage,
  budget: AttemptBudget,
): "tokens" | "cost" | "tool-calls" | "waiting-windows" | undefined {
  if (budget.maxTotalTokens !== undefined && usage.inputTokens + usage.outputTokens >= budget.maxTotalTokens) {
    return "tokens";
  }
  if (budget.maxCostUsd !== undefined && usage.costUsd >= budget.maxCostUsd) return "cost";
  if (budget.maxToolCalls !== undefined && usage.toolsCalled >= budget.maxToolCalls) return "tool-calls";
  if (budget.maxWaitingWindows !== undefined && usage.waiting >= budget.maxWaitingWindows) return "waiting-windows";
  return undefined;
}

export function startAttemptGuard(opts: {
  capMs: number;
  intervalMs: number;
  headProbe: () => Promise<string | undefined>;
  now: () => number;
  schedule: (fn: () => void, ms: number) => () => void;
  /** `reason` distinguishes the soft commit/edit deadline ("stalled"), edit-loop
   * churn without diff growth ("edit-loop-stall"), the commit-anchored hard cap
   * ("hard-cap", issue #637), and the non-timeout guards. Callbacks that ignore
   * the argument keep the prior behaviour. */
  abort: (reason: AttemptGuardAbortReason) => void;
  /**
   * Per-attempt resource budget (#908). When both `budget` and `budgetUsage` are
   * supplied, the guard reads the cumulative usage each poll and aborts with
   * reason `"budget"` once any ceiling is breached. Omitted → no budget cap.
   */
  budget?: AttemptBudget;
  /** Sync probe for the cumulative usage this poll (the activity meter's
   * `peek()`). Read only when `budget` is also set. */
  budgetUsage?: () => AttemptBudgetUsage;
  /** Live activity-meter snapshot. Increases in tool/text/reasoning/token
   * counters are productive activity and extend the soft progress deadline while
   * the worker is still below the commit hard cap. */
  activityUsage?: () => AttemptActivityUsage;
  /** Active build/test descendant predicate. A true value extends the soft
   * progress deadline so slow validation is not killed as a commit stall. */
  activeDescendantProbe?: () => boolean;
  /**
   * Goal predicate (ADR 0057): reads the claimed issue's CLOSED state on THIS
   * same poll (one issue-state read per tick — no extra polling loop). Resolves
   * `true` when the issue is CLOSED, `false` when open, `undefined` on a gh /
   * network failure. Only a definite `true` aborts the attempt ("goal-moot");
   * `false` / `undefined` are no-ops, so a flaky read never kills on uncertainty.
   * Optional → omitted means the goal predicate is disabled (prior behaviour).
   */
  goalProbe?: () => Promise<boolean | undefined>;
  /** Worktree line-volume probe (ADR 0051): a CHANGE between polls counts as
   * progress and resets the deadline, so an editing-but-not-committing runner
   * (codex) is not falsely stalled. Optional → guard stays commit-anchored. */
  progressProbe?: () => Promise<number | undefined>;
  /** Commit-anchored hard cap (issue #637): when set, edit-signal resets may
   * extend the deadline only this long past the last commit (or spawn) — once
   * `hardCapMs` elapses with no NEW commit, abort fires regardless of worktree
   * edits. Without it a busy-but-unproductive agent that touches a file every
   * <capMs resets the soft deadline forever. Optional → soft cap only. */
  hardCapMs?: number;
  /** Fired once per poll (proof-of-life externalization): the externalized
   * heartbeat + on_heartbeat hook ride this same cadence (PR-B). Never throws —
   * the caller wraps its own IO. */
  onTick?: (info: AttemptProgressInfo) => void;
}): { stop: () => void; firedTimeout: () => boolean; firedGoalMoot: () => boolean; firedBudget: () => boolean } {
  let lastProgress = opts.now();
  let lastCommit = opts.now();
  let lastHead: string | undefined;
  let lastVolume: number | undefined;
  let lastActivityScore: number | undefined;
  let diffHighWater: number | undefined;
  let sawNonGrowingEditSinceProgress = false;
  let fired = false;
  let goalMoot = false;
  let budgetFired = false;
  const cancel = opts.schedule(() => {
    void (async () => {
      if (fired) return;
      // Goal predicate (ADR 0057): rides THIS poll — one issue-state read per
      // tick, no separate loop. A definite CLOSED means the attempt's goal is
      // already reflected in the world (someone landed it, or our own merge), so
      // the attempt is moot: abort. An open issue OR a failed read (`!== true`)
      // is a no-op — the predicate never kills on uncertainty. Checked before the
      // progress/deadline logic so a busy-but-committing agent on an already-closed
      // issue is still terminated within ~2 poll intervals.
      if (opts.goalProbe) {
        let closed: boolean | undefined;
        try {
          closed = await opts.goalProbe();
        } catch {
          closed = undefined;
        }
        if (fired) return;
        if (closed === true) {
          fired = true;
          goalMoot = true;
          opts.abort("goal-moot");
          return;
        }
      }
      // Resource budget (#908): a runaway is cut on the cumulative-usage ceiling
      // BEFORE the commit/edit/deadline logic, so a slice that burns tokens (or
      // spins tool calls / waiting windows) without committing is stopped fast
      // — the #788 antidote. Pure predicate over the injected usage probe; an
      // empty budget never fires (today's behaviour).
      if (opts.budget && opts.budgetUsage) {
        if (exceedsBudget(opts.budgetUsage(), opts.budget) !== undefined) {
          fired = true;
          budgetFired = true;
          opts.abort("budget");
          return;
        }
      }
      let activityScore: number | undefined;
      if (opts.activityUsage) {
        try {
          const usage = opts.activityUsage();
          activityScore =
            usage.inputTokens +
            usage.outputTokens +
            usage.toolsCalled +
            usage.waiting +
            (usage.textChunks ?? 0) +
            (usage.reasoningCount ?? 0);
        } catch {
          activityScore = undefined;
        }
      }
      let activeDescendant = false;
      if (opts.activeDescendantProbe) {
        try {
          activeDescendant = opts.activeDescendantProbe();
        } catch {
          activeDescendant = false;
        }
      }
      // Commit signal (always present). A headProbe rejection = no progress
      // observed (let the deadline run), matching the prior commit-anchored
      // behaviour exactly when no progressProbe is supplied.
      let head: string | undefined;
      let headOk = true;
      try {
        head = await opts.headProbe();
      } catch {
        headOk = false;
      }
      if (fired) return;
      // Edit signal (optional). Only NEW diff high-water growth is real progress.
      // Plain motion (shrinking/oscillating volume) proves the agent is active,
      // but it does not advance the branch diff vs base and must not keep the
      // soft deadline open until the hard cap.
      let volume: number | undefined;
      if (opts.progressProbe) {
        try {
          volume = await opts.progressProbe();
        } catch {
          volume = undefined;
        }
      }
      if (fired) return;
      const committed = headOk && head !== undefined && head !== lastHead;
      const volumeChanged = volume !== undefined && lastVolume !== undefined && volume !== lastVolume;
      const grewDiff = volume !== undefined && diffHighWater !== undefined && volume > diffHighWater;
      const activityAdvanced =
        activityScore !== undefined && lastActivityScore !== undefined && activityScore > lastActivityScore;
      const productiveActivity = activeDescendant || activityAdvanced;
      const nonGrowingEdit = volumeChanged && !grewDiff;
      if (committed) {
        lastProgress = opts.now();
        lastCommit = opts.now();
        sawNonGrowingEditSinceProgress = false;
      } else if (grewDiff) {
        lastProgress = opts.now();
        sawNonGrowingEditSinceProgress = false;
      } else if (productiveActivity) {
        lastProgress = opts.now();
      } else if (nonGrowingEdit) {
        sawNonGrowingEditSinceProgress = true;
      }
      // The soft deadline resets on commit OR diff growth; the hard cap resets on
      // commit ONLY, so periodic edits cannot keep an uncommitting agent alive
      // past it (issue #637 — the 5h+ re-validation loop).
      const softExpired = !committed && !grewDiff && !productiveActivity && opts.now() - lastProgress >= opts.capMs;
      const hardExpired = !committed && opts.hardCapMs !== undefined && opts.now() - lastCommit >= opts.hardCapMs;
      if (softExpired || hardExpired) {
        fired = true;
        opts.abort(hardExpired && !softExpired ? "hard-cap" : sawNonGrowingEditSinceProgress ? "edit-loop-stall" : "stalled");
      }
      if (headOk && head !== undefined) lastHead = head;
      if (volume !== undefined) {
        lastVolume = volume;
        diffHighWater = diffHighWater === undefined ? volume : Math.max(diffHighWater, volume);
      }
      if (activityScore !== undefined) lastActivityScore = activityScore;
      opts.onTick?.({ head: head ?? lastHead, lastProgressMs: lastProgress, nowMs: opts.now() });
    })();
  }, opts.intervalMs);
  return {
    stop: cancel,
    // firedTimeout EXCLUDES the goal-moot and budget aborts — each has its own
    // dedicated terminal so they never collide on the shared `fired` flag.
    firedTimeout: () => fired && !goalMoot && !budgetFired,
    firedGoalMoot: () => goalMoot,
    firedBudget: () => budgetFired,
  };
}
