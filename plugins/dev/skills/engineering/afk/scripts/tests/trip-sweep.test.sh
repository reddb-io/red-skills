#!/usr/bin/env bash
# Unit tests for the circuit-trip sweep wired into supervisor.sh
# (issue #13). Exercises:
#
#   - parse_worker_ids_from_log — pure parser over the boot stamps
#     afk.sh emits at the top of every spawn. Deduplicated, order
#     preserved.
#   - iter_dirs_for_worker / iter_dir_issue_number — fixture filesystem
#     lookups that locate the work-{wid}-i*/ dirs and pull
#     .current.number out of their afk.state.json.
#   - build_discard_envelope — schema lock for the discard variant.
#     Same `<details data-attempt-status="…">` shape build_envelope
#     emits, so the envelope parser does not need a new branch.
#   - sweep_parked_slot — orchestration with `gh` stubbed out. We only
#     verify the side effects we control: iter dirs removed, idempotent
#     SLOT_SWEPT guard, stub invocation count.
#
# Network-touching paths (real `gh issue comment` / `gh issue edit`) are
# never reached — we shim gh with a function that logs to a file.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SUP_SH="$HERE/../supervisor.sh"

TMP_ROOT="$(mktemp -d -t trip-sweep.XXXXXX)"
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

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then ok "$label"
  else bad "$label" "missing: $needle"; fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then bad "$label" "unexpectedly found: $needle"
  else ok "$label"; fi
}

# ---------- parse_worker_ids_from_log ----------

SLOT_LOG="$TMP_ROOT/slot.log"
cat >"$SLOT_LOG" <<'EOF'
[afk] worker: wAAAA
[afk] some other line
[afk] worker: wBBBB
heartbeat noise
[afk] worker: wAAAA
[afk] worker: wCCCC
EOF

IDS_OUT="$(parse_worker_ids_from_log "$SLOT_LOG" | paste -sd, -)"
assert_eq "parse: dedup + first-seen order" "wAAAA,wBBBB,wCCCC" "$IDS_OUT"

EMPTY_LOG="$TMP_ROOT/empty.log"
: >"$EMPTY_LOG"
EMPTY_OUT="$(parse_worker_ids_from_log "$EMPTY_LOG")"
assert_eq "parse: empty log yields nothing" "" "$EMPTY_OUT"

MISSING_OUT="$(parse_worker_ids_from_log "$TMP_ROOT/does-not-exist.log")"
assert_eq "parse: missing log yields nothing" "" "$MISSING_OUT"

# ---------- iter_dirs_for_worker / iter_dir_issue_number ----------

mkdir -p "$TMP_ROOT/.red/tmp/work-wAAAA-i7"
echo '{"current":{"number":7}}' >"$TMP_ROOT/.red/tmp/work-wAAAA-i7/afk.state.json"
mkdir -p "$TMP_ROOT/.red/tmp/work-wAAAA-i9"
echo '{"current":{"number":9}}' >"$TMP_ROOT/.red/tmp/work-wAAAA-i9/afk.state.json"
mkdir -p "$TMP_ROOT/.red/tmp/work-wBBBB-i7"  # worker died before claim → no state
mkdir -p "$TMP_ROOT/.red/tmp/work-wXXXX-i1"  # unrelated worker, must be ignored
echo '{"current":{"number":99}}' >"$TMP_ROOT/.red/tmp/work-wXXXX-i1/afk.state.json"

DIRS_A="$(iter_dirs_for_worker "wAAAA" | sort | paste -sd, -)"
assert_eq "iter_dirs_for_worker: matches both iter dirs" \
  "$TMP_ROOT/.red/tmp/work-wAAAA-i7,$TMP_ROOT/.red/tmp/work-wAAAA-i9" \
  "$DIRS_A"

DIRS_C="$(iter_dirs_for_worker "wCCCC")"
assert_eq "iter_dirs_for_worker: unknown worker yields nothing" "" "$DIRS_C"

