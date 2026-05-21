#!/usr/bin/env bash
# Unit test for branch-lock-session-start.sh (issue #62).
#
# The SessionStart hook offers — once, at session start — to lock the agent to
# the current branch. It must:
#   - emit an instruction (exit 0, JSON on stdout) in the primary checkout when
#     the branch is unlocked, naming the current branch;
#   - stay silent (no stdout) inside an /afk worktree (scope exemption);
#   - stay silent when a lock is already present (nothing to offer);
#   - stay silent on a detached HEAD (no branch to lock).
#
# Exercises the pure decision/text helpers sourced from the hook script, plus an
# end-to-end run of the hook against throwaway git repos.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$(dirname "$HERE")/branch-lock-session-start.sh"

# Source the script for its pure helpers (the script guards main on direct run).
# shellcheck source=../branch-lock-session-start.sh
source "$HOOK"

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
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      missing: %q\n      in:      %q\n' "$label" "$needle" "$haystack"
    fail=$((fail + 1))
  fi
}

rc_of() { "$@"; echo $?; }

# ===========================================================================
# session_start_should_prompt <root> <lockfile> <branch>
#   prompt only when: primary checkout AND unlocked AND a real branch.
# ===========================================================================
PRIMARY="/home/dev/Work/reddb.io/red-skills"
WT="/home/dev/Work/reddb.io/red-skills/.red/tmp/work-abc-i1/worktree"
ABSENT_LOCK="$(mktemp -u)"   # path that does not exist => unlocked

expect_eq "primary+unlocked+branch => prompt (rc 0)" \
  "0" "$(rc_of session_start_should_prompt "$PRIMARY" "$ABSENT_LOCK" "main")"

expect_eq "worktree => no prompt (rc 1)" \
  "1" "$(rc_of session_start_should_prompt "$WT" "$ABSENT_LOCK" "main")"

expect_eq "detached HEAD => no prompt (rc 1)" \
  "1" "$(rc_of session_start_should_prompt "$PRIMARY" "$ABSENT_LOCK" "HEAD")"

expect_eq "empty branch => no prompt (rc 1)" \
  "1" "$(rc_of session_start_should_prompt "$PRIMARY" "$ABSENT_LOCK" "")"

PRESENT_LOCK="$(mktemp)"; printf 'main\n' > "$PRESENT_LOCK"
expect_eq "already locked => no prompt (rc 1)" \
  "1" "$(rc_of session_start_should_prompt "$PRIMARY" "$PRESENT_LOCK" "feature/x")"
rm -f "$PRESENT_LOCK"

# ===========================================================================
# session_start_prompt_text <branch> — names the branch, instructs to ask.
# ===========================================================================
TEXT="$(session_start_prompt_text "feature/login")"
expect_contains "prompt text names the branch" "feature/login" "$TEXT"
expect_contains "prompt text says to ask the user" "ask" "$TEXT"
expect_contains "prompt text points at /branch-lock" "/branch-lock" "$TEXT"

# ===========================================================================
# End-to-end: run the hook against throwaway repos.
# ===========================================================================
mk_repo() {
  local dir="$1"
  git init -q "$dir"
  git -C "$dir" config user.email t@t.t
  git -C "$dir" config user.name t
  git -C "$dir" commit -q --allow-empty -m init
}

run_hook() { CLAUDE_PROJECT_DIR="$1" bash "$HOOK" <<<'{"hook_event_name":"SessionStart"}'; }

# primary checkout, unlocked => emits JSON with additionalContext naming branch
TMP_PRIMARY="$(mktemp -d)/red-skills"
mk_repo "$TMP_PRIMARY"
git -C "$TMP_PRIMARY" branch -m work-branch
OUT="$(run_hook "$TMP_PRIMARY")"
expect_contains "e2e primary: emits SessionStart event" "SessionStart" "$OUT"
expect_contains "e2e primary: names the branch" "work-branch" "$OUT"
expect_contains "e2e primary: valid additionalContext" "additionalContext" "$OUT"
if command -v jq >/dev/null 2>&1; then
  CTX="$(jq -r '.hookSpecificOutput.additionalContext' <<<"$OUT" 2>/dev/null)"
  expect_contains "e2e primary: JSON parses, branch in context" "work-branch" "$CTX"
fi

# already locked => silent (empty stdout)
mkdir -p "$TMP_PRIMARY/.red/tmp"
printf 'work-branch\n' > "$TMP_PRIMARY/.red/tmp/branch-lock.yaml"
OUT_LOCKED="$(run_hook "$TMP_PRIMARY")"
expect_eq "e2e locked: silent" "" "$OUT_LOCKED"

# worktree => silent even when unlocked
TMP_WT="$(mktemp -d)/red-skills/.red/tmp/work-zzz-i1/worktree"
mkdir -p "$(dirname "$TMP_WT")"
mk_repo "$TMP_WT"
OUT_WT="$(run_hook "$TMP_WT")"
expect_eq "e2e worktree: silent" "" "$OUT_WT"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
