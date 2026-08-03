import type { TickResult } from "./result.js";

function continueResult(): TickResult {
  return { respawned: [], deaths: [], parked: [], idleParked: [], halfOpened: [], reaped: [], crashReconciled: [], reconciledSlots: [], retiredSlots: [], runnerChanged: false, stopped: false, queueDepth: 0, abandoned: true };
}

/**
 * Run one supervise tick under a wall-clock ceiling. A tick that exceeds
 * `timeoutMs` (a hung gh/ps/git await) or throws is abandoned — logged, and a
 * non-stop result returned — so the supervisor loop continues to the next pass
 * instead of freezing forever on the await. Pure over an injected `sleep`
 * (the timeout clock) so it is deterministically testable with no real timers.
 * The abandoned tick promise is left to settle on its own; the loop moves on.
 */
export async function guardedTick(
  tick: () => Promise<TickResult>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  log?: (line: string) => void,
): Promise<TickResult> {
  const TIMEOUT = Symbol("tick-timeout");
  try {
    const raced = await Promise.race<TickResult | typeof TIMEOUT>([
      tick(),
      sleep(timeoutMs).then(() => TIMEOUT),
    ]);
    if (raced === TIMEOUT) {
      log?.(`tick exceeded ${Math.round(timeoutMs / 1000)}s — abandoning this pass, loop continues`);
      return continueResult();
    }
    return raced;
  } catch (err) {
    log?.(`tick threw: ${err instanceof Error ? err.message : String(err)} — loop continues`);
    return continueResult();
  }
}
