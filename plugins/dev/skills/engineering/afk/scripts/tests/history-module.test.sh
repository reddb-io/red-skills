#!/usr/bin/env bash
# Unit test for lib/history.sh — the deep History Module (issue #48).
#
# Sources the module directly (no orchestrator globals) and exercises all three
# entry points against temp ledgers / a fixture:
#   1. history_read_done_buckets — bucketing against tests/fixtures/history,
#      including non-`done` events ignored and out-of-window indices dropped,
#      plus the missing-file / custom-width contracts.
#   2. history_append — one JSONL record per call, optional fields present only
#      when non-empty, issue/duration_s emitted as JSON numbers, and a round
#      trip back through history_read_done_buckets.
#   3. history_trim — caps to the bound and echoes the cap; no-op stays silent.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/history.sh"
FIXTURES="$HERE/fixtures/history"

# shellcheck source=../lib/history.sh
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

expect_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label — missing: $needle"; fail=$((fail + 1))
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

# ===========================================================================
# history_read_done_buckets — bucketing against a fixture ledger
# ===========================================================================
# The fixture has done events at hours 1000 (×3), 1005, 1047; one done at hour
# 1048 (out of window above) and one at 999 (below); plus a blocked and an
# exhausted event that must be ignored. With from_hour=1000, width 48:
#   bucket 0 = 3, bucket 5 = 1, bucket 47 = 1, all others 0.
LEDGER="$FIXTURES/buckets.jsonl"
buckets="$(history_read_done_buckets "$LEDGER" 1000 48)"
read -ra B <<<"$buckets"
expect_eq "buckets/width is 48"        "48"  "${#B[@]}"
expect_eq "buckets/bucket 0 (3 done)"  "3"   "${B[0]}"
expect_eq "buckets/bucket 5 (1 done)"  "1"   "${B[5]}"
expect_eq "buckets/bucket 47 (1 done)" "1"   "${B[47]}"
expect_eq "buckets/bucket 1 empty"     "0"   "${B[1]}"
expect_eq "buckets/bucket 46 empty"    "0"   "${B[46]}"
# total done in-window = 5 (the hour-1048 and hour-999 done events fall outside)
total=0; for v in "${B[@]}"; do total=$((total + v)); done
expect_eq "buckets/total in-window = 5" "5" "$total"

# custom width: only the first 6 hours → bucket 0 = 3, bucket 5 = 1
narrow="$(history_read_done_buckets "$LEDGER" 1000 6)"
read -ra N <<<"$narrow"
expect_eq "buckets/narrow width 6"      "6"  "${#N[@]}"
expect_eq "buckets/narrow bucket 0"     "3"  "${N[0]}"
expect_eq "buckets/narrow bucket 5"     "1"  "${N[5]}"

# missing file → non-zero, no output
mb="$(history_read_done_buckets "$FIXTURES/does-not-exist.jsonl" 1000 48)"; rc=$?
expect_eq "buckets/missing file rc"     "1"  "$rc"
expect_eq "buckets/missing file silent" ""   "$mb"

# ===========================================================================
# history_append — one JSONL record per call; optional fields; numeric types
# ===========================================================================
tmp_ledger="$(mktemp -d)/afk-history.jsonl"

# done with merge_sha, no reason → merge_sha present, reason absent
history_append "$tmp_ledger" "done" worker=wTEST issue=42 runner=claude duration_s=600 merge_sha=abcdef1
expect_eq "append/one line after first call" "1" "$(wc -l < "$tmp_ledger")"
line1="$(tail -n1 "$tmp_ledger")"
expect_eq "append/done event"        "done"    "$(jq -r '.event' <<<"$line1")"
expect_eq "append/worker"            "wTEST"   "$(jq -r '.worker' <<<"$line1")"
expect_eq "append/runner"            "claude"  "$(jq -r '.runner' <<<"$line1")"
expect_eq "append/merge_sha"         "abcdef1" "$(jq -r '.merge_sha' <<<"$line1")"
# issue and duration_s are JSON numbers, not strings
expect_eq "append/issue is number"   "number"  "$(jq -r '.issue | type' <<<"$line1")"
expect_eq "append/duration is number" "number" "$(jq -r '.duration_s | type' <<<"$line1")"
expect_eq "append/issue value"       "42"      "$(jq -r '.issue' <<<"$line1")"
# ts and epoch are stamped by the module
expect_eq "append/epoch is number"   "number"  "$(jq -r '.epoch | type' <<<"$line1")"
expect_not_contains "append/no reason key when empty" "$line1" '"reason"'

# blocked with reason, no merge_sha → reason present, merge_sha absent
history_append "$tmp_ledger" "blocked" worker=wTEST issue=43 runner=codex duration_s=12 reason=no-sentinel
expect_eq "append/two lines after second call" "2" "$(wc -l < "$tmp_ledger")"
line2="$(tail -n1 "$tmp_ledger")"
expect_eq "append/blocked reason"    "no-sentinel" "$(jq -r '.reason' <<<"$line2")"
expect_not_contains "append/no merge_sha key when empty" "$line2" '"merge_sha"'

# exhausted with neither optional field → both absent, defaults applied
history_append "$tmp_ledger" "exhausted" worker=wTEST issue=44 runner=claude
line3="$(tail -n1 "$tmp_ledger")"
expect_eq "append/default duration_s 0" "0" "$(jq -r '.duration_s' <<<"$line3")"
expect_not_contains "append/exhausted no merge_sha" "$line3" '"merge_sha"'
expect_not_contains "append/exhausted no reason"    "$line3" '"reason"'

# missing args → non-zero, no write
history_append "$tmp_ledger" "" worker=wX 2>/dev/null; rc=$?
expect_eq "append/missing event rc"  "2"  "$rc"
expect_eq "append/missing event no write" "3" "$(wc -l < "$tmp_ledger")"

# round trip: a done event lands in the right bucket via the reader
rt_ledger="$(mktemp -d)/afk-history.jsonl"
now_h=$(( $(date +%s) / 3600 ))
history_append "$rt_ledger" "done" worker=wRT issue=1 runner=claude duration_s=5 merge_sha=deadbee
rt="$(history_read_done_buckets "$rt_ledger" "$now_h" 48)"
read -ra RT <<<"$rt"
expect_eq "append/round-trip lands in bucket 0" "1" "${RT[0]}"

# ===========================================================================
# history_trim — caps to the bound, echoes the cap; no-op stays silent
# ===========================================================================
trim_ledger="$(mktemp -d)/afk-history.jsonl"
for i in $(seq 1 20); do printf '{"event":"done","epoch":%d}\n' "$i" >> "$trim_ledger"; done
echoed="$(history_trim "$trim_ledger" 5)"
expect_eq "trim/caps to bound"   "5"  "$(wc -l < "$trim_ledger")"
expect_eq "trim/echoes the cap"  "5"  "$echoed"
# the newest 5 lines survive (epoch 16..20), oldest dropped
first_kept="$(head -n1 "$trim_ledger" | jq -r '.epoch')"
expect_eq "trim/keeps newest"    "16" "$first_kept"

# under bound → no-op, silent, file untouched
quiet="$(history_trim "$trim_ledger" 100)"
expect_eq "trim/under bound silent" "" "$quiet"
expect_eq "trim/under bound untouched" "5" "$(wc -l < "$trim_ledger")"

# missing file → silent no-op, rc 0
mt="$(history_trim "$trim_ledger.missing" 5)"; rc=$?
expect_eq "trim/missing file rc 0" "0" "$rc"
expect_eq "trim/missing file silent" "" "$mt"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
