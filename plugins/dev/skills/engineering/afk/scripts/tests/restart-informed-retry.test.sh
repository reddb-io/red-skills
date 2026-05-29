#!/usr/bin/env bash
# Tests for restart-informed retries (issue #255, PRD #244).
#
# On a terminal FAILURE the orchestrator persists two per-attempt marker files
# into the attempt dir (snapshot-branch.ref, failure.reason). On a RETRY it
# reads the previous attempt's restart context from the attempt ledger BEFORE
# the current attempt dir exists, fetches the prior snapshot branch into the
# worktree under a stable local ref, and surfaces the prior failure reason +
# fetched ref to the inner agent through a <prior-attempt-context> handoff
# element — while STILL branching fresh off the base (no fix-forward). First
# attempts are byte-for-byte unaffected.
#
# afk.sh is sourced for its functions; the orchestrator main block stays
# dormant thanks to the BASH_SOURCE guard at the bottom of afk.sh.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"

# shellcheck disable=SC1090
source "$AFK_SH"

WORKER_ID="wTEST"
FILTER_KIND="all"
FILTER_VALUE=""

pass=0
fail=0

expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    printf 'FAIL  %s\n  got:  >>%s<<\n  want: >>%s<<\n' "$label" "$got" "$want"
    fail=$((fail + 1))
  fi
}

expect_contains() {
  local label="$1" hay="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$hay"; then
    echo "PASS  $label"; pass=$((pass + 1))
  else
    echo "FAIL  $label — missing: $needle"
    echo "----- hay -----"; echo "$hay"; echo "---------------"
    fail=$((fail + 1))
  fi
}

expect_not_contains() {
  local label="$1" hay="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$hay"; then
    echo "FAIL  $label — unexpectedly found: $needle"; fail=$((fail + 1))
  else
    echo "PASS  $label"; pass=$((pass + 1))
  fi
}

expect_ok() {
  local label="$1"; shift
  if "$@"; then echo "PASS  $label"; pass=$((pass + 1))
  else echo "FAIL  $label (command failed: $*)"; fail=$((fail + 1)); fi
}

expect_not_ok() {
  local label="$1"; shift
  if "$@"; then echo "FAIL  $label (unexpectedly succeeded: $*)"; fail=$((fail + 1))
  else echo "PASS  $label"; pass=$((pass + 1)); fi
}

# ---------- AC2 (writer): record_failure_markers persists both markers --------

D="$(mktemp -d)"
record_failure_markers "$D" "afk-attempts/wTEST/255-foo" "blocked: typecheck failed"
expect_eq "snapshot ref marker written" "afk-attempts/wTEST/255-foo" "$(cat "$D/snapshot-branch.ref")"
expect_contains "failure reason marker written" "$(cat "$D/failure.reason")" "blocked: typecheck failed"

# A missing attempt dir is a no-op (rc 0) — a kill before iter_open must never
# fail the emit path.
expect_ok "missing dir is a no-op" record_failure_markers "/no/such/dir/here" "ref" "reason"

# An empty ref skips the ref file but still records the reason (runner-crash
# path: no afk-attempts push, but the reason is still worth surfacing).
D2="$(mktemp -d)"
record_failure_markers "$D2" "" "runner-crash rc=7"
expect_not_ok "no ref file when ref is empty" test -f "$D2/snapshot-branch.ref"
expect_contains "reason still written when ref empty" "$(cat "$D2/failure.reason")" "runner-crash rc=7"

# ---------- ledger timing: prior context read before the current dir exists ---
# This mirrors iter_open: prior attempts a1.. exist on disk, the CURRENT attempt
# dir is NOT yet created, so attempt_ledger_context returns the *previous*
# attempt's markers — not an empty current dir.
ROOT="$(mktemp -d)"
mkdir -p "$ROOT/workers/wTEST/255-a1/worktree"
printf 'afk-attempts/wTEST/255-foo\n' > "$ROOT/workers/wTEST/255-a1/snapshot-branch.ref"
printf 'blocked: tests failed\n'      > "$ROOT/workers/wTEST/255-a1/failure.reason"
CTX="$(attempt_ledger_context "$ROOT" 255)"
expect_contains "ledger context names prior branch" "$CTX" "afk-attempts/wTEST/255-foo"
expect_contains "ledger context names prior reason" "$CTX" "blocked: tests failed"

