#!/usr/bin/env bash
# Tests for plugins/.../afk/scripts/lib/attempt-ledger.sh (issue #249, PRD #244).
#
# Sources the module directly (with its worker-paths dependency) and exercises
# the attempt-ledger contract the acceptance criteria name:
#   - next attempt number derived from the on-disk attempt directories for an
#     issue (max existing attempt + 1), enumerated via the worker-paths glob;
#   - the first-attempt (no prior directory) case derives 1;
#   - prior-attempt context = the previous attempt's remote snapshot branch ref
#     + its recorded failure reason, read from the attempt dir;
#   - first attempt assembles no prior context (empty), and a prior attempt with
#     missing/partial marker files degrades gracefully.
#
# The directory tree is built under a real mktemp root so the FS enumeration is
# exercised for what it is — this module owns that I/O, delegating only the path
# grammar to worker-paths.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/attempt-ledger.sh"

# shellcheck source=../lib/attempt-ledger.sh
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

expect_not_ok() {
  local label="$1"; shift
  if "$@"; then
    echo "FAIL  $label (command unexpectedly succeeded: $*)"
    fail=$((fail + 1))
  else
    echo "PASS  $label"
    pass=$((pass + 1))
  fi
}

# --- fixture root: a real attempt tree under mktemp ---------------------------
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

# Helper: materialise an attempt directory <worker>/<issue>-a<attempt> with
# optional snapshot-branch ref and failure reason marker files.
mk_attempt() {
  local worker="$1" issue="$2" attempt="$3" branch="${4:-}" reason="${5:-}"
  local dir="$ROOT/workers/$worker/${issue}-a${attempt}"
  mkdir -p "$dir/worktree"
  [[ -n "$branch" ]] && printf '%s\n' "$branch" > "$dir/snapshot-branch.ref"
  [[ -n "$reason" ]] && printf '%s\n' "$reason" > "$dir/failure.reason"
}

# ---------- AC1 + AC3: next attempt number from on-disk directories ----------

# No directory yet for issue 249 ⇒ first attempt ⇒ 1.
expect_eq "first attempt (no dirs) ⇒ 1" "1" "$(attempt_ledger_next_number "$ROOT" 249)"

# One prior attempt (a1) ⇒ next is 2.
mk_attempt wA1B9 249 1 "afk-attempts/wA1B9/249-foo" "BLOCKED: typecheck failed"
expect_eq "one prior (a1) ⇒ 2" "2" "$(attempt_ledger_next_number "$ROOT" 249)"

# Several prior attempts, out of glob order ⇒ max+1 (numeric, not lexical).
mk_attempt wA1B9 249 2 "afk-attempts/wA1B9/249-foo" "no-sentinel"
mk_attempt wC7D2 249 10 "afk-attempts/wC7D2/249-foo" "stall-reaped"
mk_attempt wC7D2 249 3 "afk-attempts/wC7D2/249-foo" "BLOCKED"
expect_eq "max across workers a10 ⇒ 11 (numeric)" "11" "$(attempt_ledger_next_number "$ROOT" 249)"

# A different issue is enumerated independently (no cross-talk).
mk_attempt wA1B9 250 4 "afk-attempts/wA1B9/250-bar" "fail"
expect_eq "issue 250 independent ⇒ 5" "5" "$(attempt_ledger_next_number "$ROOT" 250)"
expect_eq "issue 249 unaffected by 250 ⇒ 11" "11" "$(attempt_ledger_next_number "$ROOT" 249)"

# An issue with no directories at all ⇒ first attempt ⇒ 1.
expect_eq "unseen issue 999 ⇒ 1" "1" "$(attempt_ledger_next_number "$ROOT" 999)"

# Junk that matches the shell glob but is NOT a valid attempt dir is ignored:
# worker_paths_parse rejects `249-aX`, so it never bumps the counter.
mkdir -p "$ROOT/workers/wZZZ/249-aX"
expect_eq "non-numeric attempt suffix ignored ⇒ still 11" "11" \
  "$(attempt_ledger_next_number "$ROOT" 249)"