ISSUE7="$(iter_dir_issue_number "$TMP_ROOT/.red/tmp/work-wAAAA-i7")"
assert_eq "iter_dir_issue_number: reads .current.number" "7" "$ISSUE7"

ISSUE_NONE="$(iter_dir_issue_number "$TMP_ROOT/.red/tmp/work-wBBBB-i7")"
assert_eq "iter_dir_issue_number: no state file → empty" "" "$ISSUE_NONE"

# ---------- build_discard_envelope ----------

BODY="$(build_discard_envelope "claude" 0 "wAAAA,wBBBB" 5 ".red/tmp/afk-supervisor.log")"
assert_contains "envelope: opens with data-attempt-status=discarded" "$BODY" '<details data-attempt-status="discarded">'
assert_contains "envelope: summary line names runner"                 "$BODY" 'runner `claude`'
assert_contains "envelope: summary line carries status"               "$BODY" 'status: discarded'
assert_contains "envelope: summary line carries trip cause"           "$BODY" 'cause: runner-broken, slot parked after 5 fast deaths'
assert_contains "envelope: data-section=summary block present"        "$BODY" '<details data-section="summary">'
assert_contains "envelope: slot index"                                "$BODY" 'slot: 0'
assert_contains "envelope: worker IDs csv"                            "$BODY" 'worker IDs: wAAAA,wBBBB'
assert_contains "envelope: fast deaths count"                         "$BODY" 'fast deaths: 5'
assert_contains "envelope: supervisor log path"                       "$BODY" 'supervisor log: .red/tmp/afk-supervisor.log'
assert_not_contains "envelope: no notes section"                      "$BODY" 'data-section="notes"'
assert_not_contains "envelope: no drop section"                       "$BODY" 'data-section="drop"'
assert_not_contains "envelope: no log section"                        "$BODY" 'data-section="log"'

# ---------- sweep_parked_slot (with stubbed gh) ----------

# Stub gh so we record every call without touching the network.
GH_CALLS="$TMP_ROOT/gh.calls"
: >"$GH_CALLS"
gh() {
  printf '%s\n' "$*" >>"$GH_CALLS"
  case "$1" in
    repo) printf 'reddb-io/red-skills\n' ;;
    *)    return 0 ;;
  esac
}
export -f gh

# Stage the slot's bookkeeping so sweep_parked_slot can run.
RED_AFK_TARGET=1
SLOT_SWEPT=(0)
SLOT_FAST_DEATHS=("100 110 120 130 140")  # 5 deaths → matches CIRCUIT_K
SUPERVISOR_RUNNER="claude"

# Stage the slot log + iter dirs.
SWEEP_SLOT_LOG="$TMP_DIR/afk-supervisor-slot-0.log"
cat >"$SWEEP_SLOT_LOG" <<'EOF'
[afk] worker: wAAAA
[afk] worker: wBBBB
EOF

# wAAAA → issue 7 + 9; wBBBB → claimed nothing (no state file).
# (iter dirs already created above)

sweep_parked_slot 0

# Expect: ensure_runner_error_label → gh label create runner-error
assert_contains "sweep calls gh label create runner-error" "$(cat "$GH_CALLS")" 'label create runner-error'

# Expect: gh repo view to resolve repo name.
assert_contains "sweep resolves repo via gh repo view" "$(cat "$GH_CALLS")" 'repo view'

# Expect: gh issue comment for each claimed issue (7 and 9).
COMMENT_LINES="$(grep -c 'issue comment' "$GH_CALLS" || true)"
assert_eq "sweep posts one envelope per claimed issue" "2" "$COMMENT_LINES"
assert_contains "sweep posts envelope on #7" "$(cat "$GH_CALLS")" 'issue comment 7'
assert_contains "sweep posts envelope on #9" "$(cat "$GH_CALLS")" 'issue comment 9'

