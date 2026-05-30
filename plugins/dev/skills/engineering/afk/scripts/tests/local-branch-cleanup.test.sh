#!/usr/bin/env bash
# Tests for issue #274 (PRD #244): boot-time cleanup of stale local afk/*
# live-worker branches after their issues have closed.
#
#   prune_completed_local_branches [repo-dir]
#     Lists local afk/{wid}/{n}-{slug} branches, classifies each issue through
#     the same S1 issue-state classifier as the snapshot reaper, deletes CLOSED
#     issue branches, keeps OPEN/unclassified issue branches, and never deletes
#     a branch currently checked out by any git worktree.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/remote-branch.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SHIM_DIR="$TMP/shim"
GH_DIR="$TMP/gh-meta"
GIT_LOG="$TMP/git.calls"
mkdir -p "$SHIM_DIR" "$GH_DIR"
: >"$GIT_LOG"

cat >"$SHIM_DIR/gh" <<SHIM
#!/usr/bin/env bash
printf 'gh %s\n' "\$*" >>"$GIT_LOG"
n=""; want_view=0; i=1
while (( i <= \$# )); do
  a="\${!i}"
  [[ "\$a" == "view" ]] && want_view=1
  if [[ "\$want_view" == 1 && "\$a" =~ ^[0-9]+\$ ]]; then n="\$a"; break; fi
  i=\$((i+1))
done
f="$GH_DIR/\$n.json"
if [[ -n "\$n" && -f "\$f" ]]; then cat "\$f"; exit 0; fi
echo "HTTP 500: transient failure" >&2
exit 1
SHIM
chmod 0755 "$SHIM_DIR/gh"
export PATH="$SHIM_DIR:$PATH"

gh_repo() { echo "owner/repo"; }

pass=0
fail=0

expect_ok() {
  local label="$1"; shift
  if "$@"; then echo "PASS  $label"; pass=$((pass + 1))
  else echo "FAIL  $label (command failed: $*)"; fail=$((fail + 1)); fi
}

expect_not_ok() {
  local label="$1"; shift
  if "$@"; then echo "FAIL  $label (command unexpectedly succeeded: $*)"; fail=$((fail + 1))
  else echo "PASS  $label"; pass=$((pass + 1)); fi
}

expect_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then echo "PASS  $label"; pass=$((pass + 1))
  else printf 'FAIL  %s\n      missing: %q\n      in:       %q\n' "$label" "$needle" "$haystack"; fail=$((fail + 1)); fi
}

expect_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then echo "PASS  $label"; pass=$((pass + 1))
  else printf 'FAIL  %s\n      unexpected: %q\n      in:        %q\n' "$label" "$needle" "$haystack"; fail=$((fail + 1)); fi
}

gh_fixture() {
  local n="$1" state="$2" closed="$3"
  printf '{"state":"%s","closedAt":"%s"}\n' "$state" "$closed" >"$GH_DIR/$n.json"
}

branch_exists() {
  git -C "$REPO" show-ref --verify --quiet "refs/heads/$1"
}

checked_out_branch() {
  git -C "$REPO" worktree list --porcelain | grep -qF "branch refs/heads/$1"
}

REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name "Test User"
printf 'base\n' >"$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit -qm base
git -C "$REPO" branch -M main

git -C "$REPO" branch afk/wAAA/274-closed main
git -C "$REPO" branch afk/wBBB/275-open main
git -C "$REPO" branch afk/wCCC/276-checked-out main
git -C "$REPO" branch afk-attempts/wAAA/274-snapshot main

git -C "$REPO" worktree add -q "$TMP/checked-out" afk/wCCC/276-checked-out

gh_fixture 274 CLOSED "2026-05-01T00:00:00Z"
gh_fixture 275 OPEN ""
gh_fixture 276 CLOSED "2026-05-01T00:00:00Z"

# shellcheck source=../lib/remote-branch.sh
source "$LIB"

PROJECT_ROOT="$REPO" expect_ok "local prune: returns 0" prune_completed_local_branches "$REPO"

expect_not_ok "local prune: deletes closed issue branch" branch_exists "afk/wAAA/274-closed"
expect_ok     "local prune: keeps open issue branch"     branch_exists "afk/wBBB/275-open"
expect_ok     "local prune: keeps checked-out branch"    branch_exists "afk/wCCC/276-checked-out"
expect_ok     "local prune: checked-out branch remains registered" checked_out_branch "afk/wCCC/276-checked-out"
expect_ok     "local prune: ignores snapshot namespace"  branch_exists "afk-attempts/wAAA/274-snapshot"

calls="$(cat "$GIT_LOG")"
expect_contains     "local prune: classified closed issue" "$calls" "issue view 274"
expect_contains     "local prune: classified open issue"   "$calls" "issue view 275"
expect_not_contains "local prune: skips checked-out issue classification" "$calls" "issue view 276"

expect_ok "guard: afk.sh boot calls prune_completed_local_branches" \
  grep -q 'prune_completed_local_branches' "$SCRIPTS/afk.sh"

echo
echo "local-branch-cleanup: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
