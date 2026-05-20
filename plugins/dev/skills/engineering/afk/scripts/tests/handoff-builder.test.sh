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

# Directive marker helper — mirrors the GitHub-rendered <details> syntax the
# operator pastes (own-line tags, as extract_directives requires).
directive_marker() {
  printf '<details data-kind="directive">\n<summary>directive</summary>\n%s\n</details>' "$1"
}

# ---------- classify_comment routing (PRD #29 #30) ----------
expect_eq "classify/envelope"     "$(classify_comment "$ENV_OK")"                    "envelope"
expect_eq "classify/boot"         "$(classify_comment "$BOOT")"                      "audit_noise"
expect_eq "classify/heart"        "$(classify_comment "$HEART")"                     "audit_noise"
expect_eq "classify/blank"        "$(classify_comment "$BLANK")"                     "audit_noise"
expect_eq "classify/narrative"    "$(classify_comment "$HUMAN")"                     "thread_discussion"
expect_eq "classify/directive"    "$(classify_comment "$(directive_marker x)")"      "directive_carrier"

# Case 1 (AC#1): one marked directive + one narrative-only comment. Marked
# content routes to <human-guidance>; narrative routes to <thread-discussion>.
ENV_A="$(make_envelope blocked 1 'first attempt halted on parser')"
DIR_1="$(directive_marker 'keep foo, just deprecate it')"
COMMENTS_1="$(comments_array \
  "agent|2026-05-18T10:00:00Z|$ENV_A" \
  "alice|2026-05-18T10:30:00Z|$DIR_1" \
  "bob|2026-05-18T10:35:00Z|the parser needs to handle empty bodies")"

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
expect_contains "case1/directive content"       "$OUT_1" "keep foo, just deprecate it"
# Narrative comment is NOT human-guidance — it degrades to thread-discussion.
expect_contains "case1/has thread-discussion"   "$OUT_1" "<thread-discussion>"
expect_contains "case1/thread entry open"       "$OUT_1" '<thread-discussion-entry author="@bob"'
expect_contains "case1/narrative in discussion" "$OUT_1" "the parser needs to handle empty bodies"
expect_contains "case1/agent-notes open"        "$OUT_1" "<agent-notes>"
expect_contains "case1/agent-notes close"       "$OUT_1" "</agent-notes>"
expect_not_contains "case1/no legacy Brief"     "$OUT_1" "## Brief"
expect_not_contains "case1/no legacy Notes hdr" "$OUT_1" "## Notes"
# Exactly one human-guidance element (one directive) and one thread entry.
expect_eq "case1/human count"  "$(grep -cE '^<human-guidance author=' <<<"$OUT_1")"        "1"
expect_eq "case1/thread count" "$(grep -cE '^<thread-discussion-entry author=' <<<"$OUT_1")" "1"
# thread-discussion sits after human-guidance-thread, before agent-notes.
pos_hg=$(grep -n '<human-guidance-thread>' <<<"$OUT_1" | head -n1 | cut -d: -f1)
pos_td=$(grep -n '<thread-discussion>' <<<"$OUT_1" | head -n1 | cut -d: -f1)
pos_an=$(grep -n '<agent-notes>' <<<"$OUT_1" | head -n1 | cut -d: -f1)
{ [[ "$pos_td" -gt "$pos_hg" && "$pos_an" -gt "$pos_td" ]] && echo "PASS  case1/element order"; pass=$((pass+1)); } || { echo "FAIL  case1/element order hg=$pos_hg td=$pos_td an=$pos_an"; fail=$((fail+1)); }

# Case 2 (AC#2): one comment carrying two directive markers → two sibling
# <human-guidance> elements with identical author/at attributes.
DIR_2=$'<details data-kind="directive">\n<summary>directive</summary>\nfirst directive\n</details>\n\nsome chatter between markers\n\n<details data-kind="directive">\n<summary>directive</summary>\nsecond directive\n</details>'
COMMENTS_2="$(comments_array \
  "carol|2026-05-18T11:00:00Z|$DIR_2")"
