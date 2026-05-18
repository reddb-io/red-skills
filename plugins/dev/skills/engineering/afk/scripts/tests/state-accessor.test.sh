#!/usr/bin/env bash
# Tests for plugins/.../afk/scripts/lib/state.sh.
#
# Two families:
#   1. Fixture reads — state_read_into over canned fixtures asserting the
#      documented v1 defaults, presence, and malformed-tolerance.
#   2. Round-trip writes — state_init + state_write composed via the public
#      API; state_read_into round-trips every set field including nested
#      dotted paths; concurrent simulated writes never leak `.tmp.*` files.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/state.sh"
FIXTURES="$HERE/fixtures/state"

# shellcheck source=../lib/state.sh
source "$LIB"

pass=0
fail=0

# expect_eq <label> <expected> <actual>
expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      expected: %q\n      actual:   %q\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

# ----------------------------------------------------------------------
# Family 1 — fixture reads
# ----------------------------------------------------------------------

# v1-full → every field populated
unset $(compgen -v r_) 2>/dev/null
state_read_into r "$FIXTURES/v1-full.json"
expect_eq "v1-full: pid"                  "4242"                       "$r_pid"
expect_eq "v1-full: worker_id"            "wABCD"                      "$r_worker_id"
expect_eq "v1-full: total"                "3"                          "$r_total"
expect_eq "v1-full: done"                 "1"                          "$r_done"
expect_eq "v1-full: blocked"              "0"                          "$r_blocked"
expect_eq "v1-full: completed (json)"     "[21]"                       "$r_completed"
expect_eq "v1-full: durations_seconds"    "[180]"                      "$r_durations_seconds"
expect_eq "v1-full: envelope_posted"      "true"                       "$r_envelope_posted"
expect_eq "v1-full: filter_kind"          "prd"                        "$r_filter_kind"
expect_eq "v1-full: filter_value"         "16"                         "$r_filter_value"
expect_eq "v1-full: current.number"       "22"                         "$r_current_number"
expect_eq "v1-full: current.title"        "extract state.sh"           "$r_current_title"
expect_eq "v1-full: current.slug"         "extract-state-sh"           "$r_current_slug"
expect_eq "v1-full: current.stage"        "impl"                       "$r_current_stage"
expect_eq "v1-full: current.diff_added"   "47"                         "$r_current_diff_added"
expect_eq "v1-full: current.diff_removed" "12"                         "$r_current_diff_removed"
expect_eq "v1-full: current.retries"      "0"                          "$r_current_retries"

# v1-missing-current → defaults for current.* without errors
unset $(compgen -v m_) 2>/dev/null
state_read_into m "$FIXTURES/v1-missing-current.json"
expect_eq "v1-missing: pid"                  "4242" "$m_pid"
expect_eq "v1-missing: current.number"       ""     "$m_current_number"
expect_eq "v1-missing: current.title"        ""     "$m_current_title"
expect_eq "v1-missing: current.stage"        ""     "$m_current_stage"
expect_eq "v1-missing: current.diff_added"   "0"    "$m_current_diff_added"
expect_eq "v1-missing: current.diff_removed" "0"    "$m_current_diff_removed"
expect_eq "v1-missing: envelope_posted"      "false" "$m_envelope_posted"

# v1-legacy-no-diff-fields → diff_added / diff_removed default to 0
unset $(compgen -v l_) 2>/dev/null
state_read_into l "$FIXTURES/v1-legacy-no-diff-fields.json"
expect_eq "v1-legacy: current.number"       "7"                "$l_current_number"
expect_eq "v1-legacy: current.title"        "legacy iteration" "$l_current_title"
expect_eq "v1-legacy: current.diff_added"   "0"                "$l_current_diff_added"
expect_eq "v1-legacy: current.diff_removed" "0"                "$l_current_diff_removed"
expect_eq "v1-legacy: current.stage"        "impl"             "$l_current_stage"

# v1-malformed → warning to stderr, all defaults
unset $(compgen -v x_) 2>/dev/null
stderr_capture="$(mktemp)"
state_read_into x "$FIXTURES/v1-malformed.json" 2>"$stderr_capture"
expect_eq "v1-malformed: pid defaults"           "0"  "$x_pid"
expect_eq "v1-malformed: current.number default" ""   "$x_current_number"
expect_eq "v1-malformed: envelope_posted default" "false" "$x_envelope_posted"
if grep -q 'malformed state file' "$stderr_capture"; then
  echo "PASS  v1-malformed: warning emitted to stderr"
  pass=$((pass + 1))
else
  echo "FAIL  v1-malformed: warning missing from stderr"
  fail=$((fail + 1))
fi
rm -f "$stderr_capture"

