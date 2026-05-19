#!/usr/bin/env bash
# Unit tests for the envelope parser + retry handoff builder (Slice C of #2).
#
# afk.sh is sourced for its function definitions; the orchestrator's main
# block stays dormant thanks to the BASH_SOURCE guard at the bottom of afk.sh.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"

# shellcheck disable=SC1090
source "$AFK_SH"

WORKER_ID="wTEST"
FILTER_KIND="all"
FILTER_VALUE=""

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

expect_contains() {
  local label="$1" hay="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$hay"; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label — missing: $needle"
    echo "----- hay -----"; echo "$hay"; echo "---------------"
    fail=$((fail + 1))
  fi
}

expect_not_contains() {
  local label="$1" hay="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$hay"; then
    echo "FAIL  $label — unexpectedly found: $needle"
    fail=$((fail + 1))
  else
    echo "PASS  $label"
    pass=$((pass + 1))
  fi
}

# Helper: build an envelope body using the existing writer so the parser's
# input matches what emit_envelope actually posts on the issue thread.
make_envelope() {
  local status="$1" attempt="$2" notes_body="$3" log_body="${4:-}"
  local summary notes_f log_f
  summary="$(build_envelope_summary "$status" 125 "+5 -2" "$attempt")"
  notes_f="$(mktemp)"
  printf '%s' "$notes_body" > "$notes_f"
  if [[ -n "$log_body" ]]; then
    log_f="$(mktemp)"
    printf '%s' "$log_body" > "$log_f"
    build_envelope "$status" "$summary" "notes" "$notes_f" "log" "$log_f"
    rm -f "$log_f"
  else
    build_envelope "$status" "$summary" "notes" "$notes_f"
  fi
  rm -f "$notes_f"
}

# ---------- classifier predicates ----------
ENV_OK="$(make_envelope blocked 1 'something halted')"
ENV_NOSTATUS=$'<details><summary>boring</summary>\nstuff\n</details>'
HUMAN="Hey, I think the issue is in the parser, can you look?"
BOOT='🤖 /afk started at `2026-05-18T12:00:00-03:00` on runner `claude` (worker `wAB12`). worktree: `.red/tmp/work-wAB12-i1/worktree`'
PROMO='🤖 /afk promoted to ready-for-agent: all blockers closed (#3 #4).'
HEART=':two:'
BLANK=$'   \n  '

envelope_is_envelope "$ENV_OK"        && echo "PASS  classifier/envelope_ok"        && pass=$((pass+1)) || { echo "FAIL  classifier/envelope_ok"; fail=$((fail+1)); }
envelope_is_envelope "$ENV_NOSTATUS"  && { echo "FAIL  classifier/envelope_nostatus"; fail=$((fail+1)); } || { echo "PASS  classifier/envelope_nostatus"; pass=$((pass+1)); }
comment_is_boot_stamp "$BOOT"         && echo "PASS  classifier/boot"               && pass=$((pass+1)) || { echo "FAIL  classifier/boot"; fail=$((fail+1)); }
comment_is_promotion_audit "$PROMO"   && echo "PASS  classifier/promo"              && pass=$((pass+1)) || { echo "FAIL  classifier/promo"; fail=$((fail+1)); }
comment_is_heartbeat_glyph "$HEART"   && echo "PASS  classifier/heart"              && pass=$((pass+1)) || { echo "FAIL  classifier/heart"; fail=$((fail+1)); }
comment_is_human_guidance "$HUMAN"    && echo "PASS  classifier/human"              && pass=$((pass+1)) || { echo "FAIL  classifier/human"; fail=$((fail+1)); }
comment_is_human_guidance "$ENV_OK"   && { echo "FAIL  classifier/envelope_not_human"; fail=$((fail+1)); } || { echo "PASS  classifier/envelope_not_human"; pass=$((pass+1)); }
comment_is_human_guidance "$BOOT"     && { echo "FAIL  classifier/boot_not_human";     fail=$((fail+1)); } || { echo "PASS  classifier/boot_not_human";     pass=$((pass+1)); }
comment_is_human_guidance "$PROMO"    && { echo "FAIL  classifier/promo_not_human";    fail=$((fail+1)); } || { echo "PASS  classifier/promo_not_human";    pass=$((pass+1)); }
comment_is_human_guidance "$HEART"    && { echo "FAIL  classifier/heart_not_human";    fail=$((fail+1)); } || { echo "PASS  classifier/heart_not_human";    pass=$((pass+1)); }
comment_is_human_guidance "$BLANK"    && { echo "FAIL  classifier/blank_not_human";    fail=$((fail+1)); } || { echo "PASS  classifier/blank_not_human";    pass=$((pass+1)); }
# Malformed envelope (missing data-attempt-status) → falls into human guidance.
comment_is_human_guidance "$ENV_NOSTATUS" && echo "PASS  classifier/malformed_envelope_is_human" && pass=$((pass+1)) || { echo "FAIL  classifier/malformed_envelope_is_human"; fail=$((fail+1)); }

