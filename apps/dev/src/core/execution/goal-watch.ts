/**
 * Goal-predicate watch (ADR 0057) — the one predicate that outlived the attempt
 * model. Polls `goalProbe` every `intervalMs` and aborts the run once the
 * claimed issue is observed CLOSED: the goal is already reflected in the world
 * (someone landed it, or our own merge), so the run is moot. Pure over its
 * injected scheduler — no real timers, no gh — so it is fully unit-testable.
 *
 * Everything else the old attempt-progress guard carried is GONE (ADR 0103):
 * the wall-clock soft cap, the commit-anchored hard cap, the edit-loop-stall
 * abort, and the guard-driven proof-of-life sink. Stall detection is the fleet
 * supervisor's exclusive job, driven by the castle liveness lane + evaluator;
 * worker vitals ride their own independent sampler in `runtime.ts`.
 */
export function startGoalWatch(opts: {
  intervalMs: number;
  schedule: (fn: () => void, ms: number) => () => void;
  /**
   * Reads the claimed issue's CLOSED state each poll. Resolves `true` when the
   * issue is CLOSED, `false` when open, `undefined` on a gh / network failure.
   * Only a definite `true` aborts; `false` and `undefined` are no-ops, so a
   * flaky read never kills on uncertainty.
   */
  goalProbe: () => Promise<boolean | undefined>;
  /** Fired at most once, on the first definite CLOSED observation. */
  abort: () => void;
}): { stop: () => void; firedGoalMoot: () => boolean } {
  let fired = false;
  const cancel = opts.schedule(() => {
    void (async () => {
      if (fired) return;
      let closed: boolean | undefined;
      try {
        closed = await opts.goalProbe();
      } catch {
        closed = undefined;
      }
      if (fired || closed !== true) return;
      fired = true;
      opts.abort();
    })();
  }, opts.intervalMs);
  return { stop: cancel, firedGoalMoot: () => fired };
}
