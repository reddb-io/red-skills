// kill-tree — the canonical wait-and-escalate process-tree killer shared by the
// watchdog (supervisor recovery), the fleet reaper (stalled-slot teardown), and
// `fleet stop`. SIGTERM the tree, poll for a graceful exit, escalate to SIGKILL
// after a grace, then CONFIRM the process is actually gone before returning.
//
// Why this lives in one place (#580): the reaper and `fleet stop` previously
// fired a single SIGTERM and moved on — freeing the slot and `rm -rf`ing the
// worktree while a SIGTERM-ignoring worker was still alive, and reporting the
// fleet "stopped" while survivors lingered. Reusing the watchdog's
// kill-and-confirm killer everywhere makes teardown race-free.

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** True when the pid is alive (kill -0). */
export function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal the whole process group (`-pid`), falling back to the bare pid. Both
 * attempts swallow errors: a process that is already gone is success. */
export function signalTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Injectable IO so the escalation path is deterministically testable without
 * real processes or wall-clock waits. */
export interface KillTreeIO {
  isAlive(pid: number): boolean;
  signal(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

const defaultIO: KillTreeIO = {
  isAlive: isLivePid,
  signal: signalTree,
  sleep: realSleep,
};

export interface KillTreeOptions {
  /** SIGTERM grace poll iterations before escalating to SIGKILL (default 20). */
  graceTries?: number;
  /** Post-SIGKILL confirm poll iterations (default 10). */
  killTries?: number;
  /** Poll interval in ms between liveness checks (default 100). */
  pollMs?: number;
  /** Injected IO (tests); defaults to real process signals + setTimeout. */
  io?: KillTreeIO;
}

/**
 * SIGTERM the tree, wait for a graceful exit (polling up to `graceTries`×`pollMs`
 * ≈ 2s), then escalate to SIGKILL and poll again (up to `killTries`×`pollMs` ≈
 * 1s) to CONFIRM the process is gone. Returns true when the tree is confirmed
 * dead, false only when it survived SIGKILL (e.g. an uninterruptible-sleep
 * worker) — the caller must NOT tear down a worktree on a `false` return.
 */
export async function killTreeAndWait(pid: number, options: KillTreeOptions = {}): Promise<boolean> {
  const io = options.io ?? defaultIO;
  const pollMs = options.pollMs ?? 100;
  const graceTries = options.graceTries ?? 20;
  const killTries = options.killTries ?? 10;

  io.signal(pid, "SIGTERM");
  for (let i = 0; i < graceTries; i += 1) {
    if (!io.isAlive(pid)) return true;
    await io.sleep(pollMs);
  }
  io.signal(pid, "SIGKILL");
  for (let i = 0; i < killTries; i += 1) {
    if (!io.isAlive(pid)) return true;
    await io.sleep(pollMs);
  }
  return !io.isAlive(pid);
}
