#!/usr/bin/env bash
# Tests for issue #256 (PRD #244): split iteration teardown — every close path
# (success and failure/blocked) ALWAYS drops the heavy git worktree, while the
# cheap artifacts (the JSONL lanes + the handoff) are RETAINED in the attempt
# directory for post-mortem.
#
# Sources afk.sh directly (its source guard returns before the orchestrator
# main block) and drives the close helpers against a real git repo + a real
# linked worktree under mktemp, so the worktree removal is exercised for what
# it is — an actual `git worktree remove` plus the FS reconciliation.
#
# Contract under test:
#   - iter_drop_worktree removes the linked worktree (and unregisters it from
#     the parent repo) but never touches sibling artifacts; it is a best-effort
#     rc-0 no-op when the worktree is already gone.
#   - iter_close_success drops the worktree, RETAINS log.jsonl / agent.log.jsonl
#     / handoff.md, marks the retained state file not-live (pid 0), and clears
#     the ITER_DIR globals.
#   - iter_close_preserve does the same: it now also drops the worktree, where
#     before it kept everything.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"

# shellcheck disable=SC1090
source "$AFK_SH"

pass=0
fail=0

expect_ok() {
  local label="$1"; shift
  if "$@"; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label (command failed: $*)"; fail=$((fail + 1))
  fi
}

expect_not_ok() {
  local label="$1"; shift
  if "$@"; then
    echo "FAIL  $label (command unexpectedly succeeded: $*)"; fail=$((fail + 1))
  else
    echo "PASS  $label"; pass=$((pass + 1))
  fi
}

