#!/usr/bin/env bash
# Unit tests for the passive stall detector wired into supervisor.sh
# (issue #23). Exercises:
#
#   - compute_stalled — pure predicate over (spawn, log_mtime, now,
#     threshold). Locks the four acceptance criteria branches: fresh
#     worker, recently active worker, silent-but-old worker, and the
#     no-log-yet edge case.
#   - find_slot_iter_log + poll_stall_detector — sample loop over a
#     fixture tmp tree, then write_supervisor_state emits a JSON file
#     whose `.stalled[]` shape matches what monitor.sh reads.
#   - poll_stall_detector clears the flag when the log advances.
#
# Network-touching paths are not exercised — supervisor.sh has no
# network paths in the stall codepath, so sourcing it is enough.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SUP_SH="$HERE/../supervisor.sh"

# Sandbox PROJECT_ROOT so supervisor.sh's TMP_DIR points at a fixture
# tree we control. The source-guard returns before main, so no lock
# is taken and no workers are spawned.
TMP_ROOT="$(mktemp -d -t stall-detector.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/.red/tmp"

# Supervisor reads $1 as project_root; pass our sandbox.
# shellcheck disable=SC1090
source "$SUP_SH" "$TMP_ROOT"

pass=0
fail=0

ok()   { echo "PASS  $1"; pass=$((pass+1)); }
bad()  { echo "FAIL  $1"; fail=$((fail+1)); }

assert_eq() {
  local label="$1" expect="$2" got="$3"
  if [ "$expect" = "$got" ]; then ok "$label"; else bad "$label (expect=$expect got=$got)"; fi
}

# ---------- compute_stalled (pure predicate) ----------

NOW=10000
THRESH=600

# Fresh worker (alive < threshold) is never stalled, even with a long-silent log.
assert_eq "fresh worker → no"          "no"  "$(compute_stalled $((NOW-100))  $((NOW-9999)) "$NOW" "$THRESH")"

# Old worker that has produced recent output → not stalled.
assert_eq "recent log activity → no"   "no"  "$(compute_stalled $((NOW-3600)) $((NOW-60))    "$NOW" "$THRESH")"

# Old worker whose log is silent past the threshold → stalled.
assert_eq "old + silent log → yes"     "yes" "$(compute_stalled $((NOW-3600)) $((NOW-700))   "$NOW" "$THRESH")"

# Old worker that never opened a log (mtime=0) is not flagged — there
# is no baseline to compare against, so we wait for the first write.
assert_eq "no log yet → no"            "no"  "$(compute_stalled $((NOW-3600)) 0              "$NOW" "$THRESH")"

# Spawn epoch of zero (uninitialised slot) → no.
assert_eq "spawn=0 → no"               "no"  "$(compute_stalled 0             $((NOW-9999))  "$NOW" "$THRESH")"

# Custom threshold (acceptance: RED_AFK_STALL_THRESHOLD_S=30 trips at 30s).
assert_eq "custom threshold 30s → yes" "yes" "$(compute_stalled $((NOW-31))   $((NOW-31))    "$NOW" 30)"
assert_eq "custom threshold 30s → no"  "no"  "$(compute_stalled $((NOW-29))   $((NOW-29))    "$NOW" 30)"

# ---------- find_slot_iter_log + poll_stall_detector ----------

# Build a fixture iteration directory whose afk.pid matches the slot's
# pid. The fake pid is the test's own PID (always alive while the test
# is running) so kill -0 passes if anyone checks — though this codepath
# only reads files.
RED_AFK_TARGET=1
RED_AFK_STALL_THRESHOLD_S=30
# Nested layout (#252): the attempt dir lives under workers/{wid}/, and the
# slot pid matches the per-worker workers/{wid}/worker.pid.
WORKER_DIR="$TMP_ROOT/.red/tmp/workers/wTEST"
ITER_DIR="$WORKER_DIR/1-a1"
mkdir -p "$ITER_DIR"
echo "$$" > "$WORKER_DIR/worker.pid"
SLOT_PIDS=("$$")

# Liveness is read from the clean agent lane (agent.log.jsonl), never afk.log
# (the heartbeat poisons afk.log every minute — #243). find_slot_iter_log still
# resolves the human log; find_slot_agent_lane resolves the liveness lane.
LOG_PATH="$(find_slot_iter_log 0)"
assert_eq "find_slot_iter_log resolves afk.log" "$ITER_DIR/afk.log" "$LOG_PATH"
LANE_PATH="$(find_slot_agent_lane 0)"
assert_eq "find_slot_agent_lane resolves agent lane" "$ITER_DIR/agent.log.jsonl" "$LANE_PATH"

# 1) Brand-new worker with a fresh agent lane → not flagged.
SLOT_SPAWN_EPOCH=("$(date +%s)")
SLOT_STALLED=(0)
SLOT_STALL_SINCE_EPOCH=(0)
SLOT_STALL_LOG=("")
echo '{"type":"agent","msg":"fresh"}' > "$ITER_DIR/agent.log.jsonl"

poll_stall_detector
assert_eq "fresh worker not flagged"    "0" "${SLOT_STALLED[0]}"

# 2) Backdate spawn and the agent lane mtime past the threshold → flagged.
# afk.log stays fresh (as the heartbeat would keep it) to prove liveness is
# read from the lane, not afk.log.
PAST=$(( $(date +%s) - 120 ))
SLOT_SPAWN_EPOCH=("$PAST")
touch -d "@$PAST" "$ITER_DIR/agent.log.jsonl"
echo "[heartbeat] still beating" > "$ITER_DIR/afk.log"

poll_stall_detector
assert_eq "old + silent agent lane flagged (afk.log fresh)" "1" "${SLOT_STALLED[0]}"

# State file is written and conforms to the monitor's reader contract.
STATE_FILE="$TMP_ROOT/.red/tmp/afk-supervisor-circuit.json"
if [ ! -s "$STATE_FILE" ]; then bad "state file missing"; else ok "state file written"; fi
slot_in_state="$(jq -r '.stalled[0].slot' "$STATE_FILE")"
assert_eq "state.stalled[0].slot"       "0" "$slot_in_state"
dur_in_state="$(jq -r '.stalled[0].duration_s' "$STATE_FILE")"
if [ "$dur_in_state" -ge 100 ]; then ok "duration_s reflects silence"; else bad "duration_s=$dur_in_state (expected ≥100)"; fi

# `parked` array still present and empty so legacy readers do not crash.
parked_len="$(jq -r '.parked | length' "$STATE_FILE")"
assert_eq "parked[] preserved"          "0" "$parked_len"

# 3) Advance the agent lane — flag clears on next poll.
touch "$ITER_DIR/agent.log.jsonl"
poll_stall_detector
assert_eq "stall cleared after activity" "0" "${SLOT_STALLED[0]}"
stalled_len="$(jq -r '.stalled | length' "$STATE_FILE")"
assert_eq "state.stalled[] empty after clear" "0" "$stalled_len"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
