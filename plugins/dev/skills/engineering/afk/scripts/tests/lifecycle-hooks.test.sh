#!/usr/bin/env bash
# Unit tests for the per-iteration lifecycle hook wiring in afk.sh (issue #20).
#
# Exercises run_lifecycle_hook + fire_post_iteration by sourcing afk.sh (the
# orchestrator's main block stays dormant via the BASH_SOURCE guard) and
# stubbing hooks_run to record every invocation's AFK_* env contract.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"

# shellcheck disable=SC1090
source "$AFK_SH"
# afk.sh runs `set -eo pipefail` at its top — undo for tests where we
# expect non-zero returns from run_lifecycle_hook.
set +e

pass=0
fail=0

expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label"
    echo "  got:  >>$got<<"
    echo "  want: >>$want<<"
    fail=$((fail + 1))
  fi
}

# ---- recorder stub for hooks_run -------------------------------------------
HOOKS_CALLS_FILE=""
HOOKS_NEXT_RC=0

hooks_run() {
  local point="$1"
  printf '%s|slot=%s|worker=%s|runner=%s|issue=%s|iter_dir=%s|branch=%s|state_file=%s|plugin_dir=%s|status=%s|duration=%s|merge_base=%s|merge_sha=%s\n' \
    "$point" \
    "${RED_AFK_SLOT:-}" "${RED_AFK_WORKER_ID:-}" "${RED_AFK_RUNNER:-}" "${RED_AFK_ISSUE:-}" \
    "${RED_AFK_ITER_DIR:-}" "${RED_AFK_BRANCH:-}" "${RED_AFK_STATE_FILE:-}" \
    "${RED_AFK_PLUGIN_DIR:-}" \
    "${RED_AFK_ITER_STATUS:-}" "${RED_AFK_DURATION_S:-}" \
    "${RED_AFK_MERGE_BASE:-}" "${RED_AFK_MERGE_SHA:-}" \
    >> "$HOOKS_CALLS_FILE"
  return "$HOOKS_NEXT_RC"
}

reset_recorder() {
  HOOKS_CALLS_FILE="$(mktemp -t afk-lifecycle.XXXXXX)"
  HOOKS_NEXT_RC=0
  # Clear extras between cases so we don't leak across tests.
  unset RED_AFK_MERGE_BASE RED_AFK_MERGE_SHA RED_AFK_ITER_STATUS RED_AFK_DURATION_S
}

# ---- 1. run_lifecycle_hook exports the full contract -----------------------
reset_recorder
WORKER_ID=wTEST RUNNER=claude CURRENT_ISSUE=42 CURRENT_BRANCH="afk/wTEST/42-x" \
ITER_DIR=/tmp/iter STATE_FILE=/tmp/iter/state.json SKILL_DIR=/opt/skill RED_AFK_SLOT=3 \
  run_lifecycle_hook pre-iteration
rc=$?
expect_eq "pre-iteration: rc passthrough"        "$rc" "0"
expect_eq "pre-iteration: full env contract" \
  "$(cat "$HOOKS_CALLS_FILE")" \
  "pre-iteration|slot=3|worker=wTEST|runner=claude|issue=42|iter_dir=/tmp/iter|branch=afk/wTEST/42-x|state_file=/tmp/iter/state.json|plugin_dir=/opt/skill|status=|duration=|merge_base=|merge_sha="
rm -f "$HOOKS_CALLS_FILE"

# ---- 2. extras override defaults (pre-merge adds RED_AFK_MERGE_BASE) -----------
reset_recorder
WORKER_ID=wTEST RUNNER=claude CURRENT_ISSUE=42 CURRENT_BRANCH="afk/wTEST/42-x" \
ITER_DIR=/tmp/iter STATE_FILE=/tmp/iter/state.json SKILL_DIR=/opt/skill RED_AFK_SLOT=3 \
  run_lifecycle_hook pre-merge "RED_AFK_MERGE_BASE=deadbee"
rc=$?
expect_eq "pre-merge: rc=0" "$rc" "0"
got="$(awk -F'|' '{print $1, $12}' "$HOOKS_CALLS_FILE")"
expect_eq "pre-merge: carries RED_AFK_MERGE_BASE" "$got" "pre-merge merge_base=deadbee"
rm -f "$HOOKS_CALLS_FILE"

# ---- 3. post-merge adds RED_AFK_MERGE_SHA --------------------------------------
reset_recorder
WORKER_ID=wTEST RUNNER=claude CURRENT_ISSUE=42 CURRENT_BRANCH="afk/wTEST/42-x" \
ITER_DIR=/tmp/iter STATE_FILE=/tmp/iter/state.json SKILL_DIR=/opt/skill \
  run_lifecycle_hook post-merge "RED_AFK_MERGE_SHA=cafef00d"
