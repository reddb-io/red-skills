#!/usr/bin/env bash
# Regression tests for issue #251 / #243: the supervisor's stall detector and
# hard-reaper watch the clean agent lane (agent.log.jsonl) for liveness, and
# the irreversible kill is gated behind the reaper-signal predicate.
#
# Exercises the four behaviours the acceptance criteria name:
#   1. #243 masking fix — a worker whose afk.log keeps advancing (the
#      orchestrator heartbeat) but whose agent lane has gone silent past the
#      stall threshold is still flagged stalled. Liveness is read from the lane,
#      never afk.log/firehose (those are heartbeat-poisoned).
#   2. A heartbeat alone no longer keeps a stalled worker alive past the kill
#      threshold — agent-lane silence past KILL with no active descendant and
#      flat cpu is reaped even while afk.log is fresh.
#   3. Busy-by-descendant — agent-lane silence past KILL is NOT reaped while a
#      build/test descendant is active (reaper_signal_decide → no-kill).
#   4. Busy-by-cpu — agent-lane silence past KILL is NOT reaped while the worker
#      tree shows non-trivial cpu.
#
# Network/process paths are stubbed: gh/git write call lines to fixture files,
# sup_kill_tree records the signal instead of sending it, and the process
# samplers (sup_active_descendant / sup_tree_cpu) are overridden per scenario.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SUP_SH="$HERE/../supervisor.sh"

TMP_ROOT="$(mktemp -d -t stall-agent-lane.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/.red/tmp"

# shellcheck disable=SC1090
source "$SUP_SH" "$TMP_ROOT"

pass=0
fail=0
ok()   { echo "PASS  $1"; pass=$((pass+1)); }
bad()  { echo "FAIL  $1${2:+ ($2)}"; fail=$((fail+1)); }
assert_eq() {
  local label="$1" expect="$2" got="$3"
  if [ "$expect" = "$got" ]; then ok "$label"; else bad "$label" "expect=$expect got=$got"; fi
}

# ---------- stubs ----------
GH_CALLS="$TMP_ROOT/gh.calls"
KILL_CALLS="$TMP_ROOT/kill.calls"
LOG_FILE="$TMP_ROOT/.red/tmp/afk-supervisor.log"
: >"$GH_CALLS"; : >"$KILL_CALLS"; : >"$LOG_FILE"

gh() {
  printf '%s\n' "$*" >>"$GH_CALLS"
  case "$1" in
    repo) printf 'reddb-io/red-skills\n' ;;
    *)    return 0 ;;
  esac
}
export -f gh
git() { return 0; }
export -f git
sup_kill_tree() { printf 'sup_kill_tree %s %s\n' "$1" "${2:-TERM}" >>"$KILL_CALLS"; return 0; }

RED_AFK_TARGET=1
RED_AFK_STALL_THRESHOLD_S=30
SUPERVISOR_RUNNER="claude"

# stage_fixture <iter_dir> — create a worker iteration dir (nested #252 layout
# workers/{wid}/{issue}-a{n}) plus the per-worker workers/{wid}/worker.pid this
# shell owns, with afk.log + agent lane + state + handoff, both logs aged 120s.
stage_fixture() {
  local dir="$1" past wdir; past=$(( $(date +%s) - 120 ))
  wdir="$(dirname "$dir")"
  mkdir -p "$dir/worktree"
  echo "$$" > "$wdir/worker.pid"
  cat > "$dir/afk.state.json" <<EOF
{ "worker_id": "wTEST", "started_at": "$(date -Iseconds -d "@$(( $(date +%s) - 200 ))")",
  "current": { "number": 251, "title": "afk reaper agent lane", "slug": "afk-reaper-agent-lane" } }
EOF
  # afk.log stays *fresh* — as a live orchestrator heartbeat would keep it.
  printf '[heartbeat] stage:work t+00:02:00 cpu=0%% rss=10M\n' > "$dir/afk.log"
  printf '<agent-notes>\nmid-iteration note\n</agent-notes>\n' > "$dir/handoff.md"
  # The agent lane is the liveness signal — age it past the kill threshold.
  echo '{"type":"agent","msg":"last turn before the stall"}' > "$dir/agent.log.jsonl"
  touch -d "@$past" "$dir/agent.log.jsonl"
}

# reset_slot — stage slot 0 as a flagged-stalled worker silent 120s on the lane.
reset_slot() {
  SLOT_PIDS=("$$")
  SLOT_SPAWN_EPOCH=("$(( $(date +%s) - 200 ))")
  SLOT_STALLED=(1)
  SLOT_STALL_SINCE_EPOCH=("$(( $(date +%s) - 120 ))")  # silent 120s
  SLOT_STALL_LOG=("$1/agent.log.jsonl")
  SLOT_REAPED=(0)
  SLOT_PARKED=(0)
  SLOT_SWEPT=(0)
}

