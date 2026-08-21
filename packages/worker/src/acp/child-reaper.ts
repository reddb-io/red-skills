/**
 * The lifetime of every child Agent process this Worker body spawned.
 *
 * **A coding Agent that outlives its Worker is an orphan holding a session.**
 * On 4.1.15 every dead codex Worker left its `codex-acp` pair alive — the `npx`
 * wrapper AND the platform binary it had spawned — re-parented onto the systemd
 * user manager, six pairs in one evening, each still holding an authenticated
 * session and its idle memory (#4241). Two layers should have caught it and
 * neither did, so this is the one that OWNS it: the body spawned the process,
 * and the body kills it.
 *
 * Two facts decide the shape:
 *
 * 1. **The child is a wrapper, so the pid is not the process.** `npx` execs a
 *    launcher that spawns the real binary as its own child; killing the pid we
 *    hold leaves the grandchild running and re-parented. So the child is spawned
 *    `detached`, which gives it a process group of its own, and every signal
 *    goes to the GROUP (`-pid`) — one signal reaches the whole subtree without
 *    walking `/proc`, and the group id is a number we already have.
 * 2. **The last exit path cannot await anything.** A `SIGTERM` from the daemon
 *    and a plain process exit both end the loop; `process.on("exit")` may only
 *    do synchronous work. So the registry below is synchronous by construction:
 *    the graceful, confirming kill is `reapChildProcessTree`, and what runs at
 *    the edge of the process is one unconfirmed group `SIGKILL` per survivor.
 *
 * Spawning detached has one cost, taken deliberately: the child no longer shares
 * the Worker's process group, so a group-wide `SIGINT` from a terminal no longer
 * reaches it incidentally. That incidental reach is exactly what was failing —
 * it never covered the re-parented grandchild — and it is replaced here by a
 * kill this module performs on purpose.
 */
import type { ChildProcess } from "node:child_process";
import { killTreeAndWait, signalTree } from "@reddb-io/shared/kill-tree.js";

/**
 * How long a child Agent has to honour `SIGTERM` before the group is killed.
 *
 * The `killTreeAndWait` defaults already spell this grace — 20 polls of 100ms —
 * and it is named here so the number a reader is looking for is in the module
 * that owns the promise rather than in the killer's argument defaults.
 */
export const CHILD_AGENT_KILL_GRACE_MS = 2_000;

/** Every child Agent process group this body still believes is alive. */
const liveChildAgents = new Set<number>();

let reaperInstalled = false;

/** Signals whose default disposition would end the process without an `exit`. */
const TERMINAL_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/** Conventional shell exit status for a process ended by a signal. */
const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

/** Start owning `pid`'s group: the exit paths below will kill it if nothing else does. */
export function registerChildAgentProcess(pid: number): void {
  liveChildAgents.add(pid);
}

/** Stop owning `pid`'s group — it exited, or its reap already confirmed it gone. */
export function forgetChildAgentProcess(pid: number): void {
  liveChildAgents.delete(pid);
}

/** The child Agent process groups still owned. Reading order is registration order. */
export function liveChildAgentProcesses(): readonly number[] {
  return [...liveChildAgents];
}

/**
 * Signal every owned group, synchronously, and say how many were reached.
 *
 * This is the body of the `exit` hook, which is why it confirms nothing: at
 * that point there is no turn of the event loop left to confirm in. It is
 * exported so the same act is testable without ending the test process.
 */
export function reapChildAgentProcesses(signal: NodeJS.Signals): number {
  const pids = [...liveChildAgents];
  for (const pid of pids) signalTree(pid, signal);
  return pids.length;
}

/**
 * Kill one child Agent's whole process group and CONFIRM it is gone.
 *
 * `killTreeAndWait` is the repo's one wait-and-escalate killer: SIGTERM the
 * group, poll for a graceful exit through the grace above, escalate to SIGKILL,
 * and confirm. A child that was already reaped costs one `kill -0`.
 */
export async function reapChildProcessTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (pid == null) return true;
  try {
    return await killTreeAndWait(pid);
  } finally {
    forgetChildAgentProcess(pid);
  }
}

/**
 * Install the process-edge reaper once, on the first child Agent spawned.
 *
 * Lazy on purpose: a Worker body that never delegates installs no handler, and
 * a handler that exists without a child would suppress the daemon's `SIGTERM`
 * for nothing. Installing on the first spawn means the suppression and the
 * reason for it arrive together.
 */
export function installChildAgentReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  process.on("exit", onProcessExit);
  for (const signal of TERMINAL_SIGNALS) process.once(signal, onTerminalSignal);
}

/** The last thing this process does: no survivor leaves with the exit code. */
function onProcessExit(): void {
  reapChildAgentProcesses("SIGKILL");
}

/**
 * A terminal signal reached the Worker: pass it on, then stop waiting.
 *
 * Installing a listener suppresses the default disposition, so this owes the
 * process an exit. It asks the group to leave first, then hands control to the
 * escalation below — which force-exits whether or not the child obliged.
 */
function onTerminalSignal(signal: NodeJS.Signals): void {
  reapChildAgentProcesses("SIGTERM");
  scheduleChildAgentEscalation(signal);
}

/**
 * End the process once the grace has passed, killing whatever is still there.
 *
 * Unreferenced: a Worker that finishes shutting down sooner exits sooner, and
 * the `exit` hook kills the same survivors on the way out. The timer is what
 * bounds the case where nothing else ends the loop.
 */
function scheduleChildAgentEscalation(signal: NodeJS.Signals): void {
  const timer = setTimeout(() => {
    reapChildAgentProcesses("SIGKILL");
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
  }, CHILD_AGENT_KILL_GRACE_MS);
  timer.unref();
}
