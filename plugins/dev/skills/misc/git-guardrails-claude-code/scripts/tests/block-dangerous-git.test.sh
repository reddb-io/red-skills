#!/usr/bin/env bash
# Unit test for block-dangerous-git.sh — the git-guardrails PreToolUse(Bash) hook
# (issue #65: make git-guardrails lock-aware, independent, no dependency).
#
# Two responsibilities, exercised end-to-end against throwaway repos:
#   1. The always-on dangerous-pattern block (push, reset --hard, …) is
#      unchanged and lock-independent.
#   2. When a branch lock is active in the primary checkout, the hook also blocks
#      the branch-leaving / work-loss family — the same verdicts the branch-lock
#      hook reaches — so git-guardrails alone enforces the lock (AC1). With both
#      hooks installed the overlap is idempotent: both deny, never conflict (AC2).
#      And the script depends on nothing from the branch-lock skill (AC3).

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
HOOK="$SCRIPTS/block-dangerous-git.sh"

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

# A throwaway repo, optionally locked to <branch> via the gitignored lockfile.
mk_repo() {
  local dir="$1" lock="${2:-}"
  git init -q -b main "$dir"
  git -C "$dir" config user.email t@t.t
  git -C "$dir" config user.name t
  git -C "$dir" commit -q --allow-empty -m init
  git -C "$dir" branch feature
  if [[ -n "$lock" ]]; then
    mkdir -p "$dir/.red/tmp"
    printf '%s\n' "$lock" > "$dir/.red/tmp/branch-lock.yaml"
  fi
}

# Run the hook against a Bash command with the project root pinned; echo exit code.
run_hook() {
  local root="$1" cmd="$2"
  ( cd "$root" && CLAUDE_PROJECT_DIR="$root" bash "$HOOK" \
    <<<"{\"tool_input\":{\"command\":\"$cmd\"}}" ) >/dev/null 2>&1
  echo $?
}

# ===========================================================================
# Always-on dangerous patterns — unchanged, lock-independent.
# ===========================================================================
RU="$(mktemp -d)/red-skills"; mk_repo "$RU"            # unlocked
expect_eq "guardrail/push blocked (unlocked)"      "2" "$(run_hook "$RU" "git push origin main")"
expect_eq "guardrail/reset --hard blocked"          "2" "$(run_hook "$RU" "git reset --hard")"
expect_eq "guardrail/clean -fd blocked"             "2" "$(run_hook "$RU" "git clean -fd")"
expect_eq "guardrail/branch -D blocked"             "2" "$(run_hook "$RU" "git branch -D feature")"
expect_eq "guardrail/checkout dot blocked"          "2" "$(run_hook "$RU" "git checkout .")"
expect_eq "guardrail/status allowed"                "0" "$(run_hook "$RU" "git status")"
# Branch switching is NOT a guardrail pattern: allowed when no lock is active.
expect_eq "no-lock/switch other allowed"            "0" "$(run_hook "$RU" "git switch feature")"
expect_eq "no-lock/checkout -b allowed"             "0" "$(run_hook "$RU" "git checkout -b shiny")"
expect_eq "no-lock/stash allowed"                   "0" "$(run_hook "$RU" "git stash")"

# ===========================================================================
# AC1 — lock active in the primary checkout: branch-leaving / work-loss blocked.
# ===========================================================================
RL="$(mktemp -d)/red-skills"; mk_repo "$RL" main       # locked to main
expect_eq "AC1/switch other blocked"                "2" "$(run_hook "$RL" "git switch feature")"
expect_eq "AC1/checkout other blocked"              "2" "$(run_hook "$RL" "git checkout feature")"
expect_eq "AC1/checkout -b new blocked"             "2" "$(run_hook "$RL" "git checkout -b shiny")"
expect_eq "AC1/switch - blocked"                    "2" "$(run_hook "$RL" "git switch -")"
expect_eq "AC1/stash blocked"                       "2" "$(run_hook "$RL" "git stash")"
# Same-branch / legitimate ops still allowed while locked.
expect_eq "AC1/switch back to lock allowed"         "0" "$(run_hook "$RL" "git switch main")"
expect_eq "AC1/checkout back to lock allowed"       "0" "$(run_hook "$RL" "git checkout main")"
expect_eq "AC1/file restore allowed"                "0" "$(run_hook "$RL" "git checkout -- src/app.ts")"
expect_eq "AC1/status allowed while locked"         "0" "$(run_hook "$RL" "git status")"
expect_eq "AC1/worktree add allowed"                "0" "$(run_hook "$RL" "git worktree add ../wt feature")"
# The guardrail patterns still fire while locked (idempotent with the work-loss family).
expect_eq "AC1/push blocked while locked"           "2" "$(run_hook "$RL" "git push")"
expect_eq "AC1/reset --hard blocked while locked"   "2" "$(run_hook "$RL" "git reset --hard")"

# ===========================================================================
# Scope — /afk worktrees under .red/tmp/work-*/ are exempt even with a lock.
# ===========================================================================
WT="$(mktemp -d)/red-skills/.red/tmp/work-abc-i1/worktree"
mkdir -p "$(dirname "$WT")"
mk_repo "$WT" main                                     # lockfile present, but it's a worktree path
expect_eq "scope/worktree switch other allowed"     "0" "$(run_hook "$WT" "git switch feature")"
# …but a worktree's own dangerous patterns still fire (guardrail is scope-independent).
expect_eq "scope/worktree push still blocked"       "2" "$(run_hook "$WT" "git push")"

# ===========================================================================
# AC3 — no dependency on the branch-lock skill: the script must not source or
# require any of its files. (Naming the skill in a comment is fine — what would
# create a dependency is sourcing/dot-including its modules or reaching into its
# directory.)
# ===========================================================================
if grep -qE '(source|^\s*\.)[[:space:]].*(lock-store|scope-resolver|git-command-classifier|branch-lock/)' "$HOOK"; then
  echo "FAIL  AC3/no branch-lock dependency (sources a branch-lock module)"; fail=$((fail + 1))
else
  echo "PASS  AC3/no branch-lock dependency"; pass=$((pass + 1))
fi

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
