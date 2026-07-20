/**
 * process-tree.ts — process identity and verified whole-tree termination.
 *
 * A wait that cannot prove its command tree is gone must not report success.
 * Everything here therefore returns EVIDENCE (did the pids actually disappear?)
 * rather than "we sent the signal", so the caller can degrade to exit 2 when
 * cleanup is unprovable.
 */
import type { ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

/** Outcome of a termination attempt, carrying the proof the caller needs. */
export interface TerminationOutcome {
  /** True only when every tracked pid is verifiably gone. */
  cleaned: boolean;
  /** The escalation actually needed — useful for the result envelope. */
  escalation: "none" | "term" | "kill";
  /** Pids still alive after the final sweep; empty iff `cleaned`. */
  survivors: number[];
}

/**
 * TERM the whole process group, wait the grace period, then KILL, then verify.
 *
 * The command is spawned detached so it OWNS a process group; signaling `-pid`
 * reaches grandchildren that a bare `child.kill()` would leave running. We also
 * signal the enumerated descendants directly, because a child that called
 * `setsid` has escaped the group and is only reachable by pid.
 */
export async function terminateProcessTree(child: ChildProcess, graceMs: number): Promise<TerminationOutcome> {
  const pid = child.pid;
  if (!pid) return { cleaned: true, escalation: "none", survivors: [] };
  const descendants = await descendantPids(pid);
  const tracked = [pid, ...descendants];
  if (tracked.every((candidate) => !pidAlive(candidate))) {
    return { cleaned: true, escalation: "none", survivors: [] };
  }

  signalProcessGroup(child, "SIGTERM");
  signalPids(descendants, "SIGTERM");
  if (await waitForPidsGone(tracked, graceMs)) return { cleaned: true, escalation: "term", survivors: [] };

  // A tree can grow between enumeration and KILL, so re-enumerate before the
  // uninterceptable signal rather than killing a stale snapshot.
  const remaining = [...new Set([...tracked, ...(await descendantPids(pid))])];
  signalProcessGroup(child, "SIGKILL");
  signalPids(remaining, "SIGKILL");
  const killGraceMs = Math.max(1_000, graceMs);
  await waitForChildClose(child, killGraceMs);
  const cleaned = await waitForPidsGone(remaining, killGraceMs);
  return {
    cleaned,
    escalation: "kill",
    survivors: cleaned ? [] : remaining.filter(pidAlive),
  };
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

export function signalPids(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolveClosed) => {
    const timer = setTimeout(() => resolveClosed(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolveClosed(true);
    });
  });
}

export async function waitForPidsGone(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !pidAlive(pid))) return true;
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return pids.every((pid) => !pidAlive(pid));
}

/**
 * Every transitive descendant of `rootPid`, deepest first so callers signal
 * leaves before their parents. Linux-only: `/proc` is the only enumeration we
 * can do without shelling out, and elsewhere the process-group signal is the
 * whole story.
 */
export async function descendantPids(rootPid: number): Promise<number[]> {
  if (process.platform !== "linux") return [];
  const children = new Map<number, number[]>();
  for (const name of await readdir("/proc").catch(() => [])) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    const pid = Number(name);
    const fields = await procStatFields(pid);
    if (!fields) continue;
    const ppid = Number(fields[1]);
    if (!Number.isSafeInteger(ppid)) continue;
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  const descendants: number[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    descendants.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return descendants.reverse();
}

/**
 * The PID's start ticks — the second half of a durable process identity.
 * Undefined off Linux, where callers fall back to liveness alone.
 */
export async function pidStartTime(pid: number): Promise<string | undefined> {
  const fields = await procStatFields(pid);
  return fields?.[19];
}

/** True when the pid exists AND still has the start time it was recorded with. */
export async function pidIdentityMatches(pid: number, expectedStartTime: string | undefined): Promise<boolean> {
  if (!pidAlive(pid)) return false;
  if (!expectedStartTime) return true;
  const actual = await pidStartTime(pid);
  // Off Linux there is nothing to compare against; liveness already passed.
  if (actual === undefined) return process.platform !== "linux";
  return actual === expectedStartTime;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** `/proc/<pid>/stat` fields AFTER the comm field, whose parens defeat splitting. */
async function procStatFields(pid: number): Promise<string[] | null> {
  if (process.platform !== "linux") return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    return stat.slice(closeParen + 2).trim().split(/\s+/);
  } catch {
    return null;
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** A sleep that returns early when the wait is cancelled. */
export async function sleepUntil(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return;
  await new Promise<void>((resolveSleep) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
