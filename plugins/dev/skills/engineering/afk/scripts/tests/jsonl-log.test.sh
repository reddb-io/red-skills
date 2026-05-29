#!/usr/bin/env bash
# Unit test for lib/jsonl-log.sh — the JSONL Log Module (PRD #244, issue #246).
#
# Sources the module directly (no orchestrator globals) and exercises the whole
# public surface in isolation:
#   1. envelope shape    — jsonl_log_append writes one well-formed single-line
#      record carrying every standard field (ts, lvl, worker, issue, attempt,
#      type, msg) with the right JSON types, plus arbitrary extra fields.
#   2. malformed input   — missing required args, non-numeric issue/attempt,
#      reserved/ill-formed extra keys, and a msg full of JSON metacharacters all
#      either leave the lane untouched or round-trip as exactly one valid line.
#   3. shared-lane flock — many concurrent jsonl_log_append_shared writers
#      produce exactly N lines, every one independently valid JSON (no
#      interleaving), and all the payloads survive.
#   4. agent-lane contract — jsonl_log_append_agent stamps type=agent and
#      refuses synthetic record types without corrupting the lane.
#   5. readers           — jsonl_log_filter_worker / _filter_type select exactly
#      the matching records, in file order; missing file is a non-zero, silent
#      signal so the caller renders its own empty state.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/jsonl-log.sh"

# shellcheck source=../lib/jsonl-log.sh
source "$LIB"

pass=0
fail=0

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      expected: %q\n      actual:   %q\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

expect_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "FAIL  $label — unexpectedly found: $needle"; fail=$((fail + 1))
  else
    echo "PASS  $label"; pass=$((pass + 1))
  fi
}

