#!/usr/bin/env bash
# Unit test for branch-lock.sh — the /branch-lock CLI (issue #63).
#
# Covers the atomic relock-then-switch contract of `set`:
#   AC1: `set <new>` from a different branch updates the lock AND lands the
#        working tree on <new> in one step.
#   AC2: the intended switch is never blocked by the hook — proven by showing
#        (a) the PreToolUse hook BLOCKS a raw `git switch <new>` while the lock
#        still points at the old branch, yet (b) `set <new>` succeeds anyway,
#        because the CLI rewrites the lock target first so the move it performs
#        is "return to the lock target", which the hook allows.
#   AC3: locking to the branch already checked out just rewrites the target
#        (no switch needed, exit 0).
#
# End-to-end against throwaway git repos: branch-lock.sh runs main() on every
# invocation, so it cannot be sourced for pure helpers — drive it as a subprocess.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
CLI="$SCRIPTS/branch-lock.sh"
HOOK="$SCRIPTS/branch-lock-hook.sh"

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

# A throwaway repo with two branches, left checked out on `main`.
mk_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  git -C "$dir" config user.email t@t.t
  git -C "$dir" config user.name t
  git -C "$dir" commit -q --allow-empty -m init
  git -C "$dir" branch feature
}

current_branch() { git -C "$1" rev-parse --abbrev-ref HEAD; }
locked_branch()  { cat "$1/.red/tmp/branch-lock.yaml" 2>/dev/null | tr -d '\n'; }

# Run the CLI from inside the repo (git operates on cwd) with the root pinned.
run_cli() { local root="$1"; shift; ( cd "$root" && CLAUDE_PROJECT_DIR="$root" bash "$CLI" "$@" ); }
# Run the PreToolUse hook against a Bash command; echoes the exit code.
run_hook() {
  local root="$1" cmd="$2"
  ( cd "$root" && CLAUDE_PROJECT_DIR="$root" bash "$HOOK" \
    <<<"{\"tool_input\":{\"command\":\"$cmd\"}}" ) >/dev/null 2>&1
  echo $?
}

# ===========================================================================
# AC1 — set <new> from a different branch: lock moves AND tree lands on <new>.
# ===========================================================================
R1="$(mktemp -d)/red-skills"; mk_repo "$R1"
OUT1="$(run_cli "$R1" set feature)"; RC1=$?
expect_eq "AC1 set <new>: exit 0" "0" "$RC1"
expect_eq "AC1 set <new>: lock target rewritten" "feature" "$(locked_branch "$R1")"
expect_eq "AC1 set <new>: working tree on new branch" "feature" "$(current_branch "$R1")"
expect_contains "AC1 set <new>: reports the lock" "locked to 'feature'" "$OUT1"

# ===========================================================================
# AC2 — the intended switch is never blocked by the hook.
#   Lock to main first; a raw `git switch feature` is then hook-blocked, but the
#   CLI's `set feature` still succeeds (it relocks first, then switches).
# ===========================================================================
R2="$(mktemp -d)/red-skills"; mk_repo "$R2"
run_cli "$R2" set main >/dev/null
expect_eq "AC2 raw switch to <new> is hook-blocked while locked to old" \
  "2" "$(run_hook "$R2" "git switch feature")"
OUT2="$(run_cli "$R2" set feature)"; RC2=$?
expect_eq "AC2 CLI set <new>: exit 0 despite the old lock" "0" "$RC2"
expect_eq "AC2 CLI set <new>: lock now on new branch" "feature" "$(locked_branch "$R2")"
expect_eq "AC2 CLI set <new>: tree landed on new branch" "feature" "$(current_branch "$R2")"
# And the post-relock state is internally consistent: the hook now allows the
# very move the CLI just made (return to the lock target).
expect_eq "AC2 post-relock: hook allows switch to the new target" \
  "0" "$(run_hook "$R2" "git switch feature")"

# ===========================================================================
# AC3 — locking to the branch already checked out just rewrites the target.
# ===========================================================================
R3="$(mktemp -d)/red-skills"; mk_repo "$R3"   # on main, unlocked
OUT3="$(run_cli "$R3" set main)"; RC3=$?
expect_eq "AC3 set <current>: exit 0" "0" "$RC3"
expect_eq "AC3 set <current>: lock target written" "main" "$(locked_branch "$R3")"
expect_eq "AC3 set <current>: still on the same branch" "main" "$(current_branch "$R3")"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
