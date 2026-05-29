#!/usr/bin/env bash
# Tests for issue #257 (PRD #244): completion sweep — the local-disk side of
# completion cleanup.
#
#   completion_sweep_issue <issue> [root]
#     On issue completion, removes EVERY attempt dir for that issue across ALL
#     workers (the cross-worker `workers/*/<issue>-a*` glob), worktree first,
#     while never touching a live worker's active attempt.
#
#   cap_issue_attempts [root]
#     Fallback for issues that never complete: prunes attempt dirs over an age
#     cap (RED_AFK_ATTEMPT_TTL_S) or a per-issue count cap (RED_AFK_ATTEMPT_KEEP,
#     newest kept). Live attempts are never counted nor removed.
#
# Sources afk.sh directly (its source guard returns before the orchestrator main
# block) and drives the helpers against a real parent repo + real linked
# worktrees under mktemp, so worktree removal is exercised for real.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"

# shellcheck disable=SC1090
source "$AFK_SH"

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

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- a real parent repo so `git worktree add/remove` operate for real --------
PROJECT_ROOT="$TMP/repo"
mkdir -p "$PROJECT_ROOT"
git -C "$PROJECT_ROOT" init -q
git -C "$PROJECT_ROOT" config user.email test@example.invalid
git -C "$PROJECT_ROOT" config user.name "Test User"
printf 'base\n' > "$PROJECT_ROOT/file.txt"
git -C "$PROJECT_ROOT" add file.txt
git -C "$PROJECT_ROOT" commit -qm base
git -C "$PROJECT_ROOT" branch -M main

CLAIMED_ISSUE=""
TMP_DIR="$TMP/repo/.red/tmp"

# materialise_attempt <worker> <issue> <attempt> <state_pid>
# Build an attempt dir with a real linked worktree, the cheap artifacts, and a
# state file whose pid is <state_pid> (use 0 for not-live, $$ for live).
materialise_attempt() {
  local worker="$1" issue="$2" attempt="$3" pid="$4"
  local d="$TMP_DIR/workers/$worker/$issue-a$attempt"
  mkdir -p "$d"
  git -C "$PROJECT_ROOT" worktree add -q "$d/worktree" -b "afk/$worker/$issue-a$attempt" main
  printf '{"type":"vital"}\n' > "$d/log.jsonl"
  printf '# handoff\n'        > "$d/handoff.md"
  state_init "$d/afk.state.json" pid:="$pid"
  echo "$d"
}

worktree_registered() {
  git -C "$PROJECT_ROOT" worktree list --porcelain 2>/dev/null | grep -qF "$1"
}

# ===========================================================================
# completion_sweep_issue — removes every attempt of the issue across workers
# ===========================================================================
da="$(materialise_attempt wA 257 1 0)"
db="$(materialise_attempt wB 257 2 0)"   # different worker, same issue
dc="$(materialise_attempt wA 258 1 0)"   # different issue — must survive

expect_ok     "sweep: wA/257-a1 exists before"      test -d "$da"
expect_ok     "sweep: wB/257-a2 exists before"      test -d "$db"
expect_ok     "sweep: wB worktree registered before" worktree_registered "$db/worktree"

completion_sweep_issue 257

expect_not_ok "sweep: wA/257-a1 removed"            test -e "$da"
expect_not_ok "sweep: wB/257-a2 removed (cross-worker)" test -e "$db"
expect_not_ok "sweep: wB worktree unregistered"     worktree_registered "$db/worktree"
expect_ok     "sweep: unrelated issue 258 survives" test -d "$dc"

# idempotent: re-sweeping an already-clean issue is a rc-0 no-op
completion_sweep_issue 257
expect_ok     "sweep: second call rc 0"             test $? -eq 0

# ---- sweep refuses to remove a live worker's active attempt ----
dlive="$(materialise_attempt wC 259 1 $$)"   # pid = this shell → live
ddead="$(materialise_attempt wC 259 2 0)"

completion_sweep_issue 259
expect_ok     "sweep: live attempt is preserved"    test -d "$dlive"
expect_not_ok "sweep: dead attempt removed"         test -e "$ddead"

# ===========================================================================
# cap_issue_attempts — age cap
# ===========================================================================
dold="$(materialise_attempt wD 260 1 0)"
dnew="$(materialise_attempt wD 260 2 0)"
# backdate dold well past the age cap
touch -d '30 days ago' "$dold"

RED_AFK_ATTEMPT_TTL_S=$((14*86400)) RED_AFK_ATTEMPT_KEEP=99 cap_issue_attempts

expect_not_ok "cap(age): stale attempt reclaimed"   test -e "$dold"
expect_ok     "cap(age): fresh attempt kept"        test -d "$dnew"

# ===========================================================================
# cap_issue_attempts — count cap (keep newest K by attempt number)
# ===========================================================================
c1="$(materialise_attempt wE 261 1 0)"
c2="$(materialise_attempt wE 261 2 0)"
c3="$(materialise_attempt wE 261 3 0)"
c4="$(materialise_attempt wE 261 4 0)"

RED_AFK_ATTEMPT_TTL_S=$((365*86400)) RED_AFK_ATTEMPT_KEEP=2 cap_issue_attempts

expect_not_ok "cap(count): oldest attempt 1 dropped" test -e "$c1"
expect_not_ok "cap(count): attempt 2 dropped"        test -e "$c2"
expect_ok     "cap(count): newest attempt 3 kept"    test -d "$c3"
expect_ok     "cap(count): newest attempt 4 kept"    test -d "$c4"

# ---- cap refuses to remove a live worker's active attempt ----
lv="$(materialise_attempt wF 262 1 $$)"   # live, would otherwise be aged out
touch -d '30 days ago' "$lv" 2>/dev/null || true
dd="$(materialise_attempt wF 262 2 0)"
touch -d '30 days ago' "$dd"

RED_AFK_ATTEMPT_TTL_S=$((14*86400)) RED_AFK_ATTEMPT_KEEP=99 cap_issue_attempts
expect_ok     "cap: live attempt preserved despite age" test -d "$lv"
expect_not_ok "cap: dead stale attempt reclaimed"        test -e "$dd"

# ===========================================================================
# Static guard: process_issue's done path fires the completion sweep
# ===========================================================================
expect_ok     "guard: done path calls completion_sweep_issue" \
  grep -q 'completion_sweep_issue' "$AFK_SH"

# ---------- summary ----------
echo
echo "completion-sweep: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
