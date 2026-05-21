#!/usr/bin/env bash
# Unit test for lib/scope-resolver.sh (issue #60).
#
# The lock enforces in the primary checkout and is exempt in /afk worktrees,
# discriminated purely by toplevel location (.red/tmp/work-*/). Verifies both
# scope_is_worktree and its inverse scope_should_enforce across primary roots,
# worktree roots, and paths nested inside a worktree.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$(dirname "$HERE")/lib/scope-resolver.sh"

# shellcheck source=../lib/scope-resolver.sh
source "$LIB"

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

rc_of() { "$@"; echo $?; }

# ===========================================================================
# primary checkout => enforce (not a worktree)
# ===========================================================================
PRIMARY="/home/dev/Work/reddb.io/red-skills"
expect_eq "primary/is_worktree rc 1"     "1"  "$(rc_of scope_is_worktree "$PRIMARY")"
expect_eq "primary/should_enforce rc 0"  "0"  "$(rc_of scope_should_enforce "$PRIMARY")"

# a path that merely contains '.red/tmp' but is not a work-* worktree still enforces
NEAR="/home/dev/Work/reddb.io/red-skills/.red/tmp"
expect_eq "near/is_worktree rc 1"        "1"  "$(rc_of scope_is_worktree "$NEAR")"

# ===========================================================================
# worktree root => exempt
# ===========================================================================
WT="/home/dev/Work/reddb.io/red-skills/.red/tmp/work-w2UTQ-i60/worktree"
expect_eq "worktree/is_worktree rc 0"    "0"  "$(rc_of scope_is_worktree "$WT")"
expect_eq "worktree/should_enforce rc 1" "1"  "$(rc_of scope_should_enforce "$WT")"

# the .red/tmp/work-* dir itself (one level above the worktree root)
WTROOT="/home/dev/Work/reddb.io/red-skills/.red/tmp/work-abc-i1"
expect_eq "worktree-root/is_worktree rc 0" "0" "$(rc_of scope_is_worktree "$WTROOT")"

# ===========================================================================
# nested path inside a worktree => still exempt
# ===========================================================================
NESTED="/home/dev/Work/reddb.io/red-skills/.red/tmp/work-w2UTQ-i60/worktree/plugins/dev"
expect_eq "nested/is_worktree rc 0"      "0"  "$(rc_of scope_is_worktree "$NESTED")"
expect_eq "nested/should_enforce rc 1"   "1"  "$(rc_of scope_should_enforce "$NESTED")"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
