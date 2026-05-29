#!/usr/bin/env bash
# Unit test for lib/worker-paths.sh — the module that owns the AFK worker
# directory scheme `workers/{wid}/{issue}-a{n}/` (PRD #244, issue #245).
#
# Sources the module directly (no orchestrator globals) and exercises the whole
# public surface in isolation:
#   1. worker_paths_build       — builds <root>/workers/<worker>/<issue>-a<n>,
#      normalises a trailing slash, and rejects malformed identities.
#   2. worker_paths_parse       — parses (worker, issue, attempt) back out of a
#      path regardless of root depth, tolerates a trailing slash, and rejects
#      paths that don't match the scheme.
#   3. round-trip               — parse(build(id)) == id for several identities.
#   4. worker_paths_issue_glob  — the glob for all attempts of one issue across
#      all workers, both as a literal pattern and expanded against a fixture tree.
#   5. worker_paths_workers_glob — the glob for all live workers, literal and
#      expanded against the same fixture tree.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/worker-paths.sh"

# shellcheck source=../lib/worker-paths.sh
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

# expect_rc <label> <expected_rc> <command...>
# Runs the command, captures stdout, and asserts the exit code. On a non-zero
# expectation it also asserts no stdout was produced (malformed → silent).
expect_rc() {
  local label="$1" expected_rc="$2"; shift 2
  local out rc
  out="$("$@")"; rc=$?
  if [[ "$rc" -ne "$expected_rc" ]]; then
    printf 'FAIL  %s — expected rc %s, got %s\n' "$label" "$expected_rc" "$rc"
    fail=$((fail + 1)); return
  fi
  if [[ "$expected_rc" -ne 0 && -n "$out" ]]; then
    printf 'FAIL  %s — expected no output on failure, got: %q\n' "$label" "$out"
    fail=$((fail + 1)); return
  fi
  echo "PASS  $label"; pass=$((pass + 1))
}

# ===========================================================================
# worker_paths_build — happy path + trailing-slash normalisation
# ===========================================================================
expect_eq "build/basic" \
  "/tmp/afk/workers/wA1B9/245-a1" \
  "$(worker_paths_build /tmp/afk wA1B9 245 1)"
expect_eq "build/higher-attempt" \
  ".red/tmp/workers/w0O2Y/42-a7" \
  "$(worker_paths_build .red/tmp w0O2Y 42 7)"
expect_eq "build/trailing-slash-normalised" \
  "/tmp/afk/workers/wA1B9/245-a1" \
  "$(worker_paths_build /tmp/afk/ wA1B9 245 1)"

# ===========================================================================
# worker_paths_build — malformed identities are rejected predictably
# ===========================================================================
expect_rc "build/empty-root rejected"      1 worker_paths_build "" wA1B9 245 1
expect_rc "build/empty-worker rejected"    1 worker_paths_build /tmp ""    245 1
expect_rc "build/worker-with-slash"        1 worker_paths_build /tmp "w/x" 245 1
expect_rc "build/non-numeric-issue"        1 worker_paths_build /tmp wA1B9 "abc" 1
expect_rc "build/zero-issue rejected"      1 worker_paths_build /tmp wA1B9 0 1
expect_rc "build/zero-attempt rejected"    1 worker_paths_build /tmp wA1B9 245 0
expect_rc "build/negative-attempt"         1 worker_paths_build /tmp wA1B9 245 -1
expect_rc "build/leading-zero-attempt"     1 worker_paths_build /tmp wA1B9 245 01

# ===========================================================================
# worker_paths_parse — happy path, depth-independence, trailing slash
# ===========================================================================
expect_eq "parse/basic" \
  "wA1B9 245 1" \
  "$(worker_paths_parse /tmp/afk/workers/wA1B9/245-a1)"
expect_eq "parse/deep-root" \
  "w0O2Y 42 7" \
  "$(worker_paths_parse /home/me/proj/.red/tmp/workers/w0O2Y/42-a7)"
expect_eq "parse/trailing-slash" \
  "wA1B9 245 1" \
  "$(worker_paths_parse /tmp/afk/workers/wA1B9/245-a1/)"

# ===========================================================================
# worker_paths_parse — non-matching paths are rejected predictably
# ===========================================================================
expect_rc "parse/empty rejected"            1 worker_paths_parse ""
expect_rc "parse/missing-attempt"           1 worker_paths_parse /tmp/workers/wA1B9/245
expect_rc "parse/bad-leaf-separator"        1 worker_paths_parse /tmp/workers/wA1B9/245-b1
expect_rc "parse/non-numeric-issue"         1 worker_paths_parse /tmp/workers/wA1B9/x-a1
expect_rc "parse/wrong-parent-segment"      1 worker_paths_parse /tmp/agents/wA1B9/245-a1
expect_rc "parse/worktree-subdir rejected"  1 worker_paths_parse /tmp/workers/wA1B9/245-a1/worktree

# ===========================================================================
# round-trip — parse(build(id)) recovers the original identity
# ===========================================================================
for id in "wA1B9 245 1" "w0O2Y 42 7" "worker-1 1 1" "W9 9999 12"; do
  read -r w i a <<< "$id"
  built="$(worker_paths_build /tmp/afk "$w" "$i" "$a")"
  expect_eq "round-trip/$id" "$id" "$(worker_paths_parse "$built")"
done

# ===========================================================================
# worker_paths_issue_glob — literal pattern + expansion against a fixture tree
# ===========================================================================
expect_eq "issue-glob/literal" \
  "/tmp/afk/workers/*/245-a*" \
  "$(worker_paths_issue_glob /tmp/afk 245)"
expect_rc "issue-glob/non-numeric rejected" 1 worker_paths_issue_glob /tmp/afk abc

expect_eq "workers-glob/literal" \
  "/tmp/afk/workers/*" \
  "$(worker_paths_workers_glob /tmp/afk)"
expect_rc "workers-glob/empty-root rejected" 1 worker_paths_workers_glob ""

# Build a fixture tree and confirm the globs select exactly the right dirs.
TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
mkdir -p \
  "$TMPROOT/workers/wAAAA/245-a1/worktree" \
  "$TMPROOT/workers/wAAAA/245-a2/worktree" \
  "$TMPROOT/workers/wBBBB/245-a1/worktree" \
  "$TMPROOT/workers/wBBBB/300-a1/worktree" \
  "$TMPROOT/workers/wCCCC/77-a3/worktree"

# Issue glob: every attempt of issue 245 across all workers (3 dirs), and not
# issue 300 or 77.
issue_glob="$(worker_paths_issue_glob "$TMPROOT" 245)"
# shellcheck disable=SC2086
matched_issue="$(printf '%s\n' $issue_glob | sort)"
expected_issue="$(printf '%s\n' \
  "$TMPROOT/workers/wAAAA/245-a1" \
  "$TMPROOT/workers/wAAAA/245-a2" \
  "$TMPROOT/workers/wBBBB/245-a1" | sort)"
expect_eq "issue-glob/expands-to-all-attempts" "$expected_issue" "$matched_issue"

# Workers glob: every live worker dir (3 workers), regardless of issue.
workers_glob="$(worker_paths_workers_glob "$TMPROOT")"
# shellcheck disable=SC2086
matched_workers="$(printf '%s\n' $workers_glob | sort)"
expected_workers="$(printf '%s\n' \
  "$TMPROOT/workers/wAAAA" \
  "$TMPROOT/workers/wBBBB" \
  "$TMPROOT/workers/wCCCC" | sort)"
expect_eq "workers-glob/expands-to-all-workers" "$expected_workers" "$matched_workers"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
