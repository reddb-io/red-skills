// reaper-signal — busy-vs-stuck liveness predicate for the AFK hard-stall reaper.
//
// The passive stall detector flags a worker whose *agent lane* has gone silent
// past a threshold. Silence alone is not death: a worker can sit mid-`pnpm
// build` or mid-`vitest` for minutes without writing a line to the agent lane,
// and a hard reaper that keys off lane silence alone will kill live work
// (#243). This module is the clean liveness lane the reaper needs: given the
// agent-lane idle duration and a process snapshot (whether an active build/test
// descendant exists, and the worker tree's aggregate cpu%), it decides kill vs
// no-kill.
//
// A worker is BUSY (never killed) when, despite agent-lane silence, EITHER an
// active build/test descendant is running (vitest, tsc, pnpm-spawned node,
// cargo, …) OR the worker tree shows non-trivial cpu. It is STUCK (eligible to
// kill) only when ALL hold: idle past the threshold AND no active descendant
// AND flat cpu.
//
// The DECISION (`decideReaperSignal`) is pure: it runs neither ps nor pstree
// and reads no globals — the orchestrator owns that I/O. `inspectProcessTree`
// is a thin, injectable wrapper around the real process inspection so the
// predicate stays unit-testable against fixed inputs.

/** Default cpu% at or above which a worker counts as "doing non-trivial work".
 * A genuinely stuck process blocked in a syscall sits at ~0%; a real build or
 * test run is far above this. Mirrors REAPER_SIGNAL_CPU_BUSY_PCT_DEFAULT. */
export const REAPER_SIGNAL_CPU_BUSY_PCT_DEFAULT = 5;

/** Build/test executable basenames whose presence under the worker tree means
 * the worker is doing real work even while the agent lane is silent (#243).
 * Mirrors REAPER_BUSY_CMD_RE from supervisor.sh: matched against `ps -o comm=`
 * basenames, anchored (`^…$`) and case-insensitive. Many JS tools run as bare
 * `node`, so this list is not exhaustive on its own — the cpu signal catches
 * the rest. */
export const REAPER_BUSY_CMD_RE =
  /^(vitest|jest|mocha|playwright|tsc|tsx|esbuild|webpack|rollup|vite|cargo|rustc|gradle|mvn|javac|java|pytest|python[0-9.]*|go|make|cmake|ninja|cc1|cc1plus|gcc|g\+\+|clang|clang\+\+|ld|bun)$/i;

/** One process in the worker tree, as sampled by the orchestrator. `command`
 * is the `ps -o comm=` basename; `cpu` is its `%cpu`. */
export interface ProcessSnapshotEntry {
  command: string;
  cpu: number;
}

/** The two signals the decision consumes, already derived from the worker
 * tree: whether an active build/test descendant exists, and the aggregate
 * cpu% across the tree. */
export interface ReaperSignalSnapshot {
  activeDescendant: boolean;
  cpuPct: number;
}

export type ReaperDecision = "kill" | "no-kill";

export interface DecideReaperSignalInput {
  /** Agent-lane idle duration, seconds. A non-integer collapses to 0 — never
   * past a positive threshold. */
  idleSeconds: number;
  /** Kill threshold, seconds. A non-integer/empty value is unusable (we cannot
   * say a worker is "past" it) and fails safe to no-kill. */
  idleThresholdSeconds: number;
  /** True when an active build/test descendant exists under the worker tree. */
  activeDescendant: boolean;
  /** Worker tree aggregate cpu percent; may be a decimal. Non-numeric → 0. */
  cpuPct: number;
  /** cpu at or above which the worker counts as busy. Defaults to
   * REAPER_SIGNAL_CPU_BUSY_PCT_DEFAULT. */
  cpuBusyPct?: number;
}

/** True when value is a non-negative integer. Mirrors `_reaper_is_uint`. */
function isUint(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** True when value is a finite non-negative number. Mirrors `_reaper_is_num`. */
function isNum(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Reduce a list of descendant processes to the two reaper signals, matching
 * the orchestrator's `sup_active_descendant` / `sup_tree_cpu`: a descendant is
 * "active" when its command basename matches REAPER_BUSY_CMD_RE, and the cpu
 * signal is the aggregate %cpu across the whole tree. */
export function deriveSnapshot(
  descendants: readonly ProcessSnapshotEntry[],
): ReaperSignalSnapshot {
  let activeDescendant = false;
  let cpuPct = 0;
  for (const entry of descendants) {
    if (REAPER_BUSY_CMD_RE.test(entry.command)) activeDescendant = true;
    if (Number.isFinite(entry.cpu)) cpuPct += entry.cpu;
  }
  return { activeDescendant, cpuPct };
}

/** Pure busy-vs-stuck decision. Returns "kill" iff the worker is idle at or
 * past the threshold AND has no active descendant AND shows flat cpu
 * (`cpuPct < cpuBusyPct`); otherwise "no-kill". Ambiguity favours no-kill: cpu
 * exactly at the busy line counts as busy, idle below the threshold is never
 * killed, and an unparseable threshold never kills. Exact parity with bash
 * `reaper_signal_decide`. */
export function decideReaperSignal(input: DecideReaperSignalInput): ReaperDecision {
  // Sanitise numeric signals; unparseable values fail safe toward NOT killing.
  const idleSeconds = isUint(input.idleSeconds) ? input.idleSeconds : 0;
  const cpuPct = isNum(input.cpuPct) ? input.cpuPct : 0;
  const cpuBusyPct = isNum(input.cpuBusyPct ?? NaN)
    ? (input.cpuBusyPct as number)
    : REAPER_SIGNAL_CPU_BUSY_PCT_DEFAULT;

  // An unusable threshold means we cannot say the worker is "past" anything.
  if (!isUint(input.idleThresholdSeconds)) return "no-kill";

  // Within the grace window — not idle long enough to be a candidate.
  if (idleSeconds < input.idleThresholdSeconds) return "no-kill";

  // Busy: an active build/test descendant is doing real work, even if it is
  // blocked on I/O at ~0% cpu.
  if (input.activeDescendant) return "no-kill";

  // Busy: non-trivial cpu despite agent-lane silence (cpu >= busy line).
  if (cpuPct >= cpuBusyPct) return "no-kill";

  // Idle past threshold, no active descendant, flat cpu → genuinely stuck.
  return "kill";
}

/** Thin injectable wrapper around the real process inspection. The default
 * implementation is wired by the caller; the predicate above never touches it,
 * so unit tests pass fixed snapshots directly. */
export type ProcessTreeInspector = (pid: number) => readonly ProcessSnapshotEntry[];

/** Sample the worker tree via an injected inspector and reduce it to the two
 * reaper signals. Keeps the I/O boundary thin so `decideReaperSignal` stays
 * pure and testable. */
export function inspectProcessTree(
  pid: number,
  inspector: ProcessTreeInspector,
): ReaperSignalSnapshot {
  return deriveSnapshot(inspector(pid));
}
