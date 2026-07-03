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

# global options before the subcommand must not bypass the lock
expect_verdict "block/-C path checkout"      "$LOCK" "git -C /repo checkout other"   "block"
expect_verdict "block/-C path switch"        "$LOCK" "git -C /repo switch other"      "block"
expect_verdict "block/-C path checkout -b"   "$LOCK" "git -C /repo checkout -b shiny" "block"
expect_verdict "block/-c config checkout"    "$LOCK" "git -c core.x=1 checkout other" "block"
expect_verdict "block/--git-dir eq switch"   "$LOCK" "git --git-dir=/r/.git switch o" "block"
expect_verdict "block/--git-dir arg switch"  "$LOCK" "git --git-dir /r/.git switch o" "block"
expect_verdict "block/--no-pager checkout"   "$LOCK" "git --no-pager checkout other"  "block"
expect_verdict "block/-C compound"           "$LOCK" "cd x && git -C /r checkout other" "block"
expect_verdict "block/-C reset --hard"       "$LOCK" "git -C /repo reset --hard"      "block"
expect_verdict "block/-C stash"              "$LOCK" "git -C /repo stash"             "block"

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

# global options before the subcommand: legitimate operations still allowed
expect_verdict "allow/-C checkout lock"      "$LOCK" "git -C /repo checkout main"     "allow"
expect_verdict "allow/-C status"             "$LOCK" "git -C /repo status"            "allow"
expect_verdict "allow/-C file restore"       "$LOCK" "git -C /repo checkout -- a.ts"  "allow"
expect_verdict "allow/-C worktree add"       "$LOCK" "git -C /repo worktree add ../w" "allow"

# slash lock target: switching back to it is allowed, elsewhere blocked
expect_verdict "allow/slash lock back"  "feature/x" "git switch feature/x"  "allow"
expect_verdict "block/slash other"      "feature/x" "git switch feature/y"  "block"

# ===========================================================================
# BLOCK — the work-loss family (issue #61)
# ===========================================================================
expect_verdict "block/stash bare"            "$LOCK" "git stash"                   "block"
expect_verdict "block/stash push"            "$LOCK" "git stash push"              "block"
expect_verdict "block/stash push paths"      "$LOCK" "git stash push -m x src/"    "block"
expect_verdict "block/stash save"            "$LOCK" "git stash save wip"          "block"
expect_verdict "block/clean -f"              "$LOCK" "git clean -f"                "block"
expect_verdict "block/clean -fd"             "$LOCK" "git clean -fd"               "block"
expect_verdict "block/clean -xfd"            "$LOCK" "git clean -xfd"              "block"
expect_verdict "block/clean --force"         "$LOCK" "git clean --force"           "block"
expect_verdict "block/reset --hard"          "$LOCK" "git reset --hard"            "block"
expect_verdict "block/reset --hard HEAD~1"   "$LOCK" "git reset --hard HEAD~1"     "block"
expect_verdict "block/checkout dot"          "$LOCK" "git checkout ."              "block"
expect_verdict "block/restore dot"           "$LOCK" "git restore ."              "block"
expect_verdict "block/checkout dashdash dot"  "$LOCK" "git checkout -- ."          "block"
expect_verdict "block/family compound"       "$LOCK" "cd repo && git reset --hard" "block"

# ===========================================================================
# ALLOW — non-destructive members of the same command families
# ===========================================================================
expect_verdict "allow/stash list"            "$LOCK" "git stash list"              "allow"
expect_verdict "allow/stash show"            "$LOCK" "git stash show"              "allow"
expect_verdict "allow/clean dry-run"         "$LOCK" "git clean -n"                "allow"
expect_verdict "allow/clean --dry-run"       "$LOCK" "git clean --dry-run"         "allow"
expect_verdict "allow/reset soft"            "$LOCK" "git reset --soft HEAD~1"     "allow"
expect_verdict "allow/reset mixed default"   "$LOCK" "git reset HEAD file.txt"     "allow"
expect_verdict "allow/restore staged"        "$LOCK" "git restore --staged f.txt"  "allow"
expect_verdict "allow/restore single file"   "$LOCK" "git restore src/app.ts"       "allow"