# Expect: gh issue edit for each claimed issue with the label rotation.
EDIT_LINES="$(grep -c 'issue edit' "$GH_CALLS" || true)"
assert_eq "sweep edits labels for each claimed issue" "2" "$EDIT_LINES"
EDITS="$(grep 'issue edit' "$GH_CALLS")"
assert_contains "sweep adds ready-for-agent"   "$EDITS" '--add-label ready-for-agent'
assert_contains "sweep adds runner-error"      "$EDITS" '--add-label runner-error'
assert_contains "sweep removes ready-for-human" "$EDITS" '--remove-label ready-for-human'
assert_contains "sweep removes running"        "$EDITS" '--remove-label running'

# Expect: every iter dir for the affected workers removed.
[ ! -d "$TMP_ROOT/.red/tmp/work-wAAAA-i7" ] && ok "sweep removed work-wAAAA-i7" || bad "sweep left work-wAAAA-i7"
[ ! -d "$TMP_ROOT/.red/tmp/work-wAAAA-i9" ] && ok "sweep removed work-wAAAA-i9" || bad "sweep left work-wAAAA-i9"
[ ! -d "$TMP_ROOT/.red/tmp/work-wBBBB-i7" ] && ok "sweep removed work-wBBBB-i7" || bad "sweep left work-wBBBB-i7"
# Unrelated worker dir must survive.
[ -d "$TMP_ROOT/.red/tmp/work-wXXXX-i1" ] && ok "sweep preserved unrelated worker dir" || bad "sweep clobbered unrelated worker dir"

# SLOT_SWEPT guard set.
assert_eq "sweep sets SLOT_SWEPT=1" "1" "${SLOT_SWEPT[0]}"

# Idempotency: re-running the sweep is a no-op (no new gh calls, no new
# fs work). Snapshot call count, re-invoke, compare.
PRE_CALLS="$(wc -l <"$GH_CALLS")"
sweep_parked_slot 0
POST_CALLS="$(wc -l <"$GH_CALLS")"
assert_eq "sweep idempotent on re-invocation" "$PRE_CALLS" "$POST_CALLS"

# ---------- no-claimed-issues path ----------
# Reset state and stage a new slot where every observed worker died
# pre-claim (no state files). The sweep must still ensure the label,
# clean iter dirs, and post zero envelopes.
SLOT_SWEPT=(0)
SLOT_FAST_DEATHS=("200 210 220 230 240")
: >"$GH_CALLS"
mkdir -p "$TMP_ROOT/.red/tmp/work-wDDDD-i1"  # no state file
cat >"$SWEEP_SLOT_LOG" <<'EOF'
[afk] worker: wDDDD
EOF

sweep_parked_slot 0

ZERO_COMMENTS="$(grep -c 'issue comment' "$GH_CALLS" || true)"
assert_eq "no-claimed-issues sweep: zero envelopes posted" "0" "$ZERO_COMMENTS"
ZERO_EDITS="$(grep -c 'issue edit' "$GH_CALLS" || true)"
assert_eq "no-claimed-issues sweep: zero label edits"      "0" "$ZERO_EDITS"
[ ! -d "$TMP_ROOT/.red/tmp/work-wDDDD-i1" ] && ok "no-claimed-issues sweep: iter dir removed" || bad "no-claimed-issues sweep: iter dir kept"

# ---------- no-workers-observed path ----------
# Brand new slot, slot log never opened (or empty) → sweep is a no-op,
# no gh calls, no errors.
SLOT_SWEPT=(0)
SLOT_FAST_DEATHS=("300 310 320 330 340")
: >"$GH_CALLS"
: >"$SWEEP_SLOT_LOG"

sweep_parked_slot 0

NO_CALLS="$(wc -l <"$GH_CALLS")"
assert_eq "no-workers-observed sweep: zero gh calls" "0" "$NO_CALLS"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
