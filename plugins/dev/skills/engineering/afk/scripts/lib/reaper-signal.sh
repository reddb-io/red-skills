#!/usr/bin/env bash
# lib/reaper-signal.sh — busy-vs-stuck liveness predicate for the AFK reaper.
#
# The passive stall detector (supervisor.sh, compute_stalled) flags a worker
# whose *agent lane* has gone silent past a threshold. Silence alone is not
# death: a worker can sit mid-`pnpm build` or mid-`vitest` for minutes without
# writing a line to the agent lane, and a hard reaper that keys off lane
# silence alone will kill live work (see #243 — a heartbeat-poisoned firehose
# mtime even defeated the existing kill). This module is the clean liveness
# lane the reaper needs: given the agent-lane idle duration and a process
# snapshot (whether an active build/test descendant exists, and the worker
# tree's aggregate cpu%), it decides kill vs no-kill.
#
# A worker is BUSY (never killed) when, despite agent-lane silence, EITHER
# an active build/test descendant is running (the orchestrator's pstree found
# vitest, tsc, pnpm, cargo, …) OR the worker tree shows non-trivial cpu. It is
# STUCK (eligible to kill) only when ALL hold: idle past the threshold AND no
# active descendant AND flat cpu.
#
# Pure decision, no side effects: it runs neither ps nor pstree and reads no
# globals. The orchestrator owns that I/O — it samples the process tree and
# passes the already-gathered signals in as strings — so the predicate stays
# unit-testable against fixed inputs (scripts/tests/reaper-signal.test.sh).
# Wiring it into the supervisor reap path is a later slice; this module only
# decides.
#
# Public surface:
#   reaper_signal_decide <idle_s> <idle_threshold_s> <active_descendant> <cpu_pct> [<cpu_busy_pct>]
#     Echo `kill` or `no-kill` and always return 0.
#       <idle_s>            agent-lane idle duration, seconds (non-integer → 0).
#       <idle_threshold_s>  kill threshold, seconds. A non-integer/empty value
#                           is unusable — we cannot say a worker is "past" it,
#                           so the decision fails safe to no-kill.
#       <active_descendant> truthy (1/yes/true/y) when an active build/test
#                           descendant exists; anything else (0/no/false/empty)
#                           means none.
#       <cpu_pct>           worker tree aggregate cpu percent, may be a decimal
#                           like `12.5` (non-numeric/empty → 0).
#       <cpu_busy_pct>      cpu at or above which the worker counts as busy
#                           (optional; defaults to
#                           REAPER_SIGNAL_CPU_BUSY_PCT_DEFAULT).
#     Kill iff idle_s >= idle_threshold_s AND NOT active_descendant AND
#     cpu_pct < cpu_busy_pct. Otherwise no-kill. Ambiguity favours no-kill:
#     a cpu exactly at the busy line counts as busy, idle below the threshold
#     is never killed, and an unparseable threshold never kills.

# Default cpu% at or above which a worker counts as "doing non-trivial work".
# A genuinely stuck process blocked in a syscall sits at ~0%; a real build or
# test run is far above this. Override per-call with the 5th argument.
REAPER_SIGNAL_CPU_BUSY_PCT_DEFAULT="5"

# _reaper_truthy <value>  — true for 1/yes/true/y (case-insensitive); else false.
_reaper_truthy() {
  case "${1,,}" in
    1|yes|true|y) return 0 ;;
    *)            return 1 ;;
  esac
}

# _reaper_is_uint <value>  — true when value is a non-negative integer.
_reaper_is_uint() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

# _reaper_is_num <value>  — true when value is a non-negative number, integer
# or decimal: 0, 12, 12.5, .5 all match.
_reaper_is_num() {
  [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ || "$1" =~ ^\.[0-9]+$ ]]
}

# _reaper_cpu_busy <cpu_pct> <busy_pct>  — true (rc 0) when cpu_pct >= busy_pct.
# Float-safe via awk; both args are pre-sanitised numbers.
_reaper_cpu_busy() {
  awk -v c="$1" -v b="$2" 'BEGIN { exit !(c >= b) }'
}

# reaper_signal_decide <idle_s> <idle_threshold_s> <active_descendant> <cpu_pct> [<cpu_busy_pct>]
reaper_signal_decide() {
  local idle_s="${1:-}" idle_threshold_s="${2:-}" active="${3:-}" \
        cpu_pct="${4:-}" cpu_busy_pct="${5:-}"

  # Sanitise the numeric signals; unparseable values fail safe toward NOT
  # killing — idle collapses to 0 (never past a positive threshold) and cpu to
  # 0 (flat), while the busy line falls back to the module default.
  _reaper_is_uint "$idle_s" || idle_s=0
  _reaper_is_num "$cpu_pct" || cpu_pct=0
  _reaper_is_num "$cpu_busy_pct" || cpu_busy_pct="$REAPER_SIGNAL_CPU_BUSY_PCT_DEFAULT"

  # An unusable threshold means we cannot say the worker is "past" anything.
  if ! _reaper_is_uint "$idle_threshold_s"; then
    printf 'no-kill\n'
    return 0
  fi

  # Within the grace window — not idle long enough to be a candidate.
  if (( idle_s < idle_threshold_s )); then
    printf 'no-kill\n'
    return 0
  fi

  # Busy: an active build/test descendant is doing real work, even if it is
  # blocked on I/O at ~0% cpu.
  if _reaper_truthy "$active"; then
    printf 'no-kill\n'
    return 0
  fi

  # Busy: non-trivial cpu despite agent-lane silence.
  if _reaper_cpu_busy "$cpu_pct" "$cpu_busy_pct"; then
    printf 'no-kill\n'
    return 0
  fi

  # Idle past threshold, no active descendant, flat cpu → genuinely stuck.
  printf 'kill\n'
  return 0
}