# next_number always succeeds (rc 0) on a valid issue, including first-attempt.
expect_ok "next_number rc 0 (has priors)" attempt_ledger_next_number "$ROOT" 249
expect_ok "next_number rc 0 (first attempt)" attempt_ledger_next_number "$ROOT" 999

# Invalid issue / empty root ⇒ non-zero, no derivation.
expect_not_ok "invalid issue ⇒ rc != 0" attempt_ledger_next_number "$ROOT" 0
expect_not_ok "non-numeric issue ⇒ rc != 0" attempt_ledger_next_number "$ROOT" abc
expect_not_ok "empty root ⇒ rc != 0" attempt_ledger_next_number "" 249

# ---------- prior-attempt directory selection (highest attempt wins) ---------

# The previous attempt dir is the highest-numbered existing attempt (a10 here).
expect_eq "prev_dir is highest attempt" "$ROOT/workers/wC7D2/249-a10" \
  "$(attempt_ledger_prev_dir "$ROOT" 249)"

# No prior ⇒ empty output, non-zero (the caller's first-attempt signal).
expect_eq "prev_dir empty for unseen issue" "" "$(attempt_ledger_prev_dir "$ROOT" 999)"
expect_not_ok "prev_dir rc != 0 for unseen issue" attempt_ledger_prev_dir "$ROOT" 999

# ---------- AC2 + AC3: assemble prior-attempt restart context ----------------

# A fully-recorded prior attempt yields branch + reason in the context block.
ctx="$(attempt_ledger_context "$ROOT" 249)"
expect_eq "context carries the snapshot branch ref" \
  "afk-attempts/wC7D2/249-foo" \
  "$(sed -n 's/^prev-snapshot-branch: //p' <<<"$ctx")"
expect_eq "context carries the previous attempt number" \
  "10" \
  "$(sed -n 's/^prev-attempt: //p' <<<"$ctx")"
expect_ok "context names the failure reason" grep -q 'stall-reaped' <<<"$ctx"

# First attempt (no prior) ⇒ no context assembled (empty), rc != 0.
expect_eq "first-attempt context is empty" "" "$(attempt_ledger_context "$ROOT" 998)"
expect_not_ok "first-attempt context rc != 0" attempt_ledger_context "$ROOT" 998

# A prior attempt with NO marker files degrades gracefully: the block still
# names the attempt and labels the missing fields rather than failing.
mk_attempt wE5F6 777 1 "" ""
ctx_bare="$(attempt_ledger_context "$ROOT" 777)"
expect_ok "bare context still emitted (rc 0)" attempt_ledger_context "$ROOT" 777
expect_ok "bare context labels missing branch" grep -q 'prev-snapshot-branch: (none)' <<<"$ctx_bare"
expect_ok "bare context labels missing reason" grep -q '(none recorded)' <<<"$ctx_bare"
expect_eq "bare context still names the attempt number" "1" \
  "$(sed -n 's/^prev-attempt: //p' <<<"$ctx_bare")"

# A prior attempt with branch but no reason keeps the branch, labels the reason.
mk_attempt wG7H8 778 1 "afk-attempts/wG7H8/778-baz" ""
ctx_partial="$(attempt_ledger_context "$ROOT" 778)"
expect_eq "partial context keeps the branch" "afk-attempts/wG7H8/778-baz" \
  "$(sed -n 's/^prev-snapshot-branch: //p' <<<"$ctx_partial")"
expect_ok "partial context labels missing reason" grep -q '(none recorded)' <<<"$ctx_partial"

# Multi-line failure reasons are preserved verbatim in the block.
mk_attempt wI9J0 779 1 "afk-attempts/wI9J0/779-qux" "$(printf 'line one\nline two')"
ctx_multi="$(attempt_ledger_context "$ROOT" 779)"
expect_ok "multi-line reason preserves first line"  grep -q 'line one' <<<"$ctx_multi"
expect_ok "multi-line reason preserves second line" grep -q 'line two' <<<"$ctx_multi"

# ---------- summary ----------
echo
echo "attempt-ledger: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
