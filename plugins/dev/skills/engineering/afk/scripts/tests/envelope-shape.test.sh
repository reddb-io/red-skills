#!/usr/bin/env bash
# Schema test for the structured envelope writer (Slice A of issue #2 / #6).
#
# We exercise build_envelope and build_envelope_summary directly by sourcing
# afk.sh (the script returns early when sourced — see the BASH_SOURCE guard).
# Network-touching paths (post_envelope, emit_envelope's gh call) are not
# exercised here; this test only locks down the on-the-wire body that gets
# handed to `gh issue comment --body`.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"

# Source afk.sh in a dummy PROJECT_ROOT so precheck/bootstrap stay dormant
# (they only run from the main block, which we skip). $0 stays as the test
# script's name so the BASH_SOURCE guard returns before main.
# shellcheck disable=SC1090
source "$AFK_SH"

WORKER_ID="wTEST"
pass=0
fail=0

expect_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label — missing: $needle"
    echo "----- body -----"
    echo "$haystack"
    echo "----------------"
    fail=$((fail + 1))
  fi
}

expect_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "FAIL  $label — unexpectedly found: $needle"
    fail=$((fail + 1))
  else
    echo "PASS  $label"
    pass=$((pass + 1))
  fi
}

# ---------- summary line ----------
SUM_BLOCKED="$(build_envelope_summary "blocked" 125 "+42 -10" 1)"
expect_contains "summary/blocked carries worker"   "$SUM_BLOCKED" "worker \`wTEST\`"
expect_contains "summary/blocked carries status"   "$SUM_BLOCKED" "status: blocked"
expect_contains "summary/blocked carries duration" "$SUM_BLOCKED" "duration: 2m5s"
expect_contains "summary/blocked carries diff"     "$SUM_BLOCKED" "diff: +42 -10"
expect_contains "summary/blocked carries attempt"  "$SUM_BLOCKED" "attempt: 1"
expect_not_contains "summary/blocked has no merge" "$SUM_BLOCKED" "merge:"

SUM_DONE="$(build_envelope_summary "done" 600 "merged" 2 "abcdef1")"
expect_contains "summary/done carries merged"  "$SUM_DONE" "diff: merged"
expect_contains "summary/done carries attempt" "$SUM_DONE" "attempt: 2"
expect_contains "summary/done carries sha"     "$SUM_DONE" "merge: \`abcdef1\`"

# ---------- envelope body (blocked) ----------
notes_file="$(mktemp)"
printf 'agent could not reproduce, halted\n' > "$notes_file"
BODY_BLOCKED="$(build_envelope "blocked" "$SUM_BLOCKED" "notes" "$notes_file")"
expect_contains "blocked/opens with attempt-status tag" "$BODY_BLOCKED" '<details data-attempt-status="blocked">'
expect_contains "blocked/contains notes section tag"    "$BODY_BLOCKED" '<details data-section="notes">'
expect_contains "blocked/contains notes body"           "$BODY_BLOCKED" 'agent could not reproduce, halted'
expect_not_contains "blocked/has no log section"        "$BODY_BLOCKED" 'data-section="log"'
rm -f "$notes_file"

# ---------- envelope body (no-sentinel) ----------
notes_file="$(mktemp)"; log_file="$(mktemp)"
printf 'no notes appended\n' > "$notes_file"
printf 'line A\nline B\nline C\n' > "$log_file"
SUM_NS="$(build_envelope_summary "no-sentinel" 30 "+0 -0" 1)"
BODY_NS="$(build_envelope "no-sentinel" "$SUM_NS" "notes" "$notes_file" "log" "$log_file")"
expect_contains "no-sentinel/status tag"   "$BODY_NS" '<details data-attempt-status="no-sentinel">'
expect_contains "no-sentinel/notes tag"    "$BODY_NS" '<details data-section="notes">'
expect_contains "no-sentinel/log tag"      "$BODY_NS" '<details data-section="log">'
expect_contains "no-sentinel/log fenced"   "$BODY_NS" '```'
expect_contains "no-sentinel/log content"  "$BODY_NS" 'line C'
rm -f "$notes_file" "$log_file"