# ---------- field/section extractors ----------
expect_eq "field/status"   "$(envelope_field "$ENV_OK" status)"   "blocked"
expect_eq "field/worker"   "$(envelope_field "$ENV_OK" worker)"   "wTEST"
expect_eq "field/duration" "$(envelope_field "$ENV_OK" duration)" "2m5s"

NOTES_OUT="$(envelope_section "$ENV_OK" notes)"
expect_eq "section/notes" "$NOTES_OUT" "something halted"

ENV_WITH_LOG="$(make_envelope no-sentinel 2 'no notes' $'line A\nline B\nline C')"
LOG_OUT="$(envelope_section "$ENV_WITH_LOG" log)"
expect_eq "section/log/strips_fences" "$LOG_OUT" $'line A\nline B\nline C'

# ---------- comments JSON helpers ----------
# Build a JSON array shape matching what gh issue view --json comments returns
# (after the .[].comments | map(...) projection in write_handoff).
comments_array() {
  local out="["
  local first=1 arg
  for arg in "$@"; do
    local author rest created body
    author="${arg%%|*}"
    rest="${arg#*|}"
    created="${rest%%|*}"
    body="${rest#*|}"
    if [[ $first -eq 1 ]]; then first=0; else out+=","; fi
    out+="$(jq -cn --arg a "$author" --arg c "$created" --arg b "$body" \
              '{author:{login:$a}, createdAt:$c, body:$b}')"
  done
  out+="]"
  echo "$out"
}

# Case 1: one BLOCKED envelope + one human reply.
ENV_A="$(make_envelope blocked 1 'first attempt halted on parser')"
COMMENTS_1="$(comments_array \
  "agent|2026-05-18T10:00:00Z|$ENV_A" \
  "alice|2026-05-18T10:30:00Z|the parser needs to handle empty bodies")"

OUT_1="$(build_retry_handoff_body 42 "Test issue" "Issue body here" "claude" 2 "https://github.com/x/y/issues/42" "$COMMENTS_1")"
expect_contains "case1/has issue-body open"     "$OUT_1" "<issue-body>"
expect_contains "case1/has issue-body close"    "$OUT_1" "</issue-body>"
expect_contains "case1/Brief carries body"      "$OUT_1" "Issue body here"
expect_contains "case1/has previous-attempts"   "$OUT_1" "<previous-attempts>"
expect_contains "case1/attempt element"         "$OUT_1" '<previous-attempt n="1"'
expect_contains "case1/attempt status attr"     "$OUT_1" 'status="blocked"'
expect_contains "case1/attempt notes"           "$OUT_1" "first attempt halted on parser"
expect_contains "case1/has guidance thread"     "$OUT_1" "<human-guidance-thread>"
expect_contains "case1/human element open"      "$OUT_1" '<human-guidance author="@alice"'
expect_contains "case1/human element close"     "$OUT_1" "</human-guidance>"
expect_contains "case1/human content"           "$OUT_1" "the parser needs to handle empty bodies"
expect_contains "case1/agent-notes open"        "$OUT_1" "<agent-notes>"
expect_contains "case1/agent-notes close"       "$OUT_1" "</agent-notes>"
expect_not_contains "case1/no legacy Brief"     "$OUT_1" "## Brief"
expect_not_contains "case1/no legacy Notes hdr" "$OUT_1" "## Notes"
# Exactly one attempt entry.
attempts_count="$(grep -c '^<previous-attempt ' <<<"$OUT_1")"
expect_eq "case1/attempts count" "$attempts_count" "1"

# Case 2: three BLOCKED envelopes interspersed with two human replies.
ENV_B1="$(make_envelope blocked 1 'try 1 halt')"
ENV_B2="$(make_envelope blocked 2 'try 2 halt')"
ENV_B3="$(make_envelope blocked 3 'try 3 halt')"
COMMENTS_2="$(comments_array \
  "agent|2026-05-18T10:00:00Z|$ENV_B1" \
  "bob|2026-05-18T10:10:00Z|hint number one" \
  "agent|2026-05-18T10:20:00Z|$ENV_B2" \
  "bob|2026-05-18T10:30:00Z|hint number two" \
  "agent|2026-05-18T10:40:00Z|$ENV_B3")"