# ---------- AC4: first attempt unaffected — empty context, no fetch, rc!=0 ----
out_first=""; rc_first=0
out_first="$(fetch_prior_attempt_context "" "/tmp")" || rc_first=$?
expect_eq "first-attempt fetch context rc != 0" "1" "$rc_first"
expect_eq "first-attempt fetch context empty output" "" "$out_first"

# ---------- AC1 + AC2: retry fetches the snapshot branch, surfaces reason ------
WT="$(mktemp -d)"
CTX_RETRY="prev-attempt: 1
prev-snapshot-branch: afk-attempts/wTEST/255-foo
prev-failure-reason:
blocked: tests failed"

# Stub git so the fetch succeeds without a real remote.
git() { return 0; }
out_ok="$(fetch_prior_attempt_context "$CTX_RETRY" "$WT")"
unset -f git
expect_contains "retry block carries prior branch"  "$out_ok" "afk-attempts/wTEST/255-foo"
expect_contains "retry block carries prior reason"  "$out_ok" "blocked: tests failed"
expect_contains "retry block names fetched local ref" "$out_ok" "$PRIOR_ATTEMPT_LOCAL_REF"

# A failed fetch still surfaces the reason + ref; never aborts.
git() { return 1; }
out_fail="$(fetch_prior_attempt_context "$CTX_RETRY" "$WT")"
unset -f git
expect_contains "fetch-failed still surfaces reason" "$out_fail" "blocked: tests failed"
expect_contains "fetch-failed notes unavailable"     "$out_fail" "fetch unavailable"

# A "(none)" branch (push failed last time) attempts no fetch but keeps reason.
CTX_NONE="prev-attempt: 1
prev-snapshot-branch: (none)
prev-failure-reason:
stall-reaped"
out_none="$(fetch_prior_attempt_context "$CTX_NONE" "$WT")"
expect_contains "none-branch surfaces reason"  "$out_none" "stall-reaped"
expect_contains "none-branch notes unavailable" "$out_none" "fetch unavailable"

# ---------- handoff element: emitted only on a retry --------------------------
PRIOR_BLOCK="prev-attempt: 1
prev-snapshot-branch: afk-attempts/wTEST/255-foo
prev-failure-reason:
blocked: tests failed
prev-fetched-ref: refs/afk/prior-attempt"

OUT_RETRY="$(build_retry_handoff_body 255 "Title" "issue body" claude 2 "url" "[]" "$PRIOR_BLOCK")"
expect_contains "retry handoff opens <prior-attempt-context>"  "$OUT_RETRY" "<prior-attempt-context>"
expect_contains "retry handoff closes </prior-attempt-context>" "$OUT_RETRY" "</prior-attempt-context>"
expect_contains "retry handoff surfaces prior branch" "$OUT_RETRY" "afk-attempts/wTEST/255-foo"
expect_contains "retry handoff surfaces prior reason" "$OUT_RETRY" "blocked: tests failed"

# First attempt: empty 8th arg → element omitted entirely.
OUT_FIRST="$(build_retry_handoff_body 255 "Title" "issue body" claude 1 "url" "[]" "")"
expect_not_contains "first-attempt omits <prior-attempt-context>" "$OUT_FIRST" "<prior-attempt-context>"

# Back-compat: the legacy 7-arg call still works and omits the element.
OUT_LEGACY="$(build_retry_handoff_body 255 "Title" "issue body" claude 1 "url" "[]")"
expect_not_contains "7-arg legacy call omits <prior-attempt-context>" "$OUT_LEGACY" "<prior-attempt-context>"

# ---------- AC3 + wiring guards (lock the orchestrator integration) -----------
expect_ok "iter_open captures prior context before mkdir" \
  grep -q 'PRIOR_ATTEMPT_CONTEXT="\$(attempt_ledger_context' "$AFK_SH"
expect_ok "process_issue uses ITER_ATTEMPT for attempt numbering" \
  grep -q 'local attempt="\${ITER_ATTEMPT:-1}"' "$AFK_SH"
expect_not_ok "no hard-coded attempt=1 in process_issue" \
  grep -qE '^[[:space:]]*local attempt=1[[:space:]]*$' "$AFK_SH"
expect_ok "AC3: worktree still branches fresh off the base" \
  grep -qF 'worktree add "$worktree" -b "$branch" "origin/$pinned"' "$AFK_SH"
expect_ok "emit_envelope records failure markers" \
  grep -q 'record_failure_markers' "$AFK_SH"

# ---------- summary ----------
echo
echo "restart-informed-retry: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
