#!/usr/bin/env bash
# Unit test for lib/git-command-classifier.sh (issue #60).
#
# Locked to "main", verifies the minimal classifier:
#   block  — checkout/switch to a branch other than the lock target
#   allow  — switching back to the lock target, file-level `checkout -- <path>`,
#            bare checkout, `git worktree add`, and non-git/non-checkout commands

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$(dirname "$HERE")/lib/git-command-classifier.sh"

# shellcheck source=../lib/git-command-classifier.sh
source "$LIB"

pass=0
fail=0

expect_verdict() {
  local label="$1" lock="$2" cmd="$3" expected="$4"
  local actual; actual="$(classify_git_command "$lock" "$cmd")"
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      cmd:      %q\n      expected: %q\n      actual:   %q\n' \
      "$label" "$cmd" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

LOCK="main"

# ===========================================================================
# BLOCK — leaving the locked branch
# ===========================================================================
expect_verdict "block/checkout other"        "$LOCK" "git checkout feature"          "block"
expect_verdict "block/switch other"          "$LOCK" "git switch feature"            "block"
expect_verdict "block/checkout slash branch" "$LOCK" "git checkout feature/x"        "block"
expect_verdict "block/checkout -b new"       "$LOCK" "git checkout -b shiny"         "block"
expect_verdict "block/switch -c new"         "$LOCK" "git switch -c shiny"           "block"
expect_verdict "block/switch dash previous"  "$LOCK" "git switch -"                  "block"
expect_verdict "block/compound command"      "$LOCK" "cd repo && git checkout other" "block"
expect_verdict "block/checkout --track"      "$LOCK" "git checkout --track origin/x" "block"

# ===========================================================================
# ALLOW — same-branch / legitimate operations
# ===========================================================================
expect_verdict "allow/checkout lock target"  "$LOCK" "git checkout main"             "allow"
expect_verdict "allow/switch lock target"    "$LOCK" "git switch main"               "allow"
expect_verdict "allow/file restore --"       "$LOCK" "git checkout -- src/app.ts"    "allow"
expect_verdict "allow/file restore -- multi" "$LOCK" "git checkout -- a.txt b.txt"   "allow"
expect_verdict "allow/bare checkout"         "$LOCK" "git checkout"                   "allow"
expect_verdict "allow/worktree add"          "$LOCK" "git worktree add ../wt branch" "allow"
expect_verdict "allow/non-checkout git"      "$LOCK" "git status"                     "allow"
expect_verdict "allow/non-git command"       "$LOCK" "ls -la"                         "allow"
expect_verdict "allow/commit"                "$LOCK" "git commit -m wip"              "allow"

# slash lock target: switching back to it is allowed, elsewhere blocked
expect_verdict "allow/slash lock back"  "feature/x" "git switch feature/x"  "allow"
expect_verdict "block/slash other"      "feature/x" "git switch feature/y"  "block"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