# missing file → defaults (no warning)
unset $(compgen -v n_) 2>/dev/null
state_read_into n "$FIXTURES/does-not-exist.json"
expect_eq "missing-file: pid defaults" "0" "$n_pid"
expect_eq "missing-file: completed defaults" "[]" "$n_completed"

# ----------------------------------------------------------------------
# Family 2 — round-trip writes
# ----------------------------------------------------------------------

TMPDIR_RW="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_RW"' EXIT

P="$TMPDIR_RW/state.json"
state_init "$P" worker_id=wRT01 pid:=12345 log=/tmp/rt.log runner=claude

unset $(compgen -v t_) 2>/dev/null
state_read_into t "$P"
expect_eq "round-trip init: version"       "1"            "$t_version"
expect_eq "round-trip init: worker_id"     "wRT01"        "$t_worker_id"
expect_eq "round-trip init: pid"           "12345"        "$t_pid"
expect_eq "round-trip init: envelope_posted (defaulted false)" "false" "$t_envelope_posted"
expect_eq "round-trip init: current.number (no current yet)"   ""      "$t_current_number"

# Nested dotted writes — string + numeric + boolean variants
state_write "$P" current.number:=42 current.title="hello, state" current.stage=impl \
                 current.diff_added:=12 current.diff_removed:=3 envelope.posted:=true

unset $(compgen -v u_) 2>/dev/null
state_read_into u "$P"
expect_eq "round-trip write: current.number"       "42"           "$u_current_number"
expect_eq "round-trip write: current.title"        "hello, state" "$u_current_title"
expect_eq "round-trip write: current.stage"        "impl"         "$u_current_stage"
expect_eq "round-trip write: current.diff_added"   "12"           "$u_current_diff_added"
expect_eq "round-trip write: current.diff_removed" "3"            "$u_current_diff_removed"
expect_eq "round-trip write: envelope.posted"      "true"         "$u_envelope_posted"
# untouched fields preserved
expect_eq "round-trip write: pid preserved"        "12345"        "$u_pid"
expect_eq "round-trip write: worker_id preserved"  "wRT01"        "$u_worker_id"

# JSON literal writes (arrays / null)
state_write "$P" completed:='[1,2,3]' durations_seconds:='[60,90]' current:=null
unset $(compgen -v v_) 2>/dev/null
state_read_into v "$P"
expect_eq "round-trip write: completed array"   "[1,2,3]" "$v_completed"
expect_eq "round-trip write: durations array"   "[60,90]" "$v_durations_seconds"
expect_eq "round-trip write: current null → defaults" "" "$v_current_number"
expect_eq "round-trip write: current null → diff_added 0" "0" "$v_current_diff_added"

# Atomic write: simulate two concurrent writers; after both, file is valid JSON
# and no `.tmp.*` shrapnel remains.
P2="$TMPDIR_RW/concurrent.json"
state_init "$P2" worker_id=wRT02
(state_write "$P2" current.stage=tests current.diff_added:=5) &
(state_write "$P2" current.stage=merge current.diff_added:=9) &
wait
if jq empty "$P2" 2>/dev/null; then
  echo "PASS  atomic-write: final file parses as JSON"
  pass=$((pass + 1))
else
  echo "FAIL  atomic-write: final file is not valid JSON"
  fail=$((fail + 1))
fi
shrapnel="$(find "$TMPDIR_RW" -name 'concurrent.json.tmp.*' 2>/dev/null)"
if [[ -z "$shrapnel" ]]; then
  echo "PASS  atomic-write: no .tmp.* shrapnel"
  pass=$((pass + 1))
else
  echo "FAIL  atomic-write: leftover tmp files: $shrapnel"
  fail=$((fail + 1))
fi

# state_is_live
P3="$TMPDIR_RW/live.json"
state_init "$P3" pid:=$$           # this shell — alive
if state_is_live "$P3"; then
  echo "PASS  state_is_live: returns 0 for live pid"
  pass=$((pass + 1))
else
  echo "FAIL  state_is_live: should be 0 for live pid"
  fail=$((fail + 1))
fi
state_write "$P3" pid:=999999       # a pid that is almost certainly dead
if ! state_is_live "$P3"; then
  echo "PASS  state_is_live: returns non-zero for dead pid"
  pass=$((pass + 1))
else
  echo "FAIL  state_is_live: should be non-zero for dead pid"
  fail=$((fail + 1))
fi
state_write "$P3" pid:=0
if ! state_is_live "$P3"; then
  echo "PASS  state_is_live: returns non-zero for pid=0"
  pass=$((pass + 1))
else
  echo "FAIL  state_is_live: should be non-zero for pid=0"
  fail=$((fail + 1))
fi

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