OUT_2="$(build_retry_handoff_body 7 "Multi" "body" "claude" 4 "url" "$COMMENTS_2")"
attempts_count_2="$(grep -c '^<previous-attempt ' <<<"$OUT_2")"
human_count_2="$(grep -cE '^<human-guidance author="@bob"' <<<"$OUT_2" || true)"
expect_eq "case2/attempts count" "$attempts_count_2" "3"
expect_eq "case2/human count"    "$human_count_2"    "2"
# Chronological: Attempt 3's body must appear after Attempt 1's body.
pos1=$(grep -n 'try 1 halt' <<<"$OUT_2" | head -n1 | cut -d: -f1)
pos3=$(grep -n 'try 3 halt' <<<"$OUT_2" | head -n1 | cut -d: -f1)
[[ "$pos3" -gt "$pos1" ]] && { echo "PASS  case2/chronological"; pass=$((pass+1)); } || { echo "FAIL  case2/chronological pos1=$pos1 pos3=$pos3"; fail=$((fail+1)); }
hint_pos_1=$(grep -n 'hint number one' <<<"$OUT_2" | head -n1 | cut -d: -f1)
hint_pos_2=$(grep -n 'hint number two' <<<"$OUT_2" | head -n1 | cut -d: -f1)
[[ "$hint_pos_2" -gt "$hint_pos_1" ]] && { echo "PASS  case2/human chronological"; pass=$((pass+1)); } || { echo "FAIL  case2/human chronological"; fail=$((fail+1)); }

# Case 3: noise comments are filtered.
COMMENTS_3="$(comments_array \
  "github-actions|2026-05-18T09:00:00Z|$BOOT" \
  "github-actions|2026-05-18T09:01:00Z|$PROMO" \
  "github-actions|2026-05-18T09:02:00Z|$HEART" \
  "alice|2026-05-18T09:05:00Z|real human guidance content")"
OUT_3="$(build_retry_handoff_body 1 "Noise" "body" "claude" 1 "url" "$COMMENTS_3")"
expect_contains "case3/keeps human"           "$OUT_3" "real human guidance content"
expect_not_contains "case3/drops boot"        "$OUT_3" "/afk started"
expect_not_contains "case3/drops promotion"   "$OUT_3" "promoted to ready-for-agent"
expect_not_contains "case3/drops heartbeat"   "$OUT_3" ":two:"

# Case 4: zero comments → no Previous attempts, no Human guidance sections.
COMMENTS_4="[]"
OUT_4="$(build_retry_handoff_body 1 "Empty" "body" "claude" 1 "url" "$COMMENTS_4")"
expect_contains "case4/has issue-body"         "$OUT_4" "<issue-body>"
expect_not_contains "case4/no Previous"        "$OUT_4" "<previous-attempts>"
expect_not_contains "case4/no Human"           "$OUT_4" "<human-guidance-thread>"
expect_contains "case4/has agent-notes"        "$OUT_4" "<agent-notes>"

# Case 5: malformed envelope falls into Human guidance (acceptance: parser
# does not abort, and the comment surfaces verbatim instead).
COMMENTS_5="$(comments_array \
  "agent|2026-05-18T08:00:00Z|$ENV_NOSTATUS" \
  "alice|2026-05-18T08:05:00Z|please retry")"
OUT_5="$(build_retry_handoff_body 1 "Mal" "body" "claude" 1 "url" "$COMMENTS_5")"
expect_not_contains "case5/no Previous attempts"  "$OUT_5" "<previous-attempts>"
expect_contains    "case5/has guidance thread"    "$OUT_5" "<human-guidance-thread>"
expect_contains    "case5/malformed surfaces"     "$OUT_5" "boring"
expect_contains    "case5/keeps real human"       "$OUT_5" "please retry"

# Case 6: extract_handoff_notes round-trips an inner-agent appended block
# from a real on-disk handoff using the new <agent-notes> XML wrapper.
handoff_tmp="$(mktemp)"
COMMENTS_6="[]"
build_retry_handoff_body 7 "Notes RT" "body text" "claude" 1 "url" "$COMMENTS_6" > "$handoff_tmp"
# Simulate the inner agent appending notes inside <agent-notes>.
python3 - "$handoff_tmp" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1])
txt = p.read_text()
appended = "tried X, hit Y, need Z to proceed"
txt = txt.replace("</agent-notes>", appended + "\n</agent-notes>")
p.write_text(txt)
PY
NOTES_OUT="$(extract_handoff_notes "$handoff_tmp")"
expect_contains "case6/extracts appended notes"   "$NOTES_OUT" "tried X, hit Y"
expect_not_contains "case6/drops placeholder"     "$NOTES_OUT" "inner agent appends"
expect_not_contains "case6/drops open tag"        "$NOTES_OUT" "<agent-notes>"
expect_not_contains "case6/drops close tag"       "$NOTES_OUT" "</agent-notes>"
rm -f "$handoff_tmp"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