# expect_rc <label> <expected_rc> <command...> — assert exit code; on a non-zero
# expectation also assert no stdout (malformed → silent).
expect_rc() {
  local label="$1" expected_rc="$2"; shift 2
  local out rc
  out="$("$@" 2>/dev/null)"; rc=$?
  if [[ "$rc" -ne "$expected_rc" ]]; then
    printf 'FAIL  %s — expected rc %s, got %s\n' "$label" "$expected_rc" "$rc"
    fail=$((fail + 1)); return
  fi
  if [[ "$expected_rc" -ne 0 && -n "$out" ]]; then
    printf 'FAIL  %s — expected no output on failure, got: %q\n' "$label" "$out"
    fail=$((fail + 1)); return
  fi
  echo "PASS  $label"; pass=$((pass + 1))
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ===========================================================================
# 1. Envelope shape — one well-formed single-line record, all standard fields
# ===========================================================================
lane="$WORK/attempt.jsonl"
jsonl_log_append "$lane" "stage" "writing test for X" \
  lvl=info worker=wA1B9 issue=246 attempt=1 stage_n=3
expect_eq "shape/one line after first append" "1" "$(wc -l < "$lane")"
rec="$(tail -n1 "$lane")"
# valid JSON
echo "$rec" | jq -e . >/dev/null 2>&1
expect_eq "shape/record is valid JSON" "0" "$?"
# every standard field present with the right value / type
expect_eq "shape/lvl"            "info"              "$(jq -r '.lvl' <<<"$rec")"
expect_eq "shape/worker"         "wA1B9"             "$(jq -r '.worker' <<<"$rec")"
expect_eq "shape/type"           "stage"             "$(jq -r '.type' <<<"$rec")"
expect_eq "shape/msg"            "writing test for X" "$(jq -r '.msg' <<<"$rec")"
expect_eq "shape/issue is number"   "number" "$(jq -r '.issue | type' <<<"$rec")"
expect_eq "shape/attempt is number" "number" "$(jq -r '.attempt | type' <<<"$rec")"
expect_eq "shape/issue value"    "246" "$(jq -r '.issue' <<<"$rec")"
expect_eq "shape/attempt value"  "1"   "$(jq -r '.attempt' <<<"$rec")"
# ts is stamped and ISO-8601-ish
expect_eq "shape/ts present"     "string" "$(jq -r '.ts | type' <<<"$rec")"
# the extra field rides along verbatim (the "…" of the schema)
expect_eq "shape/extra field"    "3" "$(jq -r '.stage_n' <<<"$rec")"
# canonical field order: ts, lvl, worker, issue, attempt, type, msg, …extra
expect_eq "shape/field order" \
  "ts lvl worker issue attempt type msg stage_n" \
  "$(jq -r 'keys_unsorted | join(" ")' <<<"$rec")"

# defaults applied when the optional fields are omitted
lane2="$WORK/defaults.jsonl"
jsonl_log_append "$lane2" "note" "bare"
rec2="$(tail -n1 "$lane2")"
expect_eq "shape/default lvl info" "info" "$(jq -r '.lvl' <<<"$rec2")"
expect_eq "shape/default worker empty" "" "$(jq -r '.worker' <<<"$rec2")"
expect_eq "shape/default issue 0" "0" "$(jq -r '.issue' <<<"$rec2")"
expect_eq "shape/default attempt 0" "0" "$(jq -r '.attempt' <<<"$rec2")"

# parent directory auto-created
deep="$WORK/a/b/c/lane.jsonl"
jsonl_log_append "$deep" "note" "nested"
expect_eq "shape/auto-creates parent dir" "1" "$(wc -l < "$deep")"

# ===========================================================================
# 2. Malformed input never corrupts the lane
# ===========================================================================
# missing path / type → rc 2, no write
expect_rc "malformed/missing path rc"  2 jsonl_log_append "" "stage" "x"
expect_rc "malformed/missing type rc"  2 jsonl_log_append "$WORK/x.jsonl" "" "x"
expect_eq "malformed/missing type no write" "absent" "$( [[ -e "$WORK/x.jsonl" ]] && echo present || echo absent )"

# non-numeric issue / attempt → rc 3, no write
guard="$WORK/guard.jsonl"
expect_rc "malformed/non-numeric issue"   3 jsonl_log_append "$guard" "note" "m" issue=abc
expect_rc "malformed/non-numeric attempt" 3 jsonl_log_append "$guard" "note" "m" attempt=1.5
# reserved / invalid extra keys → rc 3, no write
expect_rc "malformed/reserved key type"   3 jsonl_log_append "$guard" "note" "m" type=boot
expect_rc "malformed/reserved key ts"     3 jsonl_log_append "$guard" "note" "m" ts=now
expect_rc "malformed/invalid extra key"   3 jsonl_log_append "$guard" "note" "m" "9bad=x"
expect_rc "malformed/no-equals extra"     3 jsonl_log_append "$guard" "note" "m" loneword
expect_eq "malformed/guard lane untouched" "0" "$( [[ -f "$guard" ]] && wc -l < "$guard" || echo 0 )"

# a msg full of JSON metacharacters / newlines → exactly one valid line
nasty="$WORK/nasty.jsonl"
printf -v evil 'quote " brace } bracket ] back\\slash\nNEWLINE\ttab'
jsonl_log_append "$nasty" "agent" "$evil"
expect_eq "malformed/nasty msg stays one line" "1" "$(wc -l < "$nasty")"
echo "$(cat "$nasty")" | jq -e . >/dev/null 2>&1
expect_eq "malformed/nasty msg valid JSON" "0" "$?"
expect_eq "malformed/nasty msg round-trips" "$evil" "$(jq -r '.msg' < "$nasty")"

# ===========================================================================
# 3. Shared-lane flock — concurrent writers never interleave a line
# ===========================================================================
shared="$WORK/shared.jsonl"
N=40
for i in $(seq 1 "$N"); do
  ( jsonl_log_append_shared "$shared" "tick" "msg-$i" worker="w$i" issue="$i" ) &
done
wait
expect_eq "flock/line count == N" "$N" "$(wc -l < "$shared")"
# every single line is independently valid JSON (a torn/interleaved write fails)
bad=0
while IFS= read -r ln; do
  jq -e . >/dev/null 2>&1 <<<"$ln" || bad=$((bad + 1))
done < "$shared"
expect_eq "flock/every line valid JSON (no interleave)" "0" "$bad"
# all N distinct payloads survived — none clobbered another
distinct="$(jq -r '.msg' < "$shared" | sort -u | wc -l | tr -d ' ')"
expect_eq "flock/all N payloads present" "$N" "$distinct"

# ===========================================================================
# 4. Agent-lane contract — agent output only, nothing synthetic
# ===========================================================================
agent="$WORK/agent.jsonl"
jsonl_log_append_agent "$agent" "implementing Y" worker=wA1B9 issue=246
arec="$(tail -n1 "$agent")"
expect_eq "agent/stamps type=agent" "agent" "$(jq -r '.type' <<<"$arec")"
expect_eq "agent/carries msg" "implementing Y" "$(jq -r '.msg' <<<"$arec")"
# an explicit redundant type=agent is accepted (idempotent), still one line
jsonl_log_append_agent "$agent" "still working" type=agent
expect_eq "agent/redundant type=agent accepted" "2" "$(wc -l < "$agent")"
# synthetic types are refused — rc 3, no write
expect_rc "agent/rejects synthetic heartbeat" 3 jsonl_log_append_agent "$agent" "fake" type=heartbeat
expect_rc "agent/rejects synthetic boot"      3 jsonl_log_append_agent "$agent" "fake" type=boot
expect_rc "agent/rejects any non-agent type"  3 jsonl_log_append_agent "$agent" "fake" type=stage
expect_eq "agent/lane uncorrupted after rejects" "2" "$(wc -l < "$agent")"

# ===========================================================================
# 5. Reader helpers — filter by worker and by type
# ===========================================================================
roll="$WORK/rollup.jsonl"
jsonl_log_append "$roll" "stage"     "a" worker=wAAAA
jsonl_log_append "$roll" "agent"     "b" worker=wAAAA
jsonl_log_append "$roll" "stage"     "c" worker=wBBBB
jsonl_log_append "$roll" "heartbeat" "d" worker=wBBBB
jsonl_log_append "$roll" "agent"     "e" worker=wAAAA

# by worker: 3 records for wAAAA, in file order (a, b, e)
by_worker="$(jsonl_log_filter_worker "$roll" wAAAA)"
expect_eq "reader/worker count" "3" "$(wc -l <<<"$by_worker")"
expect_eq "reader/worker order" "a b e" "$(jq -r '.msg' <<<"$by_worker" | paste -sd' ' -)"
expect_not_contains "reader/worker excludes others" "$by_worker" '"worker":"wBBBB"'

# by type: 2 stage records (a, c)
by_type="$(jsonl_log_filter_type "$roll" stage)"
expect_eq "reader/type count" "2" "$(wc -l <<<"$by_type")"
expect_eq "reader/type order" "a c" "$(jq -r '.msg' <<<"$by_type" | paste -sd' ' -)"

# no match on an existing lane → rc 0, empty output
none="$(jsonl_log_filter_type "$roll" nonesuch)"; rc=$?
expect_eq "reader/no-match rc 0" "0" "$rc"
expect_eq "reader/no-match empty" "" "$none"

# missing file → rc 1, silent (caller renders its own empty state)
expect_rc "reader/missing file rc 1" 1 jsonl_log_filter_worker "$WORK/nope.jsonl" wAAAA

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