# ---------- envelope body (merge-conflict) ----------
log_file="$(mktemp)"
printf 'CONFLICT (content): Merge conflict in foo\n' > "$log_file"
SUM_MC="$(build_envelope_summary "merge-conflict" 800 "+12 -3" 1)"
BODY_MC="$(build_envelope "merge-conflict" "$SUM_MC" "log" "$log_file")"
expect_contains "merge-conflict/status tag" "$BODY_MC" '<details data-attempt-status="merge-conflict">'
expect_contains "merge-conflict/log tag"    "$BODY_MC" '<details data-section="log">'
expect_contains "merge-conflict/diff tail"  "$BODY_MC" 'CONFLICT (content)'
expect_not_contains "merge-conflict/no notes" "$BODY_MC" 'data-section="notes"'
rm -f "$log_file"

# ---------- envelope body (done) ----------
BODY_DONE="$(build_envelope "done" "$SUM_DONE")"
expect_contains "done/status tag"            "$BODY_DONE" '<details data-attempt-status="done">'
expect_contains "done/carries merge sha"     "$BODY_DONE" 'merge: `abcdef1`'
expect_not_contains "done/no diff section"   "$BODY_DONE" 'data-section="diff"'
expect_not_contains "done/no notes section"  "$BODY_DONE" 'data-section="notes"'
expect_not_contains "done/no log section"    "$BODY_DONE" 'data-section="log"'

# ---------- diff section body (Slice B: afk-attempts push) ----------
# build_diff_section_body uses gh_repo() which shells out to `git remote
# get-url origin`. We don't want this test to touch the live repo, so stub it.
gh_repo() { echo "reddb-io/red-skills"; }
# branch_diffstat_full also shells out to git. Stub it to a deterministic value.
branch_diffstat_full() { echo "+12 -3 files=2"; }

DIFF_PUSHED="$(build_diff_section_body "afk/wTEST/9-foo" "afk-attempts/wTEST/9-foo" ".red/tmp/work-wTEST-i9/worktree")"
expect_contains "diff/pushed has compare link" "$DIFF_PUSHED" 'https://github.com/reddb-io/red-skills/compare/main...afk-attempts/wTEST/9-foo'
expect_contains "diff/pushed shows compare label" "$DIFF_PUSHED" 'compare/main...afk-attempts/wTEST/9-foo'
expect_contains "diff/pushed includes diffstat" "$DIFF_PUSHED" '+12 -3 files=2'
expect_not_contains "diff/pushed has no fallback line" "$DIFF_PUSHED" 'push to \`afk-attempts/\` failed'

DIFF_FALLBACK="$(build_diff_section_body "afk/wTEST/9-foo" "" ".red/tmp/work-wTEST-i9/worktree")"
expect_contains "diff/fallback names worktree" "$DIFF_FALLBACK" '.red/tmp/work-wTEST-i9/worktree'
expect_contains "diff/fallback marks push failure" "$DIFF_FALLBACK" 'push to `afk-attempts/` failed'
expect_contains "diff/fallback still includes diffstat" "$DIFF_FALLBACK" '+12 -3 files=2'
expect_not_contains "diff/fallback has no compare link" "$DIFF_FALLBACK" 'compare/main...'

# Diff section composes into the envelope under data-section="diff".
diff_file="$(mktemp)"; printf '%s' "$DIFF_PUSHED" > "$diff_file"
SUM_B="$(build_envelope_summary "blocked" 60 "+12 -3" 1)"
BODY_B_DIFF="$(build_envelope "blocked" "$SUM_B" "diff" "$diff_file")"
expect_contains "envelope/diff section tag" "$BODY_B_DIFF" '<details data-section="diff">'
expect_contains "envelope/diff link rendered" "$BODY_B_DIFF" 'compare/main...afk-attempts/wTEST/9-foo'
rm -f "$diff_file"

# ---------- fmt_duration ----------
[ "$(fmt_duration 0)"   = "0m0s"   ] || { echo "FAIL fmt_duration(0)";   fail=$((fail+1)); }
[ "$(fmt_duration 65)"  = "1m5s"   ] || { echo "FAIL fmt_duration(65)";  fail=$((fail+1)); }
[ "$(fmt_duration 3599)" = "59m59s" ] || { echo "FAIL fmt_duration(3599)"; fail=$((fail+1)); }

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
