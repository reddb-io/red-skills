// runtime/state-watch.ts — the REAL worker-state-change event source backing the
// supervisor's event-driven wake (#934). A recursive fs.watch over the workers
// root (.red/tmp/workers) resolves the supervisor's per-iteration wait the moment
// a worker rewrites its `afk.state.toon` (every claim / stage / phase / progress
// transition writes that file atomically). The supervisor races this against its
// safety-net timer, so a state change is reacted to immediately while the timer
// still guarantees a wake if an event is ever missed.
//
// Everything here is best-effort: if fs.watch is unavailable or errors, the
// returned promise only settles on abort (never spuriously), so the supervisor
// degrades cleanly to pure-timer polling. The pure race/accounting logic lives in
// core/event-wake.ts; this file is the thin IO adapter that produces its events.

import { watch, type FSWatcher } from "node:fs";
import type { WakeSource } from "../core/event-wake.js";
import { WORKER_STATE_FILENAME } from "../core/state.js";

/** The worker state file every worker rewrites on each state transition. A watch
 * event naming this file is a genuine state change worth waking the supervisor
 * for; events on the noisier log/firehose siblings are ignored so a `tail -f`
 * churn does not wake the loop. */
const STATE_FILENAME = WORKER_STATE_FILENAME;

/**
 * Build the supervisor's worker-state-change {@link WakeSource} over a recursive
 * fs.watch of `workersRoot`. Each `waitForEvent` call installs a fresh watcher
 * that resolves on the FIRST `afk.state.toon` change (then tears itself down) or
 * on abort (the supervisor's timer won the race). A watch that cannot be
 * established — directory missing, recursive unsupported, fs error — resolves
 * only on abort, so the supervisor falls back to its timer with no spurious wakes.
 */
export function buildStateChangeWake(workersRoot: string): WakeSource {
  return {
    waitForEvent(signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        let watcher: FSWatcher | undefined;
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", finish);
          try {
            watcher?.close();
          } catch {
            // best-effort: a close failure must never throw out of the wake.
          }
          resolve();
        };
        // The timer-wins / shutdown path: abort tears the watcher down.
        signal.addEventListener("abort", finish, { once: true });
        try {
          watcher = watch(
            workersRoot,
            { recursive: true, persistent: false },
            (_event, filename) => {
              // filename is null on some platforms; only the named state-file
              // write is a real state change. A null filename is ignored so log
              // churn under the tree cannot wake the loop (the timer still covers
              // the worst case).
              if (filename && filename.toString().endsWith(STATE_FILENAME)) finish();
            },
          );
          // A watcher error (e.g. the dir is removed mid-watch) must not reject —
          // close it and leave the timer to drive this iteration's wait.
          watcher.on("error", () => finish());
        } catch {
          // fs.watch unavailable / dir missing: never resolve spuriously — the
          // abort listener above resolves when the supervisor's timer wins.
        }
      });
    },
  };
}
