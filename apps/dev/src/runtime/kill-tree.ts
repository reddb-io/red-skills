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

/** True while either the dedicated process group or its leader still exists.
 * Group liveness is the teardown authority: the leader may exit first while a
 * pnpm/vitest descendant keeps the group alive. */
export function isLiveTree(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    return isLivePid(pid);
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

/** Signal only the process group (`kill -<signal> -<pgid>` semantics). Unlike
 * signalTree, this deliberately does not fall back to the leader: it is the
 * final escalation for descendants that survived the normal tree signal. */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone, or no process group remains
  }
}

/** Injectable IO so the escalation path is deterministically testable without
 * real processes or wall-clock waits. */
export interface KillTreeIO {
  isAlive(pid: number): boolean;
  signal(pid: number, signal: NodeJS.Signals): void;
  /** Explicit process-group signal used by the final SIGKILL fallback. Optional
   * so existing injected IO remains source-compatible. */
  signalGroup?(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

const defaultIO: KillTreeIO = {
  isAlive: isLiveTree,
  signal: signalTree,
  signalGroup: signalProcessGroup,
  sleep: realSleep,
};

export interface KillTreeOptions {
  /** SIGTERM grace poll iterations before escalating to SIGKILL (default 20). */
  graceTries?: number;
  /** Confirm poll iterations after each SIGKILL escalation (default 10). */
  killTries?: number;
  /** Poll interval in ms between liveness checks (default 100). */
  pollMs?: number;
  /** Injected IO (tests); defaults to real process signals + setTimeout. */
  io?: KillTreeIO;
}

/**
 * SIGTERM the tree, wait for a graceful exit (polling up to `graceTries`×`pollMs`
 * ≈ 2s), then escalate to SIGKILL and poll again (up to `killTries`×`pollMs` ≈
 * 1s) to CONFIRM the process is gone. If the leader survives, send one explicit
 * process-group SIGKILL and confirm again. Returns true when the tree is
 * confirmed dead, false only when it survived the group SIGKILL (e.g. an
 * uninterruptible-sleep worker) — the caller must NOT tear down a worktree on a
 * `false` return.
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
  if (!io.isAlive(pid)) return true;
  io.signalGroup?.(pid, "SIGKILL");
  for (let i = 0; i < killTries; i += 1) {
    if (!io.isAlive(pid)) return true;
    await io.sleep(pollMs);
  }
  return !io.isAlive(pid);
}
