#!/usr/bin/env bash
# Tests for hook-dispatcher.sh — lifecycle hook execution contract
# (issue #208, PRD #207).

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$HERE/../lib/hook-dispatcher.sh"

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
  if [[ "$hay" == *"$needle"* ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label"
    echo "  hay:    >>$hay<<"
    echo "  needle: >>$needle<<"
    fail=$((fail + 1))
  fi
}

reset_state() {
  HOOK_LISTS=()
}

# ---------- 1. empty list returns context unchanged ----------
reset_state
out="$(hook_dispatch pre_session '{"runner":"claude"}')"
rc=$?
expect_eq "empty list: rc=0"          "$rc" "0"
expect_eq "empty list: ctx unchanged" "$out" '{"runner":"claude"}'

# ---------- 2. command with empty stdout leaves context unchanged ----------
reset_state
hook_register pre_session 'true'
out="$(hook_dispatch pre_session '{"runner":"codex"}')"
expect_eq "empty stdout: ctx unchanged" "$out" '{"runner":"codex"}'

# ---------- 3. command with JSON stdout replaces context ----------
reset_state
hook_register pre_session 'printf "%s" "{\"runner\":\"hermes\"}"'
out="$(hook_dispatch pre_session '{"runner":"claude"}')"
expect_eq "json stdout: ctx replaced" "$out" '{"runner":"hermes"}'

# ---------- 4. chained mutations: each command sees previous output ----------
reset_state
hook_register pre_session 'jq ".n = (.n // 0) + 1"'
hook_register pre_session 'jq ".n = .n + 10"'
out="$(hook_dispatch pre_session '{}')"
expect_eq "chained mutation: 0+1+10=11" "$(printf '%s' "$out" | jq -r '.n')" "11"

# ---------- 5. env vars present (only set ones) ----------
reset_state
hook_register pre_session 'jq --arg r "$RED_AFK_RUNNER" ".runner = \$r"'
out="$(RED_AFK_RUNNER=claude hook_dispatch pre_session '{}' 2>/dev/null)"
expect_eq "env var present"    "$(printf '%s' "$out" | jq -r '.runner')" "claude"
reset_state
hook_register pre_session 'printf "%s\n" "iss=${RED_AFK_ISSUE_ID-UNSET}"; printf "%s" "{}"'
# Ensure variable is unset (not empty string).
unset RED_AFK_ISSUE_ID
errlog="$(mktemp)"
hook_dispatch pre_session '{}' >/dev/null 2>"$errlog"
# Look for the marker in the dispatcher's error/log stream.
expect_contains "env var unset (not empty)" "$(cat "$errlog")" "iss=UNSET"
rm -f "$errlog"

# ---------- 6. exit-code policy: pre_session non-zero aborts ----------
reset_state
hook_register pre_session 'exit 7'
hook_register pre_session 'printf "%s" "{\"reached\":true}"'
errlog="$(mktemp)"
out="$(hook_dispatch pre_session '{}' 2>"$errlog")"
rc=$?
expect_eq "pre_session non-zero: rc propagates" "$rc" "7"
# Second command must NOT have run.
expect_eq "pre_session abort: second cmd skipped" "$(printf '%s' "$out" | grep -c reached || true)" "0"
rm -f "$errlog"

# ---------- 7. exit-code policy: post_session non-zero continues ----------
reset_state
hook_register post_session 'exit 9'
hook_register post_session 'printf "%s" "{\"after_fail\":true}"'
errlog="$(mktemp)"
out="$(hook_dispatch post_session '{}' 2>"$errlog")"
rc=$?
expect_eq "post_session non-zero: rc=0" "$rc" "0"
expect_eq "post_session continues: second cmd ran" \
  "$(printf '%s' "$out" | jq -r '.after_fail')" "true"
rm -f "$errlog"

# ---------- 8. non-JSON stdout: pre_session aborts as parse failure ----------
reset_state
hook_register pre_session 'printf "%s" "not json"'
errlog="$(mktemp)"
hook_dispatch pre_session '{}' >/dev/null 2>"$errlog"
rc=$?
[[ $rc -ne 0 ]] && r=ok || r=bad
expect_eq "non-JSON stdout pre_session: abort" "$r" "ok"
expect_contains "non-JSON stdout: parse-failure log" "$(cat "$errlog")" "parse failure"
rm -f "$errlog"

# ---------- 9. non-JSON stdout: post_session logs and continues ----------
reset_state
hook_register post_session 'printf "%s" "still not json"'
hook_register post_session 'printf "%s" "{\"x\":1}"'
errlog="$(mktemp)"
out="$(hook_dispatch post_session '{"orig":1}' 2>"$errlog")"
rc=$?
expect_eq "non-JSON stdout post_session: rc=0" "$rc" "0"
expect_eq "non-JSON stdout post_session: later cmd applied" \
  "$(printf '%s' "$out" | jq -r '.x')" "1"
rm -f "$errlog"

# ---------- 10. unknown hook name → rc=2 ----------
reset_state
hook_dispatch pre_doesnotexist '{}' >/dev/null 2>/dev/null
rc=$?
expect_eq "unknown lifecycle point: rc=2" "$rc" "2"

# ---------- 11. canonical name set covers PRD lifecycle table ----------
names="$(hook_canonical_names | sort | tr '\n' ',')"
for required in pre_session pre_pick post_pick pre_worktree pre_attempt post_attempt pre_merge post_merge on_attempt_error on_idle post_session on_session_error; do
  if [[ ",$names" == *",$required,"* ]]; then
    echo "PASS  canonical includes $required"; pass=$((pass+1))
  else
    echo "FAIL  canonical missing $required"; fail=$((fail+1))
  fi
done

# ---------- 12. renamed (#226): old *_worker names are NOT canonical ----------
for gone in pre_worker post_worker on_worker_error; do
  if [[ ",$names" == *",$gone,"* ]]; then
    echo "FAIL  old name $gone still canonical (should be aliased only)"; fail=$((fail+1))
  else
    echo "PASS  old name $gone removed from canonical set"; pass=$((pass+1))
  fi
done

# ---------- 13. deprecated aliases resolve to their canonical replacement ----------
expect_eq "alias pre_worker → pre_attempt"      "$(hook_canonical_alias pre_worker)"      "pre_attempt"
expect_eq "alias post_worker → post_attempt"    "$(hook_canonical_alias post_worker)"     "post_attempt"
expect_eq "alias on_worker_error → on_attempt_error" "$(hook_canonical_alias on_worker_error)" "on_attempt_error"
# A canonical / unknown name passes through unchanged and returns non-zero.
hook_canonical_alias pre_attempt >/dev/null; expect_eq "pre_attempt is not an alias (rc=1)" "$?" "1"
expect_eq "non-alias prints unchanged" "$(hook_canonical_alias pre_attempt)" "pre_attempt"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
