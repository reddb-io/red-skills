#!/usr/bin/env bash
# Smoke test for run_sentinel_watchdog's sentinel detection predicate.
#
# Verifies that:
#   - intermediate mentions of <promise>DONE</promise> / <promise>BLOCKED</promise>
#     inside explanatory prose do NOT match (false-positive guarded against);
#   - final standalone sentinel lines DO match;
#   - the same anchored predicate works for both the Claude stream-json
#     shape (assistant.message.content[].text) and the Codex stream-json
#     shape (item.completed.item.text).
#
# This is not a full test of run_sentinel_watchdog (which spawns a polling
# loop and kills processes); it exercises only the detection predicate
# (jq filter + line-anchored grep) which is the part regressed by #24.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FIXTURES="$HERE/fixtures"

# Predicate values mirror afk.sh — kept in sync manually.
SENTINEL_LINE_REGEX='^<promise>(DONE|BLOCKED)</promise>$'
JSON_EVENT_LINE_REGEX='^[[:space:]]*\{'
CLAUDE_ASSISTANT_TEXT_JQ='select(.type == "assistant").message.content[]? | select(.type == "text").text // empty'
CODEX_ASSISTANT_TEXT_JQ='select(.type == "item.completed") | .item.text // empty'

# Sanity-check the constants in afk.sh haven't drifted from this test.
afk_sh="$HERE/../afk.sh"
for needle in "$SENTINEL_LINE_REGEX" "$JSON_EVENT_LINE_REGEX" "$CLAUDE_ASSISTANT_TEXT_JQ" "$CODEX_ASSISTANT_TEXT_JQ"; do
  if ! grep -qF "$needle" "$afk_sh"; then
    echo "FAIL  afk.sh missing expected predicate constant: $needle" >&2
    exit 1
  fi
done

pass=0
fail=0

check() {
  local label="$1" expect="$2" fixture="$3" jq_filter="$4"
  local got="match"
  if ! jq -r "$jq_filter" "$fixture" 2>/dev/null | grep -qE "$SENTINEL_LINE_REGEX"; then
    got="nomatch"
  fi
  if [ "$got" = "$expect" ]; then
    echo "PASS  $label  (expect=$expect)"
    pass=$((pass + 1))
  else
    echo "FAIL  $label  (expect=$expect got=$got)"
    fail=$((fail + 1))
  fi
}

check "claude/mention-only does not match"     nomatch "$FIXTURES/claude-mention-only.jsonl"  "$CLAUDE_ASSISTANT_TEXT_JQ"
check "claude/final DONE matches"              match   "$FIXTURES/claude-final-done.jsonl"    "$CLAUDE_ASSISTANT_TEXT_JQ"
check "claude/final BLOCKED matches"           match   "$FIXTURES/claude-final-blocked.jsonl" "$CLAUDE_ASSISTANT_TEXT_JQ"
check "codex/mention-only does not match"      nomatch "$FIXTURES/codex-mention-only.jsonl"   "$CODEX_ASSISTANT_TEXT_JQ"
check "codex/final DONE matches"               match   "$FIXTURES/codex-final-done.jsonl"     "$CODEX_ASSISTANT_TEXT_JQ"

got="match"
if ! grep -E "$JSON_EVENT_LINE_REGEX" "$FIXTURES/codex-banner-final-done.jsonl" \
    | jq -r "$CODEX_ASSISTANT_TEXT_JQ" 2>/dev/null \
    | grep -qE "$SENTINEL_LINE_REGEX"; then
  got="nomatch"
fi
if [ "$got" = "match" ]; then
  echo "PASS  codex/non-json banner is ignored  (expect=match)"
  pass=$((pass + 1))
else
  echo "FAIL  codex/non-json banner is ignored  (expect=match got=$got)"
  fail=$((fail + 1))
fi

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