expect_eq() {
  local label="$1" want="$2" got="$3"
  if [[ "$want" == "$got" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      want: %q\n      got:  %q\n' "$label" "$want" "$got"
    fail=$((fail + 1))
  fi
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

# CLAIMED_ISSUE empty → claim_lock_release is a harmless rc-0 no-op.
CLAIMED_ISSUE=""
TMP_DIR="$TMP/tmp"

# materialise_attempt <iter_dir> <branch>
# Build a fresh attempt dir: a linked worktree under it plus the cheap
# artifacts the close path must retain, and a live-pid state file.
materialise_attempt() {
  local iter_dir="$1" branch="$2"
  mkdir -p "$iter_dir"
  git -C "$PROJECT_ROOT" worktree add -q "$iter_dir/worktree" -b "$branch" main
  printf '{"type":"vital"}\n'  > "$iter_dir/log.jsonl"
  printf '{"type":"agent"}\n'  > "$iter_dir/agent.log.jsonl"
  printf '# handoff for 256\n' > "$iter_dir/handoff.md"
  state_init "$iter_dir/afk.state.json" pid:=$$
}

worktree_registered() {
  git -C "$PROJECT_ROOT" worktree list --porcelain 2>/dev/null | grep -qF "$1"
}

artifacts_intact() {
  local d="$1"
  [[ -s "$d/log.jsonl" && -s "$d/agent.log.jsonl" && -s "$d/handoff.md" ]] \
    && grep -q vital "$d/log.jsonl" \
    && grep -q agent "$d/agent.log.jsonl" \
    && grep -q handoff "$d/handoff.md"
}

# ===========================================================================
# iter_drop_worktree — drops only the worktree, never the siblings
# ===========================================================================
ITER_DIR="$TMP/tmp/workers/wT/256-a1"
materialise_attempt "$ITER_DIR" "afk/wT/256-drop"
expect_ok      "drop: worktree exists before"       test -d "$ITER_DIR/worktree"
expect_ok      "drop: worktree registered before"   worktree_registered "$ITER_DIR/worktree"

iter_drop_worktree "$ITER_DIR/worktree"
expect_ok      "drop: returns rc 0"                 test $? -eq 0
expect_not_ok  "drop: worktree dir is gone"         test -e "$ITER_DIR/worktree"
expect_not_ok  "drop: worktree unregistered"        worktree_registered "$ITER_DIR/worktree"
expect_ok      "drop: artifacts retained"           artifacts_intact "$ITER_DIR"

# idempotent: a second drop on the already-gone worktree is a rc-0 no-op
iter_drop_worktree "$ITER_DIR/worktree"
expect_ok      "drop: second call is rc 0"          test $? -eq 0
expect_ok      "drop: artifacts still retained"     artifacts_intact "$ITER_DIR"

# ===========================================================================
# iter_close_success — drops worktree, retains artifacts, marks not-live
# ===========================================================================
ITER_DIR="$TMP/tmp/workers/wT/256-a2"
materialise_attempt "$ITER_DIR" "afk/wT/256-success"
STATE_FILE="$ITER_DIR/afk.state.json"
ITER_LOG="$ITER_DIR/afk.log"; AGENT_LANE="$ITER_DIR/agent.log.jsonl"; FIREHOSE="$ITER_DIR/log.jsonl"
keep="$ITER_DIR"
expect_ok      "success: state live before"         state_is_live "$STATE_FILE"

iter_close_success

expect_not_ok  "success: worktree dir is gone"      test -e "$keep/worktree"
expect_not_ok  "success: worktree unregistered"     worktree_registered "$keep/worktree"
expect_ok      "success: artifacts retained"        artifacts_intact "$keep"
expect_ok      "success: state file retained"       test -f "$keep/afk.state.json"
expect_not_ok  "success: state marked not-live"     state_is_live "$keep/afk.state.json"
expect_eq      "success: state pid zeroed"          "0" "$(jq -r '.pid' "$keep/afk.state.json")"
expect_eq      "success: ITER_DIR global cleared"   "" "$ITER_DIR"

# ===========================================================================
# iter_close_preserve — also drops worktree now (was: kept everything)
# ===========================================================================
ITER_DIR="$TMP/tmp/workers/wT/256-a3"
materialise_attempt "$ITER_DIR" "afk/wT/256-preserve"
STATE_FILE="$ITER_DIR/afk.state.json"
ITER_LOG="$ITER_DIR/afk.log"; AGENT_LANE="$ITER_DIR/agent.log.jsonl"; FIREHOSE="$ITER_DIR/log.jsonl"
keep="$ITER_DIR"

iter_close_preserve

expect_not_ok  "preserve: worktree dir is gone"     test -e "$keep/worktree"
expect_not_ok  "preserve: worktree unregistered"    worktree_registered "$keep/worktree"
expect_ok      "preserve: artifacts retained"       artifacts_intact "$keep"
expect_ok      "preserve: state file retained"      test -f "$keep/afk.state.json"
expect_not_ok  "preserve: state marked not-live"    state_is_live "$keep/afk.state.json"
expect_eq      "preserve: ITER_DIR global cleared"  "" "$ITER_DIR"

# ===========================================================================
# Static guards: the orchestrator wiring no longer wipes the whole ITER_DIR on
# success, and close is the single owner of worktree teardown.
# ===========================================================================
# Inspect the success close body: it must NOT contain `rm -rf "$ITER_DIR"`.
success_body="$(awk '/^iter_close_success\(\)/{f=1} f{print} /^}/{if(f)exit}' "$AFK_SH")"
expect_not_ok  "guard: success close has no rm -rf ITER_DIR" \
  grep -qF 'rm -rf "$ITER_DIR"' <<<"$success_body"
expect_ok      "guard: success close drops the worktree" \
  grep -q 'iter_drop_worktree' <<<"$success_body"

preserve_body="$(awk '/^iter_close_preserve\(\)/{f=1} f{print} /^}/{if(f)exit}' "$AFK_SH")"
expect_ok      "guard: preserve close drops the worktree" \
  grep -q 'iter_drop_worktree' <<<"$preserve_body"

# ---------- summary ----------
echo
echo "split-teardown: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