# ===========================================================================
# PRIMARY BRANCH GUARD — dev.lock.primary-branch (issue #396 / ADR 0043)
# Table: command, cwd-is-primary, flag-state => allow/block.
# ===========================================================================
expect_primary_guard() {
  local label="$1" cmd="$2" primary="$3" flag="$4" expected="$5"
  local actual="allow"
  if [[ "$primary" == "primary" && "$flag" == "on" ]]; then
    actual="$(classify_primary_branch_switch_guard "$cmd")"
  fi
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      cmd:      %q\n      primary:  %q\n      flag:     %q\n      expected: %q\n      actual:   %q\n' \
      "$label" "$cmd" "$primary" "$flag" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

expect_primary_guard "primary/on/switch other blocked"       "git switch other"              primary  on  block
expect_primary_guard "primary/on/checkout other blocked"     "git checkout other"            primary  on  block
expect_primary_guard "primary/on/switch -b new blocked"      "git switch -b new"             primary  on  block
expect_primary_guard "primary/on/checkout -b new blocked"    "git checkout -b new"           primary  on  block
expect_primary_guard "primary/on/compound switch blocked"    "cd repo && git switch other"   primary  on  block
expect_primary_guard "primary/on/-C switch blocked"          "git -C /repo switch other"     primary  on  block
expect_primary_guard "primary/on/-C checkout -b blocked"     "git -C /repo checkout -b new"  primary  on  block
expect_primary_guard "primary/on/switch dash blocked"        "git switch -"                  primary  on  block
expect_primary_guard "primary/on/commit allowed"             "git commit -m wip"             primary  on  allow
expect_primary_guard "primary/on/worktree add allowed"       "git worktree add ../wt other"  primary  on  allow
expect_primary_guard "primary/on/status allowed"             "git status"                    primary  on  allow
expect_primary_guard "primary/on/checkout path allowed"      "git checkout -- src/app.ts"    primary  on  allow
expect_primary_guard "primary/on/checkout dot allowed"       "git checkout ."                primary  on  allow
expect_primary_guard "primary/off/switch allowed"            "git switch other"              primary  off allow
expect_primary_guard "worktree/on/switch allowed"            "git switch other"              worktree on  allow
expect_primary_guard "worktree/off/switch allowed"           "git switch other"              worktree off allow

# ---------------------------------------------------------------------------
# issue #1024: block git reset (any form) and git stash (all subcommands),
# plus git rebase --autostash, in the primary checkout. Parallel human WIP
# lives there; these commands have destroyed in-progress work before.
# ---------------------------------------------------------------------------
expect_primary_guard "primary/on/reset bare blocked"         "git reset"                          primary  on  block
expect_primary_guard "primary/on/reset --hard blocked"       "git reset --hard"                   primary  on  block
expect_primary_guard "primary/on/reset --hard HEAD~1 blocked" "git reset --hard HEAD~1"           primary  on  block
expect_primary_guard "primary/on/reset --soft blocked"       "git reset --soft HEAD~1"            primary  on  block
expect_primary_guard "primary/on/reset --mixed blocked"      "git reset --mixed"                  primary  on  block
expect_primary_guard "primary/on/reset pathspec blocked"     "git reset HEAD file.txt"            primary  on  block
expect_primary_guard "primary/on/-C reset blocked"           "git -C /repo reset --hard"          primary  on  block
expect_primary_guard "primary/on/compound reset blocked"     "cd repo && git reset --hard"        primary  on  block

expect_primary_guard "primary/on/stash bare blocked"         "git stash"                          primary  on  block
expect_primary_guard "primary/on/stash push blocked"         "git stash push"                     primary  on  block
expect_primary_guard "primary/on/stash push paths blocked"   "git stash push -m x src/"           primary  on  block
expect_primary_guard "primary/on/stash save blocked"         "git stash save wip"                 primary  on  block
expect_primary_guard "primary/on/stash pop blocked"          "git stash pop"                      primary  on  block
expect_primary_guard "primary/on/stash apply blocked"        "git stash apply"                    primary  on  block
expect_primary_guard "primary/on/stash list blocked"         "git stash list"                     primary  on  block
expect_primary_guard "primary/on/stash show blocked"         "git stash show"                     primary  on  block
expect_primary_guard "primary/on/-C stash blocked"           "git -C /repo stash"                 primary  on  block

expect_primary_guard "primary/on/rebase autostash blocked"   "git rebase --autostash"             primary  on  block
expect_primary_guard "primary/on/rebase autostash arg blocked" "git rebase --autostash origin/main" primary on block
expect_primary_guard "primary/on/rebase main autostash blocked" "git rebase main --autostash"     primary  on  block

# rebase without --autostash is not the work-loss vector this rule targets
expect_primary_guard "primary/on/rebase plain allowed"       "git rebase main"                    primary  on  allow
expect_primary_guard "primary/on/rebase --no-autostash allowed" "git rebase --no-autostash main"  primary  on  allow

# worktrees stay exempt (scope), flag-off stays inert — for reset/stash too
expect_primary_guard "worktree/on/reset allowed"             "git reset --hard"                   worktree on  allow
expect_primary_guard "worktree/on/stash allowed"             "git stash"                          worktree on  allow
expect_primary_guard "primary/off/reset allowed"             "git reset --hard"                   primary  off allow
expect_primary_guard "primary/off/stash allowed"             "git stash"                          primary  off allow

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
