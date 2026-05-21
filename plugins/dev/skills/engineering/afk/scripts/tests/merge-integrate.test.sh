#!/usr/bin/env bash
# Tests for plugins/.../afk/scripts/lib/merge.sh.
#
# Exercises the two failure-prone steps of the afk merge stage (issue #37)
# against real temporary git repos with a local bare "origin":
#   1. merge_integrate_origin — fast-forward a stale local main onto a moved
#      origin/main, and rebase a divergent local snapshot onto it, so the
#      worker branch merges onto the current tip and the push fast-forwards.
#   2. merge_rollback — drop the merge commit after a simulated push rejection
#      so local main carries no orphan merge commit.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/merge.sh"

# shellcheck source=../lib/merge.sh
source "$LIB"

pass=0
fail=0

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      expected: %q\n      actual:   %q\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

expect_ok() {
  local label="$1"; shift
  if "$@"; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label (command failed: $*)"
    fail=$((fail + 1))
  fi
}

expect_fail() {
  local label="$1"; shift
  if "$@"; then
    echo "FAIL  $label (command unexpectedly succeeded: $*)"
    fail=$((fail + 1))
  else
    echo "PASS  $label"
    pass=$((pass + 1))
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Quiet, deterministic git in every repo we spin up.
git_init_repo() {
  local repo="$1"
  git -C "$repo" config user.email afk@test.local
  git -C "$repo" config user.name "AFK Test"
  git -C "$repo" config commit.gpgsign false
}

commit_file() {
  local repo="$1" path="$2" content="$3" msg="$4"
  printf '%s\n' "$content" > "$repo/$path"
  git -C "$repo" add "$path"
  git -C "$repo" commit -q -m "$msg"
}

# Build a fresh world: bare origin seeded with C0 on main, a primary clone, and
# an "external" clone used to advance origin/main behind primary's back.
make_world() {
  local root="$1"
  mkdir -p "$root"
  git init -q --bare "$root/origin.git"

  git clone -q "$root/origin.git" "$root/primary" 2>/dev/null
  git_init_repo "$root/primary"
  commit_file "$root/primary" base.txt "c0" "C0 base"
  git -C "$root/primary" branch -M main
  git -C "$root/primary" push -q -u origin main

  git clone -q "$root/origin.git" "$root/external" 2>/dev/null
  git_init_repo "$root/external"
}

# external pushes a non-conflicting commit to origin/main.
external_advance() {
  local root="$1" path="$2" content="$3" msg="$4"
  git -C "$root/external" pull -q origin main
  commit_file "$root/external" "$path" "$content" "$msg"
  git -C "$root/external" push -q origin main
}

# ----------------------------------------------------------------------
# Scenario 1 — stale base, fast-forward integration then clean merge + push
# ----------------------------------------------------------------------
W1="$TMP/ff"
make_world "$W1"
P="$W1/primary"

# Worker branch off the boot-time main (C0).
git -C "$P" branch worker
git -C "$P" switch -q worker
commit_file "$P" worker.txt "work" "W worker change"
git -C "$P" switch -q main

# origin/main advances under us with a non-conflicting file.
external_advance "$W1" ext.txt "ext" "E external change"

c0="$(git -C "$P" rev-parse HEAD)"
git -C "$P" fetch -q origin main
expect_eq "ff: local main still stale before integrate" "$c0" "$(git -C "$P" rev-parse HEAD)"

expect_ok "ff: merge_integrate_origin succeeds" merge_integrate_origin "$P" origin main
expect_eq "ff: local main fast-forwarded to origin tip" \
  "$(git -C "$P" rev-parse origin/main)" "$(git -C "$P" rev-parse HEAD)"

# Now the worker branch merges onto the current tip and the push fast-forwards.
git -C "$P" merge -q --no-ff worker -m "merge: worker"
mc_rc=0; git -C "$P" push -q origin main || mc_rc=$?
expect_eq "ff: push to origin/main accepted (no non-fast-forward rejection)" "0" "$mc_rc"
expect_ok "ff: merged tree has the worker file"   test -f "$P/worker.txt"
expect_ok "ff: merged tree kept the external file" test -f "$P/ext.txt"

# ----------------------------------------------------------------------
# Scenario 2 — divergent local snapshot rebased onto moved origin/main
# ----------------------------------------------------------------------
W2="$TMP/rebase"
make_world "$W2"
P2="$W2/primary"

# Local main gains a snapshot commit (the dirty-primary safety net), so it has
# diverged from origin once origin advances.
commit_file "$P2" snapshot.txt "snap" "chore(afk): pre-merge snapshot"
external_advance "$W2" ext.txt "ext" "E external change"
git -C "$P2" fetch -q origin main

expect_ok "rebase: merge_integrate_origin succeeds on divergence" \
  merge_integrate_origin "$P2" origin main
expect_ok "rebase: snapshot commit preserved" test -f "$P2/snapshot.txt"
expect_ok "rebase: external commit integrated" test -f "$P2/ext.txt"
# origin/main is now an ancestor of local main (local = origin tip + snapshot).
expect_ok "rebase: origin/main is an ancestor of integrated local main" \
  git -C "$P2" merge-base --is-ancestor origin/main HEAD

# ----------------------------------------------------------------------
# Scenario 3 — push rejection rolls the merge commit back, no orphan left
# ----------------------------------------------------------------------
W3="$TMP/rollback"
make_world "$W3"
P3="$W3/primary"

git -C "$P3" branch worker
git -C "$P3" switch -q worker
commit_file "$P3" worker.txt "work" "W worker change"
git -C "$P3" switch -q main

# Capture the pre-merge tip, then create the merge commit locally.
pre_merge_sha="$(git -C "$P3" rev-parse HEAD)"
git -C "$P3" merge -q --no-ff worker -m "merge: worker"
merge_sha="$(git -C "$P3" rev-parse HEAD)"
expect_ok "rollback: merge commit created (HEAD moved off pre-merge tip)" \
  test "$pre_merge_sha" != "$merge_sha"

# Simulate a rejected push: roll back to the captured pre-merge tip.
expect_ok "rollback: merge_rollback succeeds" merge_rollback "$P3" "$pre_merge_sha"
expect_eq "rollback: local main restored to pre-merge tip" \
  "$pre_merge_sha" "$(git -C "$P3" rev-parse HEAD)"
expect_ok "rollback: worker file gone from working tree" \
  test ! -f "$P3/worker.txt"
# The orphan merge commit is no longer reachable from main.
expect_fail "rollback: merge commit no longer reachable from main" \
  git -C "$P3" merge-base --is-ancestor "$merge_sha" HEAD
expect_eq "rollback: working tree clean" "" "$(git -C "$P3" status --porcelain)"

# ----------------------------------------------------------------------
# Scenario 4 — already in sync is a no-op success
# ----------------------------------------------------------------------
W4="$TMP/insync"
make_world "$W4"
P4="$W4/primary"
git -C "$P4" fetch -q origin main
expect_ok "insync: merge_integrate_origin no-ops when already at origin tip" \
  merge_integrate_origin "$P4" origin main
expect_eq "insync: local main unchanged" \
  "$(git -C "$P4" rev-parse origin/main)" "$(git -C "$P4" rev-parse HEAD)"

# missing remote ref → clean failure (no crash).
expect_fail "missing-ref: merge_integrate_origin fails on absent remote ref" \
  merge_integrate_origin "$P4" origin nonexistent-branch

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
