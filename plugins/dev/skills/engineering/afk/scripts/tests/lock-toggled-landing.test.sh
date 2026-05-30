#!/usr/bin/env bash
# Tests for the lock-toggled landing (ADR 0030, issue #254).
#
# Verifies do_merge routes by lock state:
#   - locked   → direct local merge into the locked branch + push origin <locked>,
#                NO PR.
#   - unlocked → land_pr: a PR into <target> admin-merged, NO direct merge of the
#                attempt branch into <target>.
# And land_pr's own contract: push-before-PR, reuse an open PR, admin-merge,
# failure propagation.
#
# afk.sh is sourced (BASH_SOURCE guard skips main). git/gh and the lifecycle
# hooks are stubbed to record calls and stay offline.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"
# shellcheck disable=SC1090
source "$AFK_SH"

pass=0; fail=0
ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1${2:+ ($2)}"; fail=$((fail + 1)); }
assert_contains() { local l="$1" h="$2" n="$3"; [[ "$h" == *"$n"* ]] && ok "$l" || bad "$l" "missing: $n"; }
assert_absent()   { local l="$1" h="$2" n="$3"; [[ "$h" != *"$n"* ]] && ok "$l" || bad "$l" "unexpected: $n"; }

PROJECT_ROOT="$(mktemp -d -t afk-landing.XXXXXX)"
trap 'rm -rf "$PROJECT_ROOT"' EXIT
mkdir -p "$PROJECT_ROOT/.red/tmp"
LOCKFILE="$PROJECT_ROOT/.red/tmp/branch-lock.yaml"

GIT_CALLS="$PROJECT_ROOT/git.calls"
GH_CALLS="$PROJECT_ROOT/gh.calls"
RUNNER="claude"

# --- stubs -------------------------------------------------------------------
git() {
  printf '%s\n' "$*" >>"$GIT_CALLS"
  case "$*" in
    *"status --porcelain"*) : ;;                      # clean → no snapshot commit
    *"branch --show-current"*) printf 'main\n' ;;     # already on target → no switch
    *"rev-parse HEAD"*) printf '0000000000000000000000000000000000000000\n' ;;
    *"rev-parse --short HEAD"*) printf '0000000\n' ;;
    *"merge-base"*) printf '1111111\n' ;;
    *) : ;;                                           # fetch/merge/push/diff → success
  esac
  return 0
}
gh() { printf '%s\n' "$*" >>"$GH_CALLS"
  case "$*" in
    *"pr list"*) printf '%s\n' "${STUB_PR_NUM:-}" ;;  # current open-PR number (empty = none)
    *) : ;;
  esac
  return 0
}
gh_repo() { printf 'reddb-io/red-skills\n'; }
log() { :; }
run_lifecycle_hook() { return 0; }
hook_dispatch() { return 0; }
merge_integrate_origin() { return 0; }
merge_resolve_conflict() { return 0; }
merge_rollback() { return 0; }

reset_calls() { : >"$GIT_CALLS"; : >"$GH_CALLS"; STUB_PR_NUM=""; }

# ---------- locked → direct local merge + push, no PR ----------
printf 'work-branch\n' > "$LOCKFILE"
reset_calls
do_merge "afk/wAAAA/9-x" 9 "do thing" "work-branch" "$PROJECT_ROOT/wt" && ok "locked: do_merge returns 0" || bad "locked: do_merge non-zero"
g="$(cat "$GIT_CALLS")"; h="$(cat "$GH_CALLS")"
assert_contains "locked: merges attempt into locked branch" "$g" "merge --no-ff afk/wAAAA/9-x"
assert_contains "locked: pushes the locked branch"          "$g" "push origin work-branch"
assert_absent   "locked: opens no PR"                       "$h" "pr create"
assert_absent   "locked: admin-merges nothing"             "$h" "pr merge"

# ---------- unlocked → PR into target, admin-merged, no direct attempt merge ----------
rm -f "$LOCKFILE"
reset_calls
STUB_PR_NUM=""   # no existing PR; pr list returns empty first, then 77 after create
gh() { printf '%s\n' "$*" >>"$GH_CALLS"
  case "$*" in
    *"pr list"*) [[ -f "$PROJECT_ROOT/.pr_made" ]] && printf '77\n' || printf '\n' ;;
    *"pr create"*) : > "$PROJECT_ROOT/.pr_made" ;;
    *) : ;;
  esac
  return 0
}
rm -f "$PROJECT_ROOT/.pr_made"
do_merge "afk/wBBBB/9-x" 9 "do thing" "main" "$PROJECT_ROOT/wt" && ok "unlocked: do_merge returns 0" || bad "unlocked: do_merge non-zero"
g="$(cat "$GIT_CALLS")"; h="$(cat "$GH_CALLS")"
assert_contains "unlocked: pushes attempt branch before PR"  "$g" "push origin HEAD:refs/heads/afk/wBBBB/9-x"
assert_contains "unlocked: opens PR into main from attempt"  "$h" "pr create --base main --head afk/wBBBB/9-x"
assert_contains "unlocked: admin-merges the PR"              "$h" "pr merge 77 --admin --merge"
assert_absent   "unlocked: no direct merge of attempt into target" "$g" "merge --no-ff afk/wBBBB/9-x"
assert_contains "unlocked: ff-merges origin/main locally"    "$g" "merge --ff-only origin/main"

# ---------- unlocked: reuse an already-open PR (idempotent re-attempt) ----------
reset_calls
gh() { printf '%s\n' "$*" >>"$GH_CALLS"
  case "$*" in *"pr list"*) printf '42\n' ;; *) : ;; esac; return 0; }
land_pr "afk/wCCCC/9-x" 9 "t" "main" "" && ok "land_pr: reuse open PR returns 0" || bad "land_pr reuse non-zero"
h="$(cat "$GH_CALLS")"
assert_absent   "land_pr reuse: does not create a second PR" "$h" "pr create"
assert_contains "land_pr reuse: admin-merges the existing PR" "$h" "pr merge 42 --admin --merge"

# ---------- land_pr failure propagates (pr merge fails) ----------
reset_calls
gh() { printf '%s\n' "$*" >>"$GH_CALLS"
  case "$*" in
    *"pr list"*) printf '5\n' ;;
    *"pr merge"*) return 1 ;;
    *) : ;;
  esac; return 0; }
if land_pr "afk/wDDDD/9-x" 9 "t" "main" ""; then bad "land_pr: merge failure should return non-zero"; else ok "land_pr: admin-merge failure → return 1"; fi

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
