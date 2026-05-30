#!/usr/bin/env bash
# attempt-reader.sh — the canonical attempt-exit reader (ADR 0028).
#
# The `<promise>…</promise>` sentinel the inner agent authors is the canonical
# "attempt is over" signal — not pipe EOF, not child-process exit. This module
# owns the three responsibilities that used to be smeared across afk.sh's
# run_claude / run_codex (an ad-hoc `wait` on the pipe plus a background
# watchdog bolted alongside it):
#
#   1. sentinel DETECTION  — scan the runner's captured stream-json for a
#      line-anchored `<promise>DONE|BLOCKED|NO MORE TASKS</promise>` and map it
#      to a normalized outcome (done / blocked / no_more_tasks).
#   2. bounded TEAR-DOWN   — once the sentinel is observed, give the child a
#      grace window to exit on its own, then SIGTERM, then SIGKILL. A
#      daemonising agent that emits the sentinel and then holds the pipe open
#      (a backgrounded poll loop, a tail, a daemon) no longer hangs the loop.
#   3. the WATCH loop      — poll a live pipeline's capture file until a
#      sentinel appears (→ record outcome + tear down) or the pipe dies first
#      (→ EOF-without-sentinel, left for the caller to route to
#      `on_attempt_error`).
#
# Runner adapters source this and call `attempt_reader_watch` in the FOREGROUND
# instead of `wait`-ing on the pipe and trusting EOF. Because the watch runs in
# the caller's shell it can set `ATTEMPT_READER_OUTCOME` directly. Pipe EOF and
# child-process exit are demoted to crash detectors — they only matter when the
# agent failed to author its own exit.

# Guard against double-sourcing (afk.sh sources its lib eagerly; tests source
# the module standalone).
[[ -n "${_ATTEMPT_READER_SH:-}" ]] && return 0
_ATTEMPT_READER_SH=1

# Canonical predicate (ADR 0028). Line-anchored: the contract in
# AGENT-PROMPT.md is "<promise>…</promise> on a line by itself, last" — an
# un-anchored match false-positives on the agent quoting the sentinel inside
# planning prose (issues #4 / #6 / #7). `NO MORE TASKS` is included for
# completeness; the per-attempt runners realistically only ever emit DONE /
# BLOCKED.
ATTEMPT_READER_SENTINEL_REGEX='^<promise>(DONE|BLOCKED|NO MORE TASKS)</promise>$'

# Bounded tear-down windows (seconds): 30s grace → SIGTERM → 10s → SIGKILL,
# per ADR 0028. Overridable for tests and unusual runners. The legacy
# RED_AFK_WATCHDOG_GRACE_S is honoured as a back-compat alias for the grace
# window so operator overrides keep working across the rename.
ATTEMPT_READER_GRACE_S="${RED_AFK_ATTEMPT_GRACE_S:-${RED_AFK_WATCHDOG_GRACE_S:-30}}"
ATTEMPT_READER_KILL_S="${RED_AFK_ATTEMPT_KILL_S:-10}"
ATTEMPT_READER_POLL_S="${RED_AFK_ATTEMPT_POLL_S:-2}"

# The outcome the most recent attempt_reader_watch parsed — `done`, `blocked`,
# `no_more_tasks`, or "" when the pipe closed without a sentinel
# (EOF-without-sentinel → on_attempt_error).
ATTEMPT_READER_OUTCOME=""

# attempt_reader_outcome_from_line LINE
# Map a matched sentinel line to its normalized outcome token. Returns 1 (and
# prints nothing) when the line carries no recognised sentinel.
attempt_reader_outcome_from_line() {
  case "$1" in
    *'<promise>DONE</promise>'*)          printf 'done\n' ;;
    *'<promise>BLOCKED</promise>'*)       printf 'blocked\n' ;;
    *'<promise>NO MORE TASKS</promise>'*) printf 'no_more_tasks\n' ;;
    *) return 1 ;;
  esac
}