# ---------- scenario 1: #243 masking fix — flagged off the agent lane ----------
# KILL high so no reap fires; we only assert the flag keys off the lane while
# afk.log is fresh (the heartbeat). A fresh worker not yet flagged is staged,
# poll must flag it from lane silence even though afk.log just moved.
RED_AFK_STALL_KILL_THRESHOLD_S=600
ITER_DIR="$TMP_ROOT/.red/tmp/workers/wTEST/251-a1"
stage_fixture "$ITER_DIR"
SLOT_PIDS=("$$")
SLOT_SPAWN_EPOCH=("$(( $(date +%s) - 200 ))")
SLOT_STALLED=(0); SLOT_STALL_SINCE_EPOCH=(0); SLOT_STALL_LOG=(""); SLOT_REAPED=(0); SLOT_PARKED=(0)
# afk.log moved *just now* (heartbeat); the agent lane is 120s stale.
touch "$ITER_DIR/afk.log"
poll_stall_detector
assert_eq "masking fix: flagged from agent-lane silence (afk.log fresh)" "1" "${SLOT_STALLED[0]}"

# ---------- scenario 2: heartbeat alone does not save a stalled worker ----------
# No active descendant, flat cpu → genuinely stuck → reaped past KILL even
# though afk.log is fresh.
RED_AFK_STALL_KILL_THRESHOLD_S=90
sup_active_descendant() { echo no; }
sup_tree_cpu() { echo 0; }
ITER_DIR="$TMP_ROOT/.red/tmp/workers/wTEST/251-a1"
stage_fixture "$ITER_DIR"
touch "$ITER_DIR/afk.log"   # heartbeat keeps afk.log fresh
reset_slot "$ITER_DIR"
: >"$GH_CALLS"; : >"$KILL_CALLS"
poll_stall_detector
KILLS="$(wc -l <"$KILL_CALLS" 2>/dev/null || echo 0)"
if [ "$KILLS" -ge 1 ]; then ok "reap fires: stuck worker killed despite fresh afk.log"; else bad "reap did not fire" "no kill recorded"; fi
assert_eq "reap fires: SLOT_REAPED guard set" "1" "${SLOT_REAPED[0]}"
assert_eq "reap fires: SLOT_PIDS freed for respawn" "" "${SLOT_PIDS[0]}"
if grep -qF 'data-attempt-status="no-sentinel"' "$GH_CALLS"; then ok "reap fires: no-sentinel envelope posted"; else bad "reap fires: no envelope" ; fi
[ ! -d "$ITER_DIR" ] && ok "reap fires: iter dir torn down" || bad "reap fires: iter dir still present"

# ---------- scenario 3: busy-by-descendant ⇒ no reap ----------
RED_AFK_STALL_KILL_THRESHOLD_S=90
sup_active_descendant() { echo yes; }   # a vitest/build descendant is running
sup_tree_cpu() { echo 0; }              # even at flat cpu, the descendant protects it
ITER_DIR="$TMP_ROOT/.red/tmp/workers/wTEST/251-a1"
stage_fixture "$ITER_DIR"
reset_slot "$ITER_DIR"
: >"$GH_CALLS"; : >"$KILL_CALLS"; : >"$LOG_FILE"
poll_stall_detector
assert_eq "busy descendant: not reaped (SLOT_REAPED stays 0)" "0" "${SLOT_REAPED[0]}"
assert_eq "busy descendant: slot pid retained" "$$" "${SLOT_PIDS[0]}"
KILLS="$(wc -l <"$KILL_CALLS" 2>/dev/null || echo 0)"
assert_eq "busy descendant: no kill issued" "0" "$KILLS"
COMMENTS="$(grep -c 'issue comment' "$GH_CALLS" || true)"
assert_eq "busy descendant: no envelope posted" "0" "$COMMENTS"
[ -d "$ITER_DIR" ] && ok "busy descendant: iter dir preserved" || bad "busy descendant: iter dir removed"
if grep -qF 'deferring reap' "$LOG_FILE"; then ok "busy descendant: deferral logged"; else bad "busy descendant: no deferral log"; fi
assert_eq "busy descendant: still flagged stalled" "1" "${SLOT_STALLED[0]}"

# ---------- scenario 4: busy-by-cpu ⇒ no reap ----------
RED_AFK_STALL_KILL_THRESHOLD_S=90
sup_active_descendant() { echo no; }    # no recognised tool, but...
sup_tree_cpu() { echo 87.5; }           # ...the worker tree is burning cpu
ITER_DIR="$TMP_ROOT/.red/tmp/workers/wTEST/251-a1"
stage_fixture "$ITER_DIR"
reset_slot "$ITER_DIR"
: >"$GH_CALLS"; : >"$KILL_CALLS"
poll_stall_detector
assert_eq "busy cpu: not reaped (SLOT_REAPED stays 0)" "0" "${SLOT_REAPED[0]}"
KILLS="$(wc -l <"$KILL_CALLS" 2>/dev/null || echo 0)"
assert_eq "busy cpu: no kill issued" "0" "$KILLS"
[ -d "$ITER_DIR" ] && ok "busy cpu: iter dir preserved" || bad "busy cpu: iter dir removed"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