OUT_2="$(build_retry_handoff_body 7 "Two markers" "body" "claude" 2 "url" "$COMMENTS_2")"
expect_eq "case2/two siblings" "$(grep -cE '^<human-guidance author=' <<<"$OUT_2")" "2"
expect_eq "case2/same author/at" "$(grep -cF '<human-guidance author="@carol" at="2026-05-18T11:00:00Z">' <<<"$OUT_2")" "2"
expect_contains "case2/first directive"  "$OUT_2" "first directive"
expect_contains "case2/second directive" "$OUT_2" "second directive"
# The inter-marker chatter is not its own element (the comment is a single
# directive_carrier; its non-directive prose does not surface).
expect_not_contains "case2/no thread-discussion" "$OUT_2" "<thread-discussion>"
# Document order preserved: first before second.
p1=$(grep -n 'first directive' <<<"$OUT_2" | head -n1 | cut -d: -f1)
p2=$(grep -n 'second directive' <<<"$OUT_2" | head -n1 | cut -d: -f1)
{ [[ "$p2" -gt "$p1" ]] && echo "PASS  case2/document order"; pass=$((pass+1)); } || { echo "FAIL  case2/document order p1=$p1 p2=$p2"; fail=$((fail+1)); }

# Case 3 (AC#3): audit-noise only → neither wrapper appears.
COMMENTS_3="$(comments_array \
  "github-actions|2026-05-18T09:00:00Z|$BOOT" \
  "github-actions|2026-05-18T09:01:00Z|$PROMO" \
  "github-actions|2026-05-18T09:02:00Z|$HEART")"
OUT_3="$(build_retry_handoff_body 1 "Noise" "body" "claude" 1 "url" "$COMMENTS_3")"
expect_not_contains "case3/no human-guidance-thread" "$OUT_3" "<human-guidance-thread>"
expect_not_contains "case3/no thread-discussion"     "$OUT_3" "<thread-discussion>"
expect_not_contains "case3/drops boot"               "$OUT_3" "/afk started"
expect_not_contains "case3/drops promotion"          "$OUT_3" "promoted to ready-for-agent"
expect_not_contains "case3/drops heartbeat"          "$OUT_3" ":two:"

# Case 3b: noise + a real directive → human-guidance present, noise dropped,
# no thread-discussion (no narrative comments).
COMMENTS_3B="$(comments_array \
  "github-actions|2026-05-18T09:00:00Z|$BOOT" \
  "alice|2026-05-18T09:05:00Z|$(directive_marker 'real authoritative guidance')")"
OUT_3B="$(build_retry_handoff_body 1 "Noise+dir" "body" "claude" 1 "url" "$COMMENTS_3B")"
expect_contains     "case3b/keeps directive"       "$OUT_3B" "real authoritative guidance"
expect_contains     "case3b/has guidance thread"   "$OUT_3B" "<human-guidance-thread>"
expect_not_contains "case3b/no thread-discussion"  "$OUT_3B" "<thread-discussion>"
expect_not_contains "case3b/drops boot"            "$OUT_3B" "/afk started"

# Case 4: zero comments → no Previous attempts, no Human guidance, no discussion.
COMMENTS_4="[]"
OUT_4="$(build_retry_handoff_body 1 "Empty" "body" "claude" 1 "url" "$COMMENTS_4")"
expect_contains "case4/has issue-body"            "$OUT_4" "<issue-body>"
expect_not_contains "case4/no Previous"           "$OUT_4" "<previous-attempts>"
expect_not_contains "case4/no Human"              "$OUT_4" "<human-guidance-thread>"
expect_not_contains "case4/no thread-discussion"  "$OUT_4" "<thread-discussion>"
expect_contains "case4/has agent-notes"           "$OUT_4" "<agent-notes>"

# Case 5: malformed envelope (no data-attempt-status) is not a real attempt and
# carries no directive marker → it degrades to thread-discussion verbatim; the
# parser does not abort.
COMMENTS_5="$(comments_array \
  "agent|2026-05-18T08:00:00Z|$ENV_NOSTATUS" \
  "alice|2026-05-18T08:05:00Z|please retry when you can")"
OUT_5="$(build_retry_handoff_body 1 "Mal" "body" "claude" 1 "url" "$COMMENTS_5")"
expect_not_contains "case5/no Previous attempts"  "$OUT_5" "<previous-attempts>"
expect_not_contains "case5/no human-guidance"     "$OUT_5" "<human-guidance-thread>"
expect_contains    "case5/has thread-discussion"  "$OUT_5" "<thread-discussion>"
expect_contains    "case5/malformed surfaces"     "$OUT_5" "boring"
expect_contains    "case5/narrative surfaces"     "$OUT_5" "please retry when you can"

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