# attempt_reader_detect CAPTURE_FILE JQ_FILTER
# Scan a stream-json capture file through JQ_FILTER (which extracts assistant
# text) and print the normalized outcome of the FIRST line-anchored sentinel.
# Returns 1 (printing nothing) when no sentinel is present yet — the file may
# still be filling, so callers poll.
attempt_reader_detect() {
  local capture="$1" jq_filter="$2" line
  [[ -s "$capture" ]] || return 1
  line="$(jq -r "$jq_filter" "$capture" 2>/dev/null \
            | grep -aE "$ATTEMPT_READER_SENTINEL_REGEX" \
            | head -n1)" || true
  [[ -n "$line" ]] || return 1
  attempt_reader_outcome_from_line "$line"
}

# attempt_reader_kill_tree PID [SIGNAL]
# Recursively signal PID and all its descendants (children first). Best-effort,
# always returns 0. This is the blast radius for tearing down a *finished*
# attempt whose child won't relinquish the pipe.
attempt_reader_kill_tree() {
  local pid="$1" sig="${2:-TERM}" k
  [[ -n "$pid" ]] || return 0
  for k in $(pgrep -P "$pid" 2>/dev/null); do
    attempt_reader_kill_tree "$k" "$sig"
  done
  kill -"$sig" "$pid" 2>/dev/null || true
  return 0
}

# attempt_reader_teardown PID [GRACE_S] [KILL_S]
# Bounded tear-down of a finished attempt's pipeline: wait up to GRACE_S for
# PID to exit cleanly, else SIGTERM; wait up to KILL_S more, else SIGKILL. The
# child losing the pipe is a side effect of tearing down a *finished* attempt,
# never a precondition for the orchestrator to move on (ADR 0028). Always
# returns 0 — the orchestrator proceeds regardless of how tear-down resolves.
attempt_reader_teardown() {
  local pid="$1" grace="${2:-$ATTEMPT_READER_GRACE_S}" kill_s="${3:-$ATTEMPT_READER_KILL_S}"
  [[ -n "$pid" ]] || return 0
  local waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < grace )); do
    sleep 1; waited=$((waited + 1))
  done
  kill -0 "$pid" 2>/dev/null || return 0
  attempt_reader_kill_tree "$pid" TERM
  waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < kill_s )); do
    sleep 1; waited=$((waited + 1))
  done
  kill -0 "$pid" 2>/dev/null && attempt_reader_kill_tree "$pid" KILL
  return 0
}

# attempt_reader_watch PID CAPTURE_FILE [JQ_FILTER] [GRACE_S] [KILL_S]
# Drive a live runner pipeline to its sentinel: poll CAPTURE_FILE until a
# sentinel is observed, then record the outcome in ATTEMPT_READER_OUTCOME and
# tear the child down on the bounded timer. If the pipe closes first (EOF)
# without a sentinel, ATTEMPT_READER_OUTCOME is left "" — the caller treats
# that as on_attempt_error (the agent never declared the attempt over). Runs in
# the FOREGROUND so the parsed outcome lands in the caller's shell. Always
# returns 0.
attempt_reader_watch() {
  local pid="$1" capture="$2" jq_filter="${3:-}"
  local grace="${4:-$ATTEMPT_READER_GRACE_S}" kill_s="${5:-$ATTEMPT_READER_KILL_S}"
  ATTEMPT_READER_OUTCOME=""
  local outcome
  while kill -0 "$pid" 2>/dev/null; do
    if outcome="$(attempt_reader_detect "$capture" "$jq_filter")"; then
      ATTEMPT_READER_OUTCOME="$outcome"
      attempt_reader_teardown "$pid" "$grace" "$kill_s"
      return 0
    fi
    sleep "$ATTEMPT_READER_POLL_S"
  done
  # Pipe closed without us seeing a sentinel. Last-chance scan: the sentinel
  # may have landed in the final flush right before EOF.
  if outcome="$(attempt_reader_detect "$capture" "$jq_filter")"; then
    ATTEMPT_READER_OUTCOME="$outcome"
  fi
  return 0
}