got="$(awk -F'|' '{print $1, $13}' "$HOOKS_CALLS_FILE")"
expect_eq "post-merge: carries RED_AFK_MERGE_SHA" "$got" "post-merge merge_sha=cafef00d"
rm -f "$HOOKS_CALLS_FILE"

# ---- 4. non-zero hook rc propagates ---------------------------------------
reset_recorder
HOOKS_NEXT_RC=7
WORKER_ID=wTEST RUNNER=claude CURRENT_ISSUE=42 ITER_DIR=/tmp/iter \
  run_lifecycle_hook pre-iteration
rc=$?
expect_eq "non-zero rc: propagates to caller" "$rc" "7"
rm -f "$HOOKS_CALLS_FILE"

# ---- 5. fire_post_iteration replays snapshot after iter_close ------------
reset_recorder
WORKER_ID=wTEST RUNNER=codex CURRENT_ISSUE=99 CURRENT_BRANCH="afk/wTEST/99-y" \
  SKILL_DIR=/opt/skill RED_AFK_SLOT=1
ITER_DIR="/tmp/iter99"
STATE_FILE="/tmp/iter99/state.json"
snapshot_iter_for_hook
# Simulate iter_close_* zeroing the live cursors.
ITER_DIR="" STATE_FILE=""
fire_post_iteration "blocked" "123"
got="$(awk -F'|' '{print $1, $6, $8, $10, $11}' "$HOOKS_CALLS_FILE")"
expect_eq "fire_post_iteration: status + duration + snapshotted dir" \
  "$got" \
  "post-iteration iter_dir=/tmp/iter99 state_file=/tmp/iter99/state.json status=blocked duration=123"
expect_eq "fire_post_iteration: clears CURRENT_ISSUE"  "${CURRENT_ISSUE}"  ""
expect_eq "fire_post_iteration: clears CURRENT_BRANCH" "${CURRENT_BRANCH}" ""
expect_eq "fire_post_iteration: clears LAST_ITER_DIR"  "${LAST_ITER_DIR}"  ""
rm -f "$HOOKS_CALLS_FILE"

# ---- 6. fire_post_iteration swallows non-zero hook rc ---------------------
reset_recorder
HOOKS_NEXT_RC=9
WORKER_ID=wTEST RUNNER=claude CURRENT_ISSUE=11 CURRENT_BRANCH=b SKILL_DIR=/opt/skill
ITER_DIR=/tmp/x STATE_FILE=/tmp/x/state.json
snapshot_iter_for_hook
log_out="$(fire_post_iteration "done" "5" 2>&1)"
rc=$?
expect_eq "fire_post_iteration: returns 0 even on hook failure" "$rc" "0"
if [[ "$log_out" == *"post-iteration hook reported non-zero"* ]]; then
  echo "PASS  fire_post_iteration: logs warning on hook failure"
  pass=$((pass + 1))
else
  echo "FAIL  fire_post_iteration: no warning logged"
  echo "  got: >>$log_out<<"
  fail=$((fail + 1))
fi
rm -f "$HOOKS_CALLS_FILE"

# ---- 7. every documented status string is one we actually fire ----------
# Sanity check that process_issue's terminal sites use only the documented set.
afk_sh="$HERE/../afk.sh"
got_statuses="$(grep -oE 'fire_post_iteration "(done|blocked|no-sentinel|merge-conflict|discarded)"' "$afk_sh" \
  | sed -E 's/.*"([^"]+)".*/\1/' | sort -u | tr '\n' ',' | sed 's/,$//')"
expect_eq "process_issue covers all five documented terminal statuses" \
  "$got_statuses" "blocked,discarded,done,merge-conflict,no-sentinel"

# ---- 8. do_merge wires pre-merge + post-merge ---------------------------
if grep -qE 'run_lifecycle_hook pre-merge "RED_AFK_MERGE_BASE=' "$afk_sh"; then
  echo "PASS  do_merge: pre-merge call carries RED_AFK_MERGE_BASE"
  pass=$((pass + 1))
else
  echo "FAIL  do_merge: pre-merge call missing RED_AFK_MERGE_BASE export"
  fail=$((fail + 1))
fi
if grep -qE 'run_lifecycle_hook post-merge "RED_AFK_MERGE_SHA=' "$afk_sh"; then
  echo "PASS  do_merge: post-merge call carries RED_AFK_MERGE_SHA"
  pass=$((pass + 1))
else
  echo "FAIL  do_merge: post-merge call missing RED_AFK_MERGE_SHA export"
  fail=$((fail + 1))
fi

# ---- 9. pre-iteration abort path restores ready-for-agent --------------
if grep -A4 'pre-iteration hook failed' "$afk_sh" | grep -q 'add-label ready-for-agent'; then
  echo "PASS  pre-iteration abort restores ready-for-agent"
  pass=$((pass + 1))
else
  echo "FAIL  pre-iteration abort does not restore ready-for-agent"
  fail=$((fail + 1))
fi

# ---- summary -----------------------------------------------------------
echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
